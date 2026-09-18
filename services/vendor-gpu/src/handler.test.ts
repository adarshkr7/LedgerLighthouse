import { describe, expect, it } from "vitest";

import {
  GPU_SKUS,
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  NETWORK_BASE_SEPOLIA,
  SCHEME_EXACT,
  X402_VERSION,
  decodeSettlementHeader,
  encodePaymentHeader,
  parsePaymentRequired,
  quoteAtomic,
  type Address,
  type PaymentPayload,
  type SettleResponse,
  type VerifyResponse,
} from "@ntux402/shared";
import { SpendLedger } from "@ntux402/shared/node";

import { LeaseStore } from "./lease.js";
import type { PayerCheck } from "./payer-check.js";

import { handleRequest, type HandlerOptions } from "./handler.js";
import type { PaymentGateway } from "./gateway.js";
import type {
  GpuProvider,
  JobRequest,
  JobResult,
  LeaseProvisionResult,
  LeaseRequest,
} from "./providers/index.js";

const PAYEE = "0x4444444444444444444444444444444444444444" as Address;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const PAYER = "0x9999999999999999999999999999999999999999" as Address;

/** 15 minutes of a 4090: the cheapest thing on offer. */
const PRICE = quoteAtomic(GPU_SKUS.rtx4090, 15);
const RENTAL = "/resource/gpu?sku=rtx4090&minutes=15&workload=gpu-burn";

const OK_JOB: JobResult = {
  ok: true,
  jobId: "sim-2222222222222222",
  provider: "spy",
  simulated: true,
  provisionMs: 30_000,
  runMs: 12,
  metrics: { workload: "gpu-burn", sustainedUtilisationPct: 97.4 },
  reportedCostAtomic: undefined,
};

/** Records every call so a test can assert a machine was *not* allocated. */
class SpyProvider implements GpuProvider {
  readonly name = "spy";
  calls: JobRequest[] = [];
  leaseCalls: LeaseRequest[] = [];
  terminated: string[] = [];
  leaseResult: LeaseProvisionResult = {
    ok: true,
    providerHandle: "spy-box-1",
    endpoint: "https://spy-box-1.gpu.invalid",
    provider: "spy",
    simulated: true,
    provisionMs: 30_000,
    hardExpirySet: true,
  };
  constructor(private readonly result: JobResult = OK_JOB) {}
  async runJob(request: JobRequest): Promise<JobResult> {
    this.calls.push(request);
    return this.result;
  }
  async provisionLease(request: LeaseRequest): Promise<LeaseProvisionResult> {
    this.leaseCalls.push(request);
    return this.leaseResult;
  }
  async terminateLease(providerHandle: string): Promise<{ ok: boolean }> {
    this.terminated.push(providerHandle);
    return { ok: true };
  }
}

class SpyGateway implements PaymentGateway {
  verifyCalls = 0;
  settleCalls = 0;
  constructor(
    private readonly verifyResult: VerifyResponse = { isValid: true },
    private readonly settleResult: SettleResponse = { success: true, transaction: "0xabc" },
  ) {}
  async verify(): Promise<VerifyResponse> {
    this.verifyCalls++;
    return this.verifyResult;
  }
  async settle(): Promise<SettleResponse> {
    this.settleCalls++;
    return this.settleResult;
  }
}

function paymentHeader(
  overrides: Partial<{ to: Address; value: string; network: string; nonce: `0x${string}` }> = {},
) {
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: SCHEME_EXACT,
    network: overrides.network ?? NETWORK_BASE_SEPOLIA,
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: overrides.to ?? PAYEE,
        value: overrides.value ?? PRICE,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: overrides.nonce ?? `0x${"22".repeat(32)}`,
      },
    },
  };
  return encodePaymentHeader(payload);
}

const base = (options: Partial<HandlerOptions> = {}): HandlerOptions => ({
  provider: new SpyProvider(),
  payTo: PAYEE,
  asset: ASSET,
  baseUrl: "https://gpu.test",
  ...options,
});

