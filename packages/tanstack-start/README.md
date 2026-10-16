# @denext/tanstack-start

Run a [TanStack Start](https://tanstack.com/start)-shaped app on [denext](https://denext.dev),
server-rendered, through the plugin-kit seams alone.

```ts
// denext.config.ts
import { tanstackStart } from "@denext/tanstack-start";
export default { compatibilityMode: true, plugins: [tanstackStart()] };
```

## What it does

- **Owns the route tree.** A prepare step runs TanStack's own generator
  (`@tanstack/router-generator`) over `src/routes/` into `src/routeTree.gen.ts` at `denext build`
  and `denext dev` startup, and again whenever a route file changes in dev. Its imports carry
  extensions, so Deno resolves them as written; `tsr.config.json` still applies. The generator is
  loaded from the app's own dependencies: list `@tanstack/router-generator` in `package.json`
  (`devDependencies`), or pass `generateRouteTree: false`.
- **Renders every page on the server** through TanStack Router's SSR (`createRequestHandler` +
  `defaultRenderHandler` from `@tanstack/react-router/ssr/server`): the matched routes' `loader`s
  and `beforeLoad`s run on the server, the root route's `shellComponent` renders the document with
  `<HeadContent />` and `<Scripts />`, and the router's state is dehydrated into it.
- **Hydrates in the browser** with `RouterClient` (`@tanstack/react-router/ssr/client`), from a
  client bundle served under `/_tss/` and named in the router manifest, so `<Scripts />` loads it.
  From there navigation is TanStack's: a `<Link>` runs the next route's loader in the browser.

The server entry and the client bundle are compiled onto denext's React (the app's npm packages
import `react`), as a Pages Router app's are.

## The app

Start's layout: `src/router.tsx` exports `getRouter()` (or `createRouter()`), and
`src/routes/__root.tsx` renders the document:

```tsx
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

Options: `srcDirectory` (default `src`), `router` (relative to it, default `router.tsx`) and
`generateRouteTree: false` to keep generating the tree yourself.

## Not yet

Start's server functions (`createServerFn`), API routes (`createServerFileRoute`), streaming
SSR and `denext export` prerendering are not provided; use a denext route handler under `app/api`
for server endpoints.

Licensed MIT. Part of the denext project.
