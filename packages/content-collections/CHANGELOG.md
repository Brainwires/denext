# @denext/content-collections

## [0.2.0] - 2026-09-10

### Added

- **First-party rendering: `renderContent(entry, { components })` and `<Content entry />`.**
  `.md` entries render at request time through the package's own zero-dependency Markdown
  renderer (new `@denext/content-collections/markdown` export: headings with ids, lists, fenced
  code, blockquotes and `> [!NOTE]` callouts, links, emphasis, inline code; raw HTML is escaped,
  `javascript:`/`data:` link targets are dropped). `.mdx` entries are **compiled at build** — and
  at `denext dev` startup / on change — into a component module under
  `.denext/content/<collection>/<id>.js` via denext's build-time `@mdx-js/mdx` (a new
  `compileMdxSource` plugin-kit seam), so nothing MDX-related runs at request time;
  `components` reach the document. A compile failure is a per-entry diagnostic.
- Each entry now carries `format` (`"md"` | `"mdx"`, absent for data collections) and, for MDX,
  `v` (a source hash that cache-busts the compiled module across dev rebuilds).

### Changed

- Requires `@denext/denext` ≥ 2.4 (the `compileMdxSource` plugin-kit export).

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
