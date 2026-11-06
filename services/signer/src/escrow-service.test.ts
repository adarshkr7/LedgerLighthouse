/**
 * The escrow signer. The property under test is not that it signs correctly but
 * that it cannot sign anything else: whatever the chain reads say, the result is a
 * `receiveWithAuthorization` to the pinned collector, for a payment naming the pinned
 * operator. The refusals are tested too, but they are a courtesy. That one is the
 * point.
 */

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  domainSeparator,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AUTH_CAPTURE_ESCROW,
  ERC3009_TOKEN_COLLECTOR,
  NETWORKS,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  paymentSalt,
  type PaymentInfo,
} from "@ntux402/shared";
import { escrowNonce, paymentInfoHash } from "@ntux402/shared/viem";

import { EscrowAuthorizationSigner, type EscrowSignerConfig } from "./escrow-service.js";
import { createSignerServer } from "./http.js";
import { InMemoryKeyStore, type KeyStore } from "./keystore.js";
import { openSigner } from "./open-signer.js";
import { OnChainVaultReader, type GoalRecord, type SpendRecord, type VaultReader } from "./vault.js";

const CHAIN_ID = 84532;
const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const OTHER_TOKEN: Address = "0x00000000000000000000000000000000DeaDBeef";
const VAULT: Address = "0x00000000000000000000000000000000000ab0b1";
const VENDOR: Address = "0x0000000000000000000000000000000000007e57";
const THIEF: Address = "0x0000000000000000000000000000000000badbad";
const OWNER: Address = "0x000000000000000000000000000000000000a11c";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const NOW = 1_800_000_000;
const WINDOW = 4102444800;
const DEADLINE = 4102445100;
const AMOUNT = 100_000n;
const DOMAIN = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC } as const;

/**
 * A chain that says whatever the test tells it to. Its answers are what a malicious
 * RPC could say, which is why it is a useful thing to test against.
 */
class FakeChain implements VaultReader {
  chain = CHAIN_ID;
  goals = new Map<string, GoalRecord>();
  spends = new Map<string, SpendRecord>();
  reclaimed = false;
  deadline = DEADLINE;
  balance = 0n;
  domain: Hex = "0x00";
  /** Replaces what `escrowPayment` answers. */
  vaultsOwn?: (derived: PaymentInfo) => PaymentInfo;
  binding: { escrow: Address; collector: Address } | undefined = {
    escrow: AUTH_CAPTURE_ESCROW,
    collector: ERC3009_TOKEN_COLLECTOR,
  };

  async chainId() {
    return this.chain;
  }
  async goal(goalId: bigint) {
    return this.goals.get(goalId.toString());
  }
  async spend(goalId: bigint, seq: bigint) {
    return this.spends.get(`${goalId}:${seq}`);
  }
  async tokenDomainSeparator(): Promise<Hex> {
    return this.domain;
  }
  async tokenBalance() {
    return this.balance;
  }
  async escrowBinding() {
    return this.binding;
  }
  async captureDeadline() {
    return this.deadline;
  }
  async isReclaimed() {
    return this.reclaimed;
  }
  async escrowPayment(goalId: bigint, seq: bigint): Promise<PaymentInfo> {
    const goal = this.goals.get(goalId.toString())!;
    const spend = this.spends.get(`${goalId}:${seq}`)!;
    const derived: PaymentInfo = {
      operator: VAULT,
      payer: goal.payer,
      receiver: spend.payTo,
      token: goal.asset,
      maxAmount: spend.amount,
      preApprovalExpiry: Number(spend.validBefore),
      authorizationExpiry: this.deadline,
      refundExpiry: this.deadline,
      minFeeBps: 0,
      maxFeeBps: 0,
      feeReceiver: ZERO,
      salt: paymentSalt(goalId, seq),
    };
    return this.vaultsOwn ? this.vaultsOwn(derived) : derived;
  }
}

const CONFIG: EscrowSignerConfig = {
  chainId: CHAIN_ID,
  usdcAddress: USDC,
  vaultAddress: VAULT,
  escrow: AUTH_CAPTURE_ESCROW,
  collector: ERC3009_TOKEN_COLLECTOR,
  eip712Name: "USDC",
  eip712Version: "2",
  verifyDomainOnChain: false,
  now: () => NOW,
};

