# ROFL fast deploy

Companion to [`ROFL_RUNBOOK.md`](ROFL_RUNBOOK.md), which is the long version. This is the
short one, written against the **verified state of the deployment on 2026-08-23**, not
against the runbook's own description of it.

The runbook says "what is missing is a deployment" and its Dockerfile header says
`NOT YET BUILT OR DEPLOYED`. **Both are stale.** Steps 1–5 are done. Three commands remain.

---

## Where it actually stands

Verified against Docker Hub and Sapphire testnet, not read off the docs:

| | State | Evidence |
| --- | --- | --- |
| Image built + pushed | **done** | `schwarzite/totem-signer:v1`, `linux/amd64`, pushed 2026-08-22 12:46 UTC |
| Digest pinned | **done, and matching** | `compose.yaml` pins `sha256:e51db3d9…c8b361b`; Hub reports the same |
| App registered | **done** | `rofl1qr0fv0qs2u8vmmah0ucmwegcj2cdz7kj4qzjduhp` |
| Stake | **done** | 100.0 TEST, admin `ll_rofl` (`0x44221a29…22C87c`) |
| Secrets | **done** | 4 encrypted in `rofl.yaml` — RPC, vault, USDC, service token |
| Trust root | **done** | pinned at height 33589825 |
| **Enclave identity** | **missing** | policy reads `"enclaves": []` |
| **Machine** | **missing** | `oasis rofl show` → *No registered replicas* |

So the gap is exactly: no `oasis rofl build` has run, therefore no enclave ID exists,
therefore nothing has been scheduled.

**The one blocker is Docker.** `oasis rofl build` drives a container build environment and
`docker` is not on this shell's PATH.

---

## Step 0a — `oasis rofl build` does not work on native Windows (read this first)

Established by testing on 2026-08-23, not by reading docs. Docker Desktop 4.86.0 was
running and healthy — a **Server** block, engine `linux/amd64` — and the build still failed
in both Git Bash and PowerShell with the same error:

```
docker: Error response from daemon: the working directory '\src\services\signer'
is invalid, it needs to be an absolute path
```

The CLI normalises the *container's* working directory using **Windows** separators, so it
passes `\src\…` to a Linux container. Three things rule out the obvious explanations:

- **Not MSYS path mangling.** PowerShell produces the identical error, so Git Bash is not
  rewriting anything.
- **Not the subdirectory.** Running from a standalone directory containing only `rofl.yaml`
  and `compose.yaml` shortened it to `\src` — still backslashed, still rejected. That
  confirms the mechanism (root mounted at `/src`, manifest subpath appended) and confirms
  no directory layout escapes it.
- **No escape hatch.** `--no-container` refuses outright:
  `native ROFL builds are only supported on linux/amd64`.

So on Windows the containerised builder emits an unusable path and the native builder is
unavailable. **Build must happen under Linux.** WSL2 `Ubuntu-26.04` is already installed on
this machine and is the shortest route.

### The WSL route — already prepared

Done on 2026-08-23, so none of this needs repeating:

- **Linux CLI installed** at `~/bin/oasis` inside `Ubuntu-26.04`, version **0.19.1** — the
  exact version `tooling.version` records. `~/bin` appended to PATH in `.bashrc`.
- **Repo reachable** from WSL at `/mnt/d/CODE/LedgerLighthouse/services/signer`.
- **Manifest validates.** `oasis rofl build --only-validate` → `App validation passed.`
  That exercises the manifest, the compose file and the pinned image digest, so the whole
  configuration is confirmed good from Linux before a single byte is built.

**`GODEBUG=netdns=cgo` is required, and this is not optional.** WSL's DNS proxy
(`10.255.255.254`) intermittently returns no A record, and Go's built-in resolver gives up
with `no such host` on `registry-1.docker.io`, then on `auth.docker.io`, then somewhere
else — it fails at a different hostname each run, which makes it read like a network outage
rather than a resolver bug. glibc resolves the same names fine (`getent` and `curl` both
succeed), so forcing Go onto the cgo resolver fixes it outright. Validation went from three
consecutive failures to passing on the first try with the variable set.

**The one remaining prerequisite is a checkbox.** Docker Desktop's WSL integration is not
enabled for `Ubuntu-26.04` — `/mnt/wsl/docker-desktop/cli-tools` is empty and the distro has
no `/var/run/docker.sock`:

