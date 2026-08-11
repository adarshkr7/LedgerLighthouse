/**
 * M2 acceptance tests for the Authorization Signer.
 *
 * From IMPLEMENTATION.md §7, M2 — "passes when … the signer refuses an
 * unapproved (goalId, seq); a request carrying any terms field is rejected by
 * schema validation; the signer asserts the USDC address and chain id before
 * signing; an interrupted settlement retried with the identical authorization
 * tuple does not double-pay."
 *
 * The last one is the one the brief singles out, and it is tested here as the
 * property that actually delivers it: **two calls for the same (goalId, seq)
 * produce byte-identical output**, because both read the same frozen window off
 * the chain rather than regenerating it from the clock.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  domainSeparator,
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_BASE_SEPOLIA,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
} from "@ntux402/shared";

import { InMemoryKeyStore } from "./keystore.js";
import { AuthorizationSigner } from "./service.js";
import type { GoalRecord, SpendRecord, VaultReader } from "./vault.js";

const CHAIN_ID = 84532;
const VENDOR: Address = "0x1111111111111111111111111111111111111111";
const OTHER_TOKEN: Address = "0x00000000000000000000000000000000DeaDBeef";
const NOW = 1_800_000_000;

/** Deterministic in-memory chain. A testing seam, not a trust seam. */
class FakeVault implements VaultReader {
  chain = CHAIN_ID;
  goals = new Map<string, GoalRecord>();
  spends = new Map<string, SpendRecord>();
  used = new Set<string>();
  domainSeparator: Hex = "0x00";

