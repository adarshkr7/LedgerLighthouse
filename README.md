<p align="center">
  <img src="docs/lighthouse.webp" alt="LedgerLighthouse — confidential agentic payments" width="100%" />
</p>

<p align="center">
  <a href="https://sepolia.basescan.org/address/0x052E52a28AA15e0B556de4FCe3d0BEBb7EB4feD8"><img alt="PolicyVault on Base Sepolia" src="https://img.shields.io/badge/PolicyVault-Base%20Sepolia-0052ff" /></a>
  <img alt="368 tests passing" src="https://img.shields.io/badge/tests-368%20passing-2f5c4a" />
  <img alt="x402 v1" src="https://img.shields.io/badge/x402-v1-16150f" />
  <img alt="Inco Lightning 1.0.2" src="https://img.shields.io/badge/Inco%20Lightning-1.0.2-7c382e" />
  <img alt="Oasis ROFL TDX" src="https://img.shields.io/badge/Oasis-ROFL%20TDX-0500e2" />
</p>

# LedgerLighthouse

**Confidential, policy-controlled payments for autonomous agents.**

An LLM agent buys API resources over x402 without ever holding spending authority. The budget is
encrypted on chain, the debit is committed before the decision is knowable, the resulting attestation
is verified in the contract, and only then is a signature released from a key held inside an attested
Intel TDX enclave. That signature can only collect through the vault, which checks its own record again
when the payment is made, through x402's auth-capture escrow.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

> **Paper artifact.** This repository is the artifact of *A Payment Firewall for AI Agents: Bounded Spending
> Under Agent Compromise, and What Refunds Leak* (arXiv, v3, tag `arxiv-v3`). [`ARTIFACT.md`](ARTIFACT.md) maps
> every claim in the paper to its test or recorded run, and says how to reproduce each, offline or live.

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

Base Sepolia, chain id `84532`.

