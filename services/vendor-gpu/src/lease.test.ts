import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LeaseStore,
  RENEW_LEAD_SECONDS,
  leaseIdFor,
  mintCredential,
  redactable,
  toLeaseResponse,
  type LeaseRecord,
  type LeaseTerminator,
} from "./lease.js";

const NONCE = `0x${"22".repeat(32)}`;
const OTHER_NONCE = `0x${"33".repeat(32)}`;

const open = (store: LeaseStore, nonce = NONCE, minutes: 15 | 30 | 60 = 15) =>
  store.open({
    nonce,
    sku: "rtx4090",
    workload: "gpu-burn",
    providerHandle: "box-1",
    endpoint: "https://box-1.gpu.invalid",
    minutes,
  });

class SpyTerminator implements LeaseTerminator {
  terminated: string[] = [];
  constructor(private readonly ok = true) {}
  async terminateLease(handle: string) {
    this.terminated.push(handle);
    return this.ok ? { ok: true } : { ok: false, error: "provider unreachable" };
  }
}

const tmp = () => join(mkdtempSync(join(tmpdir(), "ll-lease-")), "leases.json");

describe("credentials", () => {
  it("mints a distinct secret every time, prefixed with the lease", () => {
    const first = mintCredential("lease-abc");
    const second = mintCredential("lease-abc");
    expect(first).not.toBe(second);
    expect(first.startsWith("lease-abc.")).toBe(true);
    // The prefix carries no entropy claim; the bytes after it are the strength.
    expect(first.split(".")[1]?.length).toBeGreaterThanOrEqual(40);
  });

  /*
   * §5.2. The vault derives its spend nonce deterministically so an interrupted
   * settlement can be retried byte for byte, and the lease id has to inherit
   * that or the retry lands somewhere new.
   */
  it("derives the same lease id from the same nonce", () => {
    expect(leaseIdFor(NONCE)).toBe(leaseIdFor(NONCE));
    expect(leaseIdFor(NONCE)).not.toBe(leaseIdFor(OTHER_NONCE));
  });
});

