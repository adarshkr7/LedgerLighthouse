/**
 * The lease lifecycle: what a paid block actually hands over, and how it ends.
 *
 * Phase 2 of `docs/GPU_RENTAL_PLAN.md`, and the place §5.1 through §5.3 get
 * built. A prepaid job's 200 is the product and the transaction is over when it
 * lands. A lease's 200 is a *capability* that stays valuable afterwards, and
 * everything below exists because of that one difference.
 *
 * ## Three things that follow from the response being a capability
 *
 * **It expires on its own.** Nothing here waits for the buyer to call an
 * endpoint. A buyer who simply stops calling keeps a machine forever, and a
 * rental that depends on the renter to end it is not a rental.
 *
 * **The credential is scoped to the lease and never written down.** The store
 * persists a SHA-256 of it and the provider's own handle, and that is enough
 * for everything the store needs to do: prove later which credential was issued
 * for which payment, and terminate the machine. Revocation goes through the
 * provider handle, so the secret itself has no reason to survive the response
 * it was returned in.
 *
 * **Reclamation does not rest on this process.** `reclaimExpired` is the prompt
 * path and it runs on a timer, but a process that is dead cannot reclaim
 * anything, and a lease store that cannot be read has forgotten what to
 * reclaim. So `provisionLease` also hands the provider a hard expiry and
 * expects a provider-side kill: the backstop is on the other side of the wire,
 * where our crash cannot reach it. Plan §5.1 asks for reclamation as reliable
 * as settlement, and one timer in one process is not that.
 *
 * ## Keyed on the spend nonce
 *
 * §5.2. `X402Client` retries 5xx with backoff and `PaymentLoop` retries a
 * settlement whose outcome was unknown, so a duplicate request is ordinary. For
 * a job a duplicate wastes a block; for a lease it provisions a second machine.
 *
 * The vault derives its spend nonce as `keccak256(abi.encode(goalId, seq))`,
 * deterministic by construction so an interrupted settlement can be retried
 * byte for byte. That makes it the right key: a request carrying an
 * authorization whose nonce already has a lease gets that lease back and
 * provisions nothing. Phase 1 relied on the facilitator declining a consumed
 * nonce, which is a check and not a lock. This is the lock.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { GpuBlockMinutes, GpuSkuName, GpuWorkloadName } from "@ntux402/shared";

/**
 * How long before expiry a buyer should start renewing, in seconds.
 *
 * Plan §5.5 sets this and explains it: `requestSpend` reverts while a spend is
 * pending on the same goal, so a renewal has to complete a whole decision cycle
 * before the block ends. Across the twelve traces in the orchestrator's store
 * that cycle ran 6.6s to 13.8s, and the safe lead time is the observed maximum
 * plus provisioning plus margin.
 *
 * Ninety seconds until it is measured against a real provider. It is served to
 * the buyer as `renewBy` so the deadline is the vendor's to state and not the
 * buyer's to guess, and so that tightening it later is a server-side change.
 */
export const RENEW_LEAD_SECONDS = 90;

/** What the store keeps. Note what is absent: the credential itself. */
export interface LeaseRecord {
  readonly id: string;
  /** The EIP-3009 authorization nonce that paid for the current block. */
  readonly nonce: string;
  /** Every nonce that has paid into this lease, oldest first. */
  readonly nonces: readonly string[];
  readonly sku: GpuSkuName;
  readonly workload: GpuWorkloadName;
  /** The provider's own identifier, and the only thing revocation needs. */
  readonly providerHandle: string;
  /** Where the buyer reaches the machine. Origin only; see `redactable`. */
  readonly endpoint: string;
  /**
   * SHA-256 of the credential most recently issued, hex, `0x`-prefixed.
   *
   * The whole point of storing this and not the credential: it proves later
   * which credential belonged to which payment, which is the only thing the
   * trace was ever evidencing, and it is useless to anyone who steals the file.
   */
  readonly credentialSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Blocks bought so far. One at provision, one more per renewal. */
  readonly blocks: number;
  /** Set once the machine has been given back. */
  readonly terminatedAt?: number;
}

/** A lease plus the secret, which exists only in the response that carries it. */
export interface IssuedLease {
  readonly record: LeaseRecord;
  readonly credential: string;
  /**
   * True when the credential is new because the old one could not be produced
   * again — a retry after a restart, since credentials are never persisted.
   * The buyer needs to know the one it may already hold has stopped working.
   */
  readonly rotated: boolean;
}

/** What the store needs from a provider to end a lease. Narrow on purpose. */
export interface LeaseTerminator {
  terminateLease(providerHandle: string): Promise<{ ok: boolean; error?: string }>;
}

