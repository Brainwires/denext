/**
 * `@denext/lightningcss` — a Deno-native WebAssembly build of the
 * [lightningcss](https://github.com/parcel-bundler/lightningcss) `transform`
 * subset denext's CSS pipeline (`src/build/css.ts`) uses.
 *
 * Upstream `lightningcss-wasm` (npm) is a **napi-rs** wasm build that needs the
 * `@napi-rs/wasm-runtime` npm package on the JS side. This is a small
 * `wasm-bindgen` wrapper over the **same** core `lightningcss` crate
 * (`1.0.0-alpha.72`, published here as `1.0.0-rc.72`), so it carries **zero npm
 * dependencies** and instantiates at import via Deno's native `.wasm` ESM support.
 * For the calls denext makes, output is identical to `lightningcss-wasm`. See
 * `THIRD-PARTY-LICENSES.md` for the crates statically linked into it.
 *
 * @example
 * ```ts
 * import { transform } from "@denext/lightningcss";
 * const { code, exports } = transform({
 *   filename: "a.css",
 *   code: new TextEncoder().encode(".a { color: #ff0000 }"),
 *   cssModules: false,
 *   minify: true,
 * });
 * new TextDecoder().decode(code); // ".a{color:red}"
 * ```
 *
 * @module
 */
export { transform } from "./lib/denext_lightningcss.js";

/**
 * No-op initializer. The wasm self-instantiates at import time (native `.wasm`
 * ESM), so no explicit init is needed — this exists only so callers written for
 * `lightningcss-wasm` (whose default export must be `await`ed before use) work
 * unchanged.
 */
export default function init(): Promise<void> {
  return Promise.resolve();
}
