# Changelog

`@denext/og` uses its own semver, independent of the upstream satori/resvg/`@cf-wasm/og`
stack it vendors (see [README](./README.md#versioning)). Each entry records the upstream
versions bundled.

## 0.1.0 — vendors `@cf-wasm/og@0.5.0` (satori@0.29.0 · resvg-wasm@2.4.1 · Noto Sans v27)

- Initial release: a Deno-native `ImageResponse` that renders JSX-shaped satori
  elements to PNG/SVG. Vendors the full satori + yoga + resvg stack as a single
  self-contained esbuild bundle (`lib/og.bundle.js`) generated from `@cf-wasm/og`'s
  `node` entry — `yoga.wasm`, `resvg.wasm`, and the default Noto Sans font are inlined
  as base64, so plain-Latin rendering needs zero npm deps and no runtime permissions.
  Replaces the opt-in npm `@cf-wasm/og` peer codec in denext's `next/og`
  implementation. Exposes `ImageResponse`, plus `CustomFont`/`GoogleFont`/
  `loadGoogleFont` for custom fonts.
