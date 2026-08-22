# Deploying the Authorization Signer to Oasis ROFL

The step that closes the biggest gap between what this project claims and what it runs.

Right now the payer key is a file at `.keys/payers.json`. The claim *"no operator can extract
it"* is true of `RoflKeyStore` and false of what is executing. Everything needed to fix that
is committed — `rofl.yaml`, `Dockerfile`, `compose.yaml`, and 12 tests over the key path.
What is missing is a deployment.

**Time:** half a day, most of it waiting on image builds and registration.
**Cost:** 100 TEST ROSE staked once at registration, plus 5.0 TEST per hour for as long as a
machine is rented. Free from the faucet — but the hourly half is the one that runs out.
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
  image itself, so a local-only image will not do. Run `docker login` before §2 — a fresh
  Docker Desktop has no `~/.docker/config.json` at all, and the push then fails at the *end*
  of a long build rather than the start of it.

  Docker Desktop installs per-user now, into `%LOCALAPPDATA%\Programs\DockerDesktop`, and the
  PATH entry it adds does not reach every shell — Git Bash and spawned subprocesses routinely
  miss it. `docker: command not found` there is a PATH problem, not a missing install:

  ```bash
  export PATH="$PATH:/c/Users/$USER/AppData/Local/Programs/DockerDesktop/resources/bin"
  ```
- **A wallet account:**
  ```
  oasis wallet create ll-rofl --file.algorithm secp256k1-bip44
  ```
- **TEST ROSE** from the Oasis testnet faucet, in two parts that behave differently:
  - **100 TEST staked** by `oasis rofl create` (§4). One-off, and `oasis rofl show` reports it
    back as `Staked amount: 100.0 TEST` — it is held against the registration, not burned.
  - **5.0 TEST per hour** for the machine `oasis rofl deploy` rents (§6). That is the
    `playground_short` offer — TDX, 4 GiB, 2 vCPU — from `rofl:provider:sapphire`. Confirm it
    rather than trusting this number, since providers reprice:

    ```bash
    oasis rofl provider show oasis1qp2ens0hsp7gh23wajxa4hpetkdek3swyyulyrmz --network testnet
    ```

  ~150 TEST therefore covers registration plus roughly ten hours of runtime, not a standing
  deployment. Check what is actually left with `oasis account show --network testnet --account
  ll_rofl` the morning of, and tear the machine down between rehearsals rather than leaving it
  billing overnight.

**Where to run things.** Every `oasis rofl` command reads `rofl.yaml` from the working
directory, so all of them run from `services/signer`:

```bash
cd services/signer
```

The one exception is the `docker buildx build` in §2, which needs the **repo root** as its
context. Running `oasis rofl` from the root does not find the manifest — and `oasis rofl init`
there would scaffold a second one, which is the mess §4 warns about.

Note the split the manifest already commits to: **the enclave runs on Sapphire Testnet while
the money stays on Base Sepolia.** No bridge sits between them — the enclave signs an
EIP-3009 authorization that Base has already approved. Worth saying out loud when someone
asks why two chains are involved.

---

## 2. Build and publish the image

Build context is the **repo root**, not `services/signer` — the signer imports
`@ntux402/shared` as a workspace dependency and the Dockerfile copies both.

```bash
docker buildx build --platform linux/amd64 -f services/signer/Dockerfile -t docker.io/schwarzite/totem-signer:v1 --push .
```

`linux/amd64` explicitly. ROFL machines are amd64, and a silently-arm64 image built on an
Apple laptop fails at run time with an exec-format error that reads like a corrupt bundle.

Then read the digest — ROFL requires a `@sha256:` pin so the deployed bytes cannot drift
from the audited ones:

```bash
docker buildx imagetools inspect docker.io/schwarzite/totem-signer:v1 --format "{{.Manifest.Digest}}"
```

**Gate:** you have a `sha256:…` string and the image is pullable from a machine that is not
yours.

---

## 3. Pin the digest in `compose.yaml`

**Already done for the current image.** `compose.yaml` pins
`sha256:e51db3d95d2aec8efb399cbff5eb2c6ec89ad009b1b0228e9bce15dcec8b361b`; redo this only
after rebuilding. Edit [`services/signer/compose.yaml`](../services/signer/compose.yaml):

```yaml
image: docker.io/schwarzite/totem-signer@sha256:<digest from step 2>
```

What comes back is an **OCI index**, not a single manifest: it carries the `linux/amd64`
image plus a buildx attestation manifest that reports its platform as `unknown/unknown`.
Pinning the index is correct and a runtime picks amd64 out of it. If one instead rejects
the index over that second entry, pin the amd64 manifest digest directly — `imagetools
inspect` on the index lists it — or rebuild with `--provenance=false` so it is never
emitted.

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

This stakes the 100 TEST and rewrites `rofl.yaml`. Commit the result — the app id is not a
secret, and losing it means re-registering and staking another 100.

**It rewrites more than the app id.** Expect all three of these, none of which are errors:

