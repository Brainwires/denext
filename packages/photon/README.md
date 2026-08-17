# @denext/photon

A Deno-native WebAssembly build of [photon-rs](https://github.com/silvia-odwyer/photon)
`v0.3.3`, exposing the image **resize / encode** subset denext's built-in image
optimizer uses. It is the same underlying Rust codec as the npm `@cf-wasm/photon`,
rebuilt for Deno with [`wasmbuild`](https://github.com/denoland/wasmbuild) so it has
**zero npm dependencies**.

```ts
import { PhotonImage, resize, SamplingFilter } from "@denext/photon";

const img = PhotonImage.new_from_byteslice(pngBytes);
const out = resize(img, 128, 128, SamplingFilter.Lanczos3);
const webp = out.get_bytes_webp();
img.free();
out.free();
```

## Versioning

The package version tracks the upstream `photon-rs` crate version it wraps
(currently **0.3.3**, pinned in `Cargo.toml`). Bumping the codec is deliberate:
update the pin, rebuild, and re-publish.

## Building

The `lib/` directory (the generated `.wasm` + JS glue) is committed and published.
To regenerate it after changing the Rust wrapper or bumping `photon-rs`:

```sh
cd packages/photon
deno run -A jsr:@deno/wasmbuild build --out lib
```

`cargo` + the `wasm32-unknown-unknown` target are required; `wasmbuild` fetches the
matching `wasm-bindgen` itself. The Rust build cache (`target/`) is git-ignored.

## License

Apache-2.0, inherited from photon-rs (see `LICENSE`). photon-rs © Silvia O'Dwyer
and contributors.
