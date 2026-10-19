# @denext/tanstack-start

Run a [TanStack Start](https://tanstack.com/start) app on [denext](https://denext.dev), through
the plugin-kit seams alone: server functions, server routes, streamed pages, hydration, Start's
import protection and its prerender.
TanStack's own runtime answers every request; denext builds the app, applies its request rules
and serves it.

```ts
// denext.config.ts
import { tanstackStart } from "@denext/tanstack-start";
export default { compatibilityMode: true, plugins: [tanstackStart()] };
```

The app lists `@tanstack/react-start` (with `@tanstack/react-router`) in `package.json`, and
`@tanstack/router-generator` in `devDependencies`. The plugin loads them from the app's own
`node_modules` and depends on no npm package itself.

`denext migrate` sets a Start app up: it recognizes `@tanstack/react-start` with Start's Vite
plugin (`tanstackStart()` in `vite.config.ts`) and writes this config, the Start options
`vite.config.ts` passes (`srcDirectory`, `router`, `importProtection`, `prerender`, `pages`,
`sitemap`, `spa`)
carried into `tanstackStart({ … })`, and a `deno.json` that maps React to denext and loads
TanStack from `node_modules`. `denext migrate --check` lists the options it leaves behind.

## What it does

- **Owns the route tree.** A prepare step runs TanStack's own generator
  (`@tanstack/router-generator`) over `src/routes/` into `src/routeTree.gen.ts` at `denext build`
  and `denext dev` startup, and again whenever a route file changes in dev. Its imports carry
  extensions, so Deno resolves them as written; `tsr.config.json` still applies. Pass
  `generateRouteTree: false` to generate it yourself.
- **Answers every request with Start's own handler** (`createStartHandler(defaultStreamHandler)`
  from `@tanstack/react-start/server`, what Start's default server entry exports):
  - **Pages** are matched by TanStack Router; each match's `beforeLoad` and `loader` run on the
    server, and the root route's `shellComponent` streams with nested layouts, pending, error and
    not-found components as in Start. A loader promise you don't await (rendered with `<Await>`
    in a `<Suspense>`) streams in when it settles. Crawlers get the whole page at once, as in
    Start.
  - **Server functions** (`createServerFn`, GET or POST, with `validator` and `middleware`) are
    answered at `/_serverFn/<id>` in Start's own RPC format, so the client code Start generates
    works unchanged. A loader calls one in process on the server and over RPC after hydration.
  - **Server routes**: a route's `server.handlers` (`GET`, `POST`, …) answer its URL directly.
  - Request middleware and `src/start.ts`'s `startInstance` apply as in Start.
- **Compiles with TanStack's own compiler** (`@tanstack/start-plugin-core`, Start's Vite plugin's
  transform): in the browser a server function is an RPC stub, its validator and handler and the
  imports only they used are dropped, as are `createMiddleware().server()`, `createServerOnlyFn`
  bodies and a route's `server` / `headers` / `ssr` options; on the server a function's handler
  is split into the module the RPC resolves.
- **Applies denext's request rules first:** a server function called with a mutating method
  (POST) must come from the app's own origin — the check denext's Server Actions use (`Origin`,
  else `Referer`; `canonicalOrigin`, `trustForwardedHeaders` and `desktop.app.origin` apply) —
  or it is a 403 before Start sees it. Request bodies to server functions and server routes are
  read under a cap (413 over it).
- **Emits Vite's asset imports** from both bundles under `/_tss/assets/`, content-hashed and the
  same URL on both sides: an `app.css?url` link (a Tailwind input is compiled with the project's
  Tailwind), images and fonts.
- **Hydrates in the browser** with Start's `StartClient`, from a client bundle served under
  `/_tss/` and named in the router manifest, so `<Scripts />` loads it. From there navigation is
  TanStack's.

- **Applies Start's import protection to both builds,** with its rules, options and messages
  (`[import-protection] Import denied in client environment`, the pattern, the importer, the
  trace from an entry): the browser build refuses a `*.server.*` file,
  `@tanstack/react-start/server` and a module marked with
  `import "@tanstack/react-start/server-only"`; the server build refuses a `*.client.*` file and a
  module marked with `import "@tanstack/react-start/client-only"`. As in a Start build, an import
  counts only when tree-shaking kept it, and the compiler's safe boundaries come first: an import
  used only inside a `createServerFn` handler or a `createServerOnlyFn` body is gone from the
  browser build, and one used only inside a `createClientOnlyFn` body is gone from the server
  build. The browser build also runs denext's own server-only scan (a `node:` import, the
  `server-only` marker or the `Deno` global in a module the browser gets, read as TanStack's
  compiler left it).