const get = (path: string, headers: Record<string, string> = {}, options?: Partial<HandlerOptions>) =>
  handleRequest({ method: "GET", path, headers }, base(options));

describe("routing and validation", () => {
  it("404s an unknown path and 405s a non-GET", async () => {
    expect((await get("/resource/nope")).status).toBe(404);
    expect(
      (await handleRequest({ method: "POST", path: RENTAL, headers: {} }, base())).status,
    ).toBe(405);
  });

  it("reports health with the provider and the ledger state", async () => {
    const ledger = new SpendLedger({ capAtomic: "25000000" });
    const res = await get("/health", {}, { ledger });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      settlement: "stub",
      provider: "spy",
      capAtomic: "25000000",
    });
  });

  it("publishes the price list without asking for payment", async () => {
    const res = await get("/catalog");
    expect(res.status).toBe(200);
    const { skus } = res.body as { skus: Array<{ name: string; pricePerMinuteAtomic: string }> };
    expect(skus.map((s) => s.name)).toEqual(["rtx4090", "a100-40gb", "h100-80gb"]);
    expect(skus[0]?.pricePerMinuteAtomic).toBe(GPU_SKUS.rtx4090.pricePerMinuteAtomic);
  });

  /*
   * A malformed request is a 400, never a 402. Quoting a price for something we
   * would refuse for free invites a caller to pay for it.
   */
  it("400s a bad request rather than quoting a price for it", async () => {
    for (const path of [
      "/resource/gpu?minutes=15&workload=gpu-burn", // no sku
      "/resource/gpu?sku=rtx4090&workload=gpu-burn", // no minutes
      "/resource/gpu?sku=rtx4090&minutes=15", // no workload
      "/resource/gpu?sku=tpu-v5&minutes=15&workload=gpu-burn",
      "/resource/gpu?sku=rtx4090&minutes=45&workload=gpu-burn",
      "/resource/gpu?sku=rtx4090&minutes=15&workload=whatever",
    ]) {
      expect((await get(path)).status, path).toBe(400);
    }
  });

  it("never reaches the provider for a request it refused", async () => {
    const provider = new SpyProvider();
    await handleRequest(
      { method: "GET", path: "/resource/gpu?sku=tpu-v5&minutes=15&workload=gpu-burn", headers: {} },
      base({ provider }),
    );
    expect(provider.calls).toHaveLength(0);
  });
});

