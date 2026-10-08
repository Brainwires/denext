# Changelog — @denext/react-router

All notable changes to this package are documented here. It follows its own
semver, independent of `@denext/denext`.

## [0.2.0]

- **The route-module client APIs run.** `clientLoader` (with `serverLoader()`, and
  `clientLoader.hydrate`), `clientAction` (with `serverAction()`) and `HydrateFallback` work as
  in React Router v7 framework mode: a hydrating client loader renders the route's
  `HydrateFallback` on the server, then loads in the browser; a navigation and every
  revalidation run it; a client action handles the route's submissions.
- **`ssr: false` is SPA mode:** routes render their `HydrateFallback` on the server and their
  component in the browser (the root still renders as the shell). It no longer warns.
- **`prerender` is applied:** a listed static route becomes `force-static`, and a dynamic
  route's listed params its `generateStaticParams` (what `denext export` writes). `true` lists
  every static path, and the function form gets them as `getStaticPaths()`.
- **Fixed:** a route module that imports `useActionData` or `useMatches` itself no longer fails
  to load (`Identifier 'useActionData' has already been declared`): the generated boundary
  imports its own copies under private names.
- Requires denext 3.4.0 (`useClientRouteData` / `useClientRouteAction` in `denext/remix`). The
  `@denext/denext` range moves to `^3.4.0` when this publishes, which waits for core 3.4.0.

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
