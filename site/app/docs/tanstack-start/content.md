---
title: TanStack Start
slug: tanstack-start
lead: The @denext/tanstack-start plugin runs a TanStack Start app on denext with its source unchanged — server functions, server routes, streamed pages, hydration, Start's import protection and its prerender. denext migrate sets it up.
---

[TanStack Start](https://tanstack.com/start) runs on denext through the
[`@denext/tanstack-start`](https://github.com/Brainwires/denext/blob/main/packages/tanstack-start/README.md)
plugin, which uses the [plugin](/docs/plugins) seams alone. TanStack's own runtime answers every
request; denext builds the app, applies its request rules and serves it. A working app is in
[`examples/tanstack-start`](https://github.com/Brainwires/denext/blob/main/examples/tanstack-start/README.md).

## Setup

```ts
// denext.config.ts
import { tanstackStart } from "@denext/tanstack-start";
export default { compatibilityMode: true, plugins: [tanstackStart()] };
```

The app lists `@tanstack/react-start` and `@tanstack/react-router` in `package.json`, and
`@tanstack/router-generator` in `devDependencies`; the plugin loads them from the app's own
`node_modules` and depends on no npm package itself. `compatibilityMode: true` is required: the
server and client bundles are compiled onto denext's React, as a Pages Router app's are, so the
app's npm packages that import `react` get denext's.

The app keeps Start's layout: `src/router.tsx` exports `getRouter()`, and
`src/routes/__root.tsx` renders the document from its `shellComponent`. `src/start.ts`
(exporting `startInstance` from `createStart`), `src/server.ts` and `src/client.tsx` are
optional, as in Start.

```tsx
// src/routes/__root.tsx
export const Route = createRootRoute({
  head: () => ({ meta: [{ title: "My app" }] }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
});
```

## Migrating a Start app

`denext migrate` recognizes a Start app from `@tanstack/react-start` in `package.json` plus
Start's Vite plugin (`tanstackStart(` in `vite.config`) or a Vinxi-era `app.config.*`. Start is
checked before the Remix and Vite SPA paths, since a Start app has a `vite.config` too; pass
`--from tanstack-start` to force it.

```sh
denext migrate --check   # what it would write, and the options it leaves behind
denext migrate
denext task dev
```

It writes:

- **`denext.config.ts`** with `compatibilityMode: true` and `tanstackStart({ … })`, carrying the
  Start options `vite.config` passes that the plugin takes (`srcDirectory`, `router`,
  `importProtection`, `prerender`, `pages`, `sitemap`, `spa`), each as written, as long as its
  value reads nothing else from the config file (an import or a top-level declaration). The config
  is read as text, never run.
- **`deno.json`**, unless you wrote one: React mapped to denext, `@denext/tanstack-start`,
  TanStack's packages left to your `node_modules` (`nodeModulesDir: "manual"`), the
  `sloppy-imports` unstable flag (Start apps import `./routeTree.gen` without an extension), and
  `src/routeTree.gen.ts` excluded from `deno fmt` and `deno lint`.
- **`.gitignore`** entries for `.denext/`, `out/` and `.deno/` (the native TypeScript 7 check's
  project cache), and a `.vscode` Deno setting, appended only when missing.

What stays behind is listed for review in the summary and in `denext migrate --check`:

- `tsr`: the route generator reads `tsr.config.json`; move these options there.
- `server`: denext builds and serves the server itself (`src/server.ts` still applies).
- `client`: denext builds the client bundle itself (`src/client.tsx` still applies).
- `vite`: there is no Vite build under denext.
- Any other key the plugin does not take, an option whose value reads an import or a declaration
  from the config (carry it by hand), and options built in code rather than written as an object.
- A Vinxi-era `app.config.*`: the plugin runs Start's current layout, so upgrade Start first
  (TanStack's Vinxi-to-Vite migration guide). Its `tsr.appDirectory` is carried as
  `srcDirectory`.

The migration bed
[`tests/migration-bed/tanstack-start-basic.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migration-bed/tanstack-start-basic.test.ts)
migrates TanStack's own `start-basic` example (file routes with a pathless layout, a server
route, a `beforeLoad` redirect, a not-found component, `~/` paths and Tailwind 4), then builds
and serves it and opens it in a headless browser.

## What the plugin does

- **Generates the route tree** with TanStack's own `@tanstack/router-generator`, over
  `src/routes/` into `src/routeTree.gen.ts`, at `denext build` and `denext dev` startup and again
  when a route file changes in dev. `tsr.config.json` still applies.
- **Answers every request with Start's handler** (`createStartHandler(defaultStreamHandler)`).
  Pages are matched by TanStack Router, their `beforeLoad` and `loader` run on the server, and the
  root route's shell streams with nested layouts and pending, error and not-found components. A
  loader promise you don't await streams in when it settles.
- **Server functions** (`createServerFn`, GET or POST, with `validator` and `middleware`) are
  answered at `/_serverFn/<id>` in Start's own RPC format. A server function called with a
  mutating method must come from the app's own origin (the check denext's Server Actions use), or
  it is a 403 before Start sees it. Request bodies to server functions and server routes are read
  under a cap: 413 over it.
- **Server routes**: a route's `server.handlers` answer its URL directly.
- **Compiles with TanStack's own compiler** (`@tanstack/start-plugin-core`): in the browser a
  server function is an RPC stub, and server-only code is dropped.
- **Emits Vite's asset imports** from both bundles under `/_tss/assets/`, content-hashed and the
  same URL on both sides: an `app.css?url` link (a Tailwind input is compiled with the project's
  Tailwind), images and fonts. It hydrates with Start's `StartClient`, from a client bundle under
  `/_tss/`.
- **Applies Start's import protection** to both builds, with its rules, options and messages,
  plus denext's own server-only scan of the browser build.
- **Lists its routes in the deploy manifest** (`.denext/deploy-manifest.json`): server routes
  and server functions as `"route-handler"`s, pages as `"static"` or `"dynamic"` with the reason,
  and its `/_tss/` client files as asset groups (`client.js` served `no-cache`, the hashed chunks
  and `assets/` immutable). The `static` deploy preset refuses the routes that need a server.
- **Prerenders with `denext export`**, using Start's `prerender` and `pages` options. Each page
  is written as its final HTML (every Suspense boundary's content in place), so an exported page
  reads the same with JavaScript off and hydrates when it is on.

## Options

| Option              | Default                                    | What it does                                                        |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `srcDirectory`      | `"src"`                                    | Where the app's sources live, relative to the project.              |
| `router`            | `"router.tsx"`                             | The router module under `srcDirectory`, or Start's `router` object. |
| `generateRouteTree` | `true`                                     | `false` leaves generating `routeTree.gen.ts` to you.                |
| `maxBodyBytes`      | the app's `actionMaxBodyBytes`, else 1 MiB | The request-body cap for server functions and server routes.        |
| `allowedOrigins`    | none                                       | Other origins (or bare hosts) allowed to POST to a server function. |
| `importProtection`  | Start's rules                              | Start's `importProtection` options.                                 |
| `prerender`         | on in `denext export`                      | Start's `prerender` options; `enabled: false` turns it off.         |
| `pages`             | `[{ path: "/" }]`                          | The paths `denext export` prerenders, with per-page options.        |
| `sitemap`           | none                                       | Writes `sitemap.xml` and `pages.json` in `denext export`.           |
| `spa`               | none                                       | Writes the SPA shell in `denext export`.                            |

### `router`

A filename under `srcDirectory`, or Start's own `router` object: `entry` (under `srcDirectory`;
the extension may be left out), `basepath`, and the route generator's options
(`routesDirectory` and `generatedRouteTree` relative to `srcDirectory`, the rest applied over
`tsr.config.json`). denext serves the app under its own `basePath`, so a `basepath` that differs
from it is refused: set `basePath` in `denext.config.ts`. Also refused: `target` (the plugin
builds a React app), `autoCodeSplitting` (denext splits the browser bundle itself) and
`addExtensions: false` (Deno resolves the route tree's imports by extension).

### `importProtection`

The same shape as in Start's Vite plugin:

- `enabled`: `false` turns Start's rules off (denext's server-only scan still runs).
- `client` / `server`: `{ specifiers, files, excludeFiles }` per side. `client.specifiers` adds to
  Start's; every other list replaces Start's default for that side. `excludeFiles` defaults to
  everything under `node_modules`. Patterns are globs over project-relative paths (or specifiers
  as written), or regular expressions.
- `include`, `exclude`, `ignoreImporters`: which importers are checked (by default those under
  `srcDirectory`).
- `onViolation(v)`: returning `false` waives a violation.
- `behavior`: `"error"` or `"mock"`, or `{ dev, build }`. Unset, it is `"mock"` in `denext dev`
  and `"error"` in `denext build`, `start` and `export`. An `"error"` violation fails the build
  (in dev, the request that builds); a `"mock"` one makes the denied import Start's mock module
  and the violation a warning.
- `mockAccess`: `"error"` (default), `"warn"` or `"off"`, how the browser mock reports its first
  use in dev.
- `maxTraceDepth`: how far up a violation's trace walks (default 20).
- `log`: `"once"` (default) warns about each mocked violation once per process, `"always"` on
  every build.

### `prerender`, `pages`, `spa` and `sitemap`

`prerender` and `pages` take Start's shapes (`prerender: { enabled, filter, crawlLinks, … }`,
`pages: [{ path, prerender, sitemap }]`). `denext export` renders the pages you list (or `/`),
every static path in the route tree and the links each page has, through Start's handler, as
`<path>/index.html`. Routes that need a server are left out and listed with the reason. A page
that does not answer 2xx fails the export (`failOnError`), as in Start.

- **`spa: { enabled, maskPath, prerender }`** adds Start's SPA shell: the root route alone,
  rendered at `maskPath` (default `"/"`) to `<prerender.outputPath>.html` (default `/_shell`, so
  `_shell.html`). Point your static host's fallback at it. In `denext dev`, as in Start's dev
  server, every page is then the shell and the browser renders the route; `spa: { enabled: false }`
  turns both off.
- **`sitemap: { enabled, host, outputPath }`** (`enabled` defaults to `true` once the option is
  given) runs Start's `buildSitemap` over every page the prerender met, writing `sitemap.xml` (at
  `outputPath`, default `"sitemap.xml"`) and `pages.json`. `host` is required: without it the
  export fails, as Start's build does.

### Checked options

`tanstackStart()` checks its options when `denext.config.ts` loads. A wrong type, or a key that is
not an option (the closest one is suggested), fails with the field's path:

```
invalid tanstackStart() options: `importProtection.cleint` is not an option (did you mean `client`?)
```

## Limitations

A mocked import's runtime message in `denext dev` lists no import trace; with
`generateRouteTree: false`, `denext export` prerenders only the `pages` listed and their links;
and the app's own `react` import must resolve to denext (`compatibilityMode`). The full list is in
[Known limitations](/docs/limitations).
