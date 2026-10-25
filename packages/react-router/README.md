# @denext/react-router

Run a [React Router v7](https://reactrouter.com) **framework-mode** app on
[denext](https://denext.dev) — with your app's source unchanged.

```ts
// denext.config.ts
import { reactRouter } from "@denext/react-router";
export default { plugins: [reactRouter()] };
```

`denext migrate` wires this for you when it finds an `app/routes.ts`.

## What it does

React Router v7's framework mode is Remix's successor: config routing in
`app/routes.ts`, an `app/root.tsx` shell, `loader`/`action` per route, and
`react-router.config.ts`. This plugin runs such an app on denext without a source
transform:

- It evaluates `app/routes.ts` — the `route()` / `index()` / `layout()` / `prefix()`
  config from `@react-router/dev/routes` (aliased to `@denext/react-router/routes`).
- It generates a denext route module for each route under `.denext/react-router/`
  (a `"use client"` component split from its server `loader`/`action` data module,
  wrapped for the `denext/remix` runtime) — the app's own files are never rewritten.
- It feeds those routes to denext's App Router through the **route-synthesizer**
  plugin seam, so **Flight, streaming SSR, per-segment error boundaries, soft
  navigation, ISR and Fast Refresh** are denext's own — no re-implementation.

Loaders and actions, `meta`, `links`, `ErrorBoundary` (with `useRouteError` /
`isRouteErrorResponse`), the root `Layout` export, and the `Route.ComponentProps`
props contract (`loaderData` / `actionData` / `params` / `matches` as component
props) all work, and so do the client data APIs below.

## Route types

React Router's route typegen runs too: every scan (`denext dev`, `build`, `start`) writes a
`+types/<route>.ts` module per route under `.react-router/types/`, laid out as
`react-router typegen` lays it out, and `denext typegen` writes them on demand (before a
`deno check` in CI, say). A route module imports its `Route` namespace as in React Router:

```ts
import type { Route } from "./+types/team";

export function loader({ params }: Route.LoaderArgs) {
  return { id: params.id }; // params.id: string, from the route's pattern
}
export default function Team({ loaderData }: Route.ComponentProps) {
  return <h1>{loaderData.id}</h1>;
}
```

`./+types/team` resolves through `compilerOptions.rootDirs: [".", "./.react-router/types"]`
(with Deno's `sloppy-imports` for the extensionless specifier), which `denext migrate` writes.
The namespace has React Router's names (`LoaderArgs`, `ClientLoaderArgs`, `ActionArgs`,
`ClientActionArgs`, `ComponentProps`, `ErrorBoundaryProps`, `HydrateFallbackProps`,
`MetaArgs` / `MetaFunction`, `LinksFunction`, `HeadersFunction`), typed from the route module:
`params` from the full URL pattern (a layout's descendants' params optional), `loaderData` and
`actionData` from what `loader` / `clientLoader` / `action` / `clientAction` return (unwrapped
from `data()`), `matches` from the route's ancestors. The files import nothing but the route
modules, so they check against the `react-router` the import map points at.

## Client data APIs

A route module's browser half runs as in React Router v7:

- **`clientLoader`** runs in the browser; its result is the route's loader data, and
  `serverLoader()` hands it the server loader's data. On the first load it runs only when it
  hydrates (`clientLoader.hydrate = true`, or the route has no server `loader`), with the
  route's **`HydrateFallback`** rendered on the server until it settles. A route a navigation
  brings in, and every revalidation, runs it.
- **`clientAction`** runs for the route's `<Form>` / `useSubmit` / same-route fetcher
  submissions; `serverAction()` runs the server `action`.
- **`ssr: false`** in `react-router.config.ts` is SPA mode: every route renders its
  `HydrateFallback` (or nothing) on the server and its component in the browser; the root
  still renders as the app shell.
- **`prerender`** (`true`, a path list, or a function given `getStaticPaths()`) becomes
  segment config: a listed static route is `force-static` (rendered once, then cached), a
  dynamic route's listed params its `generateStaticParams` (written by `denext export`). The
  loaders of a `force-static` page get the URL alone (no headers, no body), as React Router's
  build-time prerender does, since one render is served to everyone.

## Load context and middleware

Every loader, action and route middleware gets a `context`. Supply it with the plugin's
`getLoadContext` option (given `{ request, params }`, run once per request), or with a
`load-context.ts` calling `defineLoadContext` from `denext/remix/server` that
`instrumentation.ts` imports; `denext migrate` writes both from a custom server's
`getLoadContext`. The `context` is a `RouterContextProvider`: an object's properties ride on it,
and `createContext` keys work through `context.get` / `context.set`.

```ts
// denext.config.ts
export default { plugins: [reactRouter({ getLoadContext: () => ({ db }) })] };

// app/root.tsx
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request, context }, next) => {
    context.set(userContext, await getUser(request));
    return next();
  },
];
```

A route's `middleware` (or `unstable_middleware`) runs outermost route first, once per request,
before the route's loader and action; a thrown `redirect()` stops the request. On a resource
route and a plain POST to a page's action, `next()` runs the handler; on a page render it
resolves at once to a stand-in response whose headers reach the page.

## Limitations

- **Middleware on a page render runs ahead of the loaders, not around the render:** code after
  `next()` runs before the loaders, and a parent's loader may run before a child's middleware.
  `clientMiddleware` does not run.
- **`serverLoader()` on a navigation** resolves the data the navigation already fetched:
  denext renders the target route on the server, so its server `loader` runs with that render
  instead of on demand, and the route renders before its `clientLoader` settles.
- **`app/routes.ts` must resolve in the app's active config.** The plugin evaluates
  `app/routes.ts` with a plain dynamic `import()`, so its `@react-router/dev/routes`
  import (which `denext migrate` aliases in the app's `deno.json`) resolves under the
  config Deno uses for the run — the app's own `deno.json` for a standalone app. Only
  when the app is **nested inside another Deno workspace** whose root config wins does
  that alias need to be present in the active config too; there, import the DSL from
  `@denext/react-router/routes` directly (what the in-repo example does).

Licensed MIT. Part of the denext project.
