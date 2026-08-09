/**
 * The Authorization Signer. **[ASSUMPTION]** — a trusted component that exists
 * because Inco provides neither key custody nor signing (plan §7.7).
 *
 * It is deliberately, aggressively dumb. One question — "is `(goalId, seq)`
 * finalized-approved on chain?" — and if the answer is yes it signs exactly what
 * the chain froze. It has no policy of its own, no notion of price, and no way
 * to be told one. Compromising it permits re-signing spends that were *already*
 * approved; it does not permit inventing new ones. That bound is the reason it
 * is an acceptable assumption, and it only holds while the checks below do.
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
import { parseSignRequest, type SignRequest } from "./schema.js";
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

  /** Mints a per-goal ephemeral payer key and returns **only** its address. */
  mintPayer(): { address: Address } {
    return { address: this.#keys.mint() };
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
    // in brief §8 this check exists to make impossible.
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
      // the anti-pattern in brief §8, and there is nothing here to negotiate
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
    // (plan §7.6). Expiry is therefore a refusal, not a re-issue.
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
    const account = this.#keys.signerFor(goal.payer);
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
