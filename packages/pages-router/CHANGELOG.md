# Changelog

`@denext/pages-router` uses its own semver, independent of the denext version it
plugs into.

## 0.9.0 — `next/router` singleton + `withRouter`

- **`Router` singleton** (`next/router`'s default export). Proxies the active client
  router — `push`/`replace`/`reload`/`back`/`forward`/`prefetch`/`events` plus
  `pathname`/`route`/`query`/`asPath` and `ready()` — so you can navigate and subscribe
  to route events from outside React (`Router.push("/x")`, `Router.events.on(…)`). The
  client runtime publishes the live router on each navigation; before hydration it falls
  back to a `window.location`-derived router.
- **`withRouter(Component)`** — the HOC that injects the active router as a `router` prop,
  for class components (or any component that can't call `useRouter`).

## 0.8.0 — i18n locale routing

- **i18n.** With `i18n: { locales, defaultLocale }` in `denext.config.ts`, a
  `/{locale}` path prefix is peeled off before route matching (`/fr/about` →
  `/about`), and the active locale flows into `getServerSideProps`/`getStaticProps`/
  `getInitialProps` (`ctx.locale`), into `__NEXT_DATA__`, and onto the router
  (`router.locale` / `router.locales` / `router.defaultLocale`, tracked across soft
  nav). `<Link locale>` prefixes an app-absolute href. The default locale is served
  unprefixed. A non-default locale renders live so its data fetching runs with the
  locale (per-locale SSG output isn't prewritten). Reuses denext's shared
  `peelLocale` (the same primitive the App Router uses), so behavior matches.

## 0.7.0 — legacy `getInitialProps`

- **`getInitialProps`.** A page component's static `getInitialProps(ctx)` — and
  `_app`'s (which, when present, owns the flow via `App.getInitialProps({ Component,
  ctx })`, matching Next) — now supplies `pageProps`. `ctx` carries `pathname` (the
  route **pattern**), `asPath` (the real URL), `query`, `params`, and `req`. Presence
  of either makes the route dynamic. Unlike Next (which runs it on the client during
  client-side nav), denext resolves it **server-side** for both the initial render and
  soft-nav data requests — coherent with this router's server-driven data model, so
  `ctx` has no `res`.

## 0.6.0 — `<Link prefetch>` / `router.prefetch()`

- **Viewport prefetch.** `<Link prefetch>` marks an anchor so the client runtime
  warms the route's **code chunk** (and stylesheet) via an `IntersectionObserver`
  when the link scrolls into view; `router.prefetch(url)` does the same imperatively.
  A prefetch hits a new server "head" mode (`x-denext-pages-prefetch`) that returns
  only the entry/CSS URLs and deliberately **does not run
  `getServerSideProps`/`getStaticProps`** — prefetch is side-effect-free, matching
  Next's "prefetch the JS, not the data." A later navigation to a warmed route skips
  the chunk import. Deduped per URL; best-effort (a failed prefetch just navigates
  normally). Opt-in — a `Link` without `prefetch` stays a plain soft-navigating anchor.

## 0.5.0 — shallow routing + transition options

- **Shallow routing.** `router.push`/`replace` now take Next's
  `(url, as?, options?)` signature. `options.shallow` swaps the URL + query on the
  **same page** without re-running `getServerSideProps`/`getStaticProps` — the
  current page and props are kept and re-rendered (a cross-page `shallow` falls
  back to a normal data-fetching navigation, matching Next). `as` overrides the
  address-bar URL; `options.scroll: false` suppresses the scroll-to-top. Route-change
  events carry `{ shallow }`.

## 0.4.0 — `router.events`

- **`router.events`.** `useRouter().events` now exposes Next's route-change event
  emitter (`on`/`off`/`emit`) firing `routeChangeStart`, `routeChangeComplete`,
  `routeChangeError` (with `err.cancelled` for a superseded navigation),
  `beforeHistoryChange`, and the `hashChange*` names. Soft navigations emit
  start→complete around the data fetch + render; aborts (fetch/chunk failure,
  not-found, a superseded nav) emit `routeChangeError`. Unblocks NProgress-style
  top-loading bars and analytics pageview tracking. The emitter instance is stable
  across renders, so an `on`/`off` pair registered in an effect targets one emitter.
- Requires denext **≥ 2.0.0-rc.1** (workspace alignment; the peer range was `^1.0.0`).

## 0.3.1 — documentation-only

Complete the public-API doc graph so `deno doc --lint` is clean across the whole
`exports` set (raises the JSR score). No runtime or behavior change: the plugin,
router, `Link`, `Head`, and document entrypoints now re-export the denext types
they exposed only transitively (`DenextPlugin`/`PluginContext` and their closure,
`VNode`/`VNodeChildren`, etc.) and swap internal `ReturnType<typeof h>` annotations
for the public `VNode` type.

## 0.3.0 — CSS, error pages, next/head, SSG + ISR, Fast Refresh

Completes Next.js Pages Router parity for real apps.

- **CSS & CSS Modules.** `import "./x.css"` / `import s from "./x.module.css"` inside
  `pages/` now work (and Tailwind), via the new `@denext/denext/build/css` pipeline:
  imports resolve to JS shims (no CSS-parsed-as-JS), each route's reachable CSS is
  extracted and `<link>`ed at SSR for a styled first paint.
- **Error pages.** Custom `_error` / `404` / `500` render through the normal `_app`/
  `_document` pipeline; render errors are caught → `500`; unknown page paths →
  the custom `404` (asset paths still fall through to static serving).
- **`next/head`** (`@denext/pages-router/head`). `<title>`/`<meta>`/`<link>` from any
  page hoist into `<head>` at SSR and are diffed into `document.head` across soft
  navigation (SSR tags are adopted on hydration — no duplicates).
- **SSG + ISR.** `denext build` runs `getStaticPaths`/`getStaticProps` and prerenders
  `index.html` + `props.json` per path to `.denext/pages-static/`; the handler serves
  those directly. `getStaticProps` `revalidate: N` drives stale-while-revalidate ISR
  via the public `PageCache`.
- **Dev Fast Refresh.** Dev client entries emit `enableFastRefresh()` + family
  registration; the dev bundle cache invalidates on page-file edits (mtime).
- Requires denext **≥ 1.0.0** (ships `@denext/denext/bundle` + `@denext/denext/build/css`).

### Production hardening (1.0 review)

- The request handler never throws out to core: every path (bundle serving, API
  `import`, the soft-nav data endpoint, prerendered/ISR serving) is guarded and
  returns a proper response, with a last-resort 500 backstop.
- **API routes** honor a handler's own error status (`res.status(400)` then throw →
  `400`, not `500`) instead of re-throwing.
- **ISR** never poisons the cache: a background regeneration is stored only when it's
  a real `200` page (a redirect/`notFound`/error regen keeps serving stale and backs
  off); a cache-backend error still serves the prerendered file rather than a 500.
- **Soft navigation** injects the target route's stylesheet (per-route CSS Modules no
  longer render unstyled after an SPA nav), sequences concurrent navigations (a
  superseded fetch is discarded), and `next/head` restores base `<meta>` on nav-away.
- **SSG** handles catch-all array params (`{ slug: ["a","b"] }` → `/a/b`), rejects
  unsafe `getStaticPaths` paths, and reports the route in build errors.

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
