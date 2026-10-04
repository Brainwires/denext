/**
 * React-compatible `react/compiler-runtime` entrypoint for denext.
 *
 * npm libraries precompiled with the React Compiler import the memo-cache hook as
 * `import { c } from "react/compiler-runtime"`. denext's builds alias that specifier
 * here (and `denext migrate` / `denext create` write the import-map entry), so the
 * compiled output runs on denext's single hook dispatcher instead of loading real
 * React's runtime:
 *
 * ```jsonc
 * "imports": { "react/compiler-runtime": "jsr:@denext/denext/react/compiler-runtime" }
 * ```
 *
 * Like React's module it exports only `c`. Slots start as React's own
 * `Symbol.for("react.memo_cache_sentinel")`, which is what compiled code compares against.
 * denext's own auto-memo compiler imports the fuller `denext/compiler-runtime`.
 *
 * @module
 */

import { c as useMemoCacheAlias } from "../runtime/compiler-runtime.ts";

/**
 * The React Compiler's memo-cache hook: a per-component array of `size` slots that
 * survives re-renders, every slot starting as `Symbol.for("react.memo_cache_sentinel")`.
 * Compiled code reads `const $ = c(2); if ($[0] === Symbol.for("react.memo_cache_sentinel"))`.
 *
 * @param size The number of cache slots the compiled component uses.
 * @returns The component's cache array.
 */
export const c: (size: number) => unknown[] = useMemoCacheAlias;
