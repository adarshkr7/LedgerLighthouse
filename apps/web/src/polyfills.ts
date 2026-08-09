/**
 * Node globals that `@inco/lightning-js` reaches for in the browser.
 *
 * The SDK is written for both runtimes and uses `Buffer` for ciphertext
 * encoding. Vite does not shim Node builtins, so without this the module throws
 * `Buffer is not defined` at import time and the page renders empty.
 *
 * **This must be imported before anything that pulls in the Inco SDK.** ES
 * module imports are evaluated in source order, so being first in `main.tsx` is
 * what makes it work.
 */

import { Buffer } from "buffer";

const scope = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
};

scope.Buffer ??= Buffer;
// Some bundled dependencies still reference `global` rather than `globalThis`.
scope.global ??= globalThis;