- It **appends a new `testnet:` deployment** carrying the app id, `trust_root` and a real PCS
  quote policy, and marks it `default: true`. It does *not* fill in the block that was already
  there — that one survives untouched, now dead. Delete it. Left in place it is a trap for a
  later `--deployment default`, which would select an empty `quotes: {}` policy that cannot
  attest.
- It **normalises `kind: containers` to `kind: container`** on its own, so the singular/plural
  mismatch with Oasis's quickstart resolves itself. Nothing to do.
- It **strips every comment** and pins `artifacts.builder`, `firmware`, `kernel` and `stage2`
  to digests. The manifest is a CLI-managed file from here on, so design rationale belongs in
  this runbook rather than in comments that the next `create` will delete.

---

## 5. Supply the secrets

The container needs four values that are not in the image. They go in as ROFL secrets, not
build args:

`secret set` takes `<name> <file>|-`. **Prefer the file form.** The stdin form needs a shell
that can emit a value with no trailing newline, and PowerShell cannot: it has no `echo -n`
(you get a literal `-n`), and piping appends CRLF. A secret with a stray newline is accepted
silently and then fails at run time as a wrong RPC URL or a token that never matches — the
kind of fault that costs an hour because nothing reports it.

From **Git Bash**, where `echo -n` behaves:

```bash
echo -n "https://base-sepolia-rpc.publicnode.com" | oasis rofl secret set BASE_SEPOLIA_RPC_URL -
echo -n "0x0C759D06a1c14F43852D7b078Db2f8C342F15921" | oasis rofl secret set POLICY_VAULT_ADDRESS -
echo -n "0x036CbD53842c5426634e7929541eC2318f3dCF7e" | oasis rofl secret set USDC_ADDRESS -
head -c 32 /dev/urandom | base64 | tr -d '\n' | oasis rofl secret set SERVICE_TOKEN -
```

From **PowerShell**, write each value to a file first — `WriteAllText` adds no newline and no
BOM, and the file path avoids the shell entirely:

```powershell
function Set-RoflSecret($Name, $Value) {
  $f = Join-Path $env:TEMP "rofl-secret.txt"
  [IO.File]::WriteAllText($f, $Value, (New-Object Text.UTF8Encoding($false)))
  oasis rofl secret set $Name $f
  Remove-Item $f -Force
}

Set-RoflSecret BASE_SEPOLIA_RPC_URL "https://base-sepolia-rpc.publicnode.com"
Set-RoflSecret POLICY_VAULT_ADDRESS "0x0C759D06a1c14F43852D7b078Db2f8C342F15921"
Set-RoflSecret USDC_ADDRESS         "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$token = [Convert]::ToBase64String($b)
Set-RoflSecret SERVICE_TOKEN $token
$token   # keep this — the orchestrator needs the same value
```

Secrets are **encrypted into `rofl.yaml`**, so the manifest changes here and should be
committed. The plaintext is not in it; the values above are recoverable only by the enclave.

The fourth one is new, and it is not optional here. `compose.yaml` sets `BIND_HOST=0.0.0.0`,
because a process bound to the container's loopback is unreachable through the `ports:`
mapping — the orchestrator would get a connection refused that reads like a network fault
and is a bind. Binding wide puts the authorization endpoint on a reachable interface, and
the guard enforces a token only when it has one.

Give the **same value** to the orchestrator as `SERVICE_TOKEN` in its own environment;
`SignerClient` sends it as a Bearer header on both `/payer` and `/authorizations`. Set it on
both sides or on neither — a token on the signer alone turns every authorization into a 401,
which surfaces as a run that reaches Authorize and dies there.

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

`build` drives a container build environment, so a Docker daemon has to be running and
reachable. Two different failures land here and they have different fixes:

- `docker: command not found` — the install is fine, this shell cannot see it. Per-user Docker
  Desktop lives under `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin`, which Git Bash and
  spawned subprocesses often do not carry on PATH. The export is in §1.
- `failed to connect to the docker API at npipe:////./pipe/docker_engine` — the CLI is on PATH
  and nothing is answering it. Usually Docker Desktop is simply not started; on Windows a
  *missing* install also reports itself this way, which is why the two are worth separating.

`docker version` settles which one you have: a **Server** block means the daemon is up and
neither applies. It will also fail here if `compose.yaml` names a digest that is not
actually on the registry — after a rebuild, re-pin before building the bundle.

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
- **Exposure.** Handled in `compose.yaml` rather than here: it sets `BIND_HOST=0.0.0.0` and
  reads `SERVICE_TOKEN` from the secret set in §5. What remains on this side is giving the
  orchestrator the *same* `SERVICE_TOKEN`, since that is the half no ROFL secret can reach.
  The signer authorizes only `(goalId, seq)` and cannot be argued into anything else, but
  "bounded loss" is a poor answer to "why did my demo goal run out of calls".

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
| `docker: command not found` | per-user Docker Desktop not on this shell's PATH | §1 — export `…/DockerDesktop/resources/bin` |
| `docker push` denied at the end of the build | never logged in | `docker login`, then re-run §2 |
| Machine stops partway through the day | hourly rental drained the balance | `oasis account show --network testnet --account ll_rofl`, top up, redeploy |

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
