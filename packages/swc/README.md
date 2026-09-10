# @denext/swc

A Deno-native WebAssembly build of [swc](https://github.com/swc-project/swc)'s
**parse / print / transform / minify** bindings — the same JS API `@swc/wasm-web`
(npm) exposes, produced by mirroring swc's own `bindings/binding_core_wasm` (the
crate `@swc/wasm-web` is built from) and rebuilding it for Deno with
[`wasmbuild`](https://github.com/denoland/wasmbuild). It has **zero npm
dependencies** and instantiates at import via Deno's native `.wasm` ESM support.

```ts
import { parse } from "@denext/swc";

const ast = await parse("const x: number = 1", {
  syntax: "typescript",
  target: "es2022",
});
ast.type; // "Module"
```

Exports `parse` / `parseSync` / `print` / `printSync` / `transform` /
`transformSync` / `minify` / `minifySync`, matching `@swc/wasm-web`. denext's
build pipeline (`src/build/swc-ast.ts`) uses `parse`; the rest are exported for
API parity.

## Versioning

`@denext/swc` uses its **own semver**, independent of upstream. It started at
`76.0.0`, matching the wrapped `swc` crate `76.0.0`. The wrapped crate version is
**documented, not encoded** (`swc_core` is pinned in `Cargo.toml`; see
`CHANGELOG.md`).

## Building

The `lib/` directory (the generated `.wasm` + JS glue) is committed and
published. To regenerate it after changing the Rust wrapper or bumping
`swc_core`:

```sh
cd packages/swc
deno run -A jsr:@deno/wasmbuild build --out lib
```

`cargo` + the `wasm32-unknown-unknown` target are required. `wasm-bindgen` is
pinned to the version wasmbuild bundles (`=0.2.108` in `Cargo.toml`); `swc_core`
declares `^0.2`, so the graph unifies on it. `.cargo/config.toml` enables the JS
entropy backend `getrandom` needs on wasm32. The Rust build cache (`target/`) is
git-ignored.

## License

Apache-2.0, inherited from swc (see `LICENSE`). swc © kdy1 (Donny/강동윤) and
contributors. The wasm statically links swc's Rust dependency graph; every crate,
its copyright notice and license texts are in `THIRD-PARTY-LICENSES.md`.