function sha256Hex(value: string): string {
  return `0x${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Mints a credential for one lease.
 *
 * 32 bytes from the CSPRNG, prefixed with the lease id so an operator reading a
 * provider-side access log can tell which rental a call belongs to without
 * holding the secret. The prefix is not a secret and carries no entropy claim;
 * the 32 bytes after it are the whole strength.
 */
export function mintCredential(leaseId: string): string {
  return `${leaseId}.${randomBytes(32).toString("base64url")}`;
}

/** The lease id for a spend nonce. Deterministic, so a retry lands on it. */
export function leaseIdFor(nonce: string): string {
  return `lease-${nonce.replace(/^0x/, "").slice(0, 24)}`;
}

interface StoreOptions {
  /** Where to persist. Omitted keeps the store in memory — tests, mostly. */
  readonly path?: string | undefined;
  readonly now?: () => number;
  /** Called when a reclaim cannot reach the provider, so it can be logged. */
  readonly onReclaimFailed?: (record: LeaseRecord, error: string) => void;
  /** Called when the persisted store could not be read at all. */
  readonly onStoreUnreadable?: (detail: string) => void;
}

/**
 * The leases this vendor has sold, keyed on the nonce that paid for them.
 *
 * ## What an unreadable store means here
 *
 * `SpendLedger` answers a corrupt file by starting a fresh window, because a
 * ledger that cannot be read is a reason to be careful and not a reason to stop
 * selling. The same answer would be wrong here and it is worth saying why: a
 * forgotten lease is a machine nobody will reclaim, so silence would convert a
 * read error into an open-ended bill.
 *
 * So it starts empty, and it says so through `onStoreUnreadable` — loudly,
 * because what the operator has to do is reconcile against the provider by
 * hand. The thing that keeps this from being a catastrophe is that reclamation
 * was never only ours: every machine carries a provider-side hard expiry, set
 * when it was provisioned.
 */
export class LeaseStore {
  readonly #byNonce = new Map<string, string>();
  readonly #byId = new Map<string, LeaseRecord>();
  /** Credentials live here and nowhere else. Lost on restart, by design. */
  readonly #credentials = new Map<string, string>();
  readonly #path: string | undefined;
  readonly #now: () => number;
  readonly #onReclaimFailed: StoreOptions["onReclaimFailed"];
  readonly #onStoreUnreadable: StoreOptions["onStoreUnreadable"];

  constructor(options: StoreOptions = {}) {
    this.#path = options.path;
    this.#now = options.now ?? Date.now;
    this.#onReclaimFailed = options.onReclaimFailed;
    this.#onStoreUnreadable = options.onStoreUnreadable;
    this.#load();
  }

  #load(): void {
    if (this.#path === undefined || !existsSync(this.#path)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      const leases = (raw as { leases?: unknown })?.leases;
      if (!Array.isArray(leases)) {
        this.#onStoreUnreadable?.("no lease array in the store file");
        return;
      }
      for (const entry of leases as LeaseRecord[]) {
        if (typeof entry?.id !== "string" || typeof entry?.nonce !== "string") continue;
        this.#byId.set(entry.id, entry);
        for (const nonce of entry.nonces ?? [entry.nonce]) this.#byNonce.set(nonce, entry.id);
      }
    } catch (e) {
      this.#onStoreUnreadable?.(e instanceof Error ? e.message : String(e));
    }
  }

  #save(): void {
    if (this.#path === undefined) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, JSON.stringify({ leases: [...this.#byId.values()] }));
    } catch {
      /* a store we cannot write is not a reason to fail a lease already paid for */
    }
  }

  get(id: string): LeaseRecord | undefined {
    return this.#byId.get(id);
  }

  /** The lease this nonce already paid for, if it has one. The §5.2 lookup. */
  findByNonce(nonce: string): LeaseRecord | undefined {
    const id = this.#byNonce.get(nonce);
    return id === undefined ? undefined : this.#byId.get(id);
  }

  /** Live leases, for the health route and the reclaimer. */
  active(): readonly LeaseRecord[] {
    const now = this.#now();
    return [...this.#byId.values()].filter(
      (l) => l.terminatedAt === undefined && l.expiresAt > now,
    );
  }

  /** Records a freshly provisioned machine and issues its first credential. */
  open(params: {
    nonce: string;
    sku: GpuSkuName;
    workload: GpuWorkloadName;
    providerHandle: string;
    endpoint: string;
    minutes: GpuBlockMinutes;
  }): IssuedLease {
    const id = leaseIdFor(params.nonce);
    const issuedAt = this.#now();
    const credential = mintCredential(id);

    const record: LeaseRecord = {
      id,
      nonce: params.nonce,
      nonces: [params.nonce],
      sku: params.sku,
      workload: params.workload,
      providerHandle: params.providerHandle,
      endpoint: params.endpoint,
      credentialSha256: sha256Hex(credential),
      issuedAt,
      expiresAt: issuedAt + params.minutes * 60_000,
      blocks: 1,
    };

    this.#byId.set(id, record);
    this.#byNonce.set(params.nonce, id);
    this.#credentials.set(id, credential);
    this.#save();

    return { record, credential, rotated: false };
  }

  /**
   * Hands back the credential for a lease that already exists.
   *
   * The §5.2 retry path. Nothing is provisioned and nothing is charged again;
   * the buyer gets back what its first attempt bought.
   *
   * Credentials are not persisted, so after a restart there is nothing to hand
   * back and the alternative to rotating would be a lease the buyer owns and
   * cannot use. A fresh credential goes out, the old hash is replaced, and
   * `rotated` says so — the buyer has to know that whatever it may already hold
   * has stopped working.
   */
  reissue(record: LeaseRecord): IssuedLease {
    const held = this.#credentials.get(record.id);
    if (held !== undefined) return { record, credential: held, rotated: false };

    const credential = mintCredential(record.id);
    const rotated: LeaseRecord = { ...record, credentialSha256: sha256Hex(credential) };
    this.#byId.set(record.id, rotated);
    this.#credentials.set(record.id, credential);
    this.#save();
    return { record: rotated, credential, rotated: true };
  }

  /**
   * Extends a lease by one more block, against the nonce that paid for it.
   *
   * Extension runs from the current expiry and not from now, so a renewal that
   * lands early buys time on the end of the block instead of throwing away
   * whatever is left of it. A renewal that lands late would otherwise be
   * indistinguishable from a new lease, which is why `renew` refuses an expired
   * one and the caller turns that into a 409.
   */
  renew(record: LeaseRecord, nonce: string, minutes: GpuBlockMinutes): IssuedLease {
    const extended: LeaseRecord = {
      ...record,
      nonce,
      nonces: [...record.nonces, nonce],
      expiresAt: record.expiresAt + minutes * 60_000,
      blocks: record.blocks + 1,
    };
    this.#byId.set(record.id, extended);
    this.#byNonce.set(nonce, record.id);
    this.#save();
    return this.reissue(extended);
  }

  /**
   * Ends every lease whose block has run out.
   *
   * Returns what it reclaimed, so the caller can log it. A provider that
   * refuses the termination leaves the record untouched and reports through
   * `onReclaimFailed`: marking it terminated would be recording a machine as
   * given back when it is still running, and the next sweep should try again.
   */
  async reclaimExpired(provider: LeaseTerminator): Promise<readonly LeaseRecord[]> {
    const now = this.#now();
    const due = [...this.#byId.values()].filter(
      (l) => l.terminatedAt === undefined && l.expiresAt <= now,
    );

    const reclaimed: LeaseRecord[] = [];
    for (const record of due) {
      const result = await provider.terminateLease(record.providerHandle);
      if (!result.ok) {
        this.#onReclaimFailed?.(record, result.error ?? "provider declined to terminate");
        continue;
      }
      const ended: LeaseRecord = { ...record, terminatedAt: now };
      this.#byId.set(record.id, ended);
      this.#credentials.delete(record.id);
      reclaimed.push(ended);
    }

    if (reclaimed.length > 0) this.#save();
    return reclaimed;
  }
}

/**
 * The lease as the buyer sees it, credential included.
 *
 * Separate from `LeaseRecord` so the secret appears in exactly one shape, in
 * one place, and anything that records a lease has to go through
 * `redactable()` instead of reaching for the record and hoping.
 */
export interface LeaseResponse {
  readonly id: string;
  readonly sku: GpuSkuName;
  readonly workload: GpuWorkloadName;
  readonly endpoint: string;
  readonly credential: string;
  readonly credentialSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** When to start renewing. Expiry minus the §5.5 lead time. */
  readonly renewBy: number;
  readonly blocks: number;
  readonly rotated: boolean;
}

export function toLeaseResponse(issued: IssuedLease): LeaseResponse {
  const { record } = issued;
  return {
    id: record.id,
    sku: record.sku,
    workload: record.workload,
    endpoint: record.endpoint,
    credential: issued.credential,
    credentialSha256: record.credentialSha256,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    renewBy: record.expiresAt - RENEW_LEAD_SECONDS * 1000,
    blocks: record.blocks,
    rotated: issued.rotated,
  };
}

/**
 * The subset of a lease that is safe to write down.
 *
 * Plan §5.3. Traces are run records meant to be handed to an auditor, and a
 * trace carrying a live credential is a trace nobody can hand to anyone. The
 * hash is enough to prove which credential was issued for which payment, which
 * is the only thing the trace was ever evidencing.
 *
 * This is an allowlist and not a scrub, because the two fail in opposite
 * directions: a scrub that misses a field name leaks, an allowlist that misses
 * a field omits. `services/trace` applies the same rule again on the way in,
 * since the orchestrator between here and there is the component this
 * architecture assumes is compromised.
 */
export function redactable(lease: LeaseResponse): Record<string, unknown> {
  return {
    leaseId: lease.id,
    credentialSha256: lease.credentialSha256,
    expiresAt: lease.expiresAt,
    blocks: lease.blocks,
  };
}
