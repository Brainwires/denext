# @denext/pages-router

A Next.js **Pages Router** for [denext](https://jsr.io/@denext/denext), shipped as a
first-party **plugin**. Drop it into your `denext.config.ts` and a `pages/` tree
renders alongside your App Router `app/` routes — App Router routes always win, and
the Pages Router claims anything they don't match.

```ts
// denext.config.ts
import { pagesRouter } from "@denext/pages-router";
export default { plugins: [pagesRouter()] };
```

```tsx
// pages/blog/[slug].tsx
export async function getServerSideProps({ params }) {
  return { props: { slug: params.slug } };
}
export default function Post({ slug }: { slug: string }) {
  return <article>Post: {slug}</article>;
}
```

## What's supported

- **File routing** under `pages/` (or `src/pages/`): `index`, nested folders, dynamic
  `[slug]`, catch-all `[...all]`, and optional catch-all `[[...opt]]`. Static routes
  beat dynamic siblings.
- **Data fetching** — **`getServerSideProps`** (per-request), **`getStaticProps`**
  with **build-time SSG** (prerendered to HTML + JSON) and **`revalidate` ISR**
  (stale-while-revalidate), and **`getStaticPaths`** (`fallback: false` returns 404 for
  unlisted params). All support `redirect` / `notFound`.
- **`_app`** (wraps every page), **`_document`** (customize the HTML shell via
  `Html` / `Head` / `Main` / `NextScript` from `@denext/pages-router/document`), and
  **`_error` / `404` / `500`** custom error pages.
- **`next/head`** (`@denext/pages-router/head`) — per-page `<title>`/`<meta>`/`<link>`,
  hoisted at SSR and kept in sync across soft navigation.
- **CSS & CSS Modules** — `import "./x.css"` (global) and `import s from "./x.module.css"`
  inside `pages/`, plus Tailwind; extracted per route and `<link>`ed for a styled first
  paint.
- **`pages/api/*`** handlers with Next's `(req, res)` contract (`req.query`,
  `req.body`, `req.cookies`; `res.status().json()/send()/end()/redirect()`), for any
  HTTP method. Global `middleware.ts` runs before them (denext handles it).
- **`useRouter`** (`@denext/pages-router/router`) and **`Link`**
  (`@denext/pages-router/link`).
- **Client hydration + soft (SPA) navigation.** Pages hydrate in the browser
  (state, effects, event handlers), and internal navigation is client-side — no full
  reload. Each route is **code-split** (`deno bundle`, no npm) with the client runtime
  and `_app` hoisted into one shared chunk; navigating to a `getServerSideProps` /
  `getStaticProps` route fetches fresh props from a JSON data endpoint and lazily
  loads that route's chunk. `Link` clicks and browser back/forward both soft-navigate.
  In dev, entries carry the **Fast Refresh** runtime.

The page's props are embedded as `__NEXT_DATA__` for hydration; `denext build`
pre-bundles every route's client entry and prerenders static pages (served from
`denext start`).

## Roadmap

- `router.events` / shallow routing / real `<Link>` prefetch.
- i18n locale routing and legacy `getInitialProps`.

## Requirements

Requires the denext version that ships the plugin contract (`DenextPlugin`) plus the
`@denext/denext/bundle` and `@denext/denext/build/css` exports. It resolves as a
workspace member in this repo; when published, pin `@denext/denext` to that release.

## License

MIT (see `LICENSE`).
