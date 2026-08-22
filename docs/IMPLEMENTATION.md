# LedgerLighthouse — Implementation Reference

**What this describes:** where every piece lives, the rules that govern changing it, and what proves
it works.
**Companions:** [`ARCHITECTURE.md`](ARCHITECTURE.md) for why the system has this shape;
[`PRIMER.md`](PRIMER.md) for the technologies underneath it.

---

## 1. Non-negotiables

These are invariants, not preferences. If a proposed change violates one, stop and raise it rather
than working around it.

1. **The orchestrator is untrusted.** It never holds the payer key, never evaluates or modifies
   policy, and is never granted access to a budget handle. It may *point* the signer at an
   already-finalized `(goalId, seq)` — that is a pointer, not an instruction, and the distinction is
   the whole design. It never supplies terms, amounts or addresses to the signer.
2. **The Authorization Signer stays.** Neither TEE provides EIP-3009 signing on Base. Do not remove
   the signer, do not merge it into the orchestrator, and do not add terms fields to its request
   schema. Not "validate and ignore them" — they must not be in the schema at all.
3. **The signer reads the chain, never the caller.** Its only input is `(goalId, seq)`. Every
   EIP-3009 field is read from the finalized on-chain record.
4. **No generic TEE substitution.** Each enclave is used for the thing it actually provides — Inco
   for confidential decisions, Oasis for key custody. Do not swap in a mock enclave and keep the
   vocabulary, and do not describe one as providing the other's guarantee.
5. **No invented APIs.** Anything not verified in current documentation or already present in the
   repo gets verified before use. Applies equally to Inco, Oasis and x402 payload shapes.
6. **Encrypted state is never revealed.** Only the per-request decision `ebool` is ever passed to
   `e.reveal`. Reveals are permanent.

---

## 2. Repository layout

```
contracts/              Foundry — PolicyVault, TraceAnchor, deploy scripts, cheatcode tests
packages/shared/        TS types across services: x402 schema, ABIs, USDC/EIP-3009 constants,
                        the demo catalog imported by every surface
services/orchestrator/  Untrusted. LLM + x402 client + payment loop. Relay key only.
services/signer/        Holds the per-goal payer key. Reads chain only. Dockerfile + rofl.yaml.
services/facilitator/   Self-hosted x402 v1 facilitator. Outside the trust boundary.
services/trace/         Hash chain, Merkle accumulator, standalone verifier CLI
apps/web/               MetaMask UI: landing page + execution console
mock-api/               x402-priced endpoints — one per catalog resource
tools/e2e/              Operator scripts: keygen, fund, balances, state, demo, tee-check
```

**The key boundary is enforced at the dependency level.** `services/orchestrator` must never import
`services/signer`, by package name or relative path. [`scripts/check-boundary.mjs`](../scripts/check-boundary.mjs)
fails CI if it does. This is a lint rule rather than a comment because it is the security property the
whole system rests on, and it is the one an LLM writing code will erode first.

---

## 3. Stack

| Layer | Choice | Notes |
|---|---|---|
| Chain | Base Sepolia (chainId **84532**) | Where the money and the confidential policy both live |
| Contracts | Solidity `0.8.29`, `cancun`, Foundry | Matches Inco's own template |
| Confidential decisions | `@inco/lightning` 1.0.2 (Solidity), `@inco/lightning-js` 1.0.2 (TS) | TEE-backed. The FHE-era package was `@inco/js`; it is not used |
| Key custody | Oasis ROFL, `tdx`, `kind: containers` | `rofl-appd` over a UNIX socket; no SDK dependency taken |
| Chain client | **viem** everywhere | Inco's own examples use viem; mixing in ethers creates friction |
| Wallet | wagmi + viem, MetaMask connector | One connector, no RainbowKit |
| Backend | TypeScript, Node 22+, `node:http` | Fewer moving parts around the component holding a key |
| Frontend | Vite + React + TS | |
| Tests | Foundry (Solidity) + Vitest (TS) | Inco cheatcodes for the encrypted path |
| Packages | pnpm 11 workspaces | Pinned via `packageManager`; `corepack enable` picks it up |

---

## 4. The keys, and who holds each

