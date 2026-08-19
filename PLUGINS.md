# Writing a denext plugin

denext features that don't belong in core ship as **plugins** — separate JSR packages
that extend denext through a narrow, semver-stable contract. The reference plugin is
[`@denext/pages-router`](./packages/pages-router), a full Next.js Pages Router; the
smallest worked example is [`examples/plugin-aliases`](./examples/plugin-aliases).

A plugin is a `DenextPlugin`: a `name` plus a `setup(ctx)` that wires into denext's
seams. Add it to your project config:

```ts
// denext.config.ts
import { myPlugin } from "my-denext-plugin";
export default { plugins: [myPlugin()] };
```

`setup` runs **once per process, before the first route scan**. Apps with no plugins
pay nothing — every seam is a no-op when unused.

## The contract

Import the types from `@denext/denext/server`:

```ts
import type { DenextPlugin, PluginContext } from "@denext/denext/server";

export function myPlugin(): DenextPlugin {
  return {
    name: "my-plugin", // unique; registration is de-duplicated by name
    setup(ctx: PluginContext) {
      // ctx.projectRoot   — absolute project root (holds denext.config.*)
      // ctx.appDir         — the App Router scan root (avoid colliding with it)
      // ctx.config         — the resolved DenextConfig
      // ctx.mode           — "dev" | "build" | "prod" | "export"
      // ctx.load           — load a module by absolute file path
      // ...plus the four seams below.
    },
  };
}
```

### Seam 1 — contribute routes

`ctx.addRouteSynthesizer(fn)` runs your hook over every scanned `RouteManifest`
(dev, build, prod, and export all call the same scan). Push `PageRoute`/`ApiRoute`
objects and they flow through denext's matcher, renderer, **and build** unchanged —
so a route you synthesize is bundled and hydrated like any App Router route. The hook
may be async (e.g. scan your own tree off disk):

```ts
import { parsePattern } from "@denext/denext/server";

ctx.addRouteSynthesizer(async (manifest) => {
  manifest.pages.push({
    kind: "page",
    routePath: "/generated",
    pattern: parsePattern("generated"),
    filePath: "/abs/path/to/generated/page.tsx",
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  });
});
```

Use this when your routes render through denext's **normal** App Router path — the
lightest case is to clone an existing route under a new path (see
[`examples/plugin-aliases`](./examples/plugin-aliases), which aliases `/home` to `/`).

### Seam 2 — claim requests (a distinct render path)

`ctx.addRequestHandler(fn)` registers a handler called for requests the App Router
**did not** match — after core page/API matching, before static assets and the 404.
Return a `Response` to serve it, or `null` to pass. This is how a plugin runs its own
pipeline (its own `_app`/`_document`/data-fetching), as the Pages Router does:

```ts
ctx.addRequestHandler(async (request) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/legacy/")) return null; // not ours
  return new Response(await renderLegacy(url), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
```

Core routes always win, so a plugin never shadows an App Router page.

### Seam 3 — build steps

`ctx.addBuildStep(fn)` registers a step run during `denext build`, after the core
client bundles are written. Use it to emit your plugin's own assets into the output
directory:

```ts
ctx.addBuildStep(async ({ outDir, projectRoot, config }) => {
  await emitMyClientBundles(outDir);
});
```

### Seam 4 — teardown

`ctx.addTeardown(fn)` registers a disposer that runs when the server **drains** — the
symmetric shutdown for anything `setup` opened (a file watcher, a connection, a
timer). Disposers run most-recently-registered first; a throwing one is logged and
never strands the others:

```ts
const watcher = Deno.watchFs(ctx.appDir);
ctx.addTeardown(() => watcher.close());
```

## Rendering

A plugin renders with denext's **public** exports — there is no private render API to
learn:

- `h`, `Fragment`, `renderToString`, `Suspense`, `use`, hooks — from `@denext/denext`
- `renderToReadableStream` — from `@denext/denext/react-dom/server`
- client hydration (`hydrateRoot`, `startClient`, `Root`) — from `@denext/denext/client`
- route primitives (`parsePattern`, `matchSegments`, `specificity`, `splitPath`,
  `scanRoutes`, `registerRouteSynthesizer`, `registerConvention`) — from
  `@denext/denext/server`
- the browser bundler (`bundleRoutes`, `bundleSource`) — from `@denext/denext/bundle`,
  for a plugin that generates its own hydration entries. It shells out to `deno bundle`
  (code splitting on, no npm), so entries that share a runtime download it once.
- the CSS pipeline (`buildAppCss`, `extractRouteCss`) — from `@denext/denext/build/css`,
  so a plugin's own bundles can `import "./x.css"` (imports resolve to JS shims) and it
  can extract per-route CSS to `<link>`.
- the page cache (`PageCache`) — from `@denext/denext/server`, for ISR /
  stale-while-revalidate in a plugin's own render path.

Because a plugin uses the same React runtime as the rest of the app, its components
compose with App Router components and share one reconciler.

## Rules & guarantees

- **Per-plugin state needs no special seam.** A synthesizer, request handler, build
  step, or teardown registered inside `setup` **closes over `setup`'s scope**, so they
  already share state — keep it in `setup`'s locals, not module globals.
- **Ordering is defined.** Across `config.plugins`, setups run in array order. Request
  handlers are tried in registration order (first non-null wins); build steps run in
  registration order; teardowns run in reverse. Route synthesizers run in registration
  order, then the manifest is re-sorted by specificity.
- **`setup` runs once**, keyed by `name` — safe to re-enter (a dev server re-scans on
  every change; a repeated `name` registers a single time).
- **Zero cost when unused.** An app with no plugins wires none of these seams.

## Stability

The plugin surface is **semver-stable public API**: `DenextPlugin`, `PluginContext`,
`PluginRequestHandler`, `PluginBuildStep`, `PluginBuildContext`, `PluginTeardown`, and
the route/segment primitives above. Breaking changes to it follow denext's semver.
Keep your plugin's own surface small for the same reason — it becomes API the moment
someone depends on it. Publish independently (its own semver), depending on
`@denext/denext` as a peer.

## Complete examples

- **[`examples/plugin-aliases`](./examples/plugin-aliases)** — a ~40-line plugin using
  the **route-synthesizer** + **teardown** seams (path aliases). The smallest end-to-end
  model to copy.
- **[`@denext/pages-router`](./packages/pages-router)** — detects a `pages/` tree,
  registers a request handler (seam 2) that runs the Pages Router pipeline (SSR, data
  fetching, client hydration, soft navigation), and a build step (seam 3) that
  pre-bundles each route's client entry with `@denext/denext/bundle`. Its `mod.ts` is a
  compact model for the request/build seams.
