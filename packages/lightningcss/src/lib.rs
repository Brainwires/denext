//! Deno-native wasm binding for the `lightningcss` transform subset denext's CSS
//! pipeline uses (`src/build/css.ts`). Upstream `lightningcss-wasm` is a napi-rs
//! build (needs `@napi-rs/wasm-runtime`); this is a small `wasm-bindgen` wrapper
//! over the same core `lightningcss` crate (=1.0.0-alpha.72), exposing only
//! `transform({ filename, code, cssModules, minify }) -> { code, exports }` —
//! the exact call denext makes. All other lightningcss options are left at their
//! defaults, matching denext's current (option-less) invocation, so output is
//! the same as the npm build for that call.

use lightningcss::stylesheet::{MinifyOptions, ParserOptions, PrinterOptions, StyleSheet};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn err(msg: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

/// Parse, minify, and print a stylesheet. `options` is a JS object:
/// `{ filename?: string, code: Uint8Array, cssModules?: boolean, minify?: boolean }`.
/// Returns `{ code: Uint8Array, exports: object | null }` — the shape
/// `src/build/css.ts` consumes (`result.code`, `result.exports[local].{name,composes}`).
#[wasm_bindgen]
pub fn transform(options: JsValue) -> Result<JsValue, JsValue> {
    let filename = js_sys::Reflect::get(&options, &JsValue::from_str("filename"))
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default();
    let code_val = js_sys::Reflect::get(&options, &JsValue::from_str("code"))?;
    let code_bytes = code_val
        .dyn_into::<js_sys::Uint8Array>()
        .map_err(|_| err("transform: `code` must be a Uint8Array"))?
        .to_vec();
    let css_modules = js_sys::Reflect::get(&options, &JsValue::from_str("cssModules"))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let minify = js_sys::Reflect::get(&options, &JsValue::from_str("minify"))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let source = std::str::from_utf8(&code_bytes).map_err(err)?;

    let mut stylesheet = StyleSheet::parse(
        source,
        ParserOptions {
            filename: filename.clone(),
            css_modules: if css_modules {
                Some(lightningcss::css_modules::Config::default())
            } else {
                None
            },
            ..Default::default()
        },
    )
    .map_err(|e| err(format!("{}", e)))?;

    stylesheet.minify(MinifyOptions::default()).map_err(err)?;

    let res = stylesheet
        .to_css(PrinterOptions { minify, ..Default::default() })
        .map_err(err)?;

    let out = js_sys::Object::new();
    let code = js_sys::Uint8Array::from(res.code.as_bytes());
    js_sys::Reflect::set(&out, &JsValue::from_str("code"), &code)?;
    // Serialize the CSS-modules exports map as a plain JS object (not a JS `Map`,
    // serde-wasm-bindgen's default) so `css.ts`'s `Object.entries(result.exports)`
    // sees it — matching what the napi-based `lightningcss-wasm` emits.
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    let exports = res.exports.serialize(&serializer).map_err(err)?;
    js_sys::Reflect::set(&out, &JsValue::from_str("exports"), &exports)?;
    Ok(out.into())
}
