// @generated file from wasmbuild -- do not edit
// deno-lint-ignore-file
// deno-fmt-ignore-file

/**
 * Parse, minify, and print a stylesheet. `options` is a JS object:
 * `{ filename?: string, code: Uint8Array, cssModules?: boolean, minify?: boolean }`.
 * Returns `{ code: Uint8Array, exports: object | null }` — the shape
 * `src/build/css.ts` consumes (`result.code`, `result.exports[local].{name,composes}`).
 */
export function transform(options: any): any;
