// Demo catalog: the four resources the agent can be asked to buy. Shared so the
// mock API, the orchestrator and the web console cannot disagree about prices.
export * from "./catalog.js";
// Measured cost and quoted price for live search, kept here for the same
// reason: the vendor quotes it and the console displays it.
export * from "./search-tiers.js";
// Query + tier validation, shared so the orchestrator and the vendor cannot
// disagree about the limit. The boundary check forbids one importing the other.
export * from "./search-query.js";
// Shape of a live vendor's 200 body, plus the href filter the console needs.
// Here rather than in the web app because a `javascript:` filter is a security
// control and apps/web has no test runner to prove one works.
export * from "./search-result.js";
// The GPU rental catalog: cards, block lengths, workloads, and the pricing
// function the 402 quotes from. See docs/GPU_RENTAL_PLAN.md.
export * from "./gpu-skus.js";
// Validation for a rental request, shared for the reason the search validation
// is: the vendor's pass is load-bearing and the limit must not exist twice.
export * from "./gpu-request.js";
