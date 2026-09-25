/**
 * Where the web SQLite engine for {@linkcode openSqlite} lives: the URLs of the app's own
 * `@sqlite.org/sqlite-wasm` module and its `sqlite3.wasm`.
 *
 * This file is the fallback: both are null, meaning the build found no engine. denext never
 * ships an npm runtime dependency, so the engine is the app's to install
 * (`npm install @sqlite.org/sqlite-wasm`). In the prebuilt runtime this import stays external
 * as a bare specifier, and the app build (the esbuild pipeline behind SPA and compat builds)
 * points it at a generated module that emits the package's two files as assets and exports
 * their URLs, or at this fallback when the package is not installed.
 *
 * Internal to `denext/mobile`: not an entrypoint.
 *
 * @module
 */

/** The engine module's URL (`@sqlite.org/sqlite-wasm`'s `dist/index.mjs`), or null. */
export const moduleUrl: string | null = null;

/** The URL of the engine's `sqlite3.wasm`, or null. */
export const wasmUrl: string | null = null;
