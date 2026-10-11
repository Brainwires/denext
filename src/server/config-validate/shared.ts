// The helpers every denext.config field-group validator shares: the field-scoped `Fail`, the
// finite-number checks, and the small shape predicates.

/** Throws a field-scoped `invalid <name>: \`<field>\` <msg>` error. */
export type Fail = (field: string, msg: string) => never;

export interface NumOpts {
  int?: boolean;
  min?: number;
  max?: number;
}

/** Whether `v` is a finite number within the requested range / integer-ness. */
function isValidNumber(v: unknown, opts: NumOpts): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (v < (opts.min ?? 0)) return false;
  if (opts.max !== undefined && v > opts.max) return false;
  if (opts.int && !Number.isInteger(v)) return false;
  return true;
}

/**
 * A `NaN`/`Infinity`/negative slips silently into HTTP headers (`max-age`),
 * redirect-loop bounds, and cache-eviction counts otherwise, so validate
 * finiteness/range at boot (present fields only; `undefined` keeps the default).
 */
export function num(fail: Fail, field: string, v: unknown, opts: NumOpts = {}): void {
  if (isValidNumber(v, opts)) return;
  const min = opts.min ?? 0;
  const range = opts.max !== undefined ? `${min}..${opts.max}` : `>= ${min}`;
  fail(field, `must be a finite ${opts.int ? "integer" : "number"} ${range}`);
}

/** Validate an array of numbers element-wise. */
export function numArray(fail: Fail, field: string, v: unknown, opts: NumOpts): void {
  if (!Array.isArray(v)) fail(field, "must be an array of numbers");
  else (v as unknown[]).forEach((el, i) => num(fail, `${field}[${i}]`, el, opts));
}

/** Whether `v` is a plain (non-array, non-null) object. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A value that must be one of `allowed` when set. */
export function oneOf(v: unknown, allowed: readonly string[], field: string, fail: Fail): void {
  if (v !== undefined && !allowed.includes(v as string)) {
    fail(field, `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
  }
}

/** An optional project-relative path: a non-empty string when present. */
export function validateOptionalPath(field: string, value: unknown, fail: Fail): void {
  if (value !== undefined && (typeof value !== "string" || value === "")) {
    fail(field, "must be a non-empty path relative to the project root");
  }
}
