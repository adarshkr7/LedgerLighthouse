# Deploying the Authorization Signer to Oasis ROFL

The step that closes the biggest gap between what this project claims and what it runs.

Right now the payer key is a file at `.keys/payers.json`. The claim *"no operator can extract
it"* is true of `RoflKeyStore` and false of what is executing. Everything needed to fix that
is committed — `rofl.yaml`, `Dockerfile`, `compose.yaml`, and 12 tests over the key path.
What is missing is a deployment.

**Time:** half a day, most of it waiting on image builds and registration.
**Cost:** ~150 TEST ROSE, free from the faucet.
**Status of these instructions:** the CLI sequence is from Oasis's own quickstart; the
repo-specific parts are read off the committed files. The Dockerfile's own header says it has
never been built — expect to iterate on the install layer.

---

## 0. What actually changes

| | Before | After |
| --- | --- | --- |
| Payer key origin | `generatePrivateKey()` in the signer process | derived inside a TDX enclave by `rofl-appd` |
| Where it rests | `.keys/payers.json` on disk | never leaves the enclave; nothing on disk but an `address → key_id` index |
| Operator access | read the file | none — the key has never existed outside the TEE |
| If the enclave is missing | silently falls back to the file store | **refuses to boot**, once `SIGNER_REQUIRE_ROFL=true` |

That last row is the one to demo. It is already written in `openKeyStore`.

---

## 1. Prerequisites

- **Oasis CLI** — <https://docs.oasis.io/build/tools/cli/setup>
- **Docker with buildx**, able to push to a *publicly reachable* registry. ROFL pulls the
  image itself, so a local-only image will not do.
- **A wallet account:**
  ```
  oasis wallet create ll-rofl --file.algorithm secp256k1-bip44
  ```
- **~150 TEST ROSE** for registration, from the Oasis testnet faucet.

Note the split the manifest already commits to: **the enclave runs on Sapphire Testnet while
the money stays on Base Sepolia.** No bridge sits between them — the enclave signs an
EIP-3009 authorization that Base has already approved. Worth saying out loud when someone
asks why two chains are involved.

---

## 2. Build and publish the image

Build context is the **repo root**, not `services/signer` — the signer imports
`@ntux402/shared` as a workspace dependency and the Dockerfile copies both.

```bash
docker buildx build --platform linux/amd64 -f services/signer/Dockerfile -t docker.io/YOUR_USER/totem-signer:v1 --push .
```

`linux/amd64` explicitly. ROFL machines are amd64, and a silently-arm64 image built on an
Apple laptop fails at run time with an exec-format error that reads like a corrupt bundle.

Then read the digest — ROFL requires a `@sha256:` pin so the deployed bytes cannot drift
from the audited ones:

```bash
docker buildx imagetools inspect docker.io/YOUR_USER/totem-signer:v1 --format "{{.Manifest.Digest}}"
```

**Gate:** you have a `sha256:…` string and the image is pullable from a machine that is not
yours.

---

## 3. Pin the digest in `compose.yaml`

Edit [`services/signer/compose.yaml`](../services/signer/compose.yaml) and replace the
placeholder:

```yaml
image: docker.io/YOUR_USER/totem-signer@sha256:<digest from step 2>
```

Leave everything else. Two lines in that file carry the whole upgrade and neither should
change: the `/run/rofl-appd.sock` mount, which is the only route to the enclave's key
manager, and the *absence* of any payer key — there is nothing to inject, because the key is
derived at run time and has never existed anywhere else.

---

## 4. Register the app

**Do not run `oasis rofl init`.** The quickstart starts there, but this repo already has a
hand-written `rofl.yaml` with the TDX, resource and policy choices made deliberately. `init`
would overwrite it.

```bash
oasis rofl create --network testnet
```

This fills in the app id and deployment block in `rofl.yaml` and spends the TEST ROSE. Commit
the resulting file — the app id is not a secret and losing it means re-registering.

**One thing to verify while you are here:** the committed manifest says `kind: containers`
and Oasis's current quickstart writes `kind: container`. If `create` or `build` rejects the
manifest, that is the first line to try. Let the CLI's own validation decide rather than
guessing.

---

## 5. Supply the secrets

The container needs three values that are not in the image. They go in as ROFL secrets, not
build args:

```bash
echo -n "https://base-sepolia-rpc.publicnode.com" | oasis rofl secret set BASE_SEPOLIA_RPC_URL -
```

```bash
echo -n "0x0C759D06a1c14F43852D7b078Db2f8C342F15921" | oasis rofl secret set POLICY_VAULT_ADDRESS -
```

```bash
echo -n "0x036CbD53842c5426634e7929541eC2318f3dCF7e" | oasis rofl secret set USDC_ADDRESS -
```

