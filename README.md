<p align="center">
  <img src="docs/lighthouse.webp" alt="LedgerLighthouse — confidential agentic payments" width="100%" />
</p>

<p align="center">
  <a href="https://sepolia.basescan.org/address/0x0C759D06a1c14F43852D7b078Db2f8C342F15921"><img alt="PolicyVault on Base Sepolia" src="https://img.shields.io/badge/PolicyVault-Base%20Sepolia-0052ff" /></a>
  <img alt="368 tests passing" src="https://img.shields.io/badge/tests-368%20passing-2f5c4a" />
  <img alt="x402 v1" src="https://img.shields.io/badge/x402-v1-16150f" />
  <img alt="Inco Lightning 1.0.2" src="https://img.shields.io/badge/Inco%20Lightning-1.0.2-7c382e" />
  <img alt="Oasis ROFL TDX" src="https://img.shields.io/badge/Oasis-ROFL%20TDX-0500e2" />
</p>

# LedgerLighthouse

**Confidential, policy-controlled payments for autonomous agents.**

An LLM agent buys API resources over x402 without ever holding spending authority. The budget is
encrypted on chain, the debit is committed before the decision is knowable, the resulting attestation
is verified in the contract, and only then is an EIP-3009 signature released from a key held inside
an attested Intel TDX enclave.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## The problem

An agent that pays for things must read attacker-controlled text — HTTP bodies, error messages,
vendor descriptions — and must also decide when to spend. Putting both capabilities in one component
makes indirect prompt injection a direct path to a drained budget.

The common answer is a text filter over the agent's inputs. That is the wrong shape of control:
probabilistic, guarding a deterministic and irreversible asset.

This system separates the capabilities instead.

> **The invariant.** Compromise of the AI orchestrator must not confer arbitrary spending authority.

The component that reads the attacker's text has no spending authority. The component that grants
spending authority never reads the attacker's text.

---

## What is deployed

Base Sepolia, chain id `84532`. Both contracts are source-verified.