- **Prerenders with `denext export`,** using Start's own `prerender` and `pages` options: the
  pages you list (or `/`), every static path in the route tree, and the links each page has, each
  rendered through Start's handler and written as `<path>/index.html` beside the client bundle.
  Routes that need a server are left out and listed with the reason, as the `static` deploy
  preset lists them: server routes, pages that call a server function from the browser, and
  dynamic routes no prerendered page links to. Start's `spa` option adds the SPA shell
  (`_shell.html`) and its `sitemap` option writes `sitemap.xml` and `pages.json`.
- **Lists its routes in the deploy manifest** (`.denext/deploy-manifest.json`), so a deploy
  adapter sees them: server routes and server functions (at `/_serverFn/<id>`) as
  `"route-handler"`s, pages as `"static"` or, when they need a server (a server function reached
  in the browser, a dynamic segment), `"dynamic"`, with the reason. Its client files under
  `/_tss/` are the manifest's asset groups, with the `Cache-Control` it serves them with:
  `client.js` revalidated (`no-cache`), the content-hashed chunks and `assets/` immutable.
- **Keeps denext's directives:** `"use cache"` caches in the server bundle (with
  `cacheComponents` on), Start-compiled modules included. A `"use server"` module's source never
  reaches the browser: its server functions are RPC stubs there, and its other exports throw when
  called.

The server bundle and the client bundle are compiled onto denext's React (the app's npm packages
import `react`), as a Pages Router app's are. `denext build` builds both, so a build error
surfaces at build and `denext start` serves its first request without building. In `denext dev`
an edit under `src/` rebuilds both on the next request.

## The app

Start's layout: `src/router.tsx` exports `getRouter()`, and `src/routes/__root.tsx` renders the
document. `src/start.ts` (exporting `startInstance` from `createStart`), `src/server.ts` and
`src/client.tsx` are optional, as in Start.

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

```ts
// src/functions/notes.ts
import { createServerFn } from "@tanstack/react-start";
export const addNote = createServerFn({ method: "POST" })
  .validator((data: { text: string }) => data)
  .handler(({ data }) => db.notes.insert(data.text));
```

## Options

| Option              | Default                                    | What it does                                                        |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `srcDirectory`      | `src`                                      | Where the app's sources live, relative to the project.              |
| `router`            | `router.tsx`                               | The router module, or Start's `router` object (below).              |
| `generateRouteTree` | `true`                                     | `false` keeps generating `routeTree.gen.ts` yourself.               |
| `maxBodyBytes`      | the app's `actionMaxBodyBytes`, else 1 MiB | The request-body cap for server functions and server routes.        |
| `allowedOrigins`    | none                                       | Other origins (or bare hosts) allowed to POST to a server function. |
| `importProtection`  | Start's rules                              | Start's `importProtection` options (below).                         |
| `prerender`         | on in `denext export`                      | Start's `prerender` options (below); `enabled: false` turns it off. |
| `pages`             | `[{ path: "/" }]`                          | Start's `pages`: the paths `denext export` prerenders.              |
| `sitemap`           | none                                       | Start's `sitemap`: `denext export` writes `sitemap.xml` (below).    |
| `spa`               | none                                       | Start's `spa`: `denext export` writes the SPA shell (below).        |

### `importProtection`

The same shape as `tanstackStart({ importProtection })` in Start's Vite plugin:

```ts
tanstackStart({
  importProtection: {
    // Added to Start's browser rules (its own specifiers always apply).
    client: { specifiers: ["@prisma/client", /^node:/], files: ["**/*.server.*", "src/db/**"] },
    // Replace Start's server rules.
    server: { files: ["**/*.client.*", "**/*.browser.*"] },
    // Which importers are checked (default: those under srcDirectory).
    exclude: ["src/legacy/**"],
    onViolation: (v) => v.importer.endsWith("allowed.ts") ? false : undefined,
  },
});
```

`client.specifiers` adds to Start's; every other list replaces Start's default for that side
(`files`, `excludeFiles`, `server.specifiers`). Patterns are globs over paths relative to the
project (or specifiers as written), or regular expressions. `include`, `exclude` and
`ignoreImporters` choose the importers checked; `onViolation` returning `false` waives a
violation; `enabled: false` turns Start's rules off (denext's server-only scan still runs);
`maxTraceDepth` (default 20) caps how far up a violation's trace walks.

