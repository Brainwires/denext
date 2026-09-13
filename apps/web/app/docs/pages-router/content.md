---
title: Pages Router
slug: pages-router
lead: The full Next.js Pages Router as an opt-in plugin: pages/ routing, getServerSideProps / getStaticProps / getStaticPaths, _app and _document, API routes, useRouter with events and shallow routing, i18n and Preview Mode.
---

## Why a plugin

denext's built-in router is the **App Router**. The full Next.js Pages Router —
`getServerSideProps`/`getStaticProps`/`getStaticPaths`/`getInitialProps`,
`_app`/`_document`, `pages/api/*`, and `useRouter` with events, shallow routing,
`<Link>` prefetch and i18n locale routing — ships instead as the opt-in
[`@denext/pages-router`](https://jsr.io/@denext/pages-router) package: the same
surface, on a leaner core that doesn't carry two routers for the apps that use
one. It's also the reference plugin for denext's
[plugin contract](/docs/plugins). See
[Architecture](/docs/architecture) for the reasoning.

## Install

`denext plugin add @denext/pages-router` adds the dependency and wires the
plugin into `denext.config.ts` in one step. The result — or what you write by
hand:

```ts
// denext.config.ts
import { pagesRouter } from "@denext/pages-router";

export default { plugins: [pagesRouter()] };
```

With the plugin registered, a `pages/` tree is routed alongside `app/`.
`denext migrate` does this for you: when it finds a `pages/` (or `src/pages/`)
tree it maps the package in `deno.json`, scaffolds that config, and rewrites
`next/router`, `next/head` and `next/link` to the plugin's compat modules — see
[Migrating from Next.js](/docs/migrating).

## Routing

File routing lives under `pages/` or `src/pages/`: `index`, nested folders,
dynamic `[slug]`, catch-all `[...all]`, and optional catch-all `[[...opt]]`.
Static routes beat dynamic siblings, most-specific-first.

```
pages/
  _app.tsx          # wraps every page
  _document.tsx     # the HTML shell (Html/Main/NextScript)
  _error.tsx        # plus custom 404.tsx / 500.tsx
  index.tsx         # /
  blog/[slug].tsx   # /blog/hello
  docs/[...all].tsx # /docs/a/b
```

`_document` is customized with `Html` / `Head` / `Main` / `NextScript` from
`@denext/pages-router/document`. Error pages render **SSR-only** — `_error`,
`404` and `500` ship no client bundle, so handlers and effects on them don't
run.

## Data fetching

`getServerSideProps` runs per request. `getStaticProps` prerenders to HTML +
JSON at `denext build`, with `revalidate: N` driving stale-while-revalidate
ISR; `getStaticPaths` enumerates the paths (`fallback: false` returns 404 for
unlisted params). Both support `redirect` and `notFound`. A page's static
`getInitialProps` — or `_app`'s, which then owns the flow — also supplies
`pageProps`, resolved **server-side** in denext for both the initial render and
soft-nav data requests.

```tsx
// pages/ssg/[id].tsx
export const getStaticPaths = () => ({
  paths: [{ params: { id: "1" } }],
  fallback: false,
});
export const getStaticProps = ({ params }) => ({
  props: { id: params.id },
  revalidate: 60,
});
```

> [!NOTE]
> SSG and ISR are production-only. `denext dev` has no prerender step, so
> `getStaticProps` runs per request and `revalidate` is inert; `denext build` +
> `denext start` prerender and serve them.

## API routes

`pages/api/*` handlers use Next's `(req, res)` contract for any HTTP method —
`req.query`, `req.body`, `req.cookies`, and
`res.status().json()/send()/end()/redirect()`. Global `middleware.ts` runs
before them. Request bodies are capped by `bodyParser.sizeLimit` **while the
body streams** (multipart included, and `bodyParser: false` is still bounded by
the default limit); an oversized body is a `413`. A handler's own error status
is honored — `res.status(400)` then throwing yields a `400`, not a `500`.

```ts
// pages/api/hello.ts
export default function handler(req, res) {
  res.status(200).json({ hello: req.query.name ?? "world" });
}
```

## On the client

Pages hydrate in the browser and internal navigation is client-side. Each route
is **code-split** with the client runtime and `_app` hoisted into one shared
chunk; a soft navigation fetches fresh props from a JSON data endpoint and
lazily imports that route's chunk. `useRouter` and `Router` come from
`@denext/pages-router/router` (`next/router` after `denext migrate`), with
`router.events`, `push`/`replace` taking `(url, as?, options?)` — `shallow`
swaps URL and query without re-running data fetching — plus `withRouter` for
class components. `<Link prefetch>` warms a route's chunk on viewport entry
without running its data fetching. Dev entries carry **Fast Refresh**.

```tsx
import { useRouter } from "@denext/pages-router/router";

const router = useRouter();
router.events.on("routeChangeStart", (url) => start(url));
router.push("/blog?page=2", undefined, { shallow: true });
```

## i18n locale routing

With `i18n: { locales, defaultLocale }` in `denext.config.ts`, a `/{locale}`
path prefix is peeled off before route matching (`/fr/about` → `/about`). The
active locale flows into `getServerSideProps`/`getStaticProps`/`getInitialProps`
as `ctx.locale`, into `__NEXT_DATA__`, and onto the router as `router.locale` /
`router.locales` / `router.defaultLocale`, tracked across soft navigation.
`<Link locale>` prefixes an app-absolute href. The default locale is served
unprefixed; a non-default locale renders live so its data fetching runs with
that locale, rather than being prewritten per locale at build.

## Preview Mode

Preview Mode signs its cookie with `DENEXT_PREVIEW_SECRET`. Set it to a long
random value in production — comma-separated to rotate keys. Without it a random
per-process key is used, so preview sessions don't survive a restart or span
instances, and a one-time warning fires. A forged or unsigned preview cookie is
ignored: it never discloses drafts. It is one of denext's
[deliberate differences](/docs/differences).

## Mixing with the App Router

The two routers coexist in one app. Core routes always win, so the plugin never
shadows an `app/` page — it claims the requests the App Router didn't match.
`next/head` (`@denext/pages-router/head`) hoists per-page `<title>`/`<meta>`/
`<link>` at SSR and diffs them into `document.head` across soft navigation, but
its dedupe set is narrower than Next's — see
[Known limitations](/docs/limitations).

[`examples/pages-router`](https://github.com/Brainwires/denext/tree/main/examples/pages-router)
is the reference app for all of the above, including App Router coexistence; the
package itself lives at
[`packages/pages-router`](https://github.com/Brainwires/denext/tree/main/packages/pages-router).
