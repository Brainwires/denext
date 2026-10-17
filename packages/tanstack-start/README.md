# @denext/tanstack-start

Run a [TanStack Start](https://tanstack.com/start) app on [denext](https://denext.dev), through
the plugin-kit seams alone: server functions, server routes, streamed pages, hydration.
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

The server bundle and the client bundle are compiled onto denext's React (the app's npm packages
import `react`), as a Pages Router app's are. In `denext dev` an edit under `src/` rebuilds both
on the next request.

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
| `router`            | `router.tsx`                               | The router module, relative to `srcDirectory`.                      |
| `generateRouteTree` | `true`                                     | `false` keeps generating `routeTree.gen.ts` yourself.               |
| `maxBodyBytes`      | the app's `actionMaxBodyBytes`, else 1 MiB | The request-body cap for server functions and server routes.        |
| `allowedOrigins`    | none                                       | Other origins (or bare hosts) allowed to POST to a server function. |

## Not yet

`denext export` prerendering of Start routes and Start's import protection (a `*.server.*` module
reached from client code is not refused at build) are not provided.

Licensed MIT. Part of the denext project.
