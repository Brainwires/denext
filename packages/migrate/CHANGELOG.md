# Changelog

`@denext/migrate` has no semver of its own: each version is the denext version it ships with, and
`@denext/denext` X.Y.Z imports exactly `@denext/migrate` X.Y.Z (see
[README](./README.md#versioning)).

## Unreleased

- First release: the `denext migrate` migrators that `src/build` carried inside `@denext/denext`,
  moved into their own package to keep denext clear of JSR's 20 MiB package cap.
