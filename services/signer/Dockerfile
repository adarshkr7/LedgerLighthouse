# The Authorization Signer, containerized for Oasis ROFL.
#
# Built from the **repo root** as context, because the signer imports
# @ntux402/shared as a workspace dependency:
#
#   docker build -f services/signer/Dockerfile -t <user>/totem-signer .
#
# NOT YET BUILT OR DEPLOYED — Docker was unavailable in the environment that
# wrote this file. Expect to iterate on the install layer in particular; the
# rest is ordinary.

FROM node:22-alpine AS base
RUN corepack enable
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

# Deliberately no key material in the image, in a build arg, or in a secret.
# There is nothing to inject: the payer key is derived inside the enclave at
# runtime and has never existed anywhere else.
CMD ["pnpm", "--filter", "@ntux402/signer", "run", "start"]
