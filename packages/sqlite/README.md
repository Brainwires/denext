# @denext/sqlite

A Deno-native WebAssembly build of
[rsqlite-wasm](https://github.com/Brainwires/rsqlite-wasm) `v0.1.3` — a SQLite-3
engine written in Rust — exposing the small `Database` API denext's durable cache
store uses. Built for Deno with [`wasmbuild`](https://github.com/denoland/wasmbuild)
and the crate's `node:fs` file backend, so it persists to disk with **zero npm
dependencies and no `--unstable-*` flag**.

```ts
import { Database } from "@denext/sqlite";

const db = await Database.open(".denext/cache.db", { backend: "file" });
db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
db.exec("INSERT INTO kv VALUES (?, ?)", ["a", "1"]);
const rows = db.query<{ k: string; v: string }>("SELECT * FROM kv");
db.close();
```

It is denext's recommended durable [cache store](https://jsr.io/@denext/denext)
backend (`sqliteCacheStore`), a first-party alternative to Deno KV that needs no
unstable flag.

## Versioning

The package version tracks the upstream `rsqlite-wasm` crate it wraps (currently
**0.1.3**, pinned in `Cargo.toml`). Bumping the engine is deliberate: update the
pin, rebuild, and re-publish.

## Building

The `lib/` directory (the generated `.wasm` + JS glue) is committed and published.
To regenerate it after bumping `rsqlite-wasm`:

```sh
cd packages/sqlite
deno run -A jsr:@deno/wasmbuild build --out lib
```

`cargo` + the `wasm32-unknown-unknown` target are required; `wasmbuild` fetches the
matching `wasm-bindgen`. The crate is built with its `nodefs` feature (the `node:fs`
file VFS, which resolves under Deno). The Rust build cache (`target/`) is
git-ignored.

## License

MIT, inherited from rsqlite-wasm (see `LICENSE`).
