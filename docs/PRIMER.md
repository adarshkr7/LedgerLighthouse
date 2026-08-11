# LedgerLighthouse — Technical Primer

Everything this project is built on, from first principles. Written to be read start to finish by
someone who has to defend the design out loud, and to be skimmed by section when a specific question
lands.

**Companions:** [`ARCHITECTURE.md`](ARCHITECTURE.md) for how the pieces fit;
[`IMPLEMENTATION.md`](IMPLEMENTATION.md) for where the code is.

---

## Contents

1. [The problem](#1-the-problem)
2. [Money on a blockchain](#2-money-on-a-blockchain)
3. [EIP-712 — signing structured data](#3-eip-712--signing-structured-data)
4. [EIP-3009 — transferWithAuthorization](#4-eip-3009--transferwithauthorization)
5. [x402 — paying over HTTP](#5-x402--paying-over-http)
6. [Trusted Execution Environments](#6-trusted-execution-environments)
7. [Inco Lightning](#7-inco-lightning)
8. [Oasis ROFL](#8-oasis-rofl)
9. [Why two TEEs](#9-why-two-tees)
10. [Cryptographic inventory](#10-cryptographic-inventory)
11. [The engineering stack](#11-the-engineering-stack)
12. [The system end to end](#12-the-system-end-to-end)
13. [Numbers worth memorising](#13-numbers-worth-memorising)
14. [Question drill](#14-question-drill)
15. [Glossary](#15-glossary)

---

## 1. The problem

An AI agent that can spend money has to do two things that are dangerous together:

- **Read attacker-controlled text.** HTTP response bodies, error messages, vendor descriptions. Any
  of it can contain instructions aimed at the model.
- **Decide when to spend.** Which means holding, or being able to trigger, spending authority.

Put both in one component and a prompt injection becomes a direct path to draining a budget.

The usual mitigation is a filter — a classifier or a system prompt telling the model to ignore
instructions in tool output. That is a **probabilistic control guarding a deterministic,
irreversible asset**. A filter that is 99% accurate fails one call in a hundred. Agents make
thousands of calls. The arithmetic does not work.

The alternative is not to make the agent more trustworthy but to make its trustworthiness
irrelevant: give the component that reads the text no spending authority, and give the component
that grants spending authority no exposure to the text.

That is a *structural* control. It does not degrade with a cleverer injection.

---

## 2. Money on a blockchain

### 2.1 Accounts

An **EOA** (externally owned account) is an address derived from a secp256k1 keypair. Whoever holds
the private key controls the account. A **contract account** has code but no key — it cannot sign
anything, only react to calls. That distinction matters later: it is why this system cannot eliminate
the signer.

### 2.2 ERC-20 and USDC

ERC-20 is the token interface: `balanceOf`, `transfer`, `approve`, `transferFrom`. Balances are just
entries in the token contract's storage.

**USDC on Base Sepolia** is at `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, implementation
`FiatTokenV2_2`, with **6 decimals** — so `1_000_000` is one dollar and `200_000` is twenty cents.
Every amount in this project is an integer in those base units. `0.20 USDC` is `200000n`.

Getting decimals wrong by a factor of 100 is the classic testnet embarrassment. The codebase keeps a
`formatUsdc` helper so displayed values and charged values come from the same conversion.

### 2.3 Why not `approve` + `transferFrom`

The obvious way to let something spend on your behalf is `approve(spender, amount)` then have the
spender call `transferFrom`. Two problems for an autonomous agent:

- **The allowance is standing authority.** It sits on chain until revoked. Whoever controls the
  spender can drain up to the allowance at any time, in any number of transactions.
- **The payer must send a transaction to grant it** — gas, and a wallet prompt.

What this design needs instead is authority that is **single-use, pre-shaped, and expiring**. That is
exactly EIP-3009.

---

## 3. EIP-712 — signing structured data

Signing a raw hash is dangerous: the signer cannot see what they are agreeing to, and a signature
valid on one chain or contract may be replayable on another.

EIP-712 fixes both by hashing **typed structured data** together with a **domain separator**.

```
domainSeparator = keccak256(
  keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  keccak256(name), keccak256(version), chainId, verifyingContract
)

digest = keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))
```

The `0x1901` prefix distinguishes this from ordinary transaction signing. Because `chainId` and
`verifyingContract` are inside the domain, a signature for USDC on Base Sepolia is meaningless for
USDC on any other chain.

**USDC's domain on Base Sepolia:** `name: "USDC"`, `version: "2"`, `chainId: 84532`,
`verifyingContract:` the token address.

The signer in this project does not take those on faith. Before signing it reads the token's own
`DOMAIN_SEPARATOR()` and compares it to the one it computed locally. A mismatch is a refusal, because
a signature under the wrong domain is unusable and guessing at `name`/`version` produces exactly
that.

---

## 4. EIP-3009 — transferWithAuthorization

EIP-3009 lets a token holder authorize a transfer by **signature alone**, with someone else paying
the gas.

```solidity
function transferWithAuthorization(
    address from, address to, uint256 value,
    uint256 validAfter, uint256 validBefore, bytes32 nonce,
    uint8 v, bytes32 r, bytes32 s
) external;
```

The properties that matter here:

- **Gasless for the payer.** The payer signs; anyone can submit. This is what lets a facilitator
  settle without the payer ever sending a transaction.
- **Time-bounded.** `validAfter` / `validBefore` are inside the signed message, so an authorization
  expires on its own.
- **Single-use.** The `nonce` is an arbitrary `bytes32` tracked per authorizer. Once used, that
  authorization is dead.
- **Exactly shaped.** `to` and `value` are signed. A facilitator cannot redirect or inflate it.

Compare that to an allowance: this is authority for *one* transfer, of *one* amount, to *one*
address, inside *one* time window.

### 4.1 The idempotency trap

**The nonce alone is not the unit of replay protection — the whole tuple is.** The token marks the
*authorization* used, and the authorization is `(from, to, value, validAfter, validBefore, nonce)`.

So if a settlement times out with an unknown outcome and you retry, you must re-send the **identical
tuple byte for byte**. Regenerate `validBefore` from the current clock and you have produced a
*different* authorization with the same nonce — which the token will happily execute as well. That is
a double-pay.

This is why `requestSpend` freezes `validAfter` and `validBefore` into on-chain storage, and the
signer reads them back rather than computing them. Expiry is therefore a **refusal**, never a
re-issue.

Window: one hour, clamped to the goal's expiry so an authorization can never outlive its goal.

### 4.2 The nonce

```
nonce = keccak256(abi.encode(goalId, seq))
```

Deterministic, so a retry reproduces it exactly. `abi.encode` and not `encodePacked`, because packed
encoding concatenates without length prefixes and two distinct pairs could collide. Uniqueness holds
because the payer key is per goal and `seq` is per goal and monotonic.

---

## 5. x402 — paying over HTTP

x402 revives the long-unused HTTP status code **402 Payment Required** as real protocol.

### 5.1 The exchange

1. Client requests a resource with no payment.
2. Server replies **402** with a JSON body describing what it wants.
3. Client constructs a payment payload and retries with an `X-PAYMENT` header.
4. Server (usually via a facilitator) verifies and settles, then returns the resource plus
   `X-PAYMENT-RESPONSE`.

### 5.2 The 402 body, v1

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base-sepolia",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "maxAmountRequired": "350000",
    "payTo": "0x…",
    "resource": "/compliance-audit",
    "description": "…",
    "maxTimeoutSeconds": 60,
    "extra": { "name": "USDC", "version": "2" }
  }]
}
```

**The amount field is `maxAmountRequired`, never `amount`.** The internal `Terms.amount` is derived
from it, and the two names are kept distinct in code so a parser bug cannot silently substitute one
for the other.

`extra.name` / `extra.version` carry the EIP-712 domain — but that is the *vendor's claim*. The
on-chain values are authoritative and the signer checks against those.

### 5.3 v1 versus v2

| | v1 (**used here**) | v2 |
|---|---|---|
| Request header | `X-PAYMENT` | `PAYMENT-SIGNATURE` |
| Response header | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` |
| 402 header | — | `PAYMENT-REQUIRED` |
| `network` | slug — `base-sepolia` | CAIP-2 — `eip155:84532` |

The parser rejects a v2-shaped body rather than adapting to it. Silent version tolerance is how a
client ends up signing something it did not model.

### 5.4 The facilitator

A facilitator is infrastructure that verifies and submits payments so the resource server does not
have to touch chain plumbing. Interface: `POST /verify`, `POST /settle`, `GET /supported`.

It is **outside the trust boundary**. It holds a gas key and can submit or withhold, but it cannot
alter terms — the EIP-3009 signature covers them. The self-hosted facilitator here matches the hosted
shape, so switching to Coinbase's is a URL change.

### 5.5 The `exact` scheme forces the signer to exist

`exact` requires an EIP-3009 signature from the payer. EIP-3009 signatures come from EOA keys.
**Contracts cannot sign.** So a contract cannot be the payer under this scheme, and something
key-holding has to exist. Escrow-based scheme variants avoid it — real, but a different design.

This is why "just remove the signer" is not available, and why the productive question is *where does
its key live* rather than *can we delete it*.

---

## 6. Trusted Execution Environments

### 6.1 What a TEE is

A hardware-isolated region of a CPU where code and data are protected from everything outside —
including the operating system, the hypervisor, and whoever physically owns the machine. Memory is
encrypted by the CPU; the host sees ciphertext.

Two Intel flavours matter:

- **SGX** — process-level enclaves. Small trusted computing base, awkward programming model.
- **TDX** — VM-level "trust domains". You run a whole guest VM protected from the host. Much easier
  to deploy real software into, which is why container-based platforms use it.

### 6.2 Remote attestation

Isolation alone is worthless if you cannot tell whether you are talking to a real enclave. Attestation
solves it: the CPU signs a **quote** containing a measurement of the code loaded into the enclave,
chained to a vendor certificate. A verifier checks the signature and compares the measurement against
what it expects.

The claim it establishes: *"this specific code is running inside genuine hardware with confidentiality
enabled."*

### 6.3 What a TEE does not give you

- **Not a correctness proof.** It attests *which* code ran, not that the code is good. Audit is still
  yours.
- **Not immunity to side channels.** Timing, cache behaviour, memory access patterns and power draw
  have all leaked secrets out of enclaves.
- **Not trustless.** You are trusting the silicon vendor and their attestation service. This is a
  weaker assumption than "trust the operator", but it is not zero.
- **Not availability.** An enclave that stops responding stops your system.

### 6.4 TEE versus FHE — the distinction to get right

**FHE** (fully homomorphic encryption) computes on ciphertext directly. Trust rests on mathematics —
no hardware assumption at all — at a very large performance cost.

**TEE** decrypts inside protected hardware and computes in plaintext there. Trust rests on the CPU
vendor. Orders of magnitude faster.

**Inco Lightning is TEE-based.** Its SDK's only cryptographic dependencies are HPKE libraries — key
transport to an enclave — and there is no FHE runtime in it. Inco's FHE-era package was `@inco/js`;
the rename to `@inco/lightning-js` came with the change of substrate, so an old sample showing
`@inco/js` is also showing the old architecture.

---

## 7. Inco Lightning

### 7.1 What it is

A **confidentiality layer for existing blockchains** — not a new chain, and not an enclave you deploy
your own code into. Three parts:

1. **Solidity library** (`@inco/lightning`) — encrypted types and operations in ordinary Solidity.
2. **Confidential Compute Server** — runs inside a TEE; executes confidential operations and
   decryption requests, checking access control first.
3. **Client JS library** (`@inco/lightning-js`) — encrypts inputs, requests decryptions.

Live on Base mainnet and Base Sepolia. The executor singleton on Base Sepolia is
`0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624`; the verifier is
`0x867758FFe098fB0D74826A8DCf60127696440f09`.

### 7.2 The execution model — the single most important idea

**Encrypted variables are `bytes32` handles, not values.** Your contract manipulates identifiers; the
actual data lives off chain in encrypted form.

Every encrypted operation is a call into the Inco singleton, which checks access control and **emits
an event**. The compute server processes those events afterwards.

Three consequences that shape the entire design:

- **Your contract never sees a plaintext.** Not a number, not a boolean.
- **Handles are immutable.** Reassigning produces a *new* handle; the old one still decrypts to the
  old value, forever. Inco never deletes.
- **The transaction commits handle lineage and access state; the computation resolves afterwards.**
  Synchronous commit, asynchronous result.

### 7.3 Types and operations

| Capability | Available |
|---|---|
| Types | `euint256`, `ebool`, `eaddress` |
| Arithmetic | `add`, `sub`, `mul`, `div`, `rem`, shifts, rotates |
| Bitwise | `and`, `or`, `xor` — also on `ebool` |
| Comparison | `eq`, `ne`, `ge`, `gt`, `le`, `lt` → all return `ebool` |
| Min/max/not | `min`, `max` return `euint256`; `not` negates an `ebool` — **these are not comparisons** |
| Multiplexer | `select(ebool, a, b)` |
| Randomness | `rand`, `randBounded` — charge the fee |
| Access control | `allow`, `allowThis`, `reveal`, `isAllowed` |

Binary operations accept an e-type **or a plain value** as either argument, which is why comparing an
encrypted budget against a public amount works directly.

### 7.4 You cannot branch on a secret

`if`/`else` on an encrypted condition is forbidden — the path taken would leak it. So is `revert` on
one. The substitute is the multiplexer: compute both outcomes, choose with `select`.

**This constraint is load-bearing in our favour.** Because the debit cannot be conditional on an
`if`, it must be applied unconditionally with `select`, which means the debit commits *before anyone
can learn the decision*. The platform enforces write-ahead ordering that we would otherwise have to
argue for.

Select the **operand**, not the result:

```solidity
ebool ok       = budget.ge(amount);
euint256 debit = ok.select(amount.asEuint256(), uint256(0).asEuint256());
euint256 next  = budget.sub(debit);   // always well-defined
```

The alternative — `select(ok, budget.sub(amount), budget)` — computes an underflowed value on every
rejection and relies on nobody reading it.

### 7.5 Access control

- `allow(v, addr)` grants **permanent** access to that handle: see it, decrypt it, compute over it.
- `allowThis(v)` is `allow(v, address(this))`.
- Operation results are **transiently** allowed to the calling contract for the current transaction —
  which is why chained operations work. `allowThis` is needed only for handles **persisted across
  transactions**.
- `reveal(v)` makes a handle **publicly decryptable, permanently**.

The correct mental model: anyone ever granted access — transient or permanent — must be assumed to
know the value forever. Transient is not "safer".

**Forgetting `allowThis` after a debit is the single most likely way to brick the system.** The vault
would permanently lose the ability to compute over its own budget. Foundry cheatcode tests cover it
precisely because the failure is silent until the next spend.

### 7.6 Attestations

Signatures over a `(handle, value)` pair, verified on chain through the Inco verifier. Three
retrieval paths:

| Path | Requires | Use |
|---|---|---|
| `attestedDecrypt` | EIP-712 signature from an address with `allow` access | Private reveal to one party |
| `attestedReveal` | Handle already passed to `reveal` — **anyone may ask** | Public results |
| `attestedCompute` | One handle vs one public scalar, comparisons only | Simple predicates, no extra tx |

**This project uses `attestedReveal`, deliberately.** Because `reveal` already made the decision
handle public, retrieval needs **no wallet signature** — which is precisely what lets the payment loop
run unattended. `attestedDecrypt` would require a signature from an address with access, and a wallet
prompt inside the payment loop would defeat the product.

**The mandatory pattern:** verifying the signature is not enough. You must also check the attested
handle equals the handle you expected. Otherwise a genuine attestation for a *different* handle can
be substituted. `finalizeDecision` verifies against the handle the contract itself stored, and the
claimed plaintext is covered by the signatures, so a flipped claim does not verify.

### 7.7 What Inco does not provide

- **No key custody. No transaction signing.** This is the gap Oasis fills.
- **No attestation of your application.** There is no enclave measurement of *your* code exposed to
  you. Do not say "Inco attests my agent ran correctly." It attests that a handle decrypts to a value.
- **No deletion.** Handles are permanent; goal closure is ordinary public state.
- **No durability you control.** Ciphertexts live in Inco's off-chain storage.

### 7.8 Fees

Converting a client ciphertext into a handle charges `inco.getFee()` — currently `1e12` wei
(0.000001 ETH). That is why `openGoal` is `payable` and asserts `msg.value == inco.getFee()`.
Comparison, select, sub and reveal do **not** charge, which is why `requestSpend` is not payable.

### 7.9 Five things people get wrong

1. *"Encrypted state lives on chain."* Handles do; values live off chain.
2. *"The check and the decision are one atomic transaction."* The commit is atomic; the plaintext
   decision arrives later.
3. *"`allowThis` is a compute permission."* It grants full access including decryption.
4. *"Chain finality gives replay protection."* It gives ordering. Replay protection is yours to build.
5. *"I can express my whole policy with `attestedCompute`."* Only single-handle-versus-scalar.

---

## 8. Oasis ROFL

### 8.1 The gap it fills

Inco decides. Something still has to **hold the key that acts on the decision**. Left alone, that is
a private key in a file, defended by a process boundary and a CI lint rule.

**ROFL** (Runtime OFfchain Logic) runs containerized applications inside Intel TDX enclaves,
registered and attested on Oasis Sapphire.

### 8.2 `rofl-appd`

Every ROFL app gets a daemon exposing a REST API over a UNIX socket at `/run/rofl-appd.sock`. The
socket exists **only inside the container** — that is the whole access-control story.

| Endpoint | Purpose |
|---|---|
| `GET /rofl/v1/app/id` | The app's on-chain identifier |
| `POST /rofl/v1/keys/generate` | Derive a key |
| `POST /rofl/v1/tx/sign-submit` | Submit a transaction authenticated as the app |
| `GET/POST/PUT/DELETE /rofl/v1/metadata` | App metadata |
| `POST /rofl/v1/query` | Chain queries |

Key generation:

```json
POST /rofl/v1/keys/generate
{"key_id": "payer/…", "kind": "secp256k1"}

→ {"key": "a54027bff15a8726b6d9f65383bff20db51c6f3ac5497143a8412a7f16dfdda9"}
```

Kinds: `raw-256`, `raw-384`, `ed25519`, `secp256k1`. **The key comes back unprefixed** — viem needs
`0x`, and a truncated key would otherwise derive a valid-looking but wrong address whose first symptom
is a settlement against an unfunded payer. Normalise and assert 64 hex characters.

Two properties do the work:

- **Keys can only be generated inside properly attested app instances.** Not "the container refuses" —
  the on-chain key management system will not serve an unattested instance.
- **Derivation is deterministic on `key_id`**, and survives redeployment or state erasure.

That second property has a pleasant consequence: restart-survival needs only the **non-secret**
`address -> key_id` index. No private key is ever written to disk. Lose the index and keys become
unreachable — the price of never writing a secret down.

### 8.3 Deployment shape

```yaml
tee: tdx
kind: containers
resources: { memory: 512, cpus: 1, storage: { kind: disk-persistent, size: 512 } }
artifacts: { container: { compose: compose.yaml } }
deployments:
  default: { network: testnet, paratime: sapphire, policy: { … } }
```

Requirements: a **publicly reachable OCI image**, `platform: linux/amd64`, pinned by `@sha256:` digest
so deployed bytes cannot drift from audited ones, and ~150 TEST ROSE for registration, machine rental
and gas. The socket is bind-mounted in via `compose.yaml`.

Deployment is to a **provider's** TDX machine — you do not need enclave hardware yourself.

### 8.4 Sapphire, briefly

Sapphire is Oasis's confidential EVM ParaTime. All contract state is encrypted and only the contract,
executing inside an attested node, can decrypt it — so contracts read their own secrets in plaintext
and **branch on them with ordinary `if`**. Calldata is encrypted too.

Not used for the vault here, and the reason matters: the money is on Base. Moving the policy to
Sapphire would put it on a different chain from the funds and require a bridge in the middle of the
security argument. Sapphire's own docs are also blunt about the cost of being able to branch — timing,
gas, storage access patterns and unencrypted events all leak.

---

## 9. Why two TEEs

Two different questions, two different answers.

| | Inco Lightning | Oasis ROFL |
|---|---|---|
| Question | What did the policy decide? | Who holds the key? |
| Chain | Base Sepolia | Sapphire Testnet |
| Mechanism | Enclave compute over handles; attestations verified on chain | Enclave-derived key, released only to attested instances |
| Without it | The budget is public; the agent can read it | The payer key sits on disk; an operator can take it |

**They never talk to each other and nothing bridges between them.** Inco rules on a spend; the enclave
in Oasis signs an EIP-3009 authorization for a spend Base already approved. The money never leaves
Base.

**The honest limit:** Base cannot verify Oasis attestations. Custody is real, but the binding between
payer address and enclave identity is asserted by the app, not checkable by a third party from Base.
Publishing that binding to Sapphire — where attestation is native — would close it.

---

## 10. Cryptographic inventory

| Primitive | Where it is used |
|---|---|
| **secp256k1 / ECDSA** | Every EOA signature: the user's transactions, the payer's EIP-3009 authorization, the relay's gas transactions |
| **keccak256** | The EIP-3009 nonce, the `termsHash`, every trace step hash, the Merkle tree |
| **EIP-712** | Structuring and domain-separating the payment authorization |
| **HPKE** (RFC 9180) | How the browser encrypts the budget *to the Inco enclave* — `@hpke/core`, `@hpke/hybridkem-x-wing`, `@hpke/chacha20poly1305` |
| **Hash chain** | `step_hash = H(prior ‖ type ‖ H(in) ‖ H(out) ‖ ts)` — tamper-evident ordering |
| **Merkle tree** | Compresses the trace to a 32-byte root cheap enough to anchor on chain |
| **TEE remote attestation** | Underneath both Inco's decisions and Oasis's key release |

### 10.1 Why a hash chain *and* a Merkle root

The chain makes each step depend on its predecessor, so no step can be altered, removed or reordered
without breaking every hash after it. The Merkle root then compresses the whole trace to 32 bytes,
which is cheap to anchor and lets anyone holding the trace verify it against the chain.

Anchoring the full trace instead would leak prompts, purchased data and vendor relationships, and
cost would scale with volume.

---

## 11. The engineering stack

| Tool | Role | Worth knowing |
|---|---|---|
| **pnpm workspaces** | Monorepo | `workspace:*` deps; `--ignore-scripts` because git-hosted Solidity deps declare JS build scripts we never use |
| **TypeScript / Node 22+** | Services | `node:http` rather than a framework around the key-holding component |
| **viem** | Chain client | Typed ABIs, `parseEventLogs`, `waitForTransactionReceipt` |
| **wagmi** | Wallet in React | MetaMask connector, `switchChain` |
| **Foundry** | Contracts | `forge build` / `forge test`; Inco cheatcodes simulate the enclave locally |
| **Vitest** | TS tests | Interface seams (`RoflAppd`, `DecisionReader`) make enclave paths testable with no enclave |
| **Vite + React** | Frontend | |

### 11.1 Testing philosophy worth articulating

Both enclave dependencies sit behind **injectable interfaces** — `DecisionReader` for Inco,
`RoflAppd` for Oasis. So the logic around them is tested on a laptop with no TEE at all, and what
remains untestable locally is exactly the part the vendors provide.

The `tee-check` script covers the rest against the live chain, and its most important assertion is
adversarial: re-submit each attestation with the plaintext **flipped** and require on-chain
verification to reject it. If that passed, the attestation would be decoration.

---

## 12. The system end to end

**Setup.** The signer derives an ephemeral payer key (in-enclave under ROFL) and returns only its
address. The browser encrypts the budget to the Inco enclave, bound to the user's address and the
vault. The user sends `openGoal` — their own transaction, because ciphertext conversion binds to
`msg.sender` — paying the Inco fee. They fund the payer with slightly more USDC than the encrypted
budget, giving a second independent bound.

**A call.** The orchestrator requests a resource and gets `402`. A strict parser extracts
`maxAmountRequired`, `payTo`, `asset` and `resource` from the schema. The `description` — which may
contain an injection — reaches only the model.

**The commit.** The relay calls `requestSpend`. Structural checks revert; policy checks resolve into
the decision. Only the budget comparison touches Inco. The debit is applied unconditionally via
`select`, `seq` increments, `termsHash` and the validity window are frozen, and the decision handle is
revealed. **At this instant nobody knows the answer.**

**The decision.** 7–12 seconds later the compute server has processed the events. `attestedReveal`
returns the plaintext plus two signatures. `finalizeDecision` verifies them against the handle the
contract stored; on approval the public call counter decrements.

**The settlement.** The signer is asked about `(goalId, seq)` — nothing else. It re-reads the chain,
checks every refusal condition, and signs the EIP-3009 tuple exactly as frozen. The facilitator
settles. The resource returns.

**The bounce.** If the decision was false, the signer has nothing to sign. The attempt still burned a
`seq` and still appears in the trace, with its handle and signatures, verifiable by anyone.

**The record.** Every step is hash-chained, the root anchored on Base. The standalone verifier needs
only the file and a public RPC.

---

## 13. Numbers worth memorising

| | |
|---|---|
| Chain | Base Sepolia, **84532** |
| PolicyVault | `0x0C759D06a1c14F43852D7b078Db2f8C342F15921` |
| Inco executor | `0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624` |
| Inco verifier | `0x867758FFe098fB0D74826A8DCf60127696440f09` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals |
| Inco fee | `1e12` wei = 0.000001 ETH, on ciphertext→handle only |
| Encryption | 28–52 ms client-side |
| `openGoal` | ~336,600 gas |
| `requestSpend` | ~296,600 gas |
| `finalizeDecision` | ~101,400–106,800 gas |
| Decision latency | **7–12 s**, 1–2 polls, 2 signatures |
| Poll bound | 180 s, and a timeout is a *reported outcome* |
| Demo budget | 0.20 USDC encrypted; cap 6.00 public |
| Prices | 0.01 and 0.12 settle · 0.35 and 5.00 refused |
| Tests | 211 TypeScript + 23 Foundry = **234** |

---

## 14. Question drill

**"The computation is off-chain, so what did Inco actually prove?"**
Inco proves the decision. The chain proves the decision was committed before it was knowable. The
signer is bounded to decisions already on the chain. Oasis proves nobody can take the key that acts
on it.

**"Why not just filter the prompt injection?"**
Because that is a probabilistic control guarding a deterministic asset. We assume the filter fails —
the demo shows it failing — and the money still does not move.

**"Your agent got fooled. Isn't that a failure?"**
It is the point. The agent complying is the demonstration that the control is structural rather than
behavioural. If the agent had refused, the demo would prove only that this particular injection was
weak.

**"Couldn't the orchestrator just lie about the amount?"**
Understating wastes money and settles insufficient — policy intact. Overstating is bounded by
`perCallCap × callsRemaining`, paid only to an allowlisted payee. Closing that fully would mean
parsing the 402 inside the trusted component, which reintroduces the attack.

**"Why is `compliance-audit` the interesting refusal?"**
No injection, unremarkable copy, allowlisted payee, 0.35 against a public 6.00 cap. Every plaintext
precondition passes. Nothing public can refuse it — so the refusal came from the encrypted budget and
nowhere else.

**"What if Inco stalls?"**
The debit has already committed, so "decision unavailable" is a distinct state from "rejected".
Polling is bounded at 180 s and the timeout is reported, not swallowed — conflating them would
misreport where the money went.

**"Why is the per-call cap public?"**
So a bounce cannot be attributed to it. It is set deliberately *above* every demo price. A refusal
therefore has exactly one possible source.

**"What stops a replay?"**
The frozen EIP-3009 tuple plus `seq` plus `termsHash`. Not chain finality — that gives ordering, not
replay protection.

**"Is this FHE?"**
No. Inco Lightning is TEE-based; its SDK ships HPKE, not an FHE runtime. The FHE-era package was
`@inco/js`, which is not used here.

**"What are you still trusting?"**
Silicon vendors for confidentiality; Inco's off-chain storage for availability; attester liveness; the
signer's *code* (its key is enclave-held, its logic is audited not attested); and per-payment amounts
are public by design.

**"Why two TEEs instead of one?"**
They answer different questions. Deciding confidentially and holding a key are separate problems, and
one enclave doing both would need the money and the policy on the same chain — which would mean a
bridge.

---

## 15. Glossary

**Attestation** — a signed statement from an enclave. Inco's is over `(handle, value)`; Oasis's is
over the identity of a running app.

**EOA** — externally owned account, controlled by a private key. Contracts are not EOAs and cannot
sign.

**Facilitator** — infrastructure that verifies and submits x402 payments. Untrusted; the signature
covers the terms.

**Goal** — one funded, time-bounded spending mandate: encrypted budget, public cap, call count,
allowlist, payer, relay, expiry.

**Handle** — a `bytes32` identifier for an encrypted value. The value lives off chain. Immutable;
every write produces a new one.

**HPKE** — Hybrid Public Key Encryption, RFC 9180. How the browser encrypts to the Inco enclave.

**Multiplexer pattern** — computing both branches and choosing with `select`, because branching on a
secret would leak it.

**ParaTime** — an Oasis runtime. Sapphire is the confidential EVM one.

**Relay** — the orchestrator's gas-only key. Submits `requestSpend` and `finalizeDecision`;
authorizes nothing.

**ROFL** — Runtime OFfchain Logic. Containerized apps in Oasis TDX enclaves.

**`seq`** — monotonic per-goal spend counter. Increments even on rejection, so bounces appear in the
trace.

**`termsHash`** — commitment over everything the signature must match, including the payer.

**Write-ahead ordering** — debiting before the decision is knowable. Enforced by the platform, since
you cannot branch on an encrypted condition.
