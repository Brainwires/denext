---
title: Migrating from Fresh
slug: migrating-fresh
lead: denext migrate moves a Fresh 2 or Fresh 1.x app onto denext's App Router and keeps its route modules, islands and handlers where and as they are. It generates denext's side around them and reports what it cannot carry.
---

This guide covers moving an existing **Fresh** application (Fresh 2 on Vite or on Fresh's own
builder, or Fresh 1.x) to denext. It reflects what `denext migrate --from fresh` does today,
including its honest limits.

The short version: **your route modules are not rewritten.** Fresh apps are Deno projects
already, so `routes/`, `islands/` and `components/` stay where they are (code that reads files
relative to `import.meta.url` keeps working). The migration writes denext's `app/` tree and a
`middleware.ts` that run those modules the way Fresh runs them, marks the islands
`"use client"`, and points Fresh's and Preact's imports at denext through `deno.json`. The one
edit inside your files is Vite's `import.meta.env` (see
[Environment variables](/docs/migrating-fresh#7-environment-variables)).

---

## 1. Detection

`denext migrate` takes the Fresh path when the project has a `routes/` directory and one of:

- a `deno.json` / `deno.jsonc` that maps `fresh` or `@fresh/core` (Fresh 2);
- a `deno.json` that maps `$fresh/` (Fresh 1.x);
- a `fresh.gen.ts` manifest (Fresh 1.x).

Fresh is checked first, before any `package.json`-based source (Next.js, Expo, Remix, Vite), since
a Fresh app has no `package.json` of its own. Pass `--from fresh` to force the path; without a
Fresh app it stops with `no Fresh app in <dir>: expected a deno.json mapping "fresh" (Fresh 2)
or "$fresh/" (Fresh 1.x), or a fresh.gen.ts, beside a routes/ directory`.

Preview it first. `--check` writes nothing and lists what would change, what won't migrate and
what needs a look:

```sh
denext migrate --check
denext migrate
denext task dev
```

---

## 2. What it generates

- **`app/`**: a `page.tsx` for every route with a page component, a `route.ts` for every
  handler-only (API) route, a `layout.tsx` for every `_layout` (the root one runs `_app`), and
  `not-found.tsx` from the root `_404` (or the root `_error` / `_500`, which Fresh also renders
  for a 404). `[param]`, `[...rest]`, `index` and `(group)` map to folders of the same name. A
  pattern the folder tree cannot hold (`routeOverride`, `[[optional]]`, a partial segment like
  `post-[id]`) is served through `middleware.ts`.
- **`middleware.ts`** runs a request the way Fresh does: `main.ts`'s `app.use()` middleware,
  its `app.get()` / `app.post()` handlers and `app.route()` pages, the `_middleware` files, then
  the route's handler (see [`main.ts`](/docs/migrating-fresh#5-maints-the-app-builder)). A
  handler's `Response` is the answer; `page(data)` (Fresh 1.x: `ctx.render(data)`) hands the data
  to the page, which denext renders inside the layouts with the status and headers `page()` and
  the middleware set. That works for any method, so a form POST that re-renders the page works.
  `ctx.state` reaches handlers, layouts and pages; `ctx.next()` resolves with a stand-in for the
  page's response (its status and headers, which middleware may add to). An `HttpError` renders
  the not-found page (404) or the route's `_error` page. Fresh 1.x's `(req, ctx)` handlers,
  `defineRoute` / `defineApp` / `defineLayout` and `ctx.renderNotFound()` work too.
- **`app/fresh-app-route/page.tsx`** (when the app has a `main.ts`): where the pages `main.ts`
  registers in code render. `middleware.ts` rewrites those requests to it; a direct visit is a 404.
- **`app/_fresh/`** (when a source renders `<Partial>`): the app's own `fresh/runtime`, which
  re-exports denext's with `Partial` from a `"use client"` module, so each region reaches the
  browser (see [Partials](/docs/migrating-fresh#4-partials)). `deno.json` points `fresh/runtime`,
  `@fresh/core/runtime` and `$fresh/runtime.ts` at it.
- **Islands** (`islands/` and the routes' `(_islands)` folders) get `"use client"` at the top, so
  each stays its own hydration boundary. An island that imports `@preact/signals` for its types
  alone also gets `import "@preact/signals"`, so a signal prop arrives live.
- **`static/` moves to `public/`.** A stylesheet there holding the Tailwind directive moves to
  `assets/` instead, and becomes `tailwind: { input, output }` in `denext.config.ts`, compiled to
  its old `public/` path. A file already in `public/` is left in place and reported.
- **A Fresh 2 Vite app's `client.ts`**: its stylesheet imports go to the root layout (a Tailwind
  input among them is compiled to a `.gen.css` beside it, which the layout imports), and the rest
  of its code moves to `instrumentation-client.ts`, which denext runs in the browser before the
  page hydrates. A Tailwind v3 stylesheet needs `npx @tailwindcss/upgrade` first (denext compiles
  Tailwind v4).
- **Removed**: `fresh.gen.ts`, a Fresh `dev.ts`, `vite.config.*`, `client.ts`, and for Fresh 1.x
  `main.ts` and `fresh.config.ts`. Fresh 2's `main.ts` stays: `middleware.ts` runs it.
- **`deno.json` is merged, not replaced.** `fresh`, `fresh/runtime`, `@fresh/core`,
  `@fresh/core/runtime`, `$fresh/server.ts` and `$fresh/runtime.ts` map to `denext/fresh` and
  `denext/fresh/runtime`; `preact`, `preact/hooks`, `preact/compat`, `preact/jsx-runtime` and
  `preact/jsx-dev-runtime` to the matching `denext/preact` modules; `@preact/signals`, `@preact/signals/utils` and
  `@preact/signals-core` to [`denext/signals`](/docs/signals). Fresh's, Vite's and Preact's own
  packages are dropped; the `dev` / `build` / `start` tasks run denext (Fresh's `preview`,
  `update` and `manifest` are removed); `nodeModulesDir` is `"auto"`; JSX compiles with
  `jsxImportSource: "preact"` (`denext/preact/jsx-runtime`, which binds a signal passed as a DOM
  prop). Your other imports, tasks and settings stay.
- **`denext.config.ts`** (unless you wrote one), with the Tailwind block when the app had one.
- **`.gitignore`** gets `.denext/`, `out/`, `_fresh/` and `.deno/` (the native TypeScript 7
  check's project cache), appended only when missing.

---

## 3. The runtime modules

The route modules keep importing what they imported; the import map resolves it to denext.

| Module                 | What it provides                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `denext/fresh`         | `App`, `HttpError`, `page`, `createDefine` and the `Context` / `FreshContext` types; Fresh 2's middleware `staticFiles`, `trailingSlashes`, `csrf`, `cors`, `csp` (merged into denext's policy, see [`csp()`](/docs/migrating-fresh#6-csp)) and `ipFilter`; Fresh 1.x's `defineRoute`, `defineLayout`, `defineApp`, `defineConfig` and `STATUS_CODE`. `start()` rejects: run the app with `denext start`. |
| `denext/fresh/runtime` | `IS_BROWSER`, `asset` and `assetSrcSet` (paths returned as they are), `Head` (its children render in place and denext hoists `<title>`, `<meta>` and `<link>`), `Partial`, `HttpError`, and Fresh 1.x's `nonce` and CSP constants; `useCSP` does nothing.                                                                                                                                                 |
| `denext/fresh/partial` | `Partial` and the partial navigation behind it (see [Partials](/docs/migrating-fresh#4-partials)).                                                                                                                                                                                                                                                                                                        |
| `denext/fresh/env`     | `env`: Vite's `import.meta.env` (see [Environment variables](/docs/migrating-fresh#7-environment-variables)).                                                                                                                                                                                                                                                                                             |

`ctx.upgrade()` (and `app.ws()`) upgrades a WebSocket under `denext start` and `denext dev`,
where the raw request is available; denext's [Live channels](/docs/live) are the portable
alternative.

---

## 4. Partials

A `<Partial name="…">` is a region of the page that Fresh's client navigation updates in place.
On denext it is a client component: the page's Flight payload carries it with its
server-rendered children, and in the browser, inside an element with `f-client-nav` (not under
`f-client-nav="false"`):

- a same-origin **link** fetches its `f-partial` URL (else its `href`) and swaps the regions of
  the answer, then pushes its `href` to the history;
- a **`<button f-partial="…">`** that submits no form fetches that URL and swaps its regions,
  with no history entry;
- a **`<form>`** with an explicit `f-partial`, `action` or submitter `formaction` submits there
  (GET or POST) and swaps the regions of the answer.

The request carries `?fresh-partial=true`, so the handler sees `ctx.isPartial` (a route that
answers only partial requests redirects a full one, as Fresh's own website does), and a partial
request's `ctx.redirect()` keeps the parameter. Each region of the answer applies its `mode`:
`replace` (the default) swaps the children, `append` and `prepend` add them after or before the
region's content; a region the page lacks is skipped with a warning. Islands inside a swapped
region hydrate. An answer with no partials navigates the whole page instead (a link or a GET
form), and a full-page navigation renders each region with the new page's children.

---

## 5. `main.ts`: the app builder

Fresh 2's `main.ts` stays, and the generated files run what it registers:

| Call                                                      | On denext                                                                                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.use(mw)`, `app.use("/admin/*", mw)`                  | Runs before the route, under its path (`*` and `/` cover everything; `/admin` and `/admin/*` cover `/admin` and below).                                                            |
| `app.get()` / `post()` / … / `all()`, `app.ws()`          | Answered in `middleware.ts`; a handler's `ctx.render(<jsx />)` renders that JSX as a page (inside the app wrapper and layouts).                                                    |
| `app.route(path, { handler, component, config })`         | A page: its handler runs in `middleware.ts`, its component renders at `app/fresh-app-route/page.tsx`.                                                                              |
| `app.appWrapper(App)`, `app.layout(path, Layout, config)` | The root layout renders them: the layouts inside the wrapper (outermost first) and outside the `_layout` files; `skipAppWrapper` / `skipInheritedLayouts` apply.                   |
| `app.onError(path, routeOrMiddleware)`                    | The most specific one answers an error a handler or middleware raises: a middleware's Response, or the route's component (with `ctx.error`) at the error's status.                 |
| `app.notFound(routeOrMiddleware)`                         | `not-found.tsx` renders it when no `_404` / `_error` file does: the route's component, or a middleware's Response body as text at its status (`public/` files still answer first). |
| `app.mountApp(path, other)`                               | The other app's middleware, routes, layouts and error handlers, under `path`.                                                                                                      |
| `app.fsRoutes()`, `app.listen()`                          | Nothing to do: denext serves `app/`.                                                                                                                                               |

`app.islands()` is not run: islands are the `"use client"` files.

---

## 6. `csp()`

Fresh's `csp()` middleware adjusts the policy denext sends. For a page denext renders, its
directives merge into denext's own (strict, hash-based) policy: a `*-src` directive adds its
sources to denext's, so the page's own scripts and styles keep working (`'unsafe-inline'` from
Fresh's defaults is left out, as is every `'unsafe-inline'` with `useNonce`); any other directive
replaces denext's or is added (`frame-ancestors 'none'`, `upgrade-insecure-requests`, …).
`reportOnly` sends the merged policy as `Content-Security-Policy-Report-Only` instead, and
`reportTo` adds the `report-to` / `report-uri` directives and the `Reporting-Endpoints` header. A
Response a handler makes itself gets Fresh's policy as Fresh sends it.

---

## 7. Environment variables

`denext migrate` rewrites Vite's `import.meta.env` (also `(import.meta as any).env`) to
`importMetaEnv`, imported from `denext/fresh/env`, and Fresh's inlined public reads
(`Deno.env.get("FRESH_PUBLIC_FOO")`, `process.env.FRESH_PUBLIC_FOO`) to
`importMetaEnv.FRESH_PUBLIC_FOO`. It holds `MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL` and the public
variables (named `FRESH_PUBLIC_*`, `DENEXT_PUBLIC_*` or `NEXT_PUBLIC_*`), on the server and in
the browser, where they come from the page's public-env island (a production build ships the
ones its client code names). **A server-only variable is never in it**: read those with
`Deno.env.get()` in server code. `PROD` is true under `denext start` and `DEV` under
`denext dev`; your source runs in place under both, not from Vite's build output, so code that
picks a file path by `PROD` needs the development branch (`migrate --check` lists the files).

---

## 8. What `migrate --check` reports

Each finding names the files it was found in. **Won't migrate** means denext does not run it;
**review** means it migrates but needs a look.

| Won't migrate                                                                                            | What to do                                                                                          |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `app.islands()` in `main.ts`                                                                             | Move the components to `islands/` (or a `(_islands)` folder): islands are the `"use client"` files. |
| Vite plugins other than Fresh's and Tailwind's                                                           | Port what they do to `denext.config.ts` (`plugins`, `viteEmitterPlugin`).                           |
| Fresh 1.x `fresh.config.ts` plugins (Tailwind's aside)                                                   | Port what they add (routes, middleware, islands, styles) to the app or a denext plugin.             |
| `preact-render-to-string/jsx`, `/stream-node`                                                            | Use `denext/preact/render-to-string` (`preact-render-to-string` itself maps there).                 |
| `useSignalRef` / `createModel` from `@preact/signals`                                                    | Not in `denext/signals`.                                                                            |
| Preact's `options.diffed` / `unmount` / `debounceRendering` / `requestAnimationFrame` and internal hooks | denext never calls them ([Preact's `options` hooks](/docs/migrating-preact#preacts-options-hooks)). |
| A `static/` or generated file that already exists                                                        | Merge it by hand.                                                                                   |

| Review                                                         | What to do                                                                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fresh({ … })` options in `vite.config`                        | Not carried: the migration reads `routes/`, `islands/` and `client.ts` at their default places.                                                            |
| `f-view-transition`                                            | Partial navigation swaps the regions without the View Transitions wrapper.                                                                                 |
| An inline `<script dangerouslySetInnerHTML>`                   | denext's default CSP runs no inline script: move the code to a file under `public/` or into `instrumentation-client.ts`, or allow it in `csp.scriptSrc`.   |
| A WebSocket upgrade (`ctx.upgrade()`, `Deno.upgradeWebSocket`) | Works under `denext start` / `dev`, not on every deploy target; [Live channels](/docs/live) are portable.                                                  |
| `import.meta.env` (Vite)                                       | Rewritten to `denext/fresh/env`; check code that picks a file path by `PROD` (see [Environment variables](/docs/migrating-fresh#7-environment-variables)). |
| `Deno.env` in an island                                        | An island runs in the browser: pass the value as a prop, or use `publicEnv()` (a literal `FRESH_PUBLIC_*` read is rewritten for you).                      |
| `new App({ basePath })`                                        | Set `basePath` in `denext.config.ts`; the `App` option is not applied.                                                                                     |
| A Tailwind v3 stylesheet (Fresh 1.x)                           | Run `npx @tailwindcss/upgrade`.                                                                                                                            |

The list of what denext does not do for a Fresh app is also in
[Known limitations](/docs/limitations).

---

## 9. Signals

`@preact/signals` imports resolve to [`denext/signals`](/docs/signals), Preact Signals' API on
denext: a component re-renders when a signal its render read changes, a signal in JSX renders its
value, a signal passed as a DOM prop is bound, and a signal a page passes to an island arrives
live (one shared signal when two islands get the same one).

---

## 10. Proof: Fresh's own website

The migration bed
[`tests/migration-bed/fresh-www.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migration-bed/fresh-www.test.ts)
migrates Fresh's own website (`www/` in the Fresh repository, a Fresh 2 app on Vite with Tailwind
4: `main.ts` middleware, `_app` reading middleware state, `_layout`s and `_middleware`s, an
`_error` page that renders 404s, a docs route reading Markdown from the repository, handler-only
routes, a form POST, Partials and nine islands using `@preact/signals`). It builds and serves the
result, fetches every route with JavaScript off, and in a headless browser hydrates and clicks an
island and swaps a `<Partial>` region from an `f-partial` button. The one hand fix is the one
`migrate --check` reports: the docs route picks a file path by `import.meta.env.PROD`.
