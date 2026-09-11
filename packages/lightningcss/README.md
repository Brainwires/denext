# @denext/lightningcss

A Deno-native WebAssembly build of the
[lightningcss](https://github.com/parcel-bundler/lightningcss) **`transform`**
subset denext's CSS pipeline uses. Upstream `lightningcss-wasm` (npm) is a
**napi-rs** wasm build that needs the `@napi-rs/wasm-runtime` npm package; this
is a small [`wasm-bindgen`](https://github.com/denoland/wasmbuild) wrapper over
the **same** core `lightningcss` crate, so it has **zero npm dependencies** and
instantiates at import via Deno's native `.wasm` ESM support. For the calls
denext makes, its output is identical to `lightningcss-wasm`.

```ts
import { transform } from "@denext/lightningcss";

const { code, exports } = transform({
  filename: "a.css",
  code: new TextEncoder().encode(".a { color: #ff0000 }"),
  cssModules: false,
  minify: true,
});
new TextDecoder().decode(code); // ".a{color:red}"
```

`transform(options)` takes `{ filename?, code: Uint8Array, cssModules?, minify? }`
and returns `{ code: Uint8Array, exports: object | null }` (the CSS-modules class
map). It exposes only the slice denext's `src/build/css.ts` calls; the full
lightningcss option surface (targets/browserslist, drafts, dependency analysis,
visitors) is intentionally not wired.

## Versioning

`@denext/lightningcss` uses its **own semver**, independent of upstream. It
started at `1.0.0-rc.72`, matching the wrapped `lightningcss` crate
`1.0.0-alpha.72` (the crate is pre-1.0 `alpha`; JSR requires a valid semver, so
the pre-release tag is relabelled `rc`). The wrapped crate version is
**documented, not encoded** (pinned as `=1.0.0-alpha.72` in `Cargo.toml`; see
`CHANGELOG.md`).

## Building

The `lib/` directory (the generated `.wasm` + JS glue) is committed and
published. To regenerate it after changing the Rust wrapper or bumping
`lightningcss`:

```sh
cd packages/lightningcss
deno run -A jsr:@deno/wasmbuild build --out lib
```

`cargo` + the `wasm32-unknown-unknown` target are required; `wasmbuild` fetches
the matching `wasm-bindgen` itself. `.cargo/config.toml` enables the JS entropy
backend `getrandom` needs on wasm32. The Rust build cache (`target/`) is
git-ignored.

## License

MPL-2.0, inherited from lightningcss (see `LICENSE`). lightningcss © Devon Govett
and contributors. The wasm statically links lightningcss's Rust dependency graph;
every crate, its copyright notice and license texts are in
`THIRD-PARTY-LICENSES.md`.
