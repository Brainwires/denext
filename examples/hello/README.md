# hello — the denext starter tour

The smallest end-to-end denext app, and the one the docs and benchmarks lean on.
It exercises the whole round-trip — SSR, hydration, a code-split island, static
and dynamic routes, an API handler, and middleware — in a handful of files. It's
also the **bundle-size baseline** for `bench/` (the "first load" number in
`bench/REPORT.md`).

## What it shows

- **SSR + hydration** (`app/page.tsx`) — the home page renders on the server and
  hydrates into an interactive `useState`/`useEffect` counter; an on-page status
  flips from "server-rendered" to "hydrated ✅" once the browser takes over.
- **Client-only island** (`app/island.tsx`) — loaded via
  `dynamic(() => import("./island.tsx"), { ssr: false })`, so it's code-split
  into its own chunk, absent from the server HTML, and mounted only in the
  browser.
- **Static route, zero JS** (`app/about/page.tsx`) — a page with no
  interactivity ships no client bundle and no hydration script.
- **Dynamic route + SSG + async data** (`app/blog/[slug]/page.tsx`) — an `async`
  Server Component that "fetches" a post server-side, with
  `generateStaticParams` pre-rendering known slugs during `denext export`.
- **Route handler** (`app/api/hello/route.ts`) — a `GET` returning a `Response`.
- **Middleware** (`middleware.ts`) — runs before routing: redirects a legacy
  path and tags every response with a header.
- **Layout, error & 404** (`app/layout.tsx`, `app/error.tsx`,
  `app/not-found.tsx`) — the in-body chrome, an `error.tsx` boundary, and a
  real 404.

## Run

```sh
# from this directory
deno task dev             # http://localhost:3000
deno task build && deno task start
```

Or from the repo root: `deno run -A cli.ts dev examples/hello`.
