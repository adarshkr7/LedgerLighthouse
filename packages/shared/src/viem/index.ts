/**
 * The viem-dependent corner of the shared package.
 *
 * On its own subpath so the root export stays free of viem: the browser
 * imports `@ntux402/shared` and must not pull a chain client in through it.
 * Same reasoning as `@ntux402/shared/node` and `node:fs`.
 */

export * from "./transport.js";
export * from "./chains.js";
export * from "./account.js";
export * from "./escrow.js";
export * from "./enrollment.js";
