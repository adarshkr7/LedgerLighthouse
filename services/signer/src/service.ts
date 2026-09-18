/**
 * The Authorization Signer. **[ASSUMPTION]** — a trusted component that exists
 * because Inco provides neither key custody nor signing (ARCHITECTURE.md).
 *
 * It is deliberately, aggressively dumb. One question — "is `(goalId, seq)`
 * finalized-approved on chain?" — and if the answer is yes it signs exactly what
 * the chain froze. It has no policy of its own, no notion of price, and no way
 * to be told one.
 *
 * ## What compromising it would permit
 *
 * For `sign()`: re-signing spends that were *already* approved, and nothing
 * else. It cannot invent one.
 *
 * For `sweep()`: producing a transfer of a payer's whole balance **to that
 * goal's owner**, for goals that are already closed. This is a real widening
 * and is stated rather than buried — a sweep is the one authorization here the
 * confidential policy never approved. Three things bound it, and they are the
 * reason it is acceptable:
 *
 *   - the destination is `goal.owner` read from the vault, so the worst
 *     outcome is that someone returns a user's money to that user early;
 *   - it requires `goal.open == false`, and only the owner can close a goal,
 *     so an attacker holding the signer cannot reach an open goal at all;
 *   - the amount is the payer's balance, not a caller's number.
 *
 * Both bounds only hold while the checks below do, and the first of them also
 * depends on something outside this file: that `goal.owner` for a given payer
 * is the party who funded it. That is a property of `PolicyVault.openGoal`,
 * which binds a payer to one goal permanently and refuses a second. Without
 * that binding "the destination is the owner" reads as a bound and is not one —
 * an attacker opens a goal of their own naming somebody else's payer, closes
 * it, and is the owner. `payerGoal` is what makes the sentence above true.
 *
 * Read `refuse()` as the specification. Every branch is a way the signature must
 * not happen.
 */

import {
  domainSeparator,
  isAddressEqual,
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
} from "viem";
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
  type TransferAuthorization,
} from "@ntux402/shared";

import type { KeyStore } from "./keystore.js";
import { parseSignRequest, parseSweepRequest, type SignRequest } from "./schema.js";
import type { VaultReader } from "./vault.js";

export interface SignerConfig {
  /** Asserted against the RPC before every signature. Never inferred. */
  readonly chainId: number;
  /** Asserted against the goal record's `asset`. A 402 never gets a say. */
  readonly usdcAddress: Address;
  readonly eip712Name?: string;
  readonly eip712Version?: string;
  /**
   * Verify the EIP-712 domain against the token's own `DOMAIN_SEPARATOR()`
   * before signing. On by default; a fake chain in tests may switch it off.
   */
  readonly verifyDomainOnChain?: boolean;
  /** Injected so validity-window checks are testable. */
  readonly now?: () => number;
}

export interface SignedAuthorization {
  readonly goalId: string;
  readonly seq: string;
  readonly token: Address;
  readonly chainId: number;
  readonly authorization: {
    readonly from: Address;
    readonly to: Address;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: Hex;
  };
  readonly signature: Hex;
  /** The vault's own terms hash for this spend. Lets the caller cross-check. */
  readonly termsHash: Hex;
}

export type SignOutcome =
  | { readonly ok: true; readonly value: SignedAuthorization }
  | { readonly ok: false; readonly status: number; readonly error: string };

function refuse(status: number, error: string): SignOutcome {
  return { ok: false, status, error };
}

export class AuthorizationSigner {
  readonly #vault: VaultReader;
  readonly #keys: KeyStore;
  readonly #config: Required<Omit<SignerConfig, "now">> & { now: () => number };

