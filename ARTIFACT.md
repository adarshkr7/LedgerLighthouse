# Artifact

This repository is the artifact of the paper

> Adarsh Kumar. *A Payment Firewall for AI Agents: Bounded Spending Under Agent Compromise, and What Refunds Leak.*
> arXiv, version 3, November 2026. Tag `arxiv-v3`.

It holds the system, every test, every recorded run with its raw data, the evaluation code, and the script that
generates every data table in the paper from those records. Nothing in a table is typed by hand. Failed and stalled
runs are kept beside the successful ones and are labelled as such.

**On `main`, `paper/` is not tracked for now.** The paper's source, its table generator and the evaluation code and data
(`paper/arxiv-v3/`, `paper/eval/`) are in the tag `arxiv-v3`, which the paper cites: run `git checkout arxiv-v3`, or browse
[`https://github.com/adarshkr7/LedgerLighthouse/tree/arxiv-v3/paper`](https://github.com/adarshkr7/LedgerLighthouse/tree/arxiv-v3/paper). Rows below marked *(tag)* are there; everything else is on `main` too.

Earlier versions of the paper cite the tags `arxiv-v1`, `arxiv-v1.1` and `arxiv-v2`. Their evidence is still in
`docs/runs/`, and `docs/runs/README.md` says which vault and which design each record belongs to.

## Where things are

| Path | What it is |
| --- | --- |
| `paper/arxiv-v3/` *(tag)* | The paper: LaTeX source (`main.tex`, `sec-*.tex`, `fig-*.tex`), the built `main.pdf`, and `build.sh` (TeX Live in Docker) |
| `paper/arxiv-v3/tables/make_tables.py` *(tag)* | Regenerates every data table and every number macro (`numbers.tex`) from the records below |
| `paper/eval/injection-v2.mts`, `paper/eval/results-v2/` *(tag)* | Injection study, version 2: harness and every model answer |
| `paper/eval/injection-eval.mts`, `paper/eval/results/` *(tag)* | Injection study, version 1 (earlier versions of the paper) |
| `paper/eval/leakage/` *(tag)* | Exact leakage computation on three cap priors, and its output |
| `docs/runs/` | Every recorded run: console logs, raw benchmark records (JSON), enclave identity. Index: `docs/runs/README.md` |
| `contracts/src/EscrowPolicyVault.sol`, `PolicyVault.sol` | The vault |
| `contracts/src/baselines/` | Comparators: `PlaintextEscrowVault`, `EnclavePolicyVault`, `BaselineEscrowVault` |
| `contracts/src/delivery/KeyReleaseVerifier.sol` | The dispute predicate of the key-release protocol |
| `contracts/test/AccountingInvariants.t.sol`, `contracts/test/fixtures/escrow-state.json` | Stateful invariants J1 to J4 against a recorded snapshot of the escrow, collector and USDC |
| `contracts/mutate-accounting.py` | Mutation test of the invariant suite |
| `contracts/broadcast/` | Deployment records for every vault on Base Sepolia |
| `services/signer/` | The signer; `compose.yaml` pins its image digest, `rofl.yaml` its enclave measurements and policy |
| `services/orchestrator/`, `services/facilitator/`, `mock-api/`, `packages/shared/`, `apps/web/` | Agent and payment loop, x402 facilitator, mock vendor, shared code, console |
| `tools/e2e/` | Live runners: `tee-check`, `adversary` (the A2 campaign), `bench`, `baseline-bench`, `demo`, `sweep`, `reclaim` |

## Claims and their evidence

Names refer to the paper's theorems, tables and sections. "Live" means Base Sepolia with Inco's real covalidators.

| Claim | Evidence | Record |
| --- | --- | --- |
| Invariants J1 to J4 and the lifetime loss bound (Proposition "Invariants", Theorem "Lifetime loss bound") | 1,024 runs of 256 calls, no violation; 13 of 14 mutants killed, the survivor equivalent | `escrow-v3-2026-11-09-invariants.log`, `-invariants-reached.log`, `-invariant-mutants.json` |
| Loss bound, live; extraction to the exact ceilings | Campaign C1, C3, C13: 0.25 USDC on the budget-bound goal, 0.20 on the cap-bound goal | `escrow-enclave-2026-11-11-adversary.log` (signer in the enclave); `escrow-v3-2026-11-09-adversary.log` (local signer) |
| No authority from text (Property) | C7, C15 to C25 | same campaign logs |
| Authenticated enrollment (Section "Authenticated enrollment") | 12 Foundry tests in `contracts/test/Enrollment.t.sol`; C26 to C29 live | same campaign logs |
| Recorded funding deadline; reclaim cannot double-pay (Properties) | Deadline boundary tests; C6 live | Foundry suites; campaign logs |
| Decision-channel bound (Theorem) | Proof; C14 live; `contracts/test/ProbeLeak.t.sol` | campaign logs |
| What the bound leaves in practice (leakage table) | Exact computation | `paper/eval/leakage/out/summary.json` *(tag)* |
| Matched baselines | 2 runs of 10 interleaved rounds, plain x402 / plaintext vault / confidential vault | `baseline-bench-2026-11-09T140550.{json,log}`, `baseline-bench-2026-11-09T141612.{json,log}` |
| Full x402 path, local signer (benchmark table) | 2 runs, 100 calls, every one reported | `bench-v3-2026-11-09-run2.json`, `bench-2026-11-09T144203-0xdd45.json` and their logs |
| Full x402 path, signer in the enclave (benchmark table) | 1 run, 50 calls, every one reported; one failed on a late finalization, described in the paper | `bench-2026-11-11T090222-0x466a.json`, `escrow-enclave-2026-11-11-bench.log` |
| Recovery after a storage wipe | Machine restarted with its storage wiped; the enclave re-derived a payer's key from the chain and swept its 0.07 USDC to the owner | `enclave-v5-2026-11-11-after-wipe-sweep.log`, `enclave-v5-2026-11-11-identity.txt` |
| Inco round trip, enclave vault | Approval, rejection, flipped plaintext refused | `escrow-enclave-2026-11-11-tee-check.log` |
| Enclave identity | Image digest, measurements, app policy, replica, `/health` | `enclave-v5-2026-11-11-identity.txt`, `enclave-v5-2026-11-09-signer-image-build.log` |
| Injection study | Nemotron 3 Ultra, 5 trajectories per arm, 5 adaptive-vendor runs per arm | `paper/eval/results-v2/` *(tag)* |
| Delivery predicate gas (key-release section) | 5 Foundry tests, 86,894 gas at 4 KiB | `contracts/test/KeyReleaseVerifier.t.sol` |
| Enclave-held policy and plaintext comparator gas | Foundry tests on a pinned fork | `contracts/test/Baselines.t.sol` |

Failures kept on purpose: `escrow-v3-2026-11-09-bench-crashed.log` (the benchmark process crashed after 19 paid
calls, and its records were lost), `escrow-2026-11-06-bench.log` (Inco never revealed one decision and the goal
stalled), and the earlier designs' logs whose attacks succeeded, described in `docs/runs/README.md`.

## Deployments (Base Sepolia, chain 84532)

| Contract | Address | Deployment |
| --- | --- | --- |
| `EscrowPolicyVault`, enrollment key in the ROFL enclave | `0x466AB18595d2E71A87928c8d4A45F57a5D5ADFd5` | `0x4135f116…d17065`, 11 Nov 2026 |
| `EscrowPolicyVault`, enrollment key from a local seed | `0xdd450306ca3905612a96Ff92aDbee23B48385014` | `0xb5ef280c…7a55ac`, 9 Nov 2026 |
| `PlaintextEscrowVault` (baseline) | `0x9c9D87550C556cD51591CbBDbe6B28895761D224` | 9 Nov 2026 |
| Commerce-payments `AuthCaptureEscrow` v1.1.0 | `0xf968…B19c` (code hashes in the paper's end-to-end binding section) | upstream |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Circle |

The two `EscrowPolicyVault` deployments have identical runtime code except for three immutables: the enrollment
address, the vault's own address and the EIP-712 domain separator derived from it. Earlier vaults, for earlier
versions of the paper, are listed in `README.md` and `docs/runs/README.md`.

Enclave: Oasis ROFL app `rofl1qr0fv0qs2u8vmmah0ucmwegcj2cdz7kj4qzjduhp` on Sapphire testnet; signer image
`docker.io/schwarzite/totem-signer@sha256:f8d12e03a682b62d2b9740d0bab49d35d92b2a1274633005686e320b8bbb267c`;
enrollment key `0x5Ddd4f587818B39960987ea4Df34b9D94E29193a`, derived by Oasis's key manager for admitted instances
only. The accepted measurements are in `services/signer/rofl.yaml` and on chain (`oasis rofl show`).

## Reproducing

Four levels, from what needs nothing to what needs rented hardware. A pass at a lower level says nothing about the
live evidence above it.

**1. Offline, no network.** Node 22, pnpm, Foundry, Python 3.

```
pnpm install
pnpm verify                                   # typecheck, all TypeScript tests, Foundry tests, import boundary
cd contracts && forge test --match-contract AccountingInvariants   # J1-J4 from the recorded snapshot
cd contracts && python -I mutate-accounting.py                     # the 14 mutants
pnpm --filter @ntux402/e2e run bench:stats ../../docs/runs/bench-v3-2026-11-09-run2.json   # any bench record's statistics
git checkout arxiv-v3                                              # the three lines below need the tag
python -I paper/eval/leakage/leakage.py                            # the leakage table's inputs
python -I paper/arxiv-v3/tables/make_tables.py                     # every table, from docs/runs and paper/eval
paper/arxiv-v3/build.sh                                            # the PDF (Docker)
```

The fork suites (`Baselines`, `DeployEscrowPolicyVault`, the live-state variant of the invariants) skip without
`ESCROW_FORK_RPC` and print that they skipped.

**2. A local fork.** The full flow and the operator scripts against a fork of Base Sepolia, with a stand-in that
applies the policy in the clear. It tests the flow, not the encrypted comparison.

```
ESCROW_FORK_RPC=https://sepolia.base.org forge test            # from contracts/
anvil --fork-url https://sepolia.base.org --port 8599 --block-time 1
ESCROW_ANVIL_RPC=http://127.0.0.1:8599 pnpm --filter @ntux402/e2e run fork-tools
```

**3. Live on Base Sepolia.** Needs funded test keys and test USDC (`README.md`, "Configure"), Inco's covalidators,
and `pnpm dev` running. Then `tee-check`, `adversary`, `bench` and `baseline-bench` from `tools/e2e`, as named in
each log's first line. The injection study needs a model gateway:
`pnpm --filter @ntux402/e2e exec tsx ../../paper/eval/injection-v2.mts <model>`, from the tag.

**4. The enclave.** An Oasis ROFL machine on Sapphire testnet, deployed from `services/signer/rofl.yaml`
(`README.md`, "Deploying the enclave"). Point `SIGNER_URL` at it; its `/health` reports `"store":"rofl"` and the
enrollment address the vault must pin.

## What this artifact is not

It is testnet evidence. No contract has been audited, nothing has run on mainnet, and the ROFL machine is a
`playground_short` rental its provider marks as testnet only. Base cannot verify an Oasis attestation, so a third
party reading Base sees signatures from payer addresses, not where their keys live; the link between the two is the
app policy on Sapphire and the enrollment key the vault pins.
