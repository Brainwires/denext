# Changelog — @denext/tanstack-start

All notable changes to this package are documented here. It follows its own semver, independent
of `@denext/denext`.

## [0.2.0] - Unreleased

- **The options are checked** when `tanstackStart()` is called, so a bad config fails as
  `denext.config.ts` loads: each option against the shape Start's own plugin accepts (`router`,
  `importProtection`, `prerender`, `pages`) or the plugin's own, with `denext.config`'s
  field-scoped errors (``invalid tanstackStart() options: `importProtection.client.files[1]` must
  be a string (a glob) or a RegExp``). A key that is not an option is refused with the closest
  one suggested, so a typo in a security rule (`cleint`, `ignoreImporter`) no longer turns it off.
- **Start's remaining `importProtection` keys**: `maxTraceDepth` (default 20) caps how far up a
  violation's trace walks, as Start's does; `behavior` and `mockAccess` are accepted, but every
  violation still fails the build (and in dev the request that builds), so a `"mock"` behavior is
  warned about, once per process or, with `log: "always"`, on every build.
- **Start's object form of `router`**: `entry` (under `srcDirectory`, the extension optional),
  `basepath` (it must match the app's `basePath`; a different one is refused) and the route
  generator's options (`routesDirectory` and `generatedRouteTree` relative to `srcDirectory`, the
  rest over `tsr.config.json`, the app's generator plugins kept). `target` and
  `addExtensions: false` are refused, with the reason. In dev the generator re-runs on an edit in
  the routes directory the app configured.
- **An exported page works with JavaScript off.** `denext export` wrote each page as the server
  streamed it, so a route's content (behind a Suspense boundary, as TanStack Router renders its
  matches) arrived as a `<template>` that a script moves into place: with JavaScript off the
  page showed only the fallback. Each page is now written as its final HTML, every boundary's
  content in its placeholder, which is the DOM the script would have produced, so it hydrates the
  same way.
- The tests assert on the emitted bundles: the server bundle has no `*.client.*` module body, and
  the browser bundle neither a `*.server.*` module that only a server function's handler used nor
  the handler's body. The example keeps its notes in `notes.server.ts`, and its static export is
  checked with JavaScript off: the pages render from their HTML and a link loads the next
  exported file.

## [0.1.0] - 2026-10-17

Initial release: a TanStack Start app on denext. The plugin generates the route tree with
TanStack's generator and answers every request with Start's own handler
(`createStartHandler(defaultStreamHandler)`), loaded from the app's `@tanstack/react-start`:

- Pages stream through TanStack Router's matching and match loaders: nested layouts, pending,
  error and not-found components behave as in Start, and a loader promise left unawaited streams
  in when it settles.
- Server functions (`createServerFn`, GET and POST, validators, middleware) are served at
  `/_serverFn/<id>` in Start's own RPC format; a route's `server.handlers` serve as server routes.
- TanStack's own compiler (`@tanstack/start-plugin-core`) builds both bundles: server-function
  RPC stubs and no server-only code in the browser, the provider split on the server. denext's
  own transforms run on what it compiles: `"use cache"` (with `cacheComponents` on) still caches.
- Start's import protection guards both builds, with Start's rules, build-mode semantics and
  messages (`[import-protection] Import denied in client environment`, the pattern, importer,
  resolved file and trace): the browser build refuses a `*.server.*` file,
  `@tanstack/react-start/server` and a module marked `@tanstack/react-start/server-only`; the
  server build refuses a `*.client.*` file and a module marked
  `@tanstack/react-start/client-only`. An import counts only when tree-shaking kept it, after
  TanStack's compiler removed what a `createServerFn` handler, a `createServerOnlyFn` body (in the
  browser) or a `createClientOnlyFn` body (on the server) alone used.
- `importProtection`: Start's own option shape (`client` / `server` with `specifiers`, `files`
  and `excludeFiles`, plus `include`, `exclude`, `ignoreImporters`, `onViolation` and `enabled`),
  merged with Start's defaults the way Start merges them, applied to both builds.
- The browser build also fails on denext's server-only scan (a `node:` import, the `server-only`
  marker or the `Deno` global in a module the browser gets, read as compiled).
- `denext export` prerenders the app with Start's prerender: its `prerender` and `pages` options
  (`filter`, `crawlLinks`, `autoSubfolderIndex`, `autoStaticPathsDiscovery`, `concurrency`,
  `failOnError`, `maxRedirects`, `retryCount`, `retryDelay`, `headers`, `onSuccess`, a page's
  `outputPath`), the route tree's static paths and the links each page has, rendered through the
  server bundle and written beside the client bundle. Routes that need a server — server routes,
  pages that call a server function from the browser, dynamic routes no prerendered page covers —
  are left out and listed with the reason.
- A `"use server"` module that declares server functions ships only their RPC stubs: its other
  exports throw when called in the browser, and the rest of its source stays on the server.
- `denext build` builds the server bundle as well as the client bundle, so a build error surfaces
  at build and `denext start` serves its first request without building.
- Requires `@denext/denext` 4.3.0.
- A server function called with a mutating method must come from the app's own origin (403
  otherwise), and request bodies are capped (`maxBodyBytes`, default the app's
  `actionMaxBodyBytes` or 1 MiB); `allowedOrigins` admits others.
- The browser hydrates with Start's `StartClient`; `src/start.ts`, `src/server.ts` and
  `src/client.tsx` are honoured; `denext dev` rebuilds on an edit under `src/`.
