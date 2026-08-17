# Changelog

`@denext/photon` uses its own semver, independent of upstream photon-rs (see
[README](./README.md#versioning)). Each entry records the photon-rs version wrapped.

## 0.3.4 — wraps photon-rs 0.3.3

- Rebuilt with an aggressive release profile (`opt-level=3`, LTO,
  `codegen-units=1`) to close most of the latency gap vs the npm `@cf-wasm/photon`.
  Output is byte-identical — same codec, same photon-rs 0.3.3.

## 0.3.3 — wraps photon-rs 0.3.3

- Initial release: a Deno-native `wasmbuild` build of photon-rs 0.3.3, replacing
  the npm `@cf-wasm/photon` in denext's image optimizer (zero npm).
