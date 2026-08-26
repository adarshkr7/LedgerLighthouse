# The Authorization Signer, containerized for Oasis ROFL.
#
# Built from the **repo root** as context, because the signer imports
# @ntux402/shared as a workspace dependency:
#
#   docker build -f services/signer/Dockerfile -t <user>/totem-signer .
#
# Built and deployed. The image this produced is pinned by digest in
# compose.yaml and is the one running the live enclave.

FROM node:22-alpine AS base
RUN corepack enable

# Corepack fetches the pinned pnpm on first use and caches it under `$HOME`.
# That default is why the runtime user matters here: the build runs as root, so
# the cache would land in `/root/.cache` where the unprivileged runtime user
# cannot read it — and corepack's response to a cache miss is to go to the
# network, which an enclave should not be relying on at boot. Pinning it to a
# fixed path lets the final stage hand it to `node` along with everything else.
ENV COREPACK_HOME=/opt/corepack
WORKDIR /repo

# ---------------------------------------------------------------- dependencies
# Manifests first so a source-only edit does not re-resolve the whole workspace.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/signer/package.json services/signer/

# `--filter @ntux402/signer...` restricts the install to the signer and what it
# actually depends on, which keeps the contracts workspace out of the image.
#
# It does **not** keep git out of the build. Most of the git-hosted pins resolve
# through codeload tarballs over plain HTTPS, but at least one — the
# `@safe-global/safe-smart-account` override, pinned with a `.git` suffix — takes
# pnpm's git fetcher instead, and that shells out to the real binary. `node:22-alpine`
# ships without it, so the install dies on `spawn git ENOENT` after several
# minutes of successful downloading, which reads like a network fault and is not.
#
# Added and removed in one layer, `--virtual` so the removal is exact. `runtime`
# is `FROM deps`, so anything left here ships inside the enclave image; a fetch
# tool has no business in a TEE workload once the fetching is done.
#
# `--ignore-scripts` for the same reason it is used everywhere else in this repo:
# the optional native builds have JS fallbacks and are not needed. See
# pnpm-workspace.yaml for the full argument.
# `--trust-lockfile` skips pnpm's supply-chain re-verification, which re-applies
# minimumReleaseAge/trustPolicy to **every** lockfile entry — all 639 of them,
# ignoring the filter. That means registry round trips for react-dom, @solana/*
# and the rest of the web app's tree inside an image that will never run any of
# it: five and a half minutes of network on a good day, and a build-breaking
# TimeoutError on a slow one.
#
# Skipping it here does not skip it: CI installs this same committed lockfile
# without the flag (.github/workflows/ci.yml), so the policy check still runs on
# every push. The lockfile is part of the trusted base by the time an image is
# being cut from it, which is the condition pnpm documents for this flag.
# The git config is not superstition. `@safe-global/safe-smart-account` reaches
# this install through the `overrides` block in pnpm-workspace.yaml, which pnpm
# resolves eagerly — the package belongs to the `contracts` importer alone, whose
# manifest is deliberately never copied here, so nothing in the signer's tree
# wants it and the filter cannot drop it. It is a large repo cloned in full, and
# on a slow link it dies as `early EOF` / `invalid index-pack output` rather than
# as a timeout. Disabling the low-speed abort and pack compression is the
# standard mitigation for exactly that pair of errors.
RUN apk add --no-cache --virtual .fetch-deps git \
 && git config --global core.compression 0 \
 && git config --global http.lowSpeedLimit 0 \
 && git config --global http.lowSpeedTime 999999 \
 && git config --global http.postBuffer 524288000 \
 && pnpm install --ignore-scripts --frozen-lockfile --trust-lockfile --filter @ntux402/signer... \
 && apk del .fetch-deps

# --------------------------------------------------------------------- runtime
FROM deps AS runtime
COPY packages/shared packages/shared
COPY services/signer services/signer

# `@ntux402/shared` points `main` at ./dist, so the signer cannot import it
# until it is compiled. `dist/` is gitignored and excluded by .dockerignore, so
# it is built here rather than inherited from whichever machine ran the build
# last — the same reason CI runs `pnpm build` before it typechecks.
RUN pnpm --filter @ntux402/shared run build

# Where the non-secret address -> key_id index lives. Backed by the persistent
# disk declared in rofl.yaml, so payer keys survive a restart. It holds no key
# material — that is the point of RoflKeyStore.
ENV SIGNER_ROFL_SOCKET=/run/rofl-appd.sock \
    SIGNER_ROFL_INDEX_PATH=/data/payers.json \
    SIGNER_PORT=8402

EXPOSE 8402

# --------------------------------------------------------- dropping privilege
# `su-exec` is the whole privilege-dropping mechanism: ~10 KB, does one thing,
# and unlike the `git` above it has to stay in the image because it runs at
# boot rather than at build time. See entrypoint.sh for why `USER node` alone
# cannot do this job — `/data` is a bind mount and its ownership arrives from
# the host, so a build-time chown of it is overwritten before the signer starts.
RUN apk add --no-cache su-exec
COPY services/signer/entrypoint.sh /usr/local/bin/entrypoint.sh

# `HOME` is set explicitly because `su-exec` does not set it: it changes uid and
# leaves the environment alone, so without this the signer would run as `node`
# while still pointed at `/root`, and the first thing pnpm wanted to write there
# would fail with EACCES. Naming it here also means the build populates the same
# directory the runtime reads, rather than two that happen to agree.
ENV HOME=/home/node

# The two directories the runtime user must be able to *write*: the corepack
# cache `pnpm` is launched through, and the home directory pnpm resolves its
# own scratch paths against.
#
# `/repo` is deliberately not in that list. Root created it with the default
# umask, so it is already world-readable and world-executable, which is the
# whole of what the signer needs — it reads its own source and writes only
# `/data/payers.json`. Chowning it would rewrite metadata for every file in a
# fully installed pnpm workspace, and because a layer records changed metadata
# as changed files, that single instruction would duplicate the largest layer
# in the image. A TEE image that ships over a registry pays for that twice.
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /home/node \
 && chown -R node:node /opt/corepack /home/node

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Deliberately no key material in the image, in a build arg, or in a secret.
# There is nothing to inject: the payer key is derived inside the enclave at
# runtime and has never existed anywhere else.
CMD ["pnpm", "--filter", "@ntux402/signer", "run", "start"]
