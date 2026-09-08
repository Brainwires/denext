# @denext/content-collections

## [0.1.0] - 2026-09-08

### Added

- Initial release: a typed, validated, queryable content layer for denext apps.
  - `content.config.ts` with `defineContentConfig` / `defineCollection` and a Standard Schema per
    collection; a `glob` loader for local MD/MDX/YAML/JSON, and a `Loader` interface for
    remote/custom sources.
  - The `contentCollections()` plugin builds the store (`.denext/content-data.json`) and generates
    types (`.denext/content.ts`) — live in `denext dev` (regenerated on content changes) and at
    `denext build`, via denext's plugin prepare-step seam.
  - Server-only runtime `getCollection` / `getEntry` typed to your collections and schemas.
  - `denext content build | list | validate` CLI verb (`validate` is a CI gate).
