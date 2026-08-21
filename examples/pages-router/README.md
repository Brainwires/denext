# pages-router — the `@denext/pages-router` plugin

The reference app for the legacy **Pages Router**, which ships as an opt-in
plugin (`@denext/pages-router`) rather than in the core. It also shows the Pages
Router **coexisting with the App Router** in one app.

## Enabling it

```ts
// denext.config.ts
import { pagesRouter } from "@denext/pages-router";

export default {
  plugins: [pagesRouter()],
};
```

With the plugin registered, a `pages/` tree is routed alongside `app/`.

## What it shows

- **File routing** (`pages/index.tsx`, `pages/about.tsx`,
  `pages/blog/[slug].tsx`, `pages/ssg/[id].tsx`) — index, static, and dynamic
  routes.
- **Data fetching** — `getServerSideProps` (`pages/blog/[slug].tsx`,
  per-request, server-side — including the JSON fetch a soft navigation makes)
  and `getStaticProps` + `getStaticPaths` with `revalidate` ISR
  (`pages/ssg/[id].tsx`).
- **Custom `_app`** (`pages/_app.tsx`) — wraps every page; its `.shell` node is
  shared across routes, so a correct soft navigation reconciles it in place
  rather than remounting.
- **Custom `404`** (`pages/404.tsx`).
- **`next/head` + CSS Modules** — `@denext/pages-router/head` for per-page
  `<title>`/`<meta>`, and `*.module.css` scoped styles (`index.module.css`,
  `about.module.css`) plus global CSS (`styles/globals.css`).
- **Hydration + soft nav** — the counter on the home page proves state/event
  hydration; the `<Link>`s prove code-split soft navigation.
- **App Router coexistence** (`app/app-page/page.tsx`) — an App Router route
  living in the same app as the `pages/` tree.

The plugin's known gaps (`router.events`, shallow routing, `<Link>` prefetch,
i18n locale routing) are tracked in
[KNOWN-LIMITATIONS.md](../../KNOWN-LIMITATIONS.md).

## Run

```sh
# from this directory
deno task dev             # http://localhost:3000
deno task build && deno task start
```
