#!/bin/sh
# Drops root before the signer starts.
#
# The obvious implementation is `USER node` in the Dockerfile, and it does not
# work here. `/data` is a **bind mount** (`/storage/signer:/data` in
# compose.yaml), and a bind mount takes its ownership from the host directory,
# not from the image — so a `chown` at build time is overwritten at boot and
# uid 1000 lands on a root-owned 0755 directory. `RoflKeyStore.#persist` writes
# `/data/payers.json` with no try/catch, so the first `POST /payer` would throw
# EACCES and mint nothing. That failure would appear only on a deployed enclave,
# which is the worst place to discover it.
#
# So: start as root, fix the one directory that needs fixing, then hand the
# process to an unprivileged user. `exec` so the signer is PID 1 and receives
# the container's signals directly — without it, `restart: on-failure` would be
# watching this shell rather than the service.
#
# What dropping root actually buys inside a TEE is modest, and worth stating
# plainly rather than overselling: the enclave has no other users, no shell
# exposed and only two mounts. It means a defect in the signer's own
# dependencies cannot rewrite the application it is running in. That is a
# smaller claim than the key custody one — the key never leaves rofl-appd
# regardless — but it costs nothing to hold.
set -eu

mkdir -p /data
chown -R node:node /data

exec su-exec node "$@"