function makeSigner(chain: FakeChain, keys: KeyStore, overrides: Partial<EscrowSignerConfig> = {}) {
  return new EscrowAuthorizationSigner({ vault: chain, keys, config: { ...CONFIG, ...overrides } });
}

describe("EscrowAuthorizationSigner", () => {
  let chain: FakeChain;
  let keys: InMemoryKeyStore;
  let payer: Address;

  const setGoal = (over: Partial<GoalRecord> = {}) =>
    chain.goals.set("1", {
      owner: OWNER,
      payer,
      relay: VENDOR,
      asset: USDC,
      callsRemaining: 1,
      expiry: 5_000_000_000n,
      seq: 1n,
      open: true,
      ...over,
    });
  const setSpend = (over: Partial<SpendRecord> = {}) =>
    chain.spends.set("1:1", {
      payer,
      amount: AMOUNT,
      payTo: VENDOR,
      asset: USDC,
      nonce: "0x00",
      validAfter: 0n,
      validBefore: BigInt(WINDOW),
      termsHash: `0x${"ab".repeat(32)}`,
      finalized: true,
      approved: true,
      ...over,
    });

  beforeEach(async () => {
    chain = new FakeChain();
    keys = new InMemoryKeyStore();
    payer = await keys.mint();
    setGoal();
    setSpend();
  });

  const sign = () => makeSigner(chain, keys).sign({ goalId: 1n, seq: 1n });

  async function signed() {
    const outcome = await sign();
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  }

  /** Recovers who signed, under the only type this signer may use. */
  async function recover(value: Awaited<ReturnType<typeof signed>>): Promise<Address> {
    return recoverTypedDataAddress({
      domain: DOMAIN,
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: value.authorization.from,
        to: value.authorization.to,
        value: BigInt(value.authorization.value),
        validAfter: BigInt(value.authorization.validAfter),
        validBefore: BigInt(value.authorization.validBefore),
        nonce: value.authorization.nonce,
      },
      signature: value.signature,
    });
  }

  describe("what it signs", () => {
    it("signs a receiveWithAuthorization to the collector, as the payer", async () => {
      const value = await signed();
      expect(value.authorization.to).toBe(ERC3009_TOKEN_COLLECTOR);
      expect(value.authorization.validAfter).toBe("0");
      expect(value.authorization.validBefore).toBe(String(WINDOW));
      expect(await recover(value)).toBe(payer);
    });

    it("commits the nonce to the whole payment, naming the vault as operator", async () => {
      const value = await signed();
      expect(value.payment.operator).toBe(VAULT);
      expect(value.payment.receiver).toBe(VENDOR);
      expect(value.payment.maxFeeBps).toBe(0);
      expect(value.payment.salt).toBe(paymentSalt(1n, 1n).toString());
      expect(value.authorization.nonce).toBe(
        escrowNonce(
          { ...value.payment, maxAmount: AMOUNT, salt: paymentSalt(1n, 1n) },
          { escrow: AUTH_CAPTURE_ESCROW, chainId: CHAIN_ID },
        ),
      );
    });

    /** A retry after a dropped response must be the same authorization, not a new one. */
    it("gives a byte-identical authorization on retry, whatever the clock says", async () => {
      const first = await signed();
      const later = await makeSigner(chain, keys, { now: () => NOW + 500 }).sign({ goalId: 1n, seq: 1n });
      expect(later).toEqual({ ok: true, value: first });
    });

    it("carries no route to a plain transfer", () => {
      const source = readFileSync(fileURLToPath(new URL("./escrow-service.ts", import.meta.url)), "utf8");
      expect(source).not.toMatch(/TRANSFER_WITH_AUTHORIZATION_TYPES|primaryType: "TransferWithAuthorization"/);
      expect(source.match(/signTypedData/g)).toHaveLength(1);
    });

    it("does not produce a signature usable as a plain transfer", async () => {
      const value = await signed();
      // Every field as signed, so the type is the only difference under test.
      const asTransfer = await recoverTypedDataAddress({
        domain: DOMAIN,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: value.authorization.from,
          to: value.authorization.to,
          value: BigInt(value.authorization.value),
          validAfter: BigInt(value.authorization.validAfter),
          validBefore: BigInt(value.authorization.validBefore),
          nonce: value.authorization.nonce,
        },
        signature: value.signature,
      });
      expect(asTransfer).not.toBe(payer);
    });
  });

  /** What each test's chain says is a lie. What matters is what the lie can buy. */
  describe("against a lying RPC", () => {
    it("binds an invented approval to the vault, which will refuse it", async () => {
      setSpend({ payTo: THIEF, amount: 999_000_000n });
      const value = await signed();
      expect(value.authorization.to).toBe(ERC3009_TOKEN_COLLECTOR);
      expect(value.payment.operator).toBe(VAULT);
      expect(value.payment.token).toBe(USDC);
    });

    it("cannot be told a different operator: the vault's answer only ever causes a refusal", async () => {
      chain.vaultsOwn = (derived) => ({ ...derived, operator: THIEF });
      const outcome = await sign();
      expect(outcome).toMatchObject({ ok: false, status: 500 });
      expect(JSON.stringify(outcome)).not.toContain("signature");
    });

    it("binds a false owner in a sweep to the vault, which checks the real one", async () => {
      setGoal({ open: false, owner: THIEF });
      chain.balance = 1_000_000n;
      const outcome = await makeSigner(chain, keys).sweep({ goalId: "1" });
      if (!outcome.ok) throw new Error(outcome.error);
      expect(outcome.value.authorization.to).toBe(ERC3009_TOKEN_COLLECTOR);
      expect(outcome.value.payment.operator).toBe(VAULT);
    });
  });

  describe("refusals", () => {
    const cases: [string, number, () => void][] = [
      ["the RPC is on another chain", 503, () => void (chain.chain = 1)],
      ["the goal does not exist", 404, () => chain.goals.clear()],
      ["the goal is in another token", 409, () => setGoal({ asset: OTHER_TOKEN })],
      ["no spend is recorded", 404, () => chain.spends.clear()],
      ["the decision is not finalized", 425, () => setSpend({ finalized: false, approved: false })],
      ["the policy rejected it", 403, () => setSpend({ approved: false })],
      ["the two records name different payers", 500, () => setSpend({ payer: THIEF })],
      ["the goal is closed", 409, () => setGoal({ open: false })],
      ["the amount already went back to the budget", 410, () => void (chain.reclaimed = true)],
      ["the window has closed", 410, () => setSpend({ validBefore: BigInt(NOW) })],
      ["the amount does not fit the escrow", 500, () => setSpend({ amount: 2n ** 120n })],
      ["the vault derives other terms", 500, () => void (chain.vaultsOwn = (d) => ({ ...d, salt: 7n }))],
    ];
    it.each(cases)("refuses when %s", async (_name, status, arrange) => {
      arrange();
      expect(await sign()).toMatchObject({ ok: false, status });
    });

    it("refuses a payer it holds no key for", async () => {
      const other = await new InMemoryKeyStore().mint();
      setGoal({ payer: other });
      setSpend({ payer: other });
      expect(await sign()).toMatchObject({ ok: false, status: 404 });
    });

    it("refuses when the token's EIP-712 domain disagrees", async () => {
      const outcome = await makeSigner(chain, keys, { verifyDomainOnChain: true }).sign({ goalId: 1n, seq: 1n });
      expect(outcome).toMatchObject({ ok: false, status: 500 });
    });

    it("signs when the token's EIP-712 domain matches", async () => {
      chain.domain = domainSeparator({ domain: DOMAIN });
      const outcome = await makeSigner(chain, keys, { verifyDomainOnChain: true }).sign({ goalId: 1n, seq: 1n });
      expect(outcome.ok).toBe(true);
    });

    /*
     * USDC's name differs by network, "USDC" here and "USD Coin" on Base, so a signer on
     * Base that kept the testnet name would produce signatures the token rejects. Written
     * out and not read from NETWORKS, so the test pins it independently.
     */
    it("signs under Base USDC's own domain on Base", async () => {
      const base = NETWORKS.base;
      chain.chain = base.chainId;
      setGoal({ asset: base.usdc.address });
      chain.domain = domainSeparator({
        domain: { name: "USD Coin", version: "2", chainId: base.chainId, verifyingContract: base.usdc.address },
      });
      const onBase = new EscrowAuthorizationSigner({
        vault: chain,
        keys,
        config: {
          chainId: base.chainId,
          usdcAddress: base.usdc.address,
          vaultAddress: VAULT,
          escrow: AUTH_CAPTURE_ESCROW,
          collector: ERC3009_TOKEN_COLLECTOR,
          now: () => NOW,
        },
      });
      expect((await onBase.sign({ goalId: 1n, seq: 1n })).ok).toBe(true);
    });

    it("refuses to start on a chain whose USDC domain it does not know", () => {
      expect(
        () =>
          new EscrowAuthorizationSigner({
            vault: chain,
            keys,
            config: {
              chainId: 1,
              usdcAddress: USDC,
              vaultAddress: VAULT,
              escrow: AUTH_CAPTURE_ESCROW,
              collector: ERC3009_TOKEN_COLLECTOR,
            },
          }),
      ).toThrow(/no USDC EIP-712 domain/);
    });

    /** No route takes terms. */
    it("refuses a body that carries terms", async () => {
      const outcome = await makeSigner(chain, keys).signRaw({ goalId: "1", seq: "1", payTo: THIEF });
      expect(outcome).toMatchObject({ ok: false, status: 400 });
    });
  });

  describe("sweep", () => {
    const sweep = () => makeSigner(chain, keys).sweep({ goalId: "1" });

    it("signs the payer's whole balance to the owner, once the goal is closed", async () => {
      setGoal({ open: false });
      chain.balance = 1_000_000n;
      const outcome = await sweep();
      if (!outcome.ok) throw new Error(outcome.error);
      expect(outcome.value.seq).toBe("sweep");
      expect(outcome.value.payment.receiver).toBe(OWNER);
      expect(outcome.value.payment.maxAmount).toBe("1000000");
      expect(outcome.value.payment.salt).toBe(paymentSalt(1n, 0n).toString());
      expect(await recover(outcome.value)).toBe(payer);
    });

    it("refuses an open goal, an empty payer, and another token", async () => {
      chain.balance = 1n;
      expect(await sweep()).toMatchObject({ ok: false, status: 409 });

      setGoal({ open: false });
      chain.balance = 0n;
      expect(await sweep()).toMatchObject({ ok: false, status: 409 });

      setGoal({ open: false, asset: OTHER_TOKEN });
      chain.balance = 1n;
      expect(await sweep()).toMatchObject({ ok: false, status: 409 });
    });

    it("refuses a payer it holds no key for", async () => {
      setGoal({ open: false, payer: await new InMemoryKeyStore().mint() });
      chain.balance = 1n;
      expect(await sweep()).toMatchObject({ ok: false, status: 404 });
    });

    it("refuses a body carrying payment terms, and names them", async () => {
      const outcome = await makeSigner(chain, keys).sweep({ goalId: "1", to: THIEF, value: "999999999" });
      if (outcome.ok) throw new Error("it signed");
      expect(outcome.status).toBe(400);
      expect(outcome.error).toContain("payment terms");
      expect(outcome.error).toContain("to");
      expect(outcome.error).toContain("value");
    });

    it("refuses an unknown field, and a malformed body", async () => {
      const signer = makeSigner(chain, keys);
      expect(await signer.sweep({ goalId: "1", memo: "hello" })).toMatchObject({ ok: false, status: 400 });
      expect(await signer.sweep({ goalId: "not a number" })).toMatchObject({ ok: false, status: 400 });
      expect(await signer.sweep("1")).toMatchObject({ ok: false, status: 400 });
    });
  });

  it("mints a payer and returns only its address", async () => {
    const minted = await makeSigner(chain, keys).mintPayer();
    expect(Object.keys(minted)).toEqual(["address"]);
    expect(await keys.signerFor(minted.address)).toBeDefined();
  });

  it("serves through the same HTTP surface", async () => {
    const server = createSignerServer({ signer: makeSigner(chain, keys) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/authorizations`, {
        method: "POST",
        body: JSON.stringify({ goalId: "1", seq: "1" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { collector: string; payment: { operator: string } };
      expect(body.collector).toBe(ERC3009_TOKEN_COLLECTOR);
      expect(body.payment.operator).toBe(VAULT);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/**
 * One fixed payment, checked two ways. The hash and nonce were read from the deployed
 * escrow on Base Sepolia with `cast call`. contracts/test/EscrowPolicyVault.t.sol
 * submits this exact signature to the deployed USDC, collector and escrow on a fork, so
 * a mistake in any field of this signer's hashing fails there.
 */
describe("the shared vector", () => {
  const account = privateKeyToAccount(`0x${(0xa11cen).toString(16).padStart(64, "0")}`);
  const INFO: PaymentInfo = {
    operator: VAULT,
    payer: account.address,
    receiver: VENDOR,
    token: USDC,
    maxAmount: AMOUNT,
    preApprovalExpiry: WINDOW,
    authorizationExpiry: DEADLINE,
    refundExpiry: DEADLINE,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: ZERO,
    salt: paymentSalt(1n, 1n),
  };
  const BINDING = { escrow: AUTH_CAPTURE_ESCROW, chainId: CHAIN_ID };

  it("matches the deployed escrow's hashes", () => {
    expect(paymentInfoHash(INFO, BINDING)).toBe(
      "0x83be1b134b747bf09820d7fe9516a1ebdded3735ed62fa12a43b84d4aced0e52",
    );
    expect(escrowNonce(INFO, BINDING)).toBe(
      "0xa1840922f636af0f6befe7e4443b44068ea5bd195d16ddfa8d1e7b2767767793",
    );
  });

  it("produces the signature the Foundry test submits", async () => {
    const chain = new FakeChain();
    chain.goals.set("1", {
      owner: OWNER,
      payer: account.address,
      relay: VENDOR,
      asset: USDC,
      callsRemaining: 1,
      expiry: 5_000_000_000n,
      seq: 1n,
      open: true,
    });
    chain.spends.set("1:1", {
      payer: account.address,
      amount: AMOUNT,
      payTo: VENDOR,
      asset: USDC,
      nonce: "0x00",
      validAfter: 0n,
      validBefore: BigInt(WINDOW),
      termsHash: `0x${"ab".repeat(32)}`,
      finalized: true,
      approved: true,
    });
    const keys: KeyStore = {
      mint: async () => account.address,
      signerFor: async () => account as LocalAccount,
      addresses: async () => [account.address],
    };
    const outcome = await makeSigner(chain, keys).sign({ goalId: 1n, seq: 1n });
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.value.signature).toBe(
      "0x16da224649ab955655569ae0f24e443910acb33263451cd2c5b383d85f6939ae743f8e9be901b93dc1d2ceb0d3f516fe3f793fb34a3b915115ddf101c1011e651b",
    );
  });
});

describe("opening the signer at boot", () => {
  const base = async (chain: FakeChain) => ({
    vault: chain,
    keys: new InMemoryKeyStore(),
    chainId: CHAIN_ID,
    usdcAddress: USDC,
    vaultAddress: VAULT,
  });

  it("refuses a vault with no escrow", async () => {
    const chain = new FakeChain();
    chain.binding = undefined;
    await expect(openSigner(await base(chain))).rejects.toThrow(/has no escrow/);
  });

  it("refuses a vault using another escrow or collector", async () => {
    const chain = new FakeChain();
    chain.binding = { escrow: THIEF, collector: ERC3009_TOKEN_COLLECTOR };
    await expect(openSigner(await base(chain))).rejects.toThrow(/signs only for/);
    chain.binding = { escrow: AUTH_CAPTURE_ESCROW, collector: THIEF };
    await expect(openSigner(await base(chain))).rejects.toThrow(/signs only for/);
  });

  it("opens on a vault using the pinned escrow and collector", async () => {
    expect(await openSigner(await base(new FakeChain()))).toBeInstanceOf(EscrowAuthorizationSigner);
  });
});

describe("OnChainVaultReader.escrowBinding", () => {
  function reader(request: (method: string) => unknown): OnChainVaultReader {
    const client = createPublicClient({
      transport: custom({ request: async ({ method }) => request(method) }),
    }) as PublicClient;
    return new OnChainVaultReader({ rpcUrl: "http://unused", vaultAddress: VAULT, chainId: CHAIN_ID, client });
  }

  it("reads a vault without the functions as having no escrow", async () => {
    const empty = reader((method) => (method === "eth_call" ? "0x" : undefined));
    expect(await empty.escrowBinding()).toBeUndefined();
  });

  /** "The RPC is down" must not read as "this is not an escrow vault". */
  it("does not mistake an RPC failure for an answer", async () => {
    const down = reader(() => {
      throw new Error("connection refused");
    });
    await expect(down.escrowBinding()).rejects.toThrow();
  });
});
