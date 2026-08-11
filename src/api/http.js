// Small HTTP helpers shared by the API routers.

/** Wrap an async handler so rejected promises reach Express' error path. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Parse a positive integer query param with a default + hard cap. */
export function intParam(value, def, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

/** True for the sandbox test-drive namespace (patient id `sandbox:<userId>`). */
export const isSandbox = (waId) => String(waId || '').startsWith('sandbox:');
