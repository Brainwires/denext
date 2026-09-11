//! Deno-native wasm bindings for swc, mirroring swc's own `binding_core_wasm`
//! (the crate `@swc/wasm-web` is built from). The `build_*!` macros come from
//! `swc_core::binding_macros` and generate the exact JS API (`parse`, `parseSync`,
//! `print`, `transform`, `minify`, …) `@swc/wasm-web` exposes — so this is a
//! drop-in, just rebuilt for Deno with `wasmbuild` and zero npm dependencies.
//!
//! denext's build pipeline (`src/build/swc-ast.ts` + the transforms it feeds) uses
//! only `parse`, but the full binding is kept for API parity. The 59 KB
//! TypeScript `typescript_custom_section` from upstream's `types.rs` is omitted:
//! it only refines the generated `.d.ts` (callers here treat the AST as `any`),
//! and has no runtime effect.

use swc_core::binding_macros::{
    build_minify, build_minify_sync, build_parse, build_parse_sync, build_print, build_print_sync,
    build_transform, build_transform_sync,
};
use wasm_bindgen::prelude::*;

build_minify_sync!(#[wasm_bindgen(js_name = "minifySync")]);
build_minify!(#[wasm_bindgen(js_name = "minify")]);
build_parse_sync!(#[wasm_bindgen(js_name = "parseSync")]);
build_parse!(#[wasm_bindgen(js_name = "parse")]);
build_print_sync!(#[wasm_bindgen(js_name = "printSync")]);
build_print!(#[wasm_bindgen(js_name = "print")]);
build_transform_sync!(#[wasm_bindgen(js_name = "transformSync")]);
build_transform!(#[wasm_bindgen(js_name = "transform")]);
