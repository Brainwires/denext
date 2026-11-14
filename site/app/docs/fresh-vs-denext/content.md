---
title: Fresh and denext
slug: fresh-vs-denext
lead: Fresh and denext are both full-stack web frameworks for Deno. This page lists what Fresh does, where each part lives on denext, what denext adds, and where the two differ, so you can decide whether to move and know what moving costs.
---

[Fresh](https://usefresh.dev) is the Deno team's web framework: server-rendered pages, file
routes, Preact components, and islands that hydrate only the interactive parts of a page. denext
is a Deno framework whose API follows React and Next.js's App Router, on its own React core, and
which also runs code written for Preact and Fresh. A Fresh app moves with
`denext migrate` ([Migrating from Fresh](/docs/migrating-fresh)): the route modules, islands and
`main.ts` stay where they are, and denext runs them the way Fresh does.

## The short answer

**Fresh is a good fit** when you want a small framework with few moving parts, Preact's own
runtime in the browser, the Vite plugin ecosystem in your build (including plugins that
transform modules), built-in OpenTelemetry spans, and a framework maintained alongside Deno
itself.

**denext is a good fit** when the app needs more than pages and islands from one codebase:
typed API routes and Server Actions, live data over WebSockets, sign-in, a database and file
storage, background jobs, caching and partial prerendering, or the same app shipped to iOS,
Android and the desktop. It also runs React and Next.js libraries, so the npm ecosystem built for
React is open to it.

## What Fresh does, and where it lives on denext

| Fresh                                                                                                                               | On denext                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File routes in `routes/` (`[param]`, `[...rest]`, `[[optional]]`, `(group)`, partial segments, `routeOverride`)                     | The same route modules, run in place: `app/` holds a generated page or route handler for each, and `middleware.ts` matches what the folder tree cannot hold, in Fresh's match order.         |
| `_app`, `_layout`, `_middleware`, `_404`, `_500` / `_error`, `skipAppWrapper`, `skipInheritedLayouts`                               | Run as Fresh runs them, through `denext/fresh/server`.                                                                                                                                       |
| Handlers (`handler`, `define.handlers`, `page(data)`, `ctx.render()`, Fresh 1.x `(req, ctx)` handlers)                              | Run in `middleware.ts` before the page renders; any method, with the status and headers they set.                                                                                            |
| `main.ts`'s `App` (`use`, `get` … `all`, `ws`, `route`, `layout`, `appWrapper`, `onError`, `notFound`, `mountApp`, `basePath`)      | `middleware.ts` and the root layout run it ([`main.ts`](/docs/migrating-fresh#5-maints-the-app-builder)).                                                                                    |
| Islands (`islands/`, `(_islands)`, islands registered in code or in `islandSpecifiers`)                                             | `"use client"` modules, marked in place by the migration; a package island gets a `"use client"` re-export. Signal props arrive live.                                                        |
| `<Partial>` and `f-client-nav` / `f-partial` (links, buttons, forms; `replace` / `append` / `prepend`; `f-view-transition`)         | `denext/fresh/partial`: the same attributes and modes, the answer's head merged as Fresh merges it, back / forward and scroll positions kept ([Partials](/docs/migrating-fresh#4-partials)). |
| Built-in middleware (`staticFiles`, `trailingSlashes`, `csrf`, `cors`, `csp` with `useNonce`, `ipFilter`)                           | `denext/fresh`; `csp()` merges into denext's own policy ([`csp()`](/docs/migrating-fresh#6-csp)).                                                                                            |
| `Head`, `asset()`, `IS_BROWSER`, `HttpError`, `createDefine`                                                                        | `denext/fresh/runtime` and `denext/fresh`.                                                                                                                                                   |
| Preact (`preact`, `preact/hooks`, `preact/compat`, the JSX runtime, `options` hooks)                                                | `denext/preact`; `options` hooks are called where Preact's diff calls them ([Preact's `options` hooks](/docs/migrating-preact#preacts-options-hooks)).                                       |
| `@preact/signals` (signals, computeds, effects, models, `useSignalRef`, `Show` / `For`)                                             | [`denext/signals`](/docs/signals).                                                                                                                                                           |
| `preact-render-to-string` (and `/stream`, `/jsx`, `/stream-node`)                                                                   | `denext/preact/render-to-string` and its subpaths.                                                                                                                                           |
| `import.meta.env` and `FRESH_PUBLIC_*` variables                                                                                    | `denext/fresh/env`, on the server and in the browser ([Environment variables](/docs/migrating-fresh#7-environment-variables)).                                                               |
| WebSockets (`ctx.upgrade()`, `app.ws()`)                                                                                            | Work under `denext start` and `denext dev`; [Live channels](/docs/live) are the portable alternative.                                                                                        |
| The Vite plugin and its options (`routeDir`, `islandsDir`, `staticDir`, `serverEntry`, `clientEntry`, `ignore`, `islandSpecifiers`) | Read by the migration and applied; denext builds the app itself.                                                                                                                             |
| Other Vite plugins                                                                                                                  | Their build hooks run through `viteBuildPlugin` ([plugins](/docs/plugins)); hooks that transform modules do not, since denext bundles with esbuild.                                          |
| Fresh 1.x plugins (`routes`, `middlewares`, `render` / `renderAsync`, `entrypoints`, `islands`)                                     | Run by `denext/fresh/server`; `freshPlugins()` bundles their client entrypoints ([Fresh plugins](/docs/migrating-fresh#fresh-plugins)).                                                      |
| Tailwind (`@fresh/plugin-tailwind`, Fresh 1.x's Tailwind plugin)                                                                    | Built in: `tailwind: { input, output }` in `denext.config.ts` (Tailwind v4).                                                                                                                 |
| Static files in `static/`                                                                                                           | `public/`.                                                                                                                                                                                   |
| Development server with hot reloading                                                                                               | `denext dev`, with Fast Refresh that keeps component state.                                                                                                                                  |
| OpenTelemetry spans for middleware, handlers and rendering                                                                          | `instrumentation.ts`'s `onRequest` / `onRequestError` hooks and an [OpenTelemetry recipe](/docs/deploy); Deno's own OpenTelemetry export works for both.                                     |
| Deployment (`deno serve`, Deno Deploy, `deno compile`, Docker)                                                                      | `denext start`, [deploy adapters](/docs/deploy) (Deno Deploy, Fly, Docker, a generic host, static hosting), `denext build --compile` for one executable.                                     |

## What denext adds

| Area                            | What it is                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React and Next.js compatibility | The App Router's file conventions, Server Components and async Server Components, `"use client"`, and npm libraries written for React and Next.js ([npm React libraries](/docs/npm-react-libraries)).           |
| Typed API                       | `defineApi` route handlers validated by Standard Schemas, and a client (`createApiClient`, `useApi`) type-checked against the app's routes, with no code generation step to run ([typed API](/docs/typed-api)). |
| Server Actions                  | `defineAction` with typed input and output into `useActionState` ([Server Actions](/docs/server-actions)).                                                                                                      |
| Live data                       | Validated subscriptions, channels with history, presence, and server-held views (`defineLiveView`) over one WebSocket ([Live](/docs/live), [live views](/docs/live-views)).                                     |
| Authentication                  | `denextAuth`: OAuth / OIDC providers, passwords, magic links, passkeys, second factors, SAML, sessions, bearer tokens ([auth](/docs/auth)).                                                                     |
| Backend                         | The `@denext/backend` plugin: file storage on S3 or disk, Postgres with row-level security, an auto-REST API and realtime changes that stock Supabase clients talk to ([backend](/docs/backend)).               |
| Data and caching                | ISR, `unstable_cache`, Cache Components with partial prerendering, and cache stores on SQLite, Postgres, Redis or Deno KV ([rendering](/docs/rendering), [data](/docs/data)).                                   |
| Jobs and services               | Scheduled jobs (cron in UTC, retries, history) and supervised long-running services ([jobs](/docs/jobs), [services](/docs/services)).                                                                           |
| Content                         | Typed content collections (Markdown, MDX, YAML, JSON) and Markdown rendering ([content collections](/docs/content-collections), [Markdown](/docs/markdown)).                                                    |
| API description                 | OpenAPI documents and clients from the same route definitions, and GraphQL ([OpenAPI](/docs/openapi), [GraphQL](/docs/graphql)).                                                                                |
| Desktop                         | Deno Desktop apps from the same codebase, with native menus, trays, windows, notifications and installers ([desktop](/docs/desktop)).                                                                           |
| Mobile                          | iOS and Android apps in a Capacitor shell, native capabilities with web fallbacks, store builds and over-the-air UI updates ([mobile](/docs/mobile), [updates](/docs/updates)).                                 |
| React Native on the web         | Expo and React Native code built for the web, beside the App Router ([React Native](/docs/react-native)).                                                                                                       |
| Testing                         | Component and app tests with no browser, a route conformance probe, and a Vitest-compatible `denext test` ([testing](/docs/testing)).                                                                           |
| Tooling                         | A project UI (`denext ui`), an MCP server for coding agents, a profiler, and `denext doctor` ([project UI](/docs/ui), [MCP](/docs/mcp), [profile](/docs/profile)).                                              |

## Where the two differ

- **The browser runtime.** Fresh ships Preact to the browser. denext ships its own React-compatible
  runtime and runs Preact code on it, so Preact internals that tools read directly (the Preact
  devtools bridge) are not there, and a signal change re-renders the component that read it rather
  than patching its text node.
- **The build.** Fresh builds with Vite (or its own builder); denext builds with esbuild. Vite
  plugins' build hooks run on denext, but plugins that transform modules (`transform`, `load`,
  `resolveId`) do not.
- **Partial navigation.** Fresh's partial requests answer with HTML; denext's answer with the
  page's Flight payload, parsed into the regions. The attributes, modes and head merge are the
  same.
- **Content-Security-Policy.** denext sends a strict, hash-based policy by default, and runs no
  inline script of its own; Fresh's default policy allows `'unsafe-inline'` unless `useNonce` is
  set. An inline `<script dangerouslySetInnerHTML>` needs moving to a file or allowing in
  `csp.scriptSrc`.
- **Fresh 1.x plugins.** Their routes, middleware and render hooks run, but a render hook's
  replacement `htmlText` is not applied, and a plugin from outside the project has its islands
  render without hydrating.

[Known limitations](/docs/limitations) lists each remaining difference precisely.

## Moving

`denext migrate --check` previews the move without writing anything: what changes, what migrates
but needs a look, and anything that does not migrate. `denext migrate` then generates denext's
side around your modules. The migration beds run it on Fresh's own website, the two apps
`@fresh/init` scaffolds, Deno's Node.js compatibility test viewer (a Fresh 2 app on Vite with
Tailwind and Deno KV) and Deno SaaSKit (a Fresh 1.x app with five plugins), then build, serve and
click through each one; nothing in them is left unmigrated.
