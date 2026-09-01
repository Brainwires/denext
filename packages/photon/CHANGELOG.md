# Changelog

`@denext/photon` uses its own semver, independent of upstream photon-rs (see
[README](./README.md#versioning)). Each entry records the photon-rs version
wrapped.

## 0.3.4 — wraps photon-rs 0.3.3

- No code change. Re-published from CI via the `photon-v*` tag to record **build
  provenance** (0.3.3 was published manually, without it).

## 0.3.3 — wraps photon-rs 0.3.3

- Initial release: a Deno-native `wasmbuild` build of photon-rs 0.3.3, replacing
  the npm `@cf-wasm/photon` in denext's image optimizer (zero npm).