  constructor(options: { vault: VaultReader; keys: KeyStore; config: SignerConfig }) {
    this.#vault = options.vault;
    this.#keys = options.keys;
    this.#config = {
      chainId: options.config.chainId,
      usdcAddress: options.config.usdcAddress,
      eip712Name: options.config.eip712Name ?? USDC_EIP712_NAME,
      eip712Version: options.config.eip712Version ?? USDC_EIP712_VERSION,
      verifyDomainOnChain: options.config.verifyDomainOnChain ?? true,
      now: options.config.now ?? (() => Math.floor(Date.now() / 1000)),
    };
  }

  /**
   * Signs an authorization returning the payer's whole USDC balance to the
   * goal owner.
   *
   * ## How this keeps the signer's one invariant
   *
   * The security argument for this service is that no route accepts an amount,
   * a payee or a token — so no caller can direct a payment. A sweep is a
   * payment, so it has to earn its place under the same rule, and it does:
   * the caller supplies `goalId` and nothing else.
   *
   *   - the **payee** is `goal.owner`, read from the vault;
   *   - the **amount** is the payer's entire balance, read from the token;
   *   - the **token** is the one this signer is configured for, asserted
   *     against `goal.asset` exactly as `sign()` does.
   *
   * A caller who wants to move a different amount somewhere else has no way to
   * express it, which is the property that matters.
   *
   * ## Why the goal must be closed
   *
   * A sweep and a spend both draw on the same balance. Sweeping an open goal
   * could empty the payer between `finalizeDecision` and settlement, turning an
   * approved spend into a failed transfer — the policy would have said yes and
   * the money would be gone. `closeGoal` is the owner's own signature and the
   * point after which no new spend can be requested, so it is the correct
   * precondition.
   *
   * ## Replay safety comes from the nonce, not from byte-identity
   *
   * `sign()` reproduces a byte-identical authorization on retry because it
   * reads a validity window the vault froze. A sweep has no vault record and so
   * no frozen window; the one here is derived from the local clock, which means
   * two sweeps signed a minute apart are *different* authorizations with
   * different signatures.
   *
   * That is safe, but for a narrower reason than byte-identity, and the
   * distinction matters enough to state: the **nonce** is clock-independent,
   * derived from `(goalId, "SWEEP", amount)`. EIP-3009 marks a nonce used at
   * settlement, so however many sweep authorizations get signed for the same
   * balance, at most one can ever execute. A retry after a dropped response is
   * therefore safe without being identical.
   *
   * The tuple shape differs from the vault's `(uint256, uint64)` spend nonce,
   * so a sweep nonce cannot collide with a spend nonce for the same goal.
   */
  async sweep(goalIdRaw: unknown): Promise<SignOutcome> {
    const parsed = parseSweepRequest(goalIdRaw);
    if (!parsed.ok) return refuse(400, parsed.error);
    const { goalId } = parsed.value;

    const chainId = await this.#vault.chainId();
    if (chainId !== this.#config.chainId) {
      return refuse(503, `refused: RPC reports chain ${chainId}, expected ${this.#config.chainId}.`);
    }

    const goal = await this.#vault.goal(goalId);
    if (!goal) return refuse(404, `refused: goal ${goalId} does not exist.`);

    if (!isAddressEqual(goal.asset, this.#config.usdcAddress)) {
      return refuse(
        409,
        `refused: goal ${goalId} is denominated in ${goal.asset}, but this signer only signs ` +
          `for ${this.#config.usdcAddress}.`,
      );
    }

    if (goal.open) {
      return refuse(
        409,
        `refused: goal ${goalId} is still open. Close it first — sweeping a goal that can still ` +
          `spend could empty the payer underneath an already-approved authorization.`,
      );
    }

    const account = await this.#keys.signerFor(goal.payer);
    if (!account) {
      return refuse(404, `refused: no key held for payer ${goal.payer}.`);
    }

    const amount = await this.#vault.tokenBalance(this.#config.usdcAddress, goal.payer);
    if (amount === 0n) {
      return refuse(409, `refused: payer ${goal.payer} holds no ${this.#config.usdcAddress}.`);
    }

    const now = BigInt(this.#config.now());
    const nonce = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "string" }, { type: "uint256" }],
        [goalId, "SWEEP", amount],
      ),
    );

    const domain = {
      name: this.#config.eip712Name,
      version: this.#config.eip712Version,
      chainId: this.#config.chainId,
      verifyingContract: this.#config.usdcAddress,
    } as const;

    if (this.#config.verifyDomainOnChain) {
      const onChain = await this.#vault.tokenDomainSeparator(this.#config.usdcAddress);
      const local = domainSeparator({ domain });
      if (onChain.toLowerCase() !== local.toLowerCase()) {
        return refuse(500, `refused: EIP-712 domain mismatch. Token reports ${onChain}.`);
      }
    }

    const message: TransferAuthorization = {
      from: goal.payer,
      to: goal.owner,
      value: amount,
      validAfter: now - 1n,
      validBefore: now + 3600n,
      nonce,
    };

    const signature = await account.signTypedData({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });

    return {
      ok: true,
      value: {
        goalId: goalId.toString(),
        // Not a vault seq: a sweep has no spend record. Reported as such rather
        // than borrowing a number that would look like one.
        seq: "sweep",
        token: this.#config.usdcAddress,
        chainId: this.#config.chainId,
        authorization: {
          from: message.from,
          to: message.to,
          value: message.value.toString(),
          validAfter: message.validAfter.toString(),
          validBefore: message.validBefore.toString(),
          nonce: message.nonce,
        },
        signature,
        // No vault terms hash exists for a sweep; the zero hash says so.
        termsHash: `0x${"00".repeat(32)}`,
      },
    };
  }

  /** Mints a per-goal ephemeral payer key and returns **only** its address. */
  async mintPayer(): Promise<{ address: Address }> {
    return { address: await this.#keys.mint() };
  }

  /** Entry point for untyped input — the HTTP body. Schema first, always. */
  async signRaw(body: unknown): Promise<SignOutcome> {
    const parsed = parseSignRequest(body);
    if (!parsed.ok) return refuse(400, parsed.error);
    return this.sign(parsed.value);
  }

  async sign(request: SignRequest): Promise<SignOutcome> {
    const { goalId, seq } = request;

    // --- the chain is what it claims to be ---------------------------------
    // MetaMask can cache a stale chainId and a misconfigured RPC can point
    // anywhere. Re-read it per signature rather than trusting startup state.
    const chainId = await this.#vault.chainId();
    if (chainId !== this.#config.chainId) {
      return refuse(
        503,
        `refused: RPC reports chain ${chainId}, expected ${this.#config.chainId}.`,
      );
    }

    // --- the goal ----------------------------------------------------------
    const goal = await this.#vault.goal(goalId);
    if (!goal) return refuse(404, `refused: goal ${goalId} does not exist.`);

    // The signer is bound to one token, configured out of band. Reading the
    // asset from anywhere else — above all from a 402 body — is the guardrail
    // in ARCHITECTURE.md this check exists to make impossible.
    if (!isAddressEqual(goal.asset, this.#config.usdcAddress)) {
      return refuse(
        409,
        `refused: goal ${goalId} is denominated in ${goal.asset}, but this signer only signs ` +
          `for ${this.#config.usdcAddress}.`,
      );
    }

    // --- the spend record ---------------------------------------------------
    const spend = await this.#vault.spend(goalId, seq);
    if (!spend) return refuse(404, `refused: no spend recorded at (${goalId}, ${seq}).`);

    if (!spend.finalized) {
      // The decision is committed but not yet retrieved. Not an error — the
      // caller polls. Distinguished from a rejection so the orchestrator can
      // tell "wait" from "never".
      return refuse(
        425,
        `refused: (${goalId}, ${seq}) is not finalized yet. The decision was committed at ` +
          `requestSpend and resolves asynchronously; retry after finalizeDecision lands.`,
      );
    }

    if (!spend.approved) {
      // The bounce. Deliberately terminal: retrying with a smaller amount is
      // the anti-pattern in ARCHITECTURE.md, and there is nothing here to negotiate
      // with — the decision came from Inco, not from this service.
      return refuse(
        403,
        `refused: (${goalId}, ${seq}) was finalized as REJECTED by the confidential policy. ` +
          `There is no approved record to sign against.`,
      );
    }

    // --- consistency between the two records --------------------------------
    // `authorization()` reads the payer off the goal, so these agree by
    // construction today. Asserted anyway: if the vault ever grows a second
    // write path to either field, this is the check that catches it before a
    // signature does.
    if (!isAddressEqual(spend.payer, goal.payer)) {
      return refuse(
        500,
        `refused: payer mismatch — goal record says ${goal.payer}, spend record says ${spend.payer}.`,
      );
    }

    // The nonce is deterministic so an interrupted settlement can be retried
    // byte-for-byte. Recomputed locally and compared, so a vault returning
    // something else cannot slip a fresh authorization past the retry path.
    const expectedNonce = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint64" }],
        [goalId, seq],
      ),
    );
    if (spend.nonce.toLowerCase() !== expectedNonce.toLowerCase()) {
      return refuse(
        500,
        `refused: nonce mismatch — chain says ${spend.nonce}, keccak256(abi.encode(goalId, seq)) ` +
          `is ${expectedNonce}. A non-deterministic nonce breaks safe retry.`,
      );
    }

    // --- the validity window -------------------------------------------------
    // Read back, never regenerated. Regenerating it would produce a *different*
    // authorization on retry, and EIP-3009 would happily execute both
    // (ARCHITECTURE.md). Expiry is therefore a refusal, not a re-issue.
    const now = BigInt(this.#config.now());
    if (spend.validBefore <= now) {
      return refuse(
        410,
        `refused: the frozen authorization for (${goalId}, ${seq}) expired at ${spend.validBefore} ` +
          `(now ${now}). A fresh window would be a different authorization and could double-pay; ` +
          `request a new spend instead.`,
      );
    }

    // --- the key -------------------------------------------------------------
    const account = await this.#keys.signerFor(goal.payer);
    if (!account) {
      return refuse(
        404,
        `refused: no key held for payer ${goal.payer}. The payer address is fixed at openGoal ` +
          `and cannot be changed.`,
      );
    }

    // --- the EIP-712 domain --------------------------------------------------
    const domain = {
      name: this.#config.eip712Name,
      version: this.#config.eip712Version,
      chainId: this.#config.chainId,
      verifyingContract: this.#config.usdcAddress,
    } as const;

    if (this.#config.verifyDomainOnChain) {
      const onChain = await this.#vault.tokenDomainSeparator(this.#config.usdcAddress);
      const local = domainSeparator({ domain });
      if (onChain.toLowerCase() !== local.toLowerCase()) {
        return refuse(
          500,
          `refused: EIP-712 domain mismatch. Token reports ${onChain}, we computed ${local}. ` +
            `A signature under the wrong domain is unusable; do not guess at name/version.`,
        );
      }
    }

    // --- sign ----------------------------------------------------------------
    // Every field below comes from the chain. None came from the caller, which
    // supplied only the pointer `(goalId, seq)`.
    const message: TransferAuthorization = {
      from: goal.payer,
      to: spend.payTo,
      value: spend.amount,
      validAfter: spend.validAfter,
      validBefore: spend.validBefore,
      nonce: spend.nonce,
    };

    const signature = await account.signTypedData({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });

    return {
      ok: true,
      value: {
        goalId: goalId.toString(),
        seq: seq.toString(),
        token: this.#config.usdcAddress,
        chainId: this.#config.chainId,
        authorization: {
          from: message.from,
          to: message.to,
          value: message.value.toString(),
          validAfter: message.validAfter.toString(),
          validBefore: message.validBefore.toString(),
          nonce: message.nonce,
        },
        signature,
        termsHash: spend.termsHash,
      },
    };
  }
}
