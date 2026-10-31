# Changelog

`@denext/docs-corpus` has no semver of its own: each version is the denext version it was generated
for, and `@denext/denext` X.Y.Z imports exactly `@denext/docs-corpus` X.Y.Z (see
[README](./README.md#versioning)).

## Unreleased

- Carries the packed native templates `denext mobile add` writes (`./native-templates`), which
  `@denext/denext` used to ship itself, to keep it clear of JSR's 20 MiB package cap. Nothing
  about `@denext/denext`'s own API changes. The pack also carries the fastlane files, the
  widget, Live Activity and native-module sources, the composed Android `MainActivity`'s blocks
  and the desktop packaging scripts `denext create --desktop` scaffolds.

## 4.3.0

- First release, with denext 4.3.0: the corpus that `src/mcp/docs-corpus.ts` carried inside
  `@denext/denext`, moved into its own package to keep denext clear of JSR's 20 MiB package cap.
  The package was briefly versioned on its own (0.1.0); that version was never published.