describe("the 402", () => {
  it("quotes the SKU table's price for the requested block", async () => {
    const res = await get(RENTAL);
    expect(res.status).toBe(402);

    const parsed = parsePaymentRequired(res.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // The parser turns the wire's `maxAmountRequired` into a bigint `amount`.
    const [accept] = parsed.value.accepts;
    expect(accept?.amount).toBe(BigInt(PRICE));
    expect(accept?.amount).toBe(120_000n); // 0.12 USDC
    expect(accept?.payTo).toBe(PAYEE);
    expect(accept?.scheme).toBe(SCHEME_EXACT);
  });

  /*
   * The resource is what the vault freezes into `termsHash`, so the 402 and the
   * paid retry have to produce the same string from the same request line.
   */
  it("carries the whole request in the resource field", async () => {
    const res = await get(RENTAL);
    const parsed = parsePaymentRequired(res.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.accepts[0]?.resource).toBe(
      "https://gpu.test/resource/gpu?sku=rtx4090&minutes=15&workload=gpu-burn",
    );
  });

  it("quotes a different block at a different price", async () => {
    const hour = await get("/resource/gpu?sku=rtx4090&minutes=60&workload=gpu-burn");
    const parsed = parsePaymentRequired(hour.body);
    expect(parsed.ok && parsed.value.accepts[0]?.amount).toBe(480_000n);
  });

  /*
   * The duration in words, not only in the URL. A model reading `minutes=60`
   * out of a query string and a price out of a typed field has to multiply to
   * notice it is being asked for an hour.
   */
  it("says the duration in the description", async () => {
    const res = await get("/resource/gpu?sku=h100-80gb&minutes=60&workload=matmul-bench");
    const parsed = parsePaymentRequired(res.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.accepts[0]?.description).toContain("60 minutes");
    expect(parsed.value.accepts[0]?.description).toContain("H100 80GB");
  });

  /*
   * A timeout shorter than the block would have the client abandon a job it has
   * already committed to pay for, and the vendor would run it anyway.
   */
  it("advertises a timeout longer than the block it sells", async () => {
    const res = await get("/resource/gpu?sku=rtx4090&minutes=60&workload=gpu-burn");
    const parsed = parsePaymentRequired(res.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.accepts[0]?.maxTimeoutSeconds).toBeGreaterThan(60 * 60);
  });
});

describe("the spend ceiling", () => {
  /*
   * 429 rather than 503: `X402Client` retries 5xx with backoff and treats other
   * 4xx as final. A ceiling breach is final — retrying it is how a bounded
   * overspend becomes an unbounded one.
   */
  it("429s once the ceiling is reached, before quoting anything", async () => {
    const ledger = new SpendLedger({ capAtomic: "100000" }); // under one block
    const provider = new SpyProvider();
    const res = await get(RENTAL, {}, { ledger, provider });
    expect(res.status).toBe(429);
    expect(provider.calls).toHaveLength(0);
  });

  it("charges the quoted price when the provider reports no cost", async () => {
    const ledger = new SpendLedger({ capAtomic: "25000000" });
    const gateway = new SpyGateway();
    await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader() }, { ledger, gateway });
    expect(ledger.spentAtomic).toBe(PRICE);
  });

  it("charges what the provider reported when it reports one", async () => {
    const ledger = new SpendLedger({ capAtomic: "25000000" });
    const provider = new SpyProvider({ ...OK_JOB, reportedCostAtomic: "85000" });
    await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader() }, { ledger, provider });
    expect(ledger.spentAtomic).toBe("85000");
  });
});

describe("payload checks that cost nothing", () => {
  const cases: Array<[string, string, string]> = [
    ["a payee that is not us", "payee mismatch", paymentHeader({ to: PAYER })],
    ["less than the quote", "insufficient", paymentHeader({ value: "1" })],
    ["the wrong network", "network mismatch", paymentHeader({ network: "ethereum" })],
  ];

  for (const [label, reason, header] of cases) {
    it(`402s ${label} without reaching the provider`, async () => {
      const provider = new SpyProvider();
      const gateway = new SpyGateway();
      const res = await get(RENTAL, { [HEADER_PAYMENT]: header }, { provider, gateway });
      expect(res.status).toBe(402);
      expect(JSON.stringify(res.body)).toContain(reason);
      expect(provider.calls).toHaveLength(0);
      // Cheapest-first: the facilitator was never asked either.
      expect(gateway.verifyCalls).toBe(0);
    });
  }

  it("402s an undecodable header", async () => {
    const res = await get(RENTAL, { [HEADER_PAYMENT]: "not-base64-json" });
    expect(res.status).toBe(402);
  });
});

