/**
 * Query and tier validation, defined once in `@ntux402/shared`.
 *
 * Re-exported rather than reimplemented so this service and the orchestrator
 * cannot drift on the limit. The shared module explains why both of them run
 * it: the orchestrator's pass is the courteous one, this one is load-bearing,
 * and this service is the one holding a key that spends money.
 *
 * The file stays so `handler.ts` and the tests keep importing a local path —
 * the validation belongs to this service's boundary even though the code
 * defining it does not live here.
 */

export {
  MAX_QUERY_LENGTH,
  validateQuery,
  validateTier,
  type ValidationResult,
} from "@ntux402/shared";
