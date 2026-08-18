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
- **`getServerSideProps`** (per-request) and **`getStaticProps`** (rendered on
  demand), with `redirect` / `notFound` results, plus **`getStaticPaths`**
  (`fallback: false` returns 404 for unlisted params).
- **`_app`** (wraps every page) and **`_document`** (customize the HTML shell via
  `Html` / `Head` / `Main` / `NextScript` from `@denext/pages-router/document`).
- **`pages/api/*`** handlers with Next's `(req, res)` contract (`req.query`,
  `req.body`, `req.cookies`; `res.status().json()/send()/end()/redirect()`), for any
  HTTP method. Global `middleware.ts` runs before them (denext handles it).
- **`useRouter`** (`@denext/pages-router/router`) and **`Link`**
  (`@denext/pages-router/link`).

The page's props are embedded as `__NEXT_DATA__` for hydration.

## Roadmap (v0.2)

- **Client-side hydration + soft navigation.** v0.1 renders pages **server-side**;
  `useRouter`/`Link` reflect the route and navigate with a full document load. Client
  hydration (interactivity without a reload) and SPA soft navigation land next, using
  denext's client bundler.
- Build-time static pre-rendering (SSG output) for `getStaticProps` pages.
- `next/head`.

## Requirements

Requires the denext version that ships the plugin contract
(`DenextPlugin`/`matchExternal`). It resolves as a workspace member in this repo; when
published, pin `@denext/denext` to that release.

## License

MIT (see `LICENSE`).
