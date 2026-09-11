# Changelog — @denext/react-router

All notable changes to this package are documented here. It follows its own
semver, independent of `@denext/denext`.

## [0.1.1]

- No code change. `RouteOptions.id` / `caseSensitive` are documented (JSR's "has docs for
  most symbols" score); the package entrypoints are now part of the repo's `doc-lint` gate.

## [0.1.0]

- Initial release: run a **React Router v7 framework-mode** app (config routing via
  `app/routes.ts`, `app/root.tsx`, loaders/actions, `react-router.config.ts`) on denext as a
  plugin, with the app's source **untouched**. The plugin evaluates `app/routes.ts` (the
  `route()`/`index()`/`layout()`/`prefix()` DSL), generates denext route wrappers under
  `.denext/react-router/`, and feeds them to the core App Router through the route-synthesizer
  seam — so Flight, streaming, per-segment error boundaries, soft navigation, ISR and Fast
  Refresh all come from denext. Loaders/actions, `meta`, `links`, `ErrorBoundary`, the root
  `Layout` export and the `Route.ComponentProps` props contract run on the `denext/remix`
  runtime. `denext migrate` detects an RR7 app (`app/routes.ts`) and wires the plugin.
