# TanStack Start on denext

A **TanStack Start**-shaped app — `src/router.tsx` exporting `getRouter()`, file routes under
`src/routes/`, and a root route whose `shellComponent` renders the document — server-rendered by
the [`@denext/tanstack-start`](../../packages/tanstack-start) plugin.

## Run it

```sh
denext task install   # installs @tanstack/react-router into node_modules (once)
denext task dev       # http://localhost:3000
denext task build && denext task start
```

## What it shows

- **The plugin owns the route tree** — `src/routeTree.gen.ts` is generated from `src/routes/` by
  TanStack's own generator at build, and as you edit in dev (committed, excluded from fmt/lint).
- **Server rendering** — every page is rendered by TanStack Router's SSR: the matched routes'
  loaders run on the server (`/` says where its loader ran), `__root.tsx`'s `shellComponent` is
  the document, `<HeadContent />` fills the head and `<Scripts />` loads the client bundle.
- **Hydration, then client navigation** — the browser hydrates the document with `RouterClient`
  (the counter on `/` answers clicks), and a `<Link>` runs the next route's loader in the browser.
- **npm from `node_modules`** — `nodeModulesDir: "manual"` + `package.json`, with `react`
  aliased to denext in `deno.json` (what `denext migrate` writes).
