/**
 * Request validation, defined once in `@ntux402/shared`.
 *
 * Re-exported rather than reimplemented, the same arrangement `query.ts` uses
 * in the search vendor and for the same reason: the shared module explains why
 * two components run the same check, and this service is the one holding a key
 * that spends money on real hardware.
 *
 * The file stays so `handler.ts` and the tests import a local path — the
 * validation belongs to this service's boundary even though the code defining
 * it does not live here.
 */

export {
  validateMinutes,
  validateSku,
  validateWorkload,
  type ValidationResult,
} from "@ntux402/shared";