`behavior` resolves as in Start: a string applies to every command, and the object form
`{ dev, build }` (or `behavior` unset) defaults to `"mock"` in `denext dev` and `"error"` in a
build (`denext build`, `start` and `export`). An `"error"` violation fails the build, and in
`denext dev` the request that builds. A `"mock"` one passes: a denied file is replaced by Start's
self-denial module (its named exports over a mock), a denied specifier resolves to Start's
mock-edge module (the names its importer uses), and each violation is a warning in Start's words,
once per process (`log: "once"`, the default) or on every build (`log: "always"`). The mocks are
Start's own (loaded from the app's `@tanstack/start-plugin-core`): any property, call or `new`
gives another mock. In `denext dev` the browser mock logs its first use of each access as Start's
`[import-protection] Mocked import used in dev client`, with `console.error` (`mockAccess:
"error"`, the default), `console.warn` (`"warn"`) or nothing (`"off"`); on the server it is
silent. A build's mocks are Start's build mocks: silent, a denied file a self-contained mock
module. So a dev server keeps running past a violation unless `behavior` asks for `"error"`, and
a build fails on one unless it asks for `"mock"`.

### `router`

A filename under `srcDirectory`, or Start's own `router` option:

```ts
tanstackStart({
  router: {
    entry: "app-router", // under srcDirectory; the extension may be left out
    basepath: "/docs", // must match basePath in denext.config.ts
    routesDirectory: "pages", // the route generator's options, as in Start
    quoteStyle: "double",
  },
});
```

`routesDirectory` and `generatedRouteTree` are relative to `srcDirectory`, as in Start; the
generator's other options apply over `tsr.config.json`. denext serves the app under its own
`basePath`, so a `basepath` that differs is refused. Refused too: `target` (the plugin builds a
React app) and `addExtensions: false` (Deno resolves the route tree's imports by extension).

### Checked options

`tanstackStart()` checks its options when `denext.config.ts` loads, with the errors
`denext.config` validation gives: a wrong type, or a key that is not an option (the closest one is
suggested), fails with the field's path:

```
invalid tanstackStart() options: `importProtection.cleint` is not an option (did you mean `client`?)
```

### `prerender` and `pages`

The same shape as Start's: `prerender: { enabled, filter, crawlLinks, autoSubfolderIndex,
autoStaticPathsDiscovery, concurrency, failOnError, maxRedirects, retryCount, retryDelay, headers,
onSuccess }` and `pages: [{ path, prerender: { enabled, outputPath, … } }]`. A page that does not
answer 2xx fails the export (`failOnError`), as in Start:

```ts
tanstackStart({
  prerender: { filter: ({ path }) => !path.startsWith("/admin") },
  pages: [{ path: "/posts/42" }],
});
```

Each page is written as its final HTML: the content of every Suspense boundary (TanStack Router
renders a route's matches inside one) in its place, so an exported page reads the same with
JavaScript off and hydrates when it is on.

### `spa` and `sitemap`

Start's SPA shell and sitemap, written by `denext export` as Start's build writes them:

```ts
tanstackStart({
  // The root route alone (no route's loader runs), rendered at maskPath to _shell.html.
  spa: { enabled: true, maskPath: "/", prerender: { outputPath: "/_shell" } },
  // sitemap.xml and pages.json at the export's root; host is required.
  sitemap: { host: "https://example.com", outputPath: "sitemap.xml" },
  pages: [{ path: "/", sitemap: { priority: 1, changefreq: "daily" } }],
});
```

- **`spa`** adds one page, as Start's post-build does: `maskPath` (default `/`) rendered with
  Start's `X-TSS_SHELL` header, so Start renders the root route's shell and no route's loader, to
  `<prerender.outputPath>.html` (default `_shell.html`), crawling no links. Point your static
  host's fallback (the file it serves for a path with no file of its own) at it, and the app
  renders on the client. The shell is never refused (only the root route renders), it turns the
  prerender on even with `prerender.enabled: false`, and it stays out of the sitemap. As in Start,
  the shell takes its mask path: with the default `/` no `index.html` is written. In
  `denext dev`, as in Start's dev server (its `TSS_SHELL`), every page is the shell: the server
  renders the root route alone and the browser renders the route, so dev behaves as the static
  host will. `spa: { enabled: false }` turns both off; `denext build` / `denext start` render
  every page on the server either way.
- **`sitemap`** (`enabled` defaults to `true` once the option is given) runs Start's own
  `buildSitemap`, loaded from the app's `@tanstack/start-plugin-core`, over every page the
  prerender met (listed, discovered and crawled, a filtered one included, each with what its
  `onSuccess` returned): `sitemap.xml` at `outputPath` and `pages.json`, at the export's root.
  A page's `sitemap` sets its entry (`exclude`, `priority`, `changefreq`, `lastmod`,
  `alternateRefs`, `images`, `news`). Without a `host` the export fails, as Start's build does.

Prerendering is on whenever you run `denext export`; `denext build` / `denext start` serve every
route as before. The prerender reads the route tree the plugin generates, so with
`generateRouteTree: false` only the `pages` you list (and their links) are prerendered.

Licensed MIT. Part of the denext project.
