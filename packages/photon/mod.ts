/**
 * `@denext/photon` — a Deno-native WebAssembly build of
 * [photon-rs](https://github.com/silvia-odwyer/photon) `v0.3.3`, exposing the
 * image resize / encode subset denext's built-in image optimizer uses.
 *
 * It is the same underlying codec as the npm `@cf-wasm/photon`, rebuilt for Deno
 * with `jsr:@deno/wasmbuild`, so it carries **zero npm dependencies**. The wasm is
 * instantiated at import time via Deno's native `.wasm` ESM support. See
 * `THIRD-PARTY-LICENSES.md` for the crates statically linked into it.
 *
 * @example Resize a PNG and encode it to WebP
 * ```ts
 * import { PhotonImage, resize, SamplingFilter } from "@denext/photon";
 * const img = PhotonImage.new_from_byteslice(pngBytes);
 * const out = resize(img, 128, 128, SamplingFilter.Lanczos3);
 * const webp = out.get_bytes_webp();
 * img.free();
 * out.free();
 * ```
 *
 * @module
 */
export { PhotonImage, resize, SamplingFilter } from "./lib/denext_photon.js";
