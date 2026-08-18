# Changelog

`@denext/pages-router` uses its own semver, independent of the denext version it
plugs into.

## 0.2.0 — Client hydration + soft navigation

- **Client-side hydration.** Each route now ships a browser entry that hydrates the
  server-rendered page — state, effects, and event handlers work. The entry reads
  `__NEXT_DATA__`, mounts `_app > Page` under the router provider, and hydrates
  `#__next` via denext's public `hydrateRoot`.
- **Soft (SPA) navigation.** The runtime intercepts same-origin link clicks and
  `popstate`, fetches the target route's props from a JSON **data endpoint** (marked
  with `x-denext-pages-data`, so `getServerSideProps`/`getStaticProps` run on the
  server), lazily imports that route's code-split chunk, and re-renders in place — no
  full reload. The shared `_app` shell is reconciled, not remounted.
- **Code splitting.** Routes are bundled in one `deno bundle` pass (no npm) so the
  client runtime and `_app` hoist into a single shared chunk downloaded once.
- **Build step (seam 3).** `denext build` pre-bundles every route's client entry into
  `.denext/pages-client/`; `denext start` serves them (dev bundles lazily in-process).
- New `@denext/pages-router/client-runtime` export (imported by generated entries).
- Requires the denext release that ships the `@denext/denext/bundle` export.

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

(Client-side hydration + soft navigation landed in 0.2.0.)
