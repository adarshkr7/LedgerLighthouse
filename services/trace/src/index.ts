/**
 * Trace builder, Merkle accumulator, and the standalone verifier (ARCHITECTURE.md §8).
 *
 * The claim the trace supports is the narrow one from §8.3: every payment in it
 * corresponds to a confidential policy evaluation whose result was attested by
 * Inco's covalidators and verified on chain against the expected handle. Not
 * "the agent behaved correctly" — that is not something Inco attests to and not
 * something this file should be read as claiming.
 */

export * from "./canonical.js";
export * from "./step.js";
export * from "./merkle.js";
export * from "./builder.js";
export * from "./verify.js";
