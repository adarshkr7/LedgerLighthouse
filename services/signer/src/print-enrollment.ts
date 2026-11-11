/**
 * Prints the enrollment address of the local seed store, creating the seed if it is
 * absent. A vault is deployed with this as ENROLLMENT_SIGNER. For the enclave, read
 * the address from its /health instead.
 *
 *   pnpm --filter @ntux402/signer exec tsx src/print-enrollment.ts
 */
import { isAbsolute, resolve } from "node:path";
import { findRepoRoot, loadDotEnv } from "@ntux402/shared/node";
import { fileKeyStore } from "./keystore.js";

loadDotEnv();
const configured = process.env["SIGNER_SEED_PATH"] || ".keys/signer-seed.json";
const path = isAbsolute(configured) ? configured : resolve(findRepoRoot(), configured);
const store = fileKeyStore(path, { chainId: 84532, vault: "0x0000000000000000000000000000000000000000" });
console.log((await store.enrollment()).address);