| Key | Holder | Signs | Can it move money? |
|---|---|---|---|
| **User** | MetaMask | `openGoal`, USDC funding transfer, `closeGoal` | Yes — it's theirs |
| **Payer** | Authorization Signer, per goal, ephemeral | EIP-3009 `transferWithAuthorization` | Only what the chain already approved |
| **Relay** | Orchestrator | `requestSpend`, `finalizeDecision` — **gas only** | No |
| **Facilitator** | Facilitator | Submits the settlement tx — **gas only** | No |

**Why the payer key is not MetaMask.** The agent must pay autonomously while the user is away. A
wallet prompt per payment defeats the product. The ephemeral key exists so the agent can act without
the user; the confidential policy exists so acting-without-the-user is bounded.

### 4.1 Key custody

`KeyStore` in [`services/signer/src/keystore.ts`](../services/signer/src/keystore.ts) is the seam.
`AuthorizationSigner` depends on the interface and never learns where keys come from.

| Implementation | Selected when | Key origin | On disk |
|---|---|---|---|
| `RoflKeyStore` | `SIGNER_ROFL_SOCKET` set | Derived in-enclave via `POST /rofl/v1/keys/generate` | `address -> key_id` only |
| `FileKeyStore` | `SIGNER_KEY_STORE_PATH` set | `generatePrivateKey()` | the private key |
| `InMemoryKeyStore` | neither set | `generatePrivateKey()` | nothing; lost on restart |

ROFL wins whenever its socket is configured, because asking for enclave custody and silently getting
a file instead is the failure mode worth designing out. If the socket is named but absent, `mint`
throws with a message saying so — better than appearing to work while writing keys to disk.

ROFL derivation is deterministic on `key_id`, so restart-survival needs only the non-secret index.
Losing that index makes keys unreachable: the price of never writing a secret down.

---

## 5. The MetaMask flow

Two of the three signing needs must **not** go through the wallet.

1. **Connect** — wagmi MetaMask connector, `switchChain` to 84532.
2. **Mint the payer address** — the signer derives the key and returns *only* its address. No wallet
   interaction. **Must happen before `openGoal`**, because the payer address is a field of the goal
   record.
3. **Encrypt the budget client-side** — `zap.encrypt(budget, { accountAddress, dappAddress,
   handleType: handleTypes.euint256 })`, bound to the connected address and the vault.
4. **Open the goal** — MetaMask sends `openGoal` with the ciphertext, the payer address from step 2,
   and `msg.value == inco.getFee()`. **Must come from the user's own address**, because ciphertext
   conversion binds to `msg.sender`.
5. **Fund the ephemeral payer** — the user sends USDC to that address, slightly above the encrypted
   budget.
6. **Hand off** — the orchestrator runs unattended. No further wallet prompts.
7. **Verify** — the UI shows the budget handle as an opaque `bytes32`, the decision per request, and
   the trace.

Steps 2 and 4 are ordered, not interchangeable.

### 5.1 What does not need MetaMask

Retrieving the decision. `e.reveal` makes the decision handle publicly accessible, so anyone may
request an attested decryption with **no EIP-712 signature**. This is why the design uses `reveal`
rather than `attestedDecrypt`: the payment loop must run unattended.

**A wallet prompt inside the payment loop means the design has drifted.**

### 5.2 Gotchas handled explicitly

- MetaMask caches a stale `chainId` after a manual network change — chain id is re-read before every
  write rather than trusted from connection time.
- Account switched mid-session invalidates the goal context; ciphertexts are bound to the address
  that produced them.
- Base Sepolia ETH and test USDC are separate faucet trips.
- Public RPCs are load-balanced, so a read immediately after a receipt may hit a node without that
  block. Reads that follow a write are bounded polls, not single calls.

---

## 6. Configuration

```
CHAIN_ID=84532                # asserted before every write; never inferred from the wallet
BASE_SEPOLIA_RPC_URL=
POLICY_VAULT_ADDRESS=
TRACE_ANCHOR_ADDRESS=
INCO_NETWORK=                 # Lightning network selector used by the SDK
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
X402_VERSION=1                # decides header names
X402_FACILITATOR_URL=         # unset falls back to stub settlement
SIGNER_KEY_STORE_PATH=        # local runs; never a key inline
SIGNER_ROFL_SOCKET=           # /run/rofl-appd.sock inside a ROFL container; blank locally
SIGNER_ROFL_INDEX_PATH=       # companion address -> key_id map; non-secret
ORCHESTRATOR_RELAY_KEY=       # gas only
FACILITATOR_PRIVATE_KEY=      # gas only
AISA_INFERENCE_KEY=           # inference only; unset falls back to the scripted agent
LLM_MODEL=                    # gateway model id; no default
```