describe("the order of operations", () => {
  /*
   * Step 4 is the one that is easy to leave out and expensive to omit. Without
   * it, a well-formed authorization that will fail at settlement — a consumed
   * nonce, an unfunded payer — gets a machine provisioned before anyone finds
   * out, and repeating that in a loop drains the vendor for free.
   */
  it("asks the facilitator before allocating anything", async () => {
    const provider = new SpyProvider();
    const gateway = new SpyGateway({ isValid: false, invalidReason: "nonce already used" });

    const res = await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader() }, { provider, gateway });

    expect(res.status).toBe(402);
    expect(JSON.stringify(res.body)).toContain("nonce already used");
    expect(gateway.verifyCalls).toBe(1);
    expect(provider.calls).toHaveLength(0);
    expect(gateway.settleCalls).toBe(0);
  });

  /*
   * Plan §5.4 keeps this ordering. Settling first would move the buyer's money
   * and then discover there is no machine, and the only channel back is a
   * second 402 that reads as "the resource server refused the payment".
   */
  it("502s a failed job and settles nothing", async () => {
    const provider = new SpyProvider({
      ok: false,
      status: 503,
      error: "no capacity in region",
      provisioned: false,
    });
    const gateway = new SpyGateway();

    const res = await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader() }, { provider, gateway });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ providerStatus: 503, provisioned: false });
    expect(gateway.settleCalls).toBe(0);
  });

  /*
   * The operator's question after a failure is whether a meter started, and the
   * buyer pays nothing either way. Reported rather than inferred from a log.
   */
  it("says whether a machine was allocated before the failure", async () => {
    const provider = new SpyProvider({
      ok: false,
      status: 500,
      error: "instance died during setup",
      provisioned: true,
    });
    const res = await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader() }, { provider });
    expect(res.body).toMatchObject({ provisioned: true });
  });

  /*
   * The §5.4 window closing badly: the job ran, the card billed, and the USDC
   * did not move. A 402 is right despite the work being done — the payment
   * genuinely was refused, and a 200 here would describe a rental nobody paid
   * for.
   */
  it("402s a settlement failure after the job has already run", async () => {
    const provider = new SpyProvider();
    const gateway = new SpyGateway({ isValid: true }, { success: false, errorReason: "insufficient balance" });

    const res = await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader() }, { provider, gateway });

    expect(res.status).toBe(402);
    expect(JSON.stringify(res.body)).toContain("insufficient balance");
    expect(provider.calls).toHaveLength(1); // it ran, and we ate it
  });
});

describe("a paid rental", () => {
  it("returns the job, the settlement header and the margin line", async () => {
    const gateway = new SpyGateway();
    const res = await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader() }, { gateway });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      capability: "gpu-job",
      sku: "rtx4090",
      minutes: 15,
      workload: "gpu-burn",
      job: { id: "sim-2222222222222222", provider: "spy", simulated: true },
      pricing: { quotedAtomic: PRICE, quotedUsd: "0.12" },
    });

    const settlement = decodeSettlementHeader(res.headers[HEADER_PAYMENT_RESPONSE] ?? "");
    expect(settlement.ok && settlement.value.success).toBe(true);
    expect(gateway.settleCalls).toBe(1);
  });

  /*
   * `simulated` is carried into the buyer's hands and into the trace on
   * purpose. A run record that cannot be told apart from a real rental is a run
   * record nobody should trust.
   */
  it("does not hide that no hardware ran", async () => {
    const res = await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader() });
    expect(res.body).toMatchObject({ job: { simulated: true } });
  });

  /*
   * Plan §5.2. Phase 1 stores nothing, but the key the phase 2 lease store will
   * be keyed on has to reach the adapter, or the seam is not there to build on.
   */
  it("passes the authorization nonce to the provider as an idempotency key", async () => {
    const provider = new SpyProvider();
    const nonce: `0x${string}` = `0x${"ab".repeat(32)}`;
    await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader({ nonce }) }, { provider });
    expect(provider.calls[0]?.idempotencyKey).toBe(nonce);
  });

  it("stubs settlement when no facilitator is configured", async () => {
    const res = await get(RENTAL, { [HEADER_PAYMENT]: paymentHeader() });
    expect(res.status).toBe(200);
    const settlement = decodeSettlementHeader(res.headers[HEADER_PAYMENT_RESPONSE] ?? "");
    expect(settlement.ok && settlement.value.simulated).toBe(true);
  });
});

