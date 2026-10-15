// The runtime brand of `denext/result`'s `ok()` / `err()` values, shared with the boundaries
// that accept a returned `Err` (`defineApi`, `defineAction`). The brand is a non-enumerable
// string-keyed property, so it survives across loaded copies of denext and never reaches JSON;
// an ordinary `{ ok: false, error }` object a handler returns is NOT an `Err` here.

import type { Err } from "../result.ts";

/** The property `ok()` / `err()` brand their results with (non-enumerable). */
export const RESULT_KEY = "~result";

/**
 * Was `value` made by `err()` (from any loaded copy of denext)?
 *
 * @param value A handler's return value.
 * @returns True for a branded `Err`.
 */
export function isReturnedErr(value: unknown): value is Err<unknown, unknown> {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)[RESULT_KEY] === "err";
}
