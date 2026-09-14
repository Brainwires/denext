# @denext/content-collections

## [0.4.0] - 2026-09-13

### Added

- **GFM pipe tables** in the Markdown renderer: the delimiter row under the header sets each
  column's alignment (`:--` / `:-:` / `--:`, emitted as an `align-*` class, not a `style=`
  attribute), the outer pipes are optional, and a `\|` escape is consumed **before** the inline
  pass so a pipe inside a code span (`` `redirect(url, "push"\|"replace")` ``) survives cell
  splitting. Short rows are padded and long rows truncated to the header width (GFM), and the
  table is emitted inside a `<div class="table-wrap">`. A header line plus a delimiter row of the
  same width is the whole trigger, so prose containing a pipe stays a paragraph.

### Changed

- **A blank `>` line splits a quote or a `> [!NOTE]` callout into `<p>` paragraphs.** A
  single-paragraph quote renders exactly as before (bare, no `<p>`).
- **Heading ids now match GitHub for punctuation between spaces:** each space becomes one hyphen
  instead of one hyphen per run, so `## Known Gaps & Residual Risk` anchors as
  `known-gaps--residual-risk`. Anchors of headings with a `&` or `—` between words change.

## [0.3.0] - 2026-09-13

### Added

- **Reference-style links** in the Markdown renderer: `[label]: url` definitions (anywhere in
  the document, optional `<…>` and title, first definition wins) resolve `[text][label]`,
  `[label][]` and the shortcut `[label]`; an undefined label stays literal text and a
  script-scheme definition renders as plain text, like inline links.

### Fixed

- **Code-span placeholder collided with prose.** Spans were parked behind a `N` (space, digits,
  space) marker and restored over the whole output, so any digit run set off by spaces in a
  paragraph (`I have 1 apple`) was replaced by the wrong span or by `undefined`, and a span
  written inside a link destination (`[a](x`c`y)`) was restored INSIDE the `href` after
  escaping — an attribute breakout. The placeholder is NUL-delimited (NUL is stripped from the
  source first), a destination containing whitespace is not a link (as in CommonMark), and a
  `[label]: url` line inside a fenced block is code, not a definition.

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
