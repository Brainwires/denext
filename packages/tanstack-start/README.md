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
  dynamic routes no prerendered page links to.
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
`maxTraceDepth` (default 20) caps how far up a violation's trace walks. A violation always fails
the build, and in `denext dev` the request that builds: Start's `behavior: "error"`. `behavior`
and `mockAccess` are accepted so a Start config ports unchanged, but a `"mock"` is not applied and
is warned about, once per process (`log: "once"`, the default) or on every build
(`log: "always"`).

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

Prerendering is on whenever you run `denext export`; `denext build` / `denext start` serve every
route as before. The prerender reads the route tree the plugin generates, so with
`generateRouteTree: false` only the `pages` you list (and their links) are prerendered.

Licensed MIT. Part of the denext project.