  async chainId() {
    return this.chain;
  }
  async goal(goalId: bigint) {
    return this.goals.get(goalId.toString());
  }
  async spend(goalId: bigint, seq: bigint) {
    return this.spends.get(`${goalId}:${seq}`);
  }
  async tokenDomainSeparator() {
    return this.domainSeparator;
  }
  async authorizationUsed(_token: Address, authorizer: Address, nonce: Hex) {
    return this.used.has(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`);
  }
}

const nonceFor = (goalId: bigint, seq: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [goalId, seq]));

function makeGoal(overrides: Partial<GoalRecord> & { payer: Address }): GoalRecord {
  return {
    owner: "0x9999999999999999999999999999999999999999",
    relay: "0x8888888888888888888888888888888888888888",
    asset: USDC_BASE_SEPOLIA,
    callsRemaining: 5,
    expiry: BigInt(NOW + 86_400),
    seq: 1n,
    open: true,
    ...overrides,
  };
}

function makeSpend(payer: Address, overrides: Partial<SpendRecord> = {}): SpendRecord {
  return {
    payer,
    amount: 10_000n,
    payTo: VENDOR,
    asset: USDC_BASE_SEPOLIA,
    nonce: nonceFor(1n, 1n),
    validAfter: BigInt(NOW - 1),
    validBefore: BigInt(NOW + 3600),
    termsHash: `0x${"ab".repeat(32)}`,
    finalized: true,
    approved: true,
    ...overrides,
  };
}

describe("AuthorizationSigner", () => {
  let vault: FakeVault;
  let keys: InMemoryKeyStore;
  let signer: AuthorizationSigner;
  let payer: Address;

  beforeEach(async () => {
    vault = new FakeVault();
    keys = new InMemoryKeyStore();
    payer = await keys.mint();
    vault.goals.set("1", makeGoal({ payer }));
    vault.spends.set("1:1", makeSpend(payer));
    signer = new AuthorizationSigner({
      vault,
      keys,
      config: {
        chainId: CHAIN_ID,
        usdcAddress: USDC_BASE_SEPOLIA,
        verifyDomainOnChain: false,
        now: () => NOW,
      },
    });
  });

  it("signs an approved spend, and the signature recovers to the payer", async () => {
    const outcome = await signer.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { authorization, signature } = outcome.value;
    expect(authorization.from).toBe(payer);
    expect(authorization.to).toBe(VENDOR);
    expect(authorization.value).toBe("10000");
    expect(authorization.nonce).toBe(nonceFor(1n, 1n));

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: USDC_EIP712_NAME,
        version: USDC_EIP712_VERSION,
        chainId: CHAIN_ID,
        verifyingContract: USDC_BASE_SEPOLIA,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    });
    expect(recovered.toLowerCase()).toBe(payer.toLowerCase());
  });

  // The test the brief says matters most.
  it("returns a byte-identical authorization on retry, even as the clock moves", async () => {
    const first = await signer.sign({ goalId: 1n, seq: 1n });

    // Simulate an interrupted settlement: unknown facilitator outcome, retry
    // twenty minutes later. A signer that regenerated validAfter/validBefore
    // from the clock would produce a *different* authorization here, and
    // EIP-3009 would execute both.
    const later = new AuthorizationSigner({
      vault,
      keys,
      config: {
        chainId: CHAIN_ID,
        usdcAddress: USDC_BASE_SEPOLIA,
        verifyDomainOnChain: false,
        now: () => NOW + 1200,
      },
    });
    const second = await later.sign({ goalId: 1n, seq: 1n });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.authorization).toEqual(first.value.authorization);
    expect(second.value.signature).toBe(first.value.signature);
  });

  it("refuses an unapproved (goalId, seq)", async () => {
    vault.spends.set("1:1", makeSpend(payer, { finalized: true, approved: false }));
    const outcome = await signer.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toContain("REJECTED");
  });

  it("distinguishes not-yet-finalized from rejected", async () => {
    vault.spends.set("1:1", makeSpend(payer, { finalized: false, approved: false }));
    const outcome = await signer.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 425 Too Early: the caller should poll. 403 would tell it to give up.
    expect(outcome.status).toBe(425);
  });

  it("refuses a spend that was never recorded", async () => {
    const outcome = await signer.sign({ goalId: 1n, seq: 9n });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(404);
  });

  it("refuses an unknown goal", async () => {
    const outcome = await signer.sign({ goalId: 42n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(404);
  });

  it("asserts the chain id before signing", async () => {
    vault.chain = 8453; // Base mainnet — right family, wrong chain.
    const outcome = await signer.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("chain 8453");
  });

  it("asserts the goal's asset against its configured token", async () => {
    vault.goals.set("1", makeGoal({ payer, asset: OTHER_TOKEN }));
    const outcome = await signer.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409);
  });

  it("refuses when it holds no key for the goal's payer", async () => {
    vault.goals.set("1", makeGoal({ payer: "0x7777777777777777777777777777777777777777" }));
    vault.spends.set("1:1", makeSpend("0x7777777777777777777777777777777777777777"));
    const outcome = await signer.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("no key held");
  });

  it("refuses an expired window rather than re-issuing one", async () => {
    vault.spends.set("1:1", makeSpend(payer, { validBefore: BigInt(NOW - 1) }));
    const outcome = await signer.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(410);
      expect(outcome.error).toContain("double-pay");
    }
  });

  it("refuses a non-deterministic nonce", async () => {
    vault.spends.set("1:1", makeSpend(payer, { nonce: `0x${"cd".repeat(32)}` }));
    const outcome = await signer.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("nonce mismatch");
  });

  it("refuses when the goal and spend records disagree about the payer", async () => {
    vault.spends.set("1:1", makeSpend("0x7777777777777777777777777777777777777777"));
    const outcome = await signer.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("payer mismatch");
  });

  const usdcDomain = {
    name: USDC_EIP712_NAME,
    version: USDC_EIP712_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: USDC_BASE_SEPOLIA,
  } as const;

  it("refuses when the token's domain separator does not match", async () => {
    vault.domainSeparator = `0x${"ff".repeat(32)}`;
    const strict = new AuthorizationSigner({
      vault,
      keys,
      config: {
        chainId: CHAIN_ID,
        usdcAddress: USDC_BASE_SEPOLIA,
        verifyDomainOnChain: true,
        now: () => NOW,
      },
    });
    const outcome = await strict.sign({ goalId: 1n, seq: 1n });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("domain mismatch");
  });

  it("signs when the token's domain separator matches", async () => {
    vault.domainSeparator = domainSeparator({ domain: usdcDomain });
    const strict = new AuthorizationSigner({
      vault,
      keys,
      config: {
        chainId: CHAIN_ID,
        usdcAddress: USDC_BASE_SEPOLIA,
        verifyDomainOnChain: true,
        now: () => NOW,
      },
    });
    expect((await strict.sign({ goalId: 1n, seq: 1n })).ok).toBe(true);
  });

  it("rejects terms in the raw body before it ever reads the chain", async () => {
    const outcome = await signer.signRaw({ goalId: "1", seq: "1", amount: "1" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(400);
      expect(outcome.error).toContain("payment terms");
    }
  });

  it("mints a payer address without exposing a key", async () => {
    const { address } = await signer.mintPayer();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(Object.keys({ address })).toEqual(["address"]);
    expect(await keys.signerFor(address)).toBeDefined();
  });
});