describe("leases", () => {
  const LEASE = "/resource/gpu/lease?sku=rtx4090&minutes=15&workload=gpu-burn";

  /** Accepts everything, so a test can isolate the lock from the signature. */
  const anyPayer: PayerCheck = { signedByPayer: async () => true };
  const noPayer: PayerCheck = { signedByPayer: async () => false };

  const withLeases = (extra: Partial<HandlerOptions> = {}) => {
    const leases = new LeaseStore();
    const provider = new SpyProvider();
    const gateway = new SpyGateway();
    return {
      leases,
      provider,
      gateway,
      options: { leases, provider, gateway, payerCheck: anyPayer, ...extra },
    };
  };

  /*
   * A vendor that cannot remember a lease could not reclaim it either, and
   * §5.1 is entirely about the machine outliving the block.
   */
  it("501s the lease route when no store is configured", async () => {
    const res = await get(LEASE);
    expect(res.status).toBe(501);
  });

  it("quotes the same price as the equivalent job", async () => {
    const { options } = withLeases();
    const res = await get(LEASE, {}, options);
    expect(res.status).toBe(402);
    const parsed = parsePaymentRequired(res.body);
    expect(parsed.ok && parsed.value.accepts[0]?.amount).toBe(120_000n);
  });

  it("hands back a credential, an expiry and a renewal deadline", async () => {
    const { options, gateway } = withLeases();
    const res = await get(LEASE, { [HEADER_PAYMENT]: paymentHeader() }, options);

    expect(res.status).toBe(200);
    const body = res.body as {
      capability: string;
      renewLeadSeconds: number;
      lease: { id: string; credential: string; expiresAt: number; renewBy: number; blocks: number };
    };
    expect(body.capability).toBe("gpu-lease");
    expect(body.lease.credential).toContain(body.lease.id);
    expect(body.lease.blocks).toBe(1);
    expect(body.lease.expiresAt - body.lease.renewBy).toBe(body.renewLeadSeconds * 1000);
    expect(gateway.settleCalls).toBe(1);
    expect(res.headers[HEADER_PAYMENT_RESPONSE]).toBeDefined();
  });

  it("sets a provider-side kill past the block's own expiry", async () => {
    const { options, provider } = withLeases();
    await get(LEASE, { [HEADER_PAYMENT]: paymentHeader() }, options);

    const request = provider.leaseCalls[0];
    expect(request?.hardExpiryAt).toBeGreaterThan(Date.now() + 15 * 60_000);
  });

  describe("the §5.2 lock", () => {
    it("returns the same lease on a retry and provisions nothing", async () => {
      const { options, provider, gateway } = withLeases();
      const header = { [HEADER_PAYMENT]: paymentHeader() };

      const first = await get(LEASE, header, options);
      const retry = await get(LEASE, header, options);

      const id = (body: unknown) => (body as { lease: { id: string } }).lease.id;
      expect(id(retry.body)).toBe(id(first.body));
      expect(provider.leaseCalls).toHaveLength(1);
      // Already settled. The absent header is how the buyer can tell.
      expect(gateway.settleCalls).toBe(1);
      expect(retry.headers[HEADER_PAYMENT_RESPONSE]).toBeUndefined();
    });

    /*
     * The spend nonce is public — hashed from two integers, emitted in an
     * event, written into every trace. Knowing one must not be enough to be
     * handed a live credential.
     */
    it("refuses to re-issue a credential without the payer's signature", async () => {
      const { options, provider } = withLeases({ payerCheck: noPayer });
      const header = { [HEADER_PAYMENT]: paymentHeader() };

      // First purchase goes through: the lock is what the signature gates, not
      // the sale, so a fresh nonce is unaffected.
      const first = await get(LEASE, header, { ...options, payerCheck: anyPayer });
      expect(first.status).toBe(200);

      const replay = await get(LEASE, header, options);
      expect(replay.status).toBe(403);
      expect(JSON.stringify(replay.body)).not.toContain("credential");
      // The lock still held: nothing was provisioned a second time.
      expect(provider.leaseCalls).toHaveLength(1);
    });

    it("never provisions twice even when the signature check fails", async () => {
      const { options, provider } = withLeases({ payerCheck: noPayer });
      const header = { [HEADER_PAYMENT]: paymentHeader() };
      await get(LEASE, header, { ...options, payerCheck: anyPayer });
      await get(LEASE, header, options);
      await get(LEASE, header, options);
      expect(provider.leaseCalls).toHaveLength(1);
    });
  });

  /*
   * §5.4 closing badly. The machine exists and the money did not move, so it
   * goes back at once — otherwise it is a meter running against the vendor.
   */
  it("terminates immediately when settlement fails", async () => {
    const leases = new LeaseStore();
    const provider = new SpyProvider();
    const gateway = new SpyGateway({ isValid: true }, { success: false, errorReason: "no funds" });

    const res = await get(
      LEASE,
      { [HEADER_PAYMENT]: paymentHeader() },
      { leases, provider, gateway, payerCheck: anyPayer },
    );

    expect(res.status).toBe(402);
    expect(provider.terminated).toEqual(["spy-box-1"]);
    // And nothing was recorded, so there is no orphan to reconcile.
    expect(leases.active()).toHaveLength(0);
  });

  it("502s a provisioning failure and settles nothing", async () => {
    const { options, provider, gateway } = withLeases();
    provider.leaseResult = {
      ok: false,
      status: 503,
      error: "no capacity in region",
      provisioned: false,
    };

    const res = await get(LEASE, { [HEADER_PAYMENT]: paymentHeader() }, options);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ providerStatus: 503, provisioned: false });
    expect(gateway.settleCalls).toBe(0);
  });

  describe("renewal", () => {
    const renew = (id: string) => `${LEASE}&renew=${id}`;

    const openOne = async (options: Partial<HandlerOptions>) => {
      const res = await get(LEASE, { [HEADER_PAYMENT]: paymentHeader() }, options);
      return (res.body as { lease: { id: string; expiresAt: number } }).lease;
    };

    it("extends the block without provisioning again", async () => {
      const { options, provider, gateway } = withLeases();
      const lease = await openOne(options);

      const res = await get(
        renew(lease.id),
        { [HEADER_PAYMENT]: paymentHeader({ nonce: `0x${"ab".repeat(32)}` }) },
        options,
      );

      expect(res.status).toBe(200);
      const body = res.body as { lease: { blocks: number; expiresAt: number } };
      expect(body.lease.blocks).toBe(2);
      expect(body.lease.expiresAt).toBe(lease.expiresAt + 15 * 60_000);
      expect(provider.leaseCalls).toHaveLength(1);
      expect(gateway.settleCalls).toBe(2);
    });

    it("404s a lease it has never heard of", async () => {
      const { options } = withLeases();
      const res = await get(renew("lease-nope"), { [HEADER_PAYMENT]: paymentHeader() }, options);
      expect(res.status).toBe(404);
    });

    /*
     * 409, not 402. Nothing is wrong with the payment; the machine is gone, and
     * extending the lease would sell time on hardware nobody holds.
     */
    it("409s a lease that has already ended", async () => {
      const leases = new LeaseStore({ now: () => Date.now() - 60 * 60_000 });
      const provider = new SpyProvider();
      const options = { leases, provider, gateway: new SpyGateway(), payerCheck: anyPayer };
      const lease = await openOne(options);

      const res = await get(
        renew(lease.id),
        { [HEADER_PAYMENT]: paymentHeader({ nonce: `0x${"cd".repeat(32)}` }) },
        options,
      );
      expect(res.status).toBe(409);
    });

    it("400s a renewal that names a different card", async () => {
      const { options } = withLeases();
      const lease = await openOne(options);

      const res = await get(
        `/resource/gpu/lease?sku=h100-80gb&minutes=15&workload=gpu-burn&renew=${lease.id}`,
        { [HEADER_PAYMENT]: paymentHeader({ value: "900000", nonce: `0x${"ef".repeat(32)}` }) },
        options,
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("rtx4090");
    });

    it("400s a renewal aimed at the one-shot job route", async () => {
      const { options } = withLeases();
      const res = await get(`${RENTAL}&renew=lease-whatever`, {}, options);
      expect(res.status).toBe(400);
    });
  });
});
