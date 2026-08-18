# Changelog

`@denext/pages-router` uses its own semver, independent of the denext version it
plugs into.

## 0.1.0 — SSR-complete Pages Router (plugin)

- Initial release: a Next.js Pages Router as a denext plugin (`pagesRouter()`),
  registered via the `DenextPlugin` contract. It claims requests the App Router
  didn't match.
- File routing under `pages/`/`src/pages/` (index, nested, `[slug]`, `[...all]`,
  `[[...opt]]`), most-specific-first.
- `getServerSideProps` / `getStaticProps` (on-demand) with `redirect`/`notFound`;
  `getStaticPaths` (`fallback: false` → 404 for unlisted params).
- `_app` and `_document` (`Html`/`Head`/`Main`/`NextScript` via
  `@denext/pages-router/document`).
- `pages/api/*` with the `(req, res)` handler contract, any HTTP method.
- `useRouter` (`/router`) and `Link` (`/link`).
- SSR embeds `__NEXT_DATA__` for hydration.

Not yet in v0.1 (planned for v0.2): client-side hydration + soft navigation,
build-time SSG output, `next/head`.
