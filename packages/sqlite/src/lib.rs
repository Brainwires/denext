//! Deno-native wasm bindings for rsqlite-wasm (a SQLite-3 engine written in Rust),
//! built with the `node:fs` file backend so it persists to disk under Deno. This
//! re-exports the raw `WasmDatabase`; `@denext/sqlite`'s `mod.ts` wraps it in the
//! small `Database` API denext's cache store consumes.

pub use rsqlite_wasm::WasmDatabase;