`USDC_ADDRESS` carries a real value deliberately — it is a public testnet address, and a blank makes
it too easy to point the signer at whatever a 402 body claims.

**Never** put the payer key in the orchestrator's environment, even temporarily. Never log a handle
alongside its plaintext.

---

## 7. What is tested, and where

| Property | Where |
|---|---|
| 402 is control flow, not an error; malformed 402 rejected rather than coerced | `mock-api/`, `services/orchestrator/src/x402/` |
| Signer refuses an unapproved `(goalId, seq)` | `services/signer/src/service.test.ts` |
| A request carrying **any** terms field is rejected by schema validation | `services/signer/src/schema.test.ts` |
| Signer asserts USDC address, chain id and EIP-712 domain before signing | `service.test.ts` |
| An interrupted settlement retried with the identical tuple does not double-pay | `service.test.ts` |
| ROFL keys re-derive deterministically; no key material persisted; short keys rejected | `services/signer/src/keystore.test.ts` |
| In-policy spend approves; over-cap spend rejects with counters unchanged | `contracts/test/PolicyVault.t.sol` |
| `finalizeDecision` rejects a valid attestation for the **wrong** handle | `PolicyVault.t.sol` |
| Missing `allowThis` on a persisted handle is caught | `PolicyVault.t.sol`, Inco cheatcodes |
| Trace verifier rejects a tampered step and a swapped attestation | `services/trace/` |
| Orchestrator cannot import the signer | `scripts/check-boundary.mjs` |

**The retry test is the one that matters most.** `validAfter` / `validBefore` are frozen into the
on-chain record at `requestSpend`. If the signer regenerated the window from the clock, the retry
would be a different authorization and the token would happily execute it twice.

### 7.1 Commands

```sh
pnpm verify
```

Mirrors CI exactly: JSON syntax, frozen-lockfile install, build, typecheck, vitest, the boundary
check, `forge build`, `forge test`, and ABI-in-sync. Add `--skip-contracts` to run the TypeScript
half without Foundry.

```sh
pnpm --filter @ntux402/e2e run tee-check
```

The confidential path in isolation, against the live chain — encryption, handle, two decisions,
on-chain verification, and a flipped-plaintext attestation that must be rejected.

```sh
pnpm --filter @ntux402/e2e run demo
```

The whole product headless, including the injection and the bounce.

---

## 8. Guardrails

Anti-patterns that silently break the security story:

- Letting the signer accept an `amount` or `payTo` parameter "for convenience."
- Granting the orchestrator handle access to debug a failing check.
- Calling `e.allowThis` on intermediate results — unnecessary, and a habit that leads to granting on
  the wrong handle.
- Calling `e.reveal` on a budget handle to make a test pass. Reveals are permanent.
- Replacing the async reveal wait with a hardcoded `sleep`. Poll with a bounded timeout and surface
  the timeout as an outcome.
- Regenerating the EIP-3009 validity window on retry.
- Prompting MetaMask inside the payment loop.
- Catching a policy rejection and retrying with a smaller amount. The bounce is the product.
- Letting the signer read `asset` from anywhere but the goal record. A 402 body is a claim, not a
  source of configuration.
- Making the goal's payer address mutable after `openGoal`.
- Computing `remaining - amount` before the `e.select`. Select the operand instead.
- Falling back to a local key when the ROFL socket is unreachable.

---

## 9. Deploying the signer to ROFL

```sh
oasis rofl create --network testnet
```

```sh
oasis rofl build
```

```sh
oasis rofl deploy
```

Requires the `oasis` CLI, a publicly published `linux/amd64` image pinned by digest in
[`compose.yaml`](../services/signer/compose.yaml), and ~150 TEST ROSE for registration, machine
rental and gas. The image is built from the repo root because the signer imports `@ntux402/shared`:

```sh
docker buildx build --platform linux/amd64 -f services/signer/Dockerfile -t <registry>/<image> . --push
```

Two things carry the property. `compose.yaml` mounts `/run/rofl-appd.sock` into the container — the
only route to the enclave's key management. And no payer key appears anywhere in the image, a build
arg, or a secret, because one no longer has to exist outside the TEE.

Secrets go in via `oasis rofl secret set`, not baked into the image. The only ones needed are the RPC
URL and the two addresses.
