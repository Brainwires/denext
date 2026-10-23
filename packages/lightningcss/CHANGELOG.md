# Changelog

`@denext/lightningcss` uses its own semver, independent of upstream lightningcss (see
[README](./README.md#versioning)). Each entry records the `lightningcss` crate version wrapped.

## 1.0.0-rc.72.1 — wraps lightningcss 1.0.0-alpha.72

- **Security: no `rkyv` in the build (RUSTSEC-2026-0235).** The wrapped crate is built with
  `default-features = false` (plus `serde`), dropping its `bundler` and `sourcemap` features,
  which `transform` never used. `sourcemap` pulled `parcel_sourcemap`, whose unconditional
  `rkyv` 0.7.46 dependency has insufficient archive validation (out-of-bounds reads in archives
  containing `Rc`/`Arc`). `rkyv`, `parcel_sourcemap`, `rayon`, `dashmap` and the other crates only
  those features used are gone from `Cargo.lock` and from `lib/denext_lightningcss.wasm`.
  `transform`'s API and output are unchanged.

## 1.0.0-rc.72 — wraps lightningcss 1.0.0-alpha.72

- Initial release: the `lightningcss` `transform` subset denext's CSS pipeline uses, rebuilt for
  Deno with `wasmbuild` (zero npm dependencies, native `.wasm` ESM instantiation).
  `THIRD-PARTY-LICENSES.md` inventories every statically linked crate.
