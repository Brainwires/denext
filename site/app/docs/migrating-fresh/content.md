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
`"use client"`, and points Fresh's and Preact's imports at denext through `deno.json`.

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
- **`middleware.ts`** runs a request the way Fresh does: `main.ts`'s `app.use()` middleware and
  `app.get()` / `app.post()` routes, the `_middleware` files, then the route's handler. A
  handler's `Response` is the answer; `page(data)` (Fresh 1.x: `ctx.render(data)`) hands the data
  to the page, which denext renders inside the layouts with the status and headers `page()` and
  the middleware set. That works for any method, so a form POST that re-renders the page works.
  `ctx.state` reaches handlers, layouts and pages; `ctx.next()` resolves with a stand-in for the
  page's response (its status and headers, which middleware may add to). An `HttpError` renders
  the not-found page (404) or the route's `_error` page. Fresh 1.x's `(req, ctx)` handlers,
  `defineRoute` / `defineApp` / `defineLayout` and `ctx.renderNotFound()` work too.
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

| Module                 | What it provides                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `denext/fresh`         | `App`, `HttpError`, `page`, `createDefine` and the `Context` / `FreshContext` types; Fresh 2's middleware `staticFiles`, `trailingSlashes`, `csrf`, `cors`, `csp` (a no-op: denext sends its own policy) and `ipFilter`; Fresh 1.x's `defineRoute`, `defineLayout`, `defineApp`, `defineConfig` and `STATUS_CODE`. `start()` rejects: run the app with `denext start`. |
| `denext/fresh/runtime` | `IS_BROWSER`, `asset` and `assetSrcSet` (paths returned as they are), `Head` (its children render in place and denext hoists `<title>`, `<meta>` and `<link>`), `Partial` (renders its children), `HttpError`, and Fresh 1.x's `nonce` and CSP constants; `useCSP` does nothing.                                                                                       |

`ctx.isPartial` is always `false` (denext has no partial navigation). `ctx.upgrade()` upgrades a
WebSocket under `denext start` and `denext dev`, where the raw request is available; denext's
[Live channels](/docs/live) are the portable alternative.

---

## 4. What `migrate --check` reports

Each finding names the files it was found in. **Won't migrate** means denext does not run it;
**review** means it migrates but needs a look.

| Won't migrate                                                                                            | What to do                                                                                          |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `app.appWrapper` / `layout` / `onError` / `notFound` / `route` / `mountApp` / `islands` in `main.ts`     | Move them to `routes/` files (`_app`, `_layout`, `_error`, `_404`, a route).                        |
| Vite plugins other than Fresh's and Tailwind's                                                           | Port what they do to `denext.config.ts` (`plugins`, `viteEmitterPlugin`).                           |
| Fresh 1.x `fresh.config.ts` plugins (Tailwind's aside)                                                   | Port what they add (routes, middleware, islands, styles) to the app or a denext plugin.             |
| `preact-render-to-string/jsx`, `/stream-node`                                                            | Use `denext/preact/render-to-string` (`preact-render-to-string` itself maps there).                 |
| `useSignalRef` / `createModel` from `@preact/signals`                                                    | Not in `denext/signals`.                                                                            |
| Preact's `options.diffed` / `unmount` / `debounceRendering` / `requestAnimationFrame` and internal hooks | denext never calls them ([Preact's `options` hooks](/docs/migrating-preact#preacts-options-hooks)). |
| A `static/` or generated file that already exists                                                        | Merge it by hand.                                                                                   |

| Review                                                         | What to do                                                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fresh({ … })` options in `vite.config`                        | Not carried: the migration reads `routes/`, `islands/` and `client.ts` at their default places.                                                          |
| Partials (`<Partial>`, `f-client-nav`, `f-partial`)            | `<Partial>` renders its children; a link loads the next page in full.                                                                                    |
| An inline `<script dangerouslySetInnerHTML>`                   | denext's default CSP runs no inline script: move the code to a file under `public/` or into `instrumentation-client.ts`, or allow it in `csp.scriptSrc`. |
| `ctx.isPartial`                                                | Always `false`.                                                                                                                                          |
| A WebSocket upgrade (`ctx.upgrade()`, `Deno.upgradeWebSocket`) | Works under `denext start` / `dev`, not on every deploy target; [Live channels](/docs/live) are portable.                                                |
| `import.meta.env` (Vite)                                       | Not defined on denext's server: read `Deno.env`, or `publicEnv()` from `denext` in the browser.                                                          |
| `FRESH_PUBLIC_*` variables                                     | Rename them `DENEXT_PUBLIC_*` and read them with `publicEnv()`.                                                                                          |
| `Deno.env` in an island                                        | An island runs in the browser: pass the value as a prop, or use `publicEnv()`.                                                                           |
| `csp()` in `main.ts`                                           | A no-op on denext: set the directives in the `csp` config key.                                                                                           |
| `new App({ basePath })`                                        | Set `basePath` in `denext.config.ts`; the `App` option is not applied.                                                                                   |
| A Tailwind v3 stylesheet (Fresh 1.x)                           | Run `npx @tailwindcss/upgrade`.                                                                                                                          |

The list of what denext does not do for a Fresh app is also in
[Known limitations](/docs/limitations).

---

## 5. Signals

`@preact/signals` imports resolve to [`denext/signals`](/docs/signals), Preact Signals' API on
denext: a component re-renders when a signal its render read changes, a signal in JSX renders its
value, a signal passed as a DOM prop is bound, and a signal a page passes to an island arrives
live (one shared signal when two islands get the same one).

---

## 6. Proof: Fresh's own website

The migration bed
[`tests/migration-bed/fresh-www.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migration-bed/fresh-www.test.ts)
migrates Fresh's own website (`www/` in the Fresh repository, a Fresh 2 app on Vite with Tailwind
4: `main.ts` middleware, `_app` reading middleware state, `_layout`s and `_middleware`s, an
`_error` page that renders 404s, a docs route reading Markdown from the repository, handler-only
routes, a form POST, Partials and nine islands using `@preact/signals`). It builds and serves the
result, fetches every route with JavaScript off, and hydrates and clicks an island in a headless
browser. The one hand fix is the one `migrate --check` reports: the docs route reads Vite's
`import.meta.env.PROD`.
