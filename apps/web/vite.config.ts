import { defineConfig, type Rollup } from "vite";
import react from "@vitejs/plugin-react";

type RollupLog = Rollup.RollupLog;

/**
 * Build warnings from dependencies that need no action, matched narrowly so the
 * same warning from anything else still prints.
 *
 * - `/*#__PURE__*\/` comments Rollup cannot place. It discards them, which can
 *   only leave slightly more code in the bundle, and some sit in commented-out code.
 * - `crypto` in mlkem and @hpke/common. It is their fallback for Node 18 and
 *   older, after a `globalThis.crypto` check that browsers always pass.
 */
function isKnownDependencyWarning(warning: RollupLog): boolean {
  const inDependency = (text: string | undefined, packages: RegExp) =>
    text !== undefined && packages.test(text.replaceAll("\\", "/"));

  if (warning.code === "INVALID_ANNOTATION") {
    return inDependency(warning.id, /\/node_modules\/(mlkem|ox|@hpke\/common)\//);
  }
  return (
    warning.plugin === "vite:resolve" &&
    warning.message.includes('Module "crypto" has been externalized') &&
    inDependency(warning.message, /\/node_modules\/(mlkem|@hpke\/common)\//)
  );
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1" },
  /*
   * Read the repo-root `.env` rather than one beside this app, so the RPC
   * endpoints the browser uses and the ones the services use are configured in
   * a single place. They were not, and the browser quietly kept using the
   * chain's default public endpoint while every service used the configured
   * list — which is a difference nobody notices until that endpoint degrades.
   *
   * Safe despite the file holding private keys: Vite exposes only `VITE_`-
   * prefixed variables to client code. Everything else is visible to the Vite
   * process and never reaches the bundle.
   */
  envDir: "../..",
  resolve: {
    alias: {
      // `@inco/lightning-js` imports `buffer`. Bare, Vite treats that as the
      // Node builtin and externalizes it, so the polyfill never loads and the
      // SDK throws at import time. The trailing slash forces resolution to the
      // npm package in node_modules instead.
      buffer: "buffer/",
    },
  },
  optimizeDeps: {
    // Pre-bundled, so the alias applies to the dependency-optimizer's copy of
    // the SDK as well as to our own source.
    include: ["buffer"],
  },
  define: {
    // Some transitive dependencies still reference `global`.
    global: "globalThis",
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (!isKnownDependencyWarning(warning)) warn(warning);
      },
      output: {
        // React only. A viem chunk would look like the obvious next split, but
        // the lazily loaded Inco SDK uses viem as well, so naming one here pulls
        // those modules back into what every page load downloads.
        manualChunks(id) {
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
        },
      },
    },
  },
});
