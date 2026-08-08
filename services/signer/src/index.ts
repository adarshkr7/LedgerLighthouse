// Authorization Signer entry point. Populated starting M2 (plaintext-budget signing) and
// M3 (attested-reveal-gated signing). Request schema must carry (goalId, seq) only — never
// terms, amount, or addresses (IMPLEMENTATION.md §1.2). No key belongs in this file inline;
// see SIGNER_KEY_STORE_PATH in .env.example.
export {};
