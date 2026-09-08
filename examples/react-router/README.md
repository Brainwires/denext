# examples/react-router

A **React Router v7 framework-mode** app running on denext through `@denext/react-router`, with
the route components left unmodified — they still `import { Outlet, Form, useLoaderData } from
"react-router"`. The plugin reads `app/routes.ts`, generates a denext route wrapper per entry
under `.denext/react-router/`, and feeds them to the App Router, so **Flight, streaming SSR,
per-segment error boundaries, and soft navigation are all denext's**.

```sh
deno task dev          # http://localhost:3000
```

## What it shows

- **`app/root.tsx`** — the RR `Layout` export as the document shell, a default `<Outlet/>`
  component, and an `ErrorBoundary` (`useRouteError` / `isRouteErrorResponse`).
- **`app/routes.ts`** — config routing: `index` / `route` / `layout` / `prefix`, including a
  pathless layout wrapping a `teams` prefix.
- **loader data both ways** — `/` reads it as a component prop (`Route.ComponentProps`) and via
  `useLoaderData`.
- **an action** — `/teams/:id` has a `<Form method="post">` that its `action` answers.
- **a resource route** — `/api/health` is a `loader`-only module returning `Response.json`.
- **a thrown Response** — `/boom`'s loader throws `new Response("teapot", { status: 418 })`,
  which reaches the route's `ErrorBoundary` and sets the document status.

## Migration vs. this example

`denext migrate` detects an RR7 app and wires `reactRouter()` for you, aliasing
`@react-router/dev/routes` and the `@react-router/*` toolchain in `deno.json` — a migrated
app's `app/routes.ts` keeps `import … from "@react-router/dev/routes"` untouched. This in-repo
example imports the DSL from `@denext/react-router/routes` directly (so it resolves against the
framework checkout); the route components are unchanged either way.

## Known limits (from `../../packages/react-router`)

Server render only — `clientLoader` / `clientAction` / `HydrateFallback` are not run;
`react-router.config.ts` `ssr: false` (SPA) is not supported (use denext `mode: "spa"`);
`prerender` config is noted, not applied (denext prerenders static routes itself); `+types`
typegen is type-only.