> Docker Desktop → Settings → Resources → WSL Integration → enable **Ubuntu-26.04** → Apply & Restart

Then the build is one command:

```bash
wsl -d Ubuntu-26.04 -- bash -lc 'cd /mnt/d/CODE/LedgerLighthouse/services/signer && GODEBUG=netdns=cgo ~/bin/oasis rofl build'
```

`build` needs Docker but **not** the wallet. Steps 3 and 4 need the wallet but **not**
Docker, so run those back on Windows where the wallet already lives.

---

## Step 0b — the wallet passphrase is yours to type

`ll_rofl` is `kind = 'file'` (`%LOCALAPPDATA%\oasis\ll_rofl.wallet`), which means it is
passphrase-encrypted. `oasis rofl update` and `oasis rofl deploy` both sign transactions and
will prompt for it.

**Run those two yourself.** Nobody and nothing else should be typing that passphrase, and an
automated shell cannot answer the prompt anyway.

---

## Step 0 — Docker on PATH (5 min)

Per-user Docker Desktop is invisible to Git Bash. This is a PATH problem, never a missing
install:

```bash
export PATH="$PATH:/c/Users/$USER/AppData/Local/Programs/DockerDesktop/resources/bin"
```

Start Docker Desktop, then settle which failure you have — a **Server** block means the
daemon is up:

```bash
docker version
```

**Gate:** `docker version` prints a Server block. Do not continue without it; every later
failure will be misread as a ROFL problem.

---

## Step 1 — Check the balance before renting (2 min)

The machine bills ~5 TEST/hour. The 100 TEST stake is already spent and does not pay for it.

```bash
oasis account show --network testnet --account ll_rofl
```

**Gate:** enough TEST for the hours you intend to run. If it is thin, top up from the faucet
*now* — a machine that stops mid-demo is the worst possible outcome and the failure mode is
silent.

---

## Step 2 — Build the enclave bundle (10–20 min)

```bash
cd services/signer && oasis rofl build
```

This is the step that produces the enclave identity the policy is missing. It downloads the
pinned firmware, kernel, stage2 and container runtime from `rofl.yaml` — expect it to be the
slowest command here.

It also fails if `compose.yaml` names a digest not on the registry. That is already verified
to match, so a failure here is Docker, not the pin.

**Gate:** a bundle is produced and the command reports an enclave identity.

---

## Step 3 — Push policy + secrets (2 min)

```bash
oasis rofl update
```

Writes the new enclave ID into the on-chain policy and pushes the four secrets. This is the
transaction that turns `"enclaves": []` into a whitelist of one.

**Gate:**

```bash
oasis rofl show
```

`"enclaves"` is no longer empty.

---

## Step 4 — Rent a machine and schedule (5–10 min)

```bash
oasis rofl deploy
```

```bash
oasis rofl machine show
```

```bash
oasis rofl machine logs
```

**Gate — this is the one that matters.** The logs must read:

```
key store  store=ROFL enclave via /run/rofl-appd.sock
```

If they show a file path, or *"no enclave — private keys are held by this process"*, the
socket is not mounted. **Stop.** Everything past this point would be a demo of the fallback,
which is the exact thing this deployment exists to retire.

---

## Step 4b — if the machine never leaves `created`

Observed 2026-08-23: `deploy` succeeded, the ORC bundle uploaded, the machine was created —
and then it sat at `status=created` with `Node ID: <none>` indefinitely, `oasis rofl show`
reporting *No registered replicas* and `machine logs` refusing with *Machine is missing
scheduler RAK metadata*. Ten minutes of polling changed nothing, because nothing was ever
going to change.

The cause is the **offer**. `oasis rofl provider show` lists two, and the machine had been
placed on the second:

```
- playground_short        [0000000000000003]  hourly: 5.0 TEST
    ⚠️ Testnet ROFLs only. Do not use in production! ⚠️
- playground_internal_m   [0000000000000006]  hourly: 0.0, monthly: 0.0, yearly: 0.0
    ⚠️ Internal Testnet ROFLs for Oasis team. Will not work if not whitelisted! ⚠️
```