| Contract | Address | Deployment tx |
|---|---|---|
| `EscrowPolicyVault`, enrollment key in the enclave | [`0x466AB18595d2E71A87928c8d4A45F57a5D5ADFd5`](https://sepolia.basescan.org/address/0x466AB18595d2E71A87928c8d4A45F57a5D5ADFd5) | [`0x4135f116…d17065`](https://sepolia.basescan.org/tx/0x4135f116e88c661e29eda14ed6750fa9c53d932edda115af670e4c9328d17065) |
| `EscrowPolicyVault`, enrollment key from a local seed | [`0xdd450306ca3905612a96Ff92aDbee23B48385014`](https://sepolia.basescan.org/address/0xdd450306ca3905612a96Ff92aDbee23B48385014) | [`0xb5ef280c…7a55ac`](https://sepolia.basescan.org/tx/0xb5ef280c808c3f8e3d6621f7aabf2746795306695cdd9eb3862e98fa9e7a55ac) |
| `PlaintextEscrowVault` (baseline) | [`0x9c9D87550C556cD51591CbBDbe6B28895761D224`](https://sepolia.basescan.org/address/0x9c9D87550C556cD51591CbBDbe6B28895761D224) | |
| `TraceAnchor` | [`0x065d5E16160159cAB7D841818aBc92b4E85D5818`](https://sepolia.basescan.org/address/0x065d5E16160159cAB7D841818aBc92b4E85D5818) | [`0x068c2d88…2f9900`](https://sepolia.basescan.org/tx/0x068c2d8883bfe2a294164da805274905aa33c85f2a68a27ab1c06892972f9900) |

The two escrow vaults run the same code; only the enrollment address, the vault's own address and the EIP-712
domain separator built from it differ. Each is the operator of commerce-payments' `AuthCaptureEscrow` v1.1.0.
Earlier designs, for earlier versions of the paper, ran on PolicyVaults
[`0x0C759D06…F15921`](https://sepolia.basescan.org/address/0x0C759D06a1c14F43852D7b078Db2f8C342F15921) (before each payer was bound to one goal; the payer-capture attack succeeded against it),
[`0x518B8701…3522c`](https://sepolia.basescan.org/address/0x518B8701484ba99A38f60090cd4a2cc710d3522c) (public cap),
[`0x052E52a2…4feD8`](https://sepolia.basescan.org/address/0x052E52a28AA15e0B556de4FCe3d0BEBb7EB4feD8) (authorizations valid for an hour),
[`0x132DDf2b…53FBC`](https://sepolia.basescan.org/address/0x132DDf2b66A1595f10a3104f272BeB1236c53FBC),
[`0x7F583373…a4966`](https://sepolia.basescan.org/address/0x7F5833730033a1d320b3536CE08FD641330a4966) (attempt budget; tag `arxiv-v1.1`)
and EscrowPolicyVault [`0x08AAb0cF…C9C99`](https://sepolia.basescan.org/address/0x08AAb0cF0c3D2E7a8B3b52AD01B6db8Da70C9C99) (tag `arxiv-v2`).
Each log in `docs/runs` names the vault it ran against.

Settlement asset: USDC at [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e).

Sapphire testnet: ROFL app `rofl1qr0fv0qs2u8vmmah0ucmwegcj2cdz7kj4qzjduhp`, 100 TEST staked, with the
accepted enclave measurements in its on-chain policy (`oasis rofl show`). The signer image is pinned by digest in
`services/signer/compose.yaml`. ROFL compute is rented by the hour; the machine that ran the 11 November 2026
evidence is recorded in `docs/runs/enclave-v5-2026-11-11-identity.txt`, and no machine need be running for that
record to be checked.

### Transactions produced by the running system

From the 11 November 2026 campaign, signer in the enclave (`docs/runs/escrow-enclave-2026-11-11-adversary.log`):

| What | Transaction |
|---|---|
| `finalizeDecision`, approved | [`0x6963e0b2…dbebb3c`](https://sepolia.basescan.org/tx/0x6963e0b2b81c874b6b7e2c786464184d6d4789cd3fb93136a6f24af1c3dc7bcb) |
| `finalizeDecision`, rejected (one unit over the encrypted cap) | [`0xe4f0f259…e31d64`](https://sepolia.basescan.org/tx/0xe4f0f259b02842cc4d1975375e4997549c54a7af36d93cd4fd23cece78e31d64) |
| Escrow hold funded with the enclave's signature, through the vault | [`0x21e21cf1…a00e52d`](https://sepolia.basescan.org/tx/0x21e21cf17474b43684338a2a76e91c2f3d75f785443c2f602ef808eb6a00e52d) |
| Sweep of a closed goal to its owner, signed in the enclave | [`0x6d5fa1da…de9ef18`](https://sepolia.basescan.org/tx/0x6d5fa1da8dc2eca050120c759eeae4767a34e65cdd210e99fb6b934cede9ef18) |

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
lifetime vendor payments <= min(budget, perCallCap × calls), each to an allowlisted payee
```

The paper proves this by hand over an explicit transition model, for a goal whose enrollment was
authentic and whose signer is uncompromised, with Inco's evaluation and attestations correct. The
invariants behind it are tested by stateful fuzzing against the deployed escrow's code, by mutation,
and by a live campaign that extracts exactly to the ceiling. It is not mechanised.

The limits are encrypted, but each decision is public, so every request answers one question about
them. A public attempt budget caps the number of questions; on realistic caps, a vendor with five of
them prices within a few percent of the cap. Encryption here buys little against a probing vendor.

---

## Mechanism, in brief

```text
AI Orchestrator → attacker-controlled 402 terms → EscrowPolicyVault → Inco confidential computation
→ APPROVE / REJECT → Authorization Signer (enclave key) → x402 facilitator → vault → escrow → API
```

Everything left of `EscrowPolicyVault` is untrusted. Everything right of `APPROVE / REJECT` acts only on
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

1. **Read the contracts.** The source is in `contracts/src`; `contracts/broadcast` records each deployment, and the
   deployed code can be compared with a local build (`forge build`, then `cast code`).
2. **Check a decision.** The approved and rejected `finalizeDecision` transactions are listed above.
3. **Check a payment.** The escrow hold above moved the payer's tokens only through the vault's `authorize`.
4. **Check custody.** The vault's `enrollmentSigner()` is `0x5Ddd4f587818B39960987ea4Df34b9D94E29193a`, the key
   Oasis's key manager derives for this app's admitted enclaves; `docs/runs/enclave-v5-2026-11-11-identity.txt`
   records the app policy, the replica and the signer's `/health` reporting that key with `"store":"rofl"`.
5. **Verify a trace.** The standalone verifier re-derives every step hash, recomputes the Merkle
   root, and cross-checks each attestation against `PolicyVault`. It needs only the trace file and a
   public RPC.

---

## Limitations

Stated here rather than deferred to a roadmap.

- **`callsRemaining` is public plaintext**, and allowlist membership is a public mapping. The
  per-call cap is encrypted (it was public until 9 October 2026), but every approved amount is
  public, so each approval is a lower bound on the cap.
- **On-Base provability of custody is absent.** Base cannot verify Oasis attestations, so the binding
  between payer address and enclave identity is asserted by the app, not checkable by a third party
  from Base. Custody is real; its provability from Base is not.
- **A payment that is never claimed needs someone to reclaim it.** The budget and call come back only
  when `reclaimExpired` is called, once the window or the capture deadline has passed. Anyone may
  call it; nothing calls it automatically. `pnpm --filter @ntux402/e2e run reclaim` finds them.
- **A compromised signer takes the funded balance.** The payer is an ordinary key held by the signer,
  so the bound assumes the signer is not compromised. Only a smart-account payer would remove that.
- **Setup rests on the console.** Enrollment stops the orchestrator substituting a payer, but the
  console and the user's RPC endpoint are trusted, and the console pins the vault and the enrollment
  address at build time.
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
| `FACILITATOR_PRIVATE_KEY` | **Gas only.** Submits the vault's `authorize` with the payer's signature, holds no user funds |
| `SIGNER_ROFL_SOCKET` | `/run/rofl-appd.sock`. Set **only** inside a deployed enclave |
| `SIGNER_REQUIRE_ROFL` | `true` refuses to boot the signer without an enclave, so the file-store fallback cannot be enabled by accident |
| `SIGNER_SERVICE_TOKEN` | What the orchestrator *presents* to the signer. Distinct from `SERVICE_TOKEN`, which is what a service *demands* of its own callers |

Then generate and fund the two gas-only roles:

```bash
pnpm --filter @ntux402/e2e run keygen
```

```bash
pnpm --filter @ntux402/e2e run fund
```

Two separate faucets: Base Sepolia ETH for gas, and test USDC from
<https://faucet.circle.com> for the payments themselves. Settlement is always real: a hold is a
transaction, so there is no stub mode. The mock vendor also needs `VENDOR_PRIVATE_KEY` and a little ETH,
and the facilitator needs the vault in `FACILITATOR_ESCROW_OPERATORS`. See `.env.example`.

### Run

```bash
pnpm dev
```

Starts the signer (`8402`), mock resource server (`4021`), orchestrator (`8404`) and web console
(`5173`). Open <http://127.0.0.1:5173>, connect MetaMask on Base Sepolia, and walk the five steps —
connect, mint payer, open goal, fund, run.

### Get the money back

A goal's payer keeps whatever its runs did not spend until the goal is closed and swept. The console
does both for its own goal. For everything else:

```bash
pnpm --filter @ntux402/e2e run sweep
```

That lists every goal on the vault whose payer still holds USDC, and what it would do with each. It
sends nothing. Add `-- --execute` to close the goals `DEPLOYER_PRIVATE_KEY` owns and return every
balance the signer holds a key for to the goal's owner. Goals owned by another wallet have to be
closed by that wallet in the console first. `-- --vault 0x…` targets another vault, and the signer
must be running against that same vault.

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
| `contracts/` | `EscrowPolicyVault`, `PolicyVault`, baselines, `KeyReleaseVerifier`, `TraceAnchor`; Foundry tests and fixtures; deployment broadcasts |
| `services/orchestrator/` | The untrusted component: agent loop, payment loop, relay |
| `services/signer/` | Authorization Signer. Runs in the ROFL enclave; holds the payer keys |
| `services/trace/` | Trace builder, Merkle accumulator, and the standalone verifier |
| `services/facilitator/` | Self-hosted x402 facilitator for the auth-capture escrow. Outside the trust boundary |
| `packages/shared/` | Types, the x402 client, chain helpers, the shared HTTP guard |
| `apps/web/` | Console — MetaMask goal opening, funding, run visualisation |
| `mock-api/` | Mock resource server — fabricated data at chosen prices |
| `tools/e2e/` | Keygen, funding, the end-to-end demo and adversary runners, and the sweep tool |
| `scripts/` | `dev`, `verify`, ABI sync, and the CI import-boundary check |
| `docs/runs/` | Every recorded run: logs, raw benchmark records, enclave identity. Index in its README |
| `docs/ARCHITECTURE.md` | The design, at more length than the paper |
| `paper/` | Not tracked on `main` for now. The paper's source, PDF, table generator and evaluation (injection study, leakage computation) are in tag `arxiv-v3` |
| `ARTIFACT.md` | Which record backs which claim, and how to reproduce it |

The standalone verifier referenced above lives in [`services/trace/`](services/trace/): it needs only
a trace file and a public RPC, and depends on no service in this repository.

The import boundary is enforced in CI: `pnpm check:boundary` asserts that the orchestrator cannot
import the signer.

---

## License

See [`LICENSE`](LICENSE).