| Contract | Address | Deployment tx |
|---|---|---|
| `PolicyVault` | [`0x0C759D06a1c14F43852D7b078Db2f8C342F15921`](https://sepolia.basescan.org/address/0x0C759D06a1c14F43852D7b078Db2f8C342F15921) | [`0xcbf4da83…c013ee`](https://sepolia.basescan.org/tx/0xcbf4da835639699cf7ae7d472fed635a145c6df97381300941ddc9ba7fc013ee) |
| `TraceAnchor` | [`0x065d5E16160159cAB7D841818aBc92b4E85D5818`](https://sepolia.basescan.org/address/0x065d5E16160159cAB7D841818aBc92b4E85D5818) | [`0x068c2d88…2f9900`](https://sepolia.basescan.org/tx/0x068c2d8883bfe2a294164da805274905aa33c85f2a68a27ab1c06892972f9900) |

Settlement asset: USDC at [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e).

Sapphire testnet: ROFL app `rofl1qr0fv0qs2u8vmmah0ucmwegcj2cdz7kj4qzjduhp` is registered, 100 TEST
staked, with both enclave measurements whitelisted in its on-chain policy. That registration is
permanent and checkable with `oasis rofl show`.

A *running* replica is a separate matter: ROFL compute is rented by the hour, and no machine is
rented at present. So the enclave deployment is reproducible from the manifest rather than currently
live, and any run made without one falls back to the local key store — which is the assumption the
enclave exists to retire.

### Transactions produced by the running system

| What | Transaction |
|---|---|
| `finalizeDecision` — APPROVED | [`0xd38c86d5…284d95`](https://sepolia.basescan.org/tx/0xd38c86d5e327c80294f444598a00e1c3cd2ea90659194d82b74a006bbd284d95) |
| `finalizeDecision` — REJECTED | [`0x407f36fd…3e704c`](https://sepolia.basescan.org/tx/0x407f36fdabaa6f8d5763dc1310ab672d3ed24b3ce2300adad37e14d35b3e704c) |
| `transferWithAuthorization` — settled | [`0x0bf0a2ff…117b8d`](https://sepolia.basescan.org/tx/0x0bf0a2ffae8b5ffdaba66b5dd4768b6c05d792f2830d35e3635f12d07e117b8d) |

The rejection is on chain deliberately. An over-cap request lands and bounces visibly rather than
reverting into silence — a policy that never fires is indistinguishable from one that does not work.

A recorded end-to-end run, transaction hashes and all, is in [`docs/runs/`](docs/runs/).

---

## What is proven, and what is assumed

This distinction is the point of the design, so it is stated before anything else.

| Property | Status |
|---|---|
| The debit was committed before the decision was knowable | **On chain.** Ordinary Base state, checkable by anyone |
| The attestation verified against the handle the vault stored | **On chain.** `e.verifyDecryption`, bound to the stored handle |
| The signature was released only against a finalized APPROVED record | **Auditable code.** Not attested |
| The budget stayed confidential | **Vendor assumption.** Inco exposes no remote-attestation quote to applications |
| The payer key never left the enclave | **Vendor assumption.** Attested by Oasis; Base cannot verify Oasis attestations |
| The agent behaved correctly | **Not claimed.** Deliberately outside the boundary |

The claim this system is willing to defend is narrow:

> Every payment in an anchored trace corresponds to a confidential policy evaluation whose result was
> attested and verified on chain against the expected handle.

### The residual risk

A compromised orchestrator can submit an amount larger than the 402 demanded — up to `perCallCap`, to
an address already on the allowlist. Nothing in the confidential check compares the submitted amount
against the 402 body, because the vault never sees the 402. The bound is the conjunction of
`perCallCap`, the allowlist and `callsRemaining`:

```text
loss ceiling = perCallCap × callsRemaining, paid only to an allowlisted payee
```

**This is a design property, not a theorem.** It has not been formally modelled and no proof is
claimed for it. Establishing a threat model in which the adversary's channel is natural language, and
stating this bound precisely against it, is open work rather than finished work.

---

## Mechanism, in brief

```text
AI Orchestrator → attacker-controlled 402 terms → PolicyVault → Inco confidential computation
→ APPROVE / REJECT → Authorization Signer (enclave key) → EIP-3009 → x402 facilitator → API
```

Everything left of `PolicyVault` is untrusted. Everything right of `APPROVE / REJECT` acts only on
verified on-chain records.

Three properties carry the design:

**Write-ahead debit.** Inco forbids branching on an encrypted condition, so `if (approved) { debit }`
is inexpressible. The contract selects the *operand* instead — `ok.select(amount, 0)` — and subtracts
unconditionally. The debit therefore commits before anyone, including the orchestrator, can learn
whether it was approved.

**Handle-bound attestation.** `finalizeDecision` verifies the attestation against the handle the
contract itself stored. Signature validity alone is insufficient: a genuine attestation over a
different handle would otherwise be substitutable.

**A signer that accepts no terms.** It answers one question — *is `(goalId, seq)` finalized-approved
on chain?* — and if so signs exactly what the chain froze. It has no notion of price and no way to be
told one, so a compromised orchestrator cannot ask it for anything.

Each is derived and justified in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Verifying this without trusting us

1. **Read the contracts.** Both addresses above are source-verified on Basescan.
2. **Check a decision.** The APPROVED and REJECTED `finalizeDecision` transactions are listed above.
3. **Check a settlement.** The `transferWithAuthorization` transaction is listed above.
4. **Check custody.** Goal #52's payer `0xbAe2E2CFE7f612287781E9DdFee46F4C0C55b25b` appears in the
   enclave's log as the address it minted and in the vault as that goal's `payer` — and in no key
   file on any disk.
5. **Verify a trace.** The standalone verifier re-derives every step hash, recomputes the Merkle
   root, and cross-checks each attestation against `PolicyVault`. It needs only the trace file and a
   public RPC.

---

## Limitations

Stated here rather than deferred to a roadmap.

- **`perCallCap` and `callsRemaining` are public plaintext**, and allowlist membership is a public
  mapping. A vendor can read the per-call ceiling and price immediately beneath it.
- **On-Base provability of custody is absent.** Base cannot verify Oasis attestations, so the binding
  between payer address and enclave identity is asserted by the app, not checkable by a third party
  from Base. Custody is real; its provability from Base is not.
- **No refund-on-timeout accounting.** An approved-but-never-settled spend debits the budget
  permanently.
- **Strictly sequential spends per goal.** `pendingSeq` must be zero, because the public call counter
  is only decremented at finalization and a second in-flight spend would read a stale count.
- **No enclave measurement of our own application code** is attested, and Inco exposes no
  remote-attestation quote to applications.
- **Testnet only.** No mainnet deployment.

---

## Running it locally

### Prerequisites

- **Node 22+** and **pnpm 11** — pinned via `packageManager`; `corepack enable` picks it up
- **Foundry** — verified on forge 1.7.1
- A Base Sepolia RPC URL

### Install

```bash
git clone https://github.com/adarshkr7/LedgerLighthouse.git && cd LedgerLighthouse
```

```bash
pnpm install --ignore-scripts
```

`--ignore-scripts` is deliberate: the git-hosted Solidity dependencies declare JS build scripts that
are not needed, since only their `.sol` sources are consumed through Foundry remappings.

### Configure

```bash
cp .env.example .env
```

`.env.example` documents every variable. The ones that matter for the security argument:

| Variable | Role |
|---|---|
| `ORCHESTRATOR_RELAY_KEY` | **Gas only.** Submits `requestSpend` / `finalizeDecision`, authorizes nothing |
| `FACILITATOR_PRIVATE_KEY` | **Gas only.** Submits `transferWithAuthorization`, holds no user funds |
| `SIGNER_ROFL_SOCKET` | `/run/rofl-appd.sock`. Set **only** inside a deployed enclave |
| `SIGNER_REQUIRE_ROFL` | `true` refuses to boot the signer without an enclave, so the file-store fallback cannot be enabled by accident |
| `SIGNER_SERVICE_TOKEN` | What the orchestrator *presents* to the signer. Distinct from `SERVICE_TOKEN`, which is what a service *demands* of its own callers |
| `SEARCH_VENDOR_KEY` | Deliberately a different credential from the inference key. CI fails if the orchestrator so much as names it |

Then generate and fund the two gas-only roles:

```bash
pnpm --filter @ntux402/e2e run keygen
```

```bash
pnpm --filter @ntux402/e2e run fund
```

Two separate faucets: Base Sepolia ETH for gas, and test USDC from
<https://faucet.circle.com> for the payments themselves. Without test USDC everything still runs and
the resource server falls back to stub settlement — the confidential policy, the decision and the
bounce are real either way.

### Run

```bash
pnpm dev
```

Starts the signer (`8402`), mock resource server (`4021`), orchestrator (`8404`) and web console
(`5173`). Open <http://127.0.0.1:5173>, connect MetaMask on Base Sepolia, and walk the five steps —
connect, mint payer, open goal, fund, run.

### Verify

```bash
pnpm verify
```

Mirrors CI: typecheck, tests, import-boundary check, contracts. Add `--skip-contracts` if Foundry is
not installed. Full suite is **368 tests** — 345 Vitest, 23 Foundry.

### Deploying the enclave

```bash
oasis rofl create --network testnet && oasis rofl build && oasis rofl deploy
```

Needs the `oasis` CLI, a publicly published `linux/amd64` image pinned by digest, and TEST ROSE from
the faucet. Already done for this repository, so these reproduce the deployment rather than reach it.
Two traps worth knowing: `oasis rofl build` will not run on native Windows, and under WSL it needs
`GODEBUG=netdns=cgo`.

---

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | `PolicyVault`, `TraceAnchor`, Foundry tests, deployment broadcasts |
| `services/orchestrator/` | The untrusted component: agent loop, payment loop, relay |
| `services/signer/` | Authorization Signer. Runs in the ROFL enclave; holds the payer keys |
| `services/trace/` | Trace builder, Merkle accumulator, and the standalone verifier |
| `services/facilitator/` | Self-hosted x402 v1 facilitator. Outside the trust boundary |
| `services/vendor-search/` | Live search vendor — real upstream calls, priced and sold over x402 |
| `packages/shared/` | Types, the x402 client, chain helpers, the shared HTTP guard |
| `apps/web/` | Console — MetaMask goal opening, funding, run visualisation |
| `mock-api/` | Mock resource server — fabricated data at chosen prices |
| `tools/e2e/` | Keygen, funding, and the end-to-end demo runner |
| `scripts/` | `dev`, `verify`, ABI sync, and the CI import-boundary check |
| `docs/` | Architecture, and recorded runs |

The standalone verifier referenced above lives in [`services/trace/`](services/trace/): it needs only
a trace file and a public RPC, and depends on no service in this repository.

The import boundary is enforced in CI: `pnpm check:boundary` asserts that the orchestrator can reach
neither the signer nor the vendor credential.

---

## License

See [`LICENSE`](LICENSE).
