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
  dynamic route's listed params its `generateStaticParams` (written by `denext export`).

## Limitations

- **`serverLoader()` on a navigation** resolves the data the navigation already fetched:
  denext renders the target route on the server, so its server `loader` runs with that render
  instead of on demand, and the route renders before its `clientLoader` settles.
- **Route typegen** (`import type { Route } from "./+types/…"`) is type-only and
  erases at runtime, so the app runs without it; generate the `+types` with React
  Router's own `typegen` if you type-check against them.
- **`app/routes.ts` must resolve in the app's active config.** The plugin evaluates
  `app/routes.ts` with a plain dynamic `import()`, so its `@react-router/dev/routes`
  import (which `denext migrate` aliases in the app's `deno.json`) resolves under the
  config Deno uses for the run — the app's own `deno.json` for a standalone app. Only
  when the app is **nested inside another Deno workspace** whose root config wins does
  that alias need to be present in the active config too; there, import the DSL from
  `@denext/react-router/routes` directly (what the in-repo example does).

Licensed MIT. Part of the denext project.
