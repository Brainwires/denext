# TanStack Start on denext

A **TanStack Start** app — `src/router.tsx` exporting `getRouter()`, file routes
under `src/routes/`, server functions, a server route, and a root route whose
`shellComponent` renders the document — run by the
[`@denext/tanstack-start`](../../packages/tanstack-start) plugin.

## Run it

```sh
denext task install   # installs the TanStack packages into node_modules (once)
denext task dev       # http://localhost:3000
denext task build && denext task start
denext export .       # a static site in out/ (Start's prerender)
```

## What it shows

- **The plugin owns the route tree** — `src/routeTree.gen.ts` is generated from
  `src/routes/` by TanStack's own generator at build, and as you edit in dev
  (committed, excluded from fmt/lint).
- **Start's own handler answers every request** — pages stream through the
  matched routes (`/` says where its loader ran; `/posts/$postId` renders inside
  the `/posts` layout route), the root route's `shellComponent` is the document,
  `<HeadContent />` fills the head and `<Scripts />` loads the client bundle.
- **Server functions** — `src/functions/notes.ts` declares a GET and a POST
  `createServerFn` (validator, middleware). `/notes` calls the GET from its
  loader (in process on the server, over RPC after a client navigation) and the
  POST from a button.
- **Import protection** — the notes live in `src/functions/notes.server.ts`,
  which only the server functions' handlers use: Start's compiler drops those
  handlers from the browser build, and the `*.server.*` module with them. Import
  it from a component and the build fails with Start's
  `[import-protection] Import denied in client environment` error and the import
  chain.
- **Streaming** — `/deferred`'s loader returns a promise it doesn't await; the
  page streams with the fallback and the value arrives when it settles.
- **Errors** — `/boom`'s loader throws, and the route's `errorComponent` renders
  inside the root layout.
- **A server route** — `src/routes/api/hello.ts` answers `GET` and
  `POST /api/hello` with its `server.handlers`.
- **Hydration, then client navigation** — the browser hydrates the document with
  Start's `StartClient` (the counter on `/` answers clicks), and a `<Link>` runs
  the next route's loader in the browser.
- **A static export** — `denext export` prerenders the pages with Start's own
  prerender (the static routes, then the links they have, so
  `/posts/1`…`/posts/3` too) into `out/`, and lists what needs a server:
  `/api/hello` (a server route) and `/notes` (it calls a server function).
  `/boom` is filtered out in `denext.config.ts` (its loader fails on purpose,
  which would fail the export). Start's `spa` option writes its SPA shell to
  `out/_shell.html` (the root route alone, rendered at `/`), and `sitemap`
  writes `out/sitemap.xml` and `out/pages.json`. Serve `out/` from any static
  host with `_shell.html` as its fallback: the pages hydrate and navigate on the
  client, and a path with no file of its own renders from the shell.
- **npm from `node_modules`** — `nodeModulesDir: "manual"` + `package.json`,
  with `react` aliased to denext in `deno.json` (what `denext migrate` writes).
