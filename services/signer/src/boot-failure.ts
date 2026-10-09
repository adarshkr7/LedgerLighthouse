/**
 * How a failed signer boot is described on /health. Kept apart from main.ts,
 * which boots on import, so the wording can be tested.
 */

/** The first line of an error, with URL paths and queries cut: RPC URLs often carry an API key. */
export function summarize(error: unknown): string {
  const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
  return first.replace(/(https?:\/\/[^/\s]+)[^\s]*/g, "$1/…");
}

/** What usually causes a boot failure, for the ones seen in practice. */
export function hintFor(stage: string, detail: string): string | undefined {
  if (/EACCES/.test(detail) && /rofl-appd/.test(detail)) {
    return "the signer cannot open the enclave key daemon's socket. entrypoint.sh grants the node group access to it; check that the image's entrypoint is the current one.";
  }
  if (/ENOENT|unreachable/.test(detail) && /rofl-appd/.test(detail)) {
    return "SIGNER_ROFL_SOCKET names a socket that is not there. Inside ROFL, check the volume in compose.yaml; outside it, unset SIGNER_ROFL_SOCKET.";
  }
  if (/payerGoal/.test(detail)) {
    return "the vault has no payerGoal, so it predates the payer binding. Point POLICY_VAULT_ADDRESS at the current vault.";
  }
  if (/HTTP request failed|fetch failed|timed out|ECONNREFUSED|ENOTFOUND|no backend/i.test(detail)) {
    return "the RPC did not answer. Check RPC_URL or BASE_SEPOLIA_RPC_URL. Boot retries every 30 seconds, so a passing outage clears by itself.";
  }
  if (stage === "configuration") return "a setting is missing or wrong; the error names it.";
  return undefined;
}