describe("opening a lease", () => {
  it("records the block and hands back a credential once", () => {
    const store = new LeaseStore({ now: () => 1_000_000 });
    const issued = open(store);

    expect(issued.credential).toContain(issued.record.id);
    expect(issued.rotated).toBe(false);
    expect(issued.record.expiresAt).toBe(1_000_000 + 15 * 60_000);
    expect(issued.record.blocks).toBe(1);
    expect(store.findByNonce(NONCE)?.id).toBe(issued.record.id);
  });

  /*
   * The store is a file on disk. A credential in it is a credential at rest,
   * and revocation never needs one: it goes through the provider handle.
   */
  it("never writes the credential down", () => {
    const path = tmp();
    const store = new LeaseStore({ path });
    const issued = open(store);

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(issued.credential);
    expect(raw).toContain(issued.record.credentialSha256);
  });

  it("hashes the credential it issued", () => {
    const store = new LeaseStore();
    const issued = open(store);
    expect(issued.record.credentialSha256).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("the retry path", () => {
  it("hands back the same credential inside one process", () => {
    const store = new LeaseStore();
    const first = open(store);
    const again = store.reissue(store.findByNonce(NONCE) as LeaseRecord);

    expect(again.credential).toBe(first.credential);
    expect(again.rotated).toBe(false);
  });

  /*
   * Credentials are not persisted, so after a restart there is nothing to hand
   * back. The alternative to rotating is a lease the buyer owns and cannot use.
   */
  it("rotates after a restart and says so", () => {
    const path = tmp();
    const first = open(new LeaseStore({ path }));

    const reopened = new LeaseStore({ path });
    const record = reopened.findByNonce(NONCE) as LeaseRecord;
    expect(record.id).toBe(first.record.id);

    const again = reopened.reissue(record);
    expect(again.credential).not.toBe(first.credential);
    expect(again.rotated).toBe(true);
    // The old hash must not survive a rotation, or the trace would point at a
    // credential that no longer opens anything.
    expect(again.record.credentialSha256).not.toBe(first.record.credentialSha256);
  });
});

describe("renewal", () => {
  it("extends from the old expiry, not from now", () => {
    let now = 1_000_000;
    const store = new LeaseStore({ now: () => now });
    const first = open(store, NONCE, 15);

    // Renewing early must not throw away what is left of the block.
    now = 1_000_000 + 10 * 60_000;
    const renewed = store.renew(first.record, OTHER_NONCE, 15);

    expect(renewed.record.expiresAt).toBe(first.record.expiresAt + 15 * 60_000);
    expect(renewed.record.blocks).toBe(2);
  });

  it("registers the renewing nonce against the same lease", () => {
    const store = new LeaseStore();
    const first = open(store);
    store.renew(first.record, OTHER_NONCE, 15);

    expect(store.findByNonce(OTHER_NONCE)?.id).toBe(first.record.id);
    expect(store.findByNonce(NONCE)?.id).toBe(first.record.id);
  });

  it("keeps both nonces on the record", () => {
    const store = new LeaseStore();
    const first = open(store);
    const renewed = store.renew(first.record, OTHER_NONCE, 30);
    expect(renewed.record.nonces).toEqual([NONCE, OTHER_NONCE]);
  });
});

describe("reclamation", () => {
  /*
   * §5.1. Nothing here waits for the buyer. A buyer who simply stops calling
   * keeps a machine forever, and a rental the renter has to end is not one.
   */
  it("ends a lease whose block has run out", async () => {
    let now = 1_000_000;
    const store = new LeaseStore({ now: () => now });
    open(store, NONCE, 15);
    const provider = new SpyTerminator();

    expect(await store.reclaimExpired(provider)).toHaveLength(0);

    now += 15 * 60_000 + 1;
    const reclaimed = await store.reclaimExpired(provider);

    expect(reclaimed).toHaveLength(1);
    expect(provider.terminated).toEqual(["box-1"]);
    expect(store.active()).toHaveLength(0);
  });

  /*
   * Marking it terminated would record a machine as given back while it is
   * still running, and the next sweep would never look at it again.
   */
  it("leaves the record alone when the provider refuses", async () => {
    let now = 1_000_000;
    const failures: string[] = [];
    const store = new LeaseStore({
      now: () => now,
      onReclaimFailed: (record, error) => failures.push(`${record.id}: ${error}`),
    });
    open(store, NONCE, 15);
    now += 15 * 60_000 + 1;

    const refusing = new SpyTerminator(false);
    expect(await store.reclaimExpired(refusing)).toHaveLength(0);
    expect(failures[0]).toContain("provider unreachable");

    // And the next sweep tries again.
    const working = new SpyTerminator();
    expect(await store.reclaimExpired(working)).toHaveLength(1);
  });

  it("does not terminate a lease twice", async () => {
    let now = 1_000_000;
    const store = new LeaseStore({ now: () => now });
    open(store, NONCE, 15);
    now += 15 * 60_000 + 1;

    const provider = new SpyTerminator();
    await store.reclaimExpired(provider);
    await store.reclaimExpired(provider);
    expect(provider.terminated).toEqual(["box-1"]);
  });

  it("survives a restart so a lease is still reclaimable", async () => {
    const path = tmp();
    let now = 1_000_000;
    open(new LeaseStore({ path, now: () => now }), NONCE, 15);

    now += 15 * 60_000 + 1;
    const reopened = new LeaseStore({ path, now: () => now });
    const provider = new SpyTerminator();

    expect(await reopened.reclaimExpired(provider)).toHaveLength(1);
    expect(provider.terminated).toEqual(["box-1"]);
  });

  /*
   * A forgotten lease is a machine nobody will switch off, so silence is the
   * wrong answer even though it is the right one for the spend ledger. It
   * starts empty and says so; the provider-side hard expiry is the backstop.
   */
  it("shouts when the store cannot be read", () => {
    const path = tmp();
    writeFileSync(path, "{ not json");
    const unreadable = vi.fn();
    const store = new LeaseStore({ path, onStoreUnreadable: unreadable });

    expect(unreadable).toHaveBeenCalledOnce();
    expect(store.active()).toHaveLength(0);
  });
});

describe("what leaves the building", () => {
  it("tells the buyer when to start renewing", () => {
    const store = new LeaseStore({ now: () => 1_000_000 });
    const response = toLeaseResponse(open(store));
    expect(response.expiresAt - response.renewBy).toBe(RENEW_LEAD_SECONDS * 1000);
  });

  /*
   * §5.3. A trace carrying a live credential is a trace nobody can hand to an
   * auditor. The hash proves which credential belonged to which payment, which
   * is the only thing the trace was evidencing.
   */
  it("redacts to a hash, an expiry and nothing else", () => {
    const store = new LeaseStore();
    const response = toLeaseResponse(open(store));
    const safe = redactable(response);

    expect(JSON.stringify(safe)).not.toContain(response.credential);
    expect(safe).toEqual({
      leaseId: response.id,
      credentialSha256: response.credentialSha256,
      expiresAt: response.expiresAt,
      blocks: response.blocks,
    });
  });

  it("keeps the endpoint free of any secret", () => {
    const store = new LeaseStore();
    const issued = open(store);
    // A signed URL would be a credential wearing a location's clothes, and
    // §5.3 names exactly that as what a trace must not end up holding.
    expect(issued.record.endpoint).not.toContain(issued.credential);
    expect(issued.record.endpoint).not.toMatch(/[?#]/);
  });
});
