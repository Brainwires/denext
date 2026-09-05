# Changelog

`@denext/avif` uses its own semver, independent of the upstream
libavif/`@jsquash/avif` codec it vendors (see [README](./README.md#versioning)).
Each entry records the upstream version wrapped.

## 0.1.1 — wraps `@jsquash/avif@2.1.1` (libavif, single-threaded encoder)

- No code change. Ships `THIRD-PARTY-LICENSES.md` — the components compiled into
  `lib/avif_enc.{js,wasm}`: libavif (BSD-2-Clause), libaom 3.7.0 (BSD-2-Clause +
  Alliance for Open Media Patent License 1.0), the Squoosh / `@jsquash/avif`
  Apache-2.0 wrappers, and the emscripten (MIT) runtime — with full license texts.

## 0.1.0 — wraps `@jsquash/avif@2.1.1` (libavif, single-threaded encoder)

- Initial release: a Deno-native AVIF encoder forked from
  `@jsquash/avif@2.1.1`'s prebuilt single-threaded libavif wasm, driven via
  emscripten's `instantiateWasm` hook. Replaces the opt-in npm `@jsquash/avif`
  peer codec in denext's image optimizer (zero npm). Exposes
  `encode(imageData, { quality }) → ArrayBuffer`.
