# Changelog

`@denext/swc` uses its own semver, independent of upstream swc (see
[README](./README.md#versioning)). Each entry records the `swc_core` version wrapped.

## 76.0.1 — wraps swc_core 76.0.0

- **Documented, typed public surface.** `mod.ts` now exports documented wrapper
  functions (`parse`, `parseSync`, `print`, `printSync`, `transform`, `transformSync`,
  `minify`, `minifySync`) with typed `ParseOptions` / `Options` / `JsMinifyOptions`
  inputs and `Program` / `Output` results, instead of re-exporting the
  wasmbuild-generated declarations (which carry no JSDoc — the Rust bindings are
  macro-generated). No behavior change: options and results pass through to the wasm
  verbatim, so `@swc/wasm-web` parity holds. Fixes JSR's "has docs for most symbols"
  score.

## 76.0.0 — wraps swc_core 76.0.0

- Initial release: swc's `binding_core_wasm` rebuilt for Deno with `wasmbuild`, zero
  npm dependencies, native `.wasm` ESM instantiation. `THIRD-PARTY-LICENSES.md`
  inventories every statically linked crate.