`playground_internal_m` is Oasis-internal and **silently never schedules** unless the account
is whitelisted. It also explains the two things that looked like good news at the time: the
balance never dropped, and `Paid until` read a year out — because every term on that offer
costs 0.0 TEST. A free year-long rental that never runs is the failure presenting itself as
success.

Nothing warns about this. The default selection appears to favour the cheapest offer, which
is exactly the one that cannot work.

**Fix — cancel and redeploy onto the public offer.** Both commands sign, so they are yours:

```bash
oasis rofl machine remove
```

```bash
oasis rofl deploy --offer 0000000000000003 --term hour --term-count 24
```

24 hours is **120 TEST** of a 199.96 balance, leaving ~80 spare. Long enough that the
machine outlives a demo day without a top-up mid-morning, which is the failure the runbook's
§9 table warns about ("machine stops partway through the day").

Check `oasis rofl machine show` afterwards: **`Node ID` must become populated** within a few
minutes. If it is still `<none>`, the redeploy did not take the offer — confirm with
`oasis rofl deploy --show-offers` rather than waiting again.

And note the real cost model is the plan's original one: **5 TEST/hour**, not free, not
yearly. Budget accordingly.

---

## Step 5 — Prove it (5 min)

Two checks. Do both; a control nobody has watched work is a control nobody should believe.

**5a. No key material on disk.** Mint a payer, then confirm `/data/payers.json` inside the
machine holds only an `address → key_id` map. Addresses and identifiers, no keys. That file
is the whole persistent state.

**5b. Make the fallback impossible.** Set `SIGNER_REQUIRE_ROFL=true` in the compose
environment and redeploy. Then boot the signer locally with that flag and no socket. It must
refuse:

> `SIGNER_REQUIRE_ROFL is set but SIGNER_ROFL_SOCKET is empty. Refusing to start…`

**That refusal is the demo.** It converts *"we hope it uses the enclave"* into *"it cannot
run without one"*, and it fails in five seconds on stage.

---

## Step 6 — Point the stack at it (10 min)

```
SIGNER_URL=http://<rofl-machine-host>:8402
SERVICE_TOKEN=<same value as the ROFL secret>
```

`SERVICE_TOKEN` is the half no ROFL secret can reach — the orchestrator needs the same value
by hand.

Reachability is the unglamorous risk. If the orchestrator cannot reach port 8402 on the
machine, **an SSH tunnel is a respectable answer for a demo** — say so rather than pretending
otherwise.

**Gate:** `pnpm --filter @ntux402/e2e run demo` completes end to end, and the payer address
in the run matches one minted by the enclave.

---

## Realistic timing

| Step | Time |
| --- | --- |
| 0–1 Docker + balance | 7 min |
| 2 build | 10–20 min |
| 3 update | 2 min |
| 4 deploy + logs | 5–10 min |
| 5 prove | 5 min |
| 6 wire + e2e | 10 min |
| **Total, clean run** | **~40–55 min** |

Budget **90 minutes** honestly. The runbook's own §9 lists eight distinct failure modes and
the Dockerfile has never been through `oasis rofl build`, so first-attempt iteration is the
expected case, not the unlucky one.

---

## Abort criteria

Given a 14:00 demo:

- **Start by 11:00.** That leaves a full 90-minute budget plus an hour of slack.
- **If Step 2 has not passed by 12:00, stop and fall back.** Deploying is not worth arriving
  at the pitch unrehearsed, and a half-deployed app is worse than an honest local one.
- **If Step 4's gate fails, do not push on.** A machine running the file store proves nothing
  and costs 5 TEST/hour to prove it.

The fallback is not embarrassing and should be rehearsed either way:

> "The enclave key store is written and tested, the app is registered on Sapphire with stake
> posted, and the image is built and pinned. We're running the local fallback today —
> `SIGNER_REQUIRE_ROFL` is the flag that makes that impossible in production."

Every clause of that is verifiable on chain right now, which is more than most demos can say
about the parts they *did* deploy.

---

## What it buys

The claim the whole project is built to earn, and the one the landing page already makes in
present tense:

> The payer key is derived inside a TDX enclave and has never existed outside it. No
> operator — including us — can extract it.

Until Step 4's gate passes, that sentence is true of `RoflKeyStore` and false of what runs.
That is the entire point of doing this.