Use the *publicnode* RPC rather than `sepolia.base.org` — the latter has been observed
returning `-32011 no backend is currently healthy` for `eth_call` while answering everything
else, and the signer reads the chain on every authorization.

Note what is **not** in that list: no private key of any kind. If you find yourself adding
one, the deployment has drifted from the design.

---

## 6. Build and deploy

```bash
oasis rofl build
```

```bash
oasis rofl update
```

```bash
oasis rofl deploy
```

`update` pushes the secrets and the new bundle reference; `deploy` schedules it onto a
machine. Then:

```bash
oasis rofl machine show
```

```bash
oasis rofl machine logs
```

**Gate:** the logs show the signer's own startup lines, and the key-store line reads

```
key store  store=ROFL enclave via /run/rofl-appd.sock
```

If it instead says a file path, or you see the warning *"no enclave — private keys are held
by this process"*, the socket is not mounted. Stop here; everything downstream would be a
demo of the fallback.

---

## 7. Prove it is really using the enclave

Three checks, cheapest first. Do all three — the point of this exercise is a claim you can
defend, and a control nobody has watched work is a control nobody should believe.

**7a. The store it chose.** Already visible in the logs above.

**7b. Mint a payer and confirm no key is on disk.** `POST /payer` derives a key through
`rofl-appd` at `/rofl/v1/keys/generate`. Afterwards, `/data/payers.json` should contain only
an `address → key_id` map — addresses and identifiers, no key material. That file is the
whole persistent state, and it leaks nothing.

**7c. Make the fallback impossible.** Set `SIGNER_REQUIRE_ROFL=true` in the compose
environment and redeploy. Then, separately, try booting the signer with that flag and no
socket — locally is fine. It must refuse:

> `SIGNER_REQUIRE_ROFL is set but SIGNER_ROFL_SOCKET is empty. Refusing to start: the
> fallback stores hold private keys in the process or on disk, which is exactly what
> requiring ROFL is meant to prevent.`

**That refusal is the demo.** It converts *"we hope it is using the enclave"* into *"it
cannot run without one"*, and you can show it failing in five seconds.

---

## 8. Point the orchestrator at it

The signer is now on a ROFL machine rather than `127.0.0.1:8402`. On the machine running the
rest of the stack:

```
SIGNER_URL=http://<rofl-machine-host>:8402
```

Two things to sort out here, and they are the least glamorous part of this whole runbook:

- **Reachability.** `oasis rofl machine show` reports where the machine is. The orchestrator
  must be able to reach port 8402 there. If it cannot, an SSH tunnel from your laptop is a
  perfectly respectable answer for a demo — say so rather than pretending otherwise.
- **Exposure.** The signer defaults to `BIND_HOST=127.0.0.1`, which is right for a laptop and
  wrong for a container the orchestrator must reach. Widening it means the signer is
  listening somewhere real, so set `SERVICE_TOKEN` at the same time and give the orchestrator
  the same value. The signer authorizes only `(goalId, seq)` and cannot be argued into
  anything else, but "bounded loss" is a poor answer to "why did my demo goal run out of
  calls".

**Gate:** `pnpm --filter @ntux402/e2e run demo` completes end to end with the remote signer,
and the payer address in the run matches one minted by the enclave.

---

## 9. When it goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `exec format error` in machine logs | image built for arm64 | rebuild with `--platform linux/amd64` |
| `rofl-appd unreachable at /run/rofl-appd.sock` | socket not mounted | check the `volumes:` entry survived your `compose.yaml` edit |
| Key-store line shows a file path | `SIGNER_ROFL_SOCKET` unset in the container | it is set in both the Dockerfile and compose; confirm your edit did not drop the `environment:` block |
| Manifest rejected on `create` / `build` | `kind:` spelling | §4 |
| Signer boots then errors on every authorize | RPC or vault address secret missing | `oasis rofl machine logs`; re-run §5 |
| Image pull fails | registry is private | ROFL pulls it itself — the repository must be public |

---

## 10. What this buys you on stage

One sentence, and it is the one the whole project is built to earn:

> The key that signs payments was generated inside an attested TDX enclave, has never
> existed outside it, and this service refuses to start if that enclave is missing — so
> "trust the operator" is not part of the security argument.

Show `oasis rofl machine show` for the attestation, then the boot refusal from §7c. The
refusal lands harder than the attestation, because everyone has seen a dashboard and almost
nobody has seen a system decline to run insecurely.

---

## Afterwards

Update the README. The **"Written and tested, not yet live"** section currently lists ROFL
deployment as outstanding, which is to your credit while it is true and a liability the
moment it is not. Move it up, and keep the honest note that the local file store still
exists for laptop runs — with `SIGNER_REQUIRE_ROFL` as the switch that forbids it.
