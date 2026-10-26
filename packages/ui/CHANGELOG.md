# Changelog

`@denext/ui` has no semver of its own: each version is the denext version it ships with, and
`@denext/denext` X.Y.Z imports exactly `@denext/ui` X.Y.Z (see [README](./README.md#versioning)).

## Unreleased

- First release: the `denext ui` / `denext dashboard` web UI that `src/ui` carried inside
  `@denext/denext`, moved into its own package to keep denext clear of JSR's 20 MiB package cap.
