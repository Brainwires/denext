# Changelog

`@denext/photon` uses its own semver, independent of upstream photon-rs (see
[README](./README.md#versioning)). Each entry records the photon-rs version
wrapped.

## 0.3.6 — wraps photon-rs 0.3.3

- No code change. The generated `lib/denext_photon.d.ts` gains JSDoc on the members
  wasm-bindgen emits undocumented (`free()`, `[Symbol.dispose]()`, the `SamplingFilter`
  enum and its members), added by `deno task docs:wasm` after `wasmbuild`. Fixes JSR's
  "has docs for most symbols" score.

## 0.3.5 — wraps photon-rs 0.3.3

- No code change. Ships `THIRD-PARTY-LICENSES.md` — the inventory of every Rust
  crate statically linked into `lib/denext_photon.wasm` (photon-rs and its
  transitive crates: manifest license, elected license, copyright notices, and
  the full text of each non-MIT/Apache license), generated from `cargo metadata`
  by `deno task licenses:photon`.

## 0.3.4 — wraps photon-rs 0.3.3

- No code change. Re-published from CI via the `photon-v*` tag to record **build
  provenance** (0.3.3 was published manually, without it).

## 0.3.3 — wraps photon-rs 0.3.3

- Initial release: a Deno-native `wasmbuild` build of photon-rs 0.3.3, replacing
  the npm `@cf-wasm/photon` in denext's image optimizer (zero npm).
