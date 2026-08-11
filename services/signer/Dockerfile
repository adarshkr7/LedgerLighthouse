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
# actually depends on, which keeps the contracts workspace — and its git-hosted
# Solidity dependencies — out of the image entirely.
#
# `--ignore-scripts` for the same reason it is used everywhere else in this repo:
# the optional native builds have JS fallbacks and are not needed. See
# pnpm-workspace.yaml for the full argument.
RUN pnpm install --ignore-scripts --frozen-lockfile --filter @ntux402/signer...

# --------------------------------------------------------------------- runtime
FROM deps AS runtime
COPY packages/shared packages/shared
COPY services/signer services/signer

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
