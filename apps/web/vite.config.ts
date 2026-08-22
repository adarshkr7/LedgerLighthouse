import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
});
