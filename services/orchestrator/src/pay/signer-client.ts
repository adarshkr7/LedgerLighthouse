/**
 * HTTP client for the Authorization Signer.
 *
 * This file is on the untrusted side of the boundary and must stay that way:
 * `services/orchestrator` may not import `@ntux402/signer`, by package name or
 * relative path (`pnpm check:boundary`). So the request and response types are
 * declared here, structurally, rather than shared — the duplication is the
 * point. A shared type would be an import, and an import is a dependency, and a
 * dependency is how "the orchestrator cannot reach the signer's code" quietly
 * stops being true.
 *
 * **The request body is `{ goalId, seq }` and nothing else.** Not "we happen not
 * to send more" — `authorize()` constructs the object literally, and a test
 * asserts the serialised body has exactly those two keys. The signer rejects
 * extras anyway; both halves exist because either alone is one refactor away
 * from being wrong.
 *
 * ## Every signer route lives here, and that is the point
 *
 * `/sweeps` used to be called from `sweep.ts` with a hand-rolled `fetch` and a
 * bare `signerUrl`. It worked for exactly as long as the signer ran open on
 * loopback. The moment the signer moved into a ROFL enclave — where
 * `SERVICE_TOKEN` is mandatory — that call started returning 401, and the
 * console surfaced the signer's own word "unauthorized" *after* it had already
 * closed the goal through MetaMask: gas spent, goal irreversibly closed, USDC
 * stranded in the payer.
 *
 * The mint had the same bug and was fixed by routing it through this class. The
 * sweep was not, because it reached the signer by URL instead. So the rule is
 * now structural rather than remembered: **a caller that needs the signer takes
 * this client, never a URL.** There is one place the token is read, and adding
 * a fourth route cannot reintroduce the fault.
 */

export interface SignedAuthorization {
  readonly goalId: string;
  readonly seq: string;
  readonly token: `0x${string}`;
  readonly chainId: number;
  readonly authorization: {
    readonly from: `0x${string}`;
    readonly to: `0x${string}`;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: `0x${string}`;
  };
  readonly signature: `0x${string}`;
  readonly termsHash: `0x${string}`;
}

export type AuthorizeOutcome =
  | { readonly kind: "signed"; readonly value: SignedAuthorization }
  /** The decision is committed but not yet finalized on chain. Poll and retry. */
  | { readonly kind: "not-ready"; readonly reason: string }
  /** The policy said no, or the signer refused. Terminal — do not retry smaller. */
  | { readonly kind: "refused"; readonly status: number; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/**
 * A sweep authorization.
 *
 * The same `SignedAuthorization` shape, because that is literally what the
 * signer returns: `seq` is the string `"sweep"` rather than a vault sequence
 * number, and `termsHash` is the zero hash, since a sweep has no vault record
 * to hash. No `not-ready`, because a sweep waits on nothing — the goal is
 * either closed with a balance or it is not.
 */
export type SweepAuthorizationOutcome =
  | { readonly kind: "signed"; readonly value: SignedAuthorization }
  /** Goal still open, no balance, wrong token, or no key. Informative — pass it on. */
  | { readonly kind: "refused"; readonly status: number; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

export class SignerClient {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #token: string | undefined;

  /**
   * `token` is the signer's `SERVICE_TOKEN`, and it is optional because the
   * signer's guard only enforces one when it has one. On a laptop both sides run
   * open and this stays undefined; the moment the signer binds to something
   * other than loopback — a ROFL machine, per docs/ROFL_RUNBOOK.md §8 — it is
   * the only thing between the payer key and the internet.
   *
   * Sending it costs nothing when the signer is open, so there is no mode to get
   * wrong: set it on both sides, or on neither.
   */
  constructor(url: string, fetchImpl: typeof fetch = globalThis.fetch, token?: string | undefined) {
    this.#url = url.replace(/\/$/, "");
    this.#fetch = fetchImpl;
    this.#token = token === undefined || token === "" ? undefined : token;
  }

  /** Bearer added only when configured, so an open signer sees the same request as before. */
  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      ...(this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` }),
    };
  }

  /**
   * Mints the per-goal ephemeral payer key. Returns an address; the key never
   * leaves the signer. **Must happen before `openGoal`**, because the payer
   * address is a field of the goal record (ARCHITECTURE.md §5.3).
   */
  async mintPayer(): Promise<`0x${string}`> {
    const response = await this.#fetch(`${this.#url}/payer`, {
      method: "POST",
      headers: this.#headers(),
    });
    if (!response.ok) {
      throw new Error(`signer POST /payer failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { address?: string };
    if (typeof body.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      throw new Error(`signer returned no usable address: ${JSON.stringify(body)}`);
    }
    return body.address as `0x${string}`;
  }

  async authorize(goalId: bigint, seq: bigint): Promise<AuthorizeOutcome> {
    // The whole request. Two fields, both pointers.
    const body = JSON.stringify({ goalId: goalId.toString(), seq: seq.toString() });

    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/authorizations`, {
        method: "POST",
        headers: this.#headers({ "content-type": "application/json" }),
        body,
      });
    } catch (e) {
      return { kind: "unreachable", reason: e instanceof Error ? e.message : String(e) };
    }

    if (response.ok) {
      return { kind: "signed", value: (await response.json()) as SignedAuthorization };
    }

    const error = await response
      .json()
      .then((b) => (b as { error?: string }).error ?? JSON.stringify(b))
      .catch(() => response.statusText);

    // 425 Too Early means the decision exists but has not been finalized on
    // chain yet. Distinct from a refusal, and treating it as one would abandon
    // a spend the budget has already been debited for.
    if (response.status === 425) return { kind: "not-ready", reason: error };

    return { kind: "refused", status: response.status, reason: error };
  }

  /**
   * Asks the signer to authorize returning a payer's whole balance to the goal
   * owner. The body is `{ goalId }` and nothing else — same discipline as
   * `authorize`, and for the same reason: the signer reads the amount, the
   * payee and the token off the chain, so there is no field here to widen.
   *
   * The signer's refusals are the useful ones ("goal is still open", "payer
   * holds no USDC"), so the status and the message are carried through rather
   * than flattened into a generic failure.
   */
  async sweep(goalId: string): Promise<SweepAuthorizationOutcome> {
    const body = JSON.stringify({ goalId });

    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/sweeps`, {
        method: "POST",
        headers: this.#headers({ "content-type": "application/json" }),
        body,
      });
    } catch (e) {
      return { kind: "unreachable", reason: e instanceof Error ? e.message : String(e) };
    }

    if (response.ok) {
      return { kind: "signed", value: (await response.json()) as SignedAuthorization };
    }

    const error = await response
      .json()
      .then((b) => (b as { error?: string }).error ?? JSON.stringify(b))
      .catch(() => response.statusText);

    return { kind: "refused", status: response.status, reason: error };
  }
}
