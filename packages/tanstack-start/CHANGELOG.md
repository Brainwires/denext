# Changelog — @denext/tanstack-start

All notable changes to this package are documented here. It follows its own semver, independent
of `@denext/denext`.

## [0.1.0] - Unreleased

Initial release: a TanStack Start app on denext. The plugin generates the route tree with
TanStack's generator and answers every request with Start's own handler
(`createStartHandler(defaultStreamHandler)`), loaded from the app's `@tanstack/react-start`:

- Pages stream through TanStack Router's matching and match loaders: nested layouts, pending,
  error and not-found components behave as in Start, and a loader promise left unawaited streams
  in when it settles.
- Server functions (`createServerFn`, GET and POST, validators, middleware) are served at
  `/_serverFn/<id>` in Start's own RPC format; a route's `server.handlers` serve as server routes.
- TanStack's own compiler (`@tanstack/start-plugin-core`) builds both bundles: server-function
  RPC stubs and no server-only code in the browser, the provider split on the server.
- A server function called with a mutating method must come from the app's own origin (403
  otherwise), and request bodies are capped (`maxBodyBytes`, default the app's
  `actionMaxBodyBytes` or 1 MiB); `allowedOrigins` admits others.
- The browser hydrates with Start's `StartClient`; `src/start.ts`, `src/server.ts` and
  `src/client.tsx` are honoured; `denext dev` rebuilds on an edit under `src/`.
