// The single source of truth for the react/react-dom/react-is family of specifiers
// denext intercepts. Several build flows map these specifiers to denext, but each
// uses a DIFFERENT target shape, so they cannot share one map:
//
//   - codemod (`SPEC_REWRITE`)        source-text rewrite → `denext` / `denext/client` / …
//   - next-compat (`REACT_ALIASES`)   esbuild alias → prebuilt runtime file (`react.js`)
//   - migrate (`DENEXT_ALIASES` …)    deno.json import map → `<dep>/react` JSR subpath
//   - scaffold                        deno.json import map → `<dep>/react` (via the builder below)
//
// What they MUST agree on is the *set of specifiers*. Keep that here so a new
// react-family subpath is added once, and let `tests/react-specifiers.test.ts`
// fail if any table drifts from these lists.

/** The full react-family specifier set, including the extra `react-dom/server` build
 * variants and `test-utils` that only the esbuild-alias and scaffold import-map paths
 * carry. The superset every other list is a subset of. */
export const REACT_FAMILY_SPECIFIERS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react-dom/server",
  "react-dom/server.browser",
  "react-dom/server.edge",
  "react-dom/test-utils",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-is",
] as const;

/** The "core" react-family subset — primary entry points only, no `server.browser`/
 * `server.edge`/`test-utils`. Used by the source rewrite and the JSR import map. */
export const REACT_FAMILY_CORE = [
  "react",
  "react-dom",
  "react-dom/client",
  "react-dom/server",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-is",
] as const;

/** The client-only react-family subset (no server renderer) — for a Vite/SPA app. */
export const REACT_FAMILY_CLIENT = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-is",
] as const;

/**
 * The react-family portion of a scaffolded/compat deno.json import map: each
 * specifier aliased to `<dep>/<specifier>` (denext's own React under its dep
 * specifier). This is the one place that shape is authored.
 */
export function reactCompatImportMap(dep: string): Record<string, string> {
  return Object.fromEntries(REACT_FAMILY_SPECIFIERS.map((s) => [s, `${dep}/${s}`]));
}
