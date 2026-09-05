# @denext/photon

A Deno-native WebAssembly build of
[photon-rs](https://github.com/silvia-odwyer/photon) `v0.3.3`, exposing the
image **resize / encode** subset denext's built-in image optimizer uses. It is
the same underlying Rust codec as the npm `@cf-wasm/photon`, rebuilt for Deno
with [`wasmbuild`](https://github.com/denoland/wasmbuild) so it has **zero npm
dependencies**.

```ts
import { PhotonImage, resize, SamplingFilter } from "@denext/photon";

const img = PhotonImage.new_from_byteslice(pngBytes);
const out = resize(img, 128, 128, SamplingFilter.Lanczos3);
const webp = out.get_bytes_webp();
img.free();
out.free();
```

## Versioning

`@denext/photon` uses its **own semver**, independent of upstream. It started at
`0.3.3` (the photon-rs release it first wrapped) and **diverges from there** —
our number moves by our rules, never by photon-rs's:

- **patch** — a denext wrapper or build change (e.g. a rebuild against a newer
  `wasm-bindgen`, same codec).
- **minor** — additive API.
- **major** — a breaking API change here, or a codec bump that changes behavior.

The wrapped photon-rs version is **documented, not encoded** — currently
**0.3.3** (pinned as `=0.3.3` in `Cargo.toml`; see `CHANGELOG.md`). Encoding a
third-party version into ours would break the day photon-rs ships `1.0`, so we
don't.

## Building

The `lib/` directory (the generated `.wasm` + JS glue) is committed and
published. To regenerate it after changing the Rust wrapper or bumping
`photon-rs`:

```sh
cd packages/photon
deno run -A jsr:@deno/wasmbuild build --out lib
```

`cargo` + the `wasm32-unknown-unknown` target are required; `wasmbuild` fetches
the matching `wasm-bindgen` itself. The Rust build cache (`target/`) is
git-ignored.

## License

Apache-2.0, inherited from photon-rs (see `LICENSE`). photon-rs © Silvia O'Dwyer
and contributors. The wasm statically links photon-rs's Rust dependency graph
(all permissive: MIT/Apache-2.0 dual, BSD-3-Clause, Unicode-3.0); every crate,
its copyright notice and the license texts are in `THIRD-PARTY-LICENSES.md`,
regenerated after each rebuild with `deno task licenses:photon` (run from the
repo root).
