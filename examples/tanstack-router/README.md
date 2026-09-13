# TanStack Router on denext (library mode)

A stock **file-based TanStack Router** app running in denext **SPA mode** — no plugin, no
server rendering. TanStack owns routing in the browser; denext owns the bundle, the CSS, the
dev server, the HTML shell, and (via `deno task export` + `denext desktop`) native packaging.
This is exactly the shape `denext migrate` produces for a Vite + TanStack Router app.

## Run it

```sh
deno task install   # installs @tanstack/react-router into node_modules (once)
deno task dev       # http://localhost:3000
deno task build && deno task start
```

`deno task routes` regenerates `src/routeTree.gen.ts` after you add or rename a route file
(the TanStack Router CLI, run out-of-band — the Vite plugin that did this on the fly has no
role under denext). The generated file is committed and excluded from `deno fmt`/`deno lint`.

## What it shows

- **Zero framework glue** — `src/main.tsx` is the TanStack `createRouter` + `RouterProvider`
  you would write for Vite; denext bundles it as `spa.entry`.
- **History-API fallback** — every extensionless URL (`/posts/2`) gets the shell, so a deep
  link or reload lands on the right route (`src/build/spa/shared.ts`, `wantsShell`).
- **`spa.rootId`** — the app renders into `#app` (TanStack's scaffold), not the shell's
  default `#root`; `denext.config.ts` says so.
- **Loaders + dynamic segments** — `src/routes/posts/$postId.tsx` loads from `src/data.ts`
  and throws `notFound()` for an unknown id; `__root.tsx` owns the global not-found UI.
- **npm from `node_modules`** — `nodeModulesDir: "manual"` + `package.json`: the router
  resolves from the installed tree, the same as a pnpm/npm project after `denext migrate`.

## Migration vs. this example

A real Vite + TanStack Router app migrated with `denext migrate` keeps its `package.json`
untouched and its source unchanged. What migrate writes:

- `denext.config.ts` — `mode: "spa"`, `compatibilityMode: true`, `spa.entry`/`title` from
  `index.html`, `spa.rootId` when the app mounts somewhere other than `#root` (read from the
  entry's `getElementById`), the `tailwind` block pointing at whichever stylesheet imports
  Tailwind (`src/styles.css` in TanStack's scaffold), and `spa.loading`/`spa.head` boot content.
- `deno.json` — the `react`/`react-dom` aliases to denext, tsconfig `paths` as import-map
  aliases, `nodeModulesDir: "manual"` when a lockfile is present.
- Dropped: `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `@tanstack/router-plugin`,
  `@tanstack/devtools-vite` (Vite plugins with no role under denext). Kept: the runtime
  (`@tanstack/react-router`, devtools) and `@tanstack/router-cli` — run `tsr generate` (or
  `tsr watch` beside `denext dev`) instead of the Vite plugin.

This in-repo copy differs only in pointing `denext` at the checkout (`../../mod.ts`) and in
the `workspace: []` key in `deno.json` (it lives inside the denext repo's workspace without
being a member; a migrated app in its own repo does not need it).

## Known limits

- A route whose **last path segment contains a dot** (`/files/report.pdf`) is treated as an
  asset request and 404s instead of serving the shell (`wantsShell`).
- `spa.proxy` applies to `denext start` and the desktop runtime, not to `denext dev`.
- No server rendering: this is TanStack Router's library mode. TanStack Start-style SSR would
  be a `plugin-kit` router plugin (see ROADMAP.md).
