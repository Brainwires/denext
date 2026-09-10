/**
 * `@denext/swc` — a Deno-native WebAssembly build of
 * [swc](https://github.com/swc-project/swc)'s parse / print / transform / minify
 * bindings, mirroring swc's own `binding_core_wasm` (the crate `@swc/wasm-web` is
 * built from). Rebuilt for Deno with `jsr:@deno/wasmbuild`, so it carries **zero
 * npm dependencies** and instantiates at import via Deno's native `.wasm` ESM
 * support.
 *
 * The JS API matches `@swc/wasm-web`. denext's build pipeline
 * (`src/build/swc-ast.ts`) uses `parse`; the rest are exported for API parity.
 *
 * @example
 * ```ts
 * import { parse } from "@denext/swc";
 * const ast = await parse("const x: number = 1", { syntax: "typescript", target: "es2022" });
 * ast.type; // "Module"
 * ```
 *
 * @module
 */
export {
  minify,
  minifySync,
  parse,
  parseSync,
  print,
  printSync,
  transform,
  transformSync,
} from "./lib/denext_swc.js";

/**
 * No-op initializer. The wasm self-instantiates at import time (native `.wasm`
 * ESM), so no explicit init is needed — this exists only so callers written for
 * `@swc/wasm-web` (whose default export must be `await`ed before use) work
 * unchanged.
 */
export default function init(): Promise<void> {
  return Promise.resolve();
}
