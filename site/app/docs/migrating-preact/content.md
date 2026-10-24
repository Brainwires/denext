---
title: Migrating from Preact
slug: migrating-preact
lead: denext migrate runs a Preact app (Vite with @preact/preset-vite, preact-cli, WMR or esbuild) as a denext SPA with its source unchanged. Preact, its hooks, Preact Signals and preact-iso resolve to denext.
---

This guide covers moving an existing **Preact** single-page app to denext. It reflects what
`denext migrate --from preact` does today, including its honest limits.

The short version: **your source is not rewritten.** The app takes denext's
[SPA mode](/docs/spa), and Preact's packages point at denext's implementations of them, in the
import map and (for npm packages that import Preact) through `resolveAlias`. `class`, `onInput`
and `render(<App />, root)` work as written.

---

## 1. Detection

A Preact app has `preact` in its `package.json` dependencies, plus one of these, checked in this
order:

1. Vite with `@preact/preset-vite` (a dependency, or the preset in `vite.config`), which is what
   `npm create preact` makes;
2. `preact-cli`;
3. `wmr`;
4. `esbuild`, with a `tsconfig.json`, `jsconfig.json` or esbuild script (`esbuild.config.js`,
   `esbuild.config.mjs`, `build.js`, `build.mjs`) setting `jsxImportSource: "preact"` or
   `jsxFactory: "h"`.

Preact is checked before the rest of the SPA family (Create React App, Vite, a generic React
SPA), since a Preact app on Vite is a Vite app too. Pass `--from preact` to force the path.

```sh
denext migrate --check
denext migrate
denext task dev
```

---

## 2. What it generates

- **SPA mode**: `mode: "spa"` in `denext.config.ts`, as for any [Vite SPA](/docs/migrating#3b-migrating-a-vite-cra-or-generic-react-spa),
  with a `resolveAlias` block mapping `preact`, `preact/hooks`, `preact/compat`,
  `preact/jsx-runtime`, `preact/jsx-dev-runtime`, `preact-render-to-string`,
  `preact-render-to-string/stream`, `@preact/signals`, `@preact/signals/utils` and
  `@preact/signals-core` (and preact-iso's entry points, when the app uses it) to their
  `denext/*` targets, so an npm package that imports Preact gets denext's, not its own copy.
- **The import map** in `deno.json` holds the same aliases, plus `preact/debug` and
  `preact/devtools` mapped to an empty module, and `preact-iso`, `preact-iso/router`,
  `preact-iso/lazy`, `preact-iso/prerender` and `preact-iso/hydrate` mapped to
  `denext/preact-iso` when the app depends on preact-iso.
- **JSX compiles with Preact's runtime** (`jsxImportSource: "preact"`, resolved to
  `denext/preact/jsx-runtime`, which binds a signal passed as a DOM prop) when `migrate` creates
  the `deno.json`. An existing, hand-written `deno.json` is left alone: add the setting yourself.
- **Your source is unchanged.** `--codemod` does not apply to a Preact app: its imports already
  resolve to denext through the import map.
- **`.gitignore`** gets `.denext/`, `out/` and `.deno/` (the native TypeScript 7 check's project
  cache), appended only when missing.

---

## 3. What the aliases provide

| Module                           | What it provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `denext/preact`                  | `h` / `createElement`, `Fragment`, `Component`, `createContext`, `createRef`, `cloneElement`, `isValidElement`, `toChildArray`, `render`, `hydrate`, `createPortal`, `options`, and Preact's type names (`ComponentChildren`, `FunctionComponent`, `RenderableProps`, `JSX`, ...).                                                                                                                                                                                                                                                                                                                                                        |
| `denext/preact/hooks`            | The hooks, plus Preact's `useErrorBoundary`: the component that calls it is an error boundary for what it renders. A render, effect or event-handler error below re-renders it with `[error, resetError]`, the callback gets `(error, errorInfo)` once that render commits, and `resetError()` renders the children again. While it shows an error, an error its error UI throws goes to the boundary above. A production build includes this boundary support when the app's own sources name `useErrorBoundary` or import preact-iso (a library that calls the hook needs the app to name it once); a server render never catches here. |
| `denext/preact/render-to-string` | preact-render-to-string's `renderToString` (also the default export and `render`), `renderToStaticMarkup`, `renderToStringAsync` and `renderToReadableStream`, rendered by denext's server renderer in Preact's markup (see below).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `denext/signals`                 | Preact Signals: see [Preact Signals](/docs/signals).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `denext/preact-iso`              | preact-iso's contract on denext's hooks and `<Suspense>`: `LocationProvider` (same-origin link clicks and back / forward navigate on the client), `useLocation`, `Router`, `Route`, `useRoute`, `exec`, `lazy` (with `.preload()`), `ErrorBoundary`, `hydrate`, `prerender` (returns `{ html, links }`) and `locationStub`.                                                                                                                                                                                                                                                                                                               |

### Preact's `options` hooks

denext calls the hooks it can honour; the rest can be set but are never called, because
denext's reconciler does not run Preact's diff.

| Hook                                                                                              | On denext                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.vnode(vnode)`                                                                            | Called for each element `h`, `createElement`, `cloneElement` (from `denext/preact` and `denext/preact/compat`) and Preact's JSX runtime create. |
| `options.event(e)`                                                                                | Called before each handler of an intrinsic element those create; a returned value is passed to the handler in the event's place.                |
| `options.useDebugValue(value)`                                                                    | Called by `useDebugValue` from `denext/preact/hooks`, with the formatted value.                                                                 |
| `diffed`, `unmount`, `requestAnimationFrame`, `debounceRendering`, `__suspenseDidResolve`, `attr` | Never called (a no-op).                                                                                                                         |
| The internal hooks (`__b`, `__r`, `__c`, `__e`, `__h`, `_diff`, `_render`, `_commit`, …)          | Never called (a no-op), so `preact/debug` and `preact/devtools` map to an empty module.                                                         |

The element `options.vnode` receives is denext's (`type`, `props`, `key`, with the `ref` in
`props`), not Preact's internal vnode. Elements denext's own components create (outside the
Preact entry points) do not pass through these hooks.

### `denext/preact/render-to-string`

The tree renders with hooks, context, class components and Suspense, written as
preact-render-to-string writes it: void elements self-close (`<br/>`), boolean and empty
attributes are bare (`disabled`, `alt`) and boolean names lowercase (`readonly`), `class` wins
over `className`, text and attribute values escape only `&`, `<` and `"`, and a style object's
declarations each end with `;`. A synchronous render that suspends throws
`Use "renderToStringAsync" for suspenseful rendering.`, and `renderToStringAsync` brackets a
boundary that suspended with `<!--$s-->` / `<!--/$s-->`.

Where it differs from preact-render-to-string:

- Attributes keep denext's order (Preact writes an `<option>`'s `selected` first).
- camelCase SVG presentation attributes are always hyphenated (`stroke-width`), as browsers need.
- An `<input>` with both `value` and `defaultValue` writes `value` once (Preact writes both).
- The `context` argument (a legacy context object) is ignored.
- `renderToReadableStream` sends the document once every boundary has resolved; it does not
  stream fallbacks first. `preact-render-to-string/jsx` and `/stream-node` are not mapped.

### `denext/preact-iso`

It follows preact-iso: while a `lazy()` route loads, `<Router>` keeps the previous route mounted
and on screen and calls `onLoadStart(url)`; once the new route renders it calls
`onRouteChange(url)` (on a route change, not the first render) and `onLoadEnd(url)`.
`useLocation()` also carries `wasPush`. `ErrorBoundary` passes a render error to `onError`, then
on to the error boundary above it, and lets a suspended child wait in place. `hydrate()` hydrates
the markup `prerender()` wrote the first time it runs on a page with preact-iso's `isodata`
script (mounting into that script's parent by default), and renders otherwise.

Where `denext/preact-iso` differs from preact-iso: a migrated app runs as a SPA, so nothing
prerenders its pages unless you call `prerender()` yourself.

---

## 4. Other routers

**preact-router** and **wouter-preact** keep running as they are, on the Preact aliases: their
links and `route()` navigate on the client as before. `migrate --check` lists them for review, so
you check the navigation and redirects.

---

## 5. What `migrate --check` reports

`denext migrate --check` reports `source: "preact"`, with each finding naming the files it was
found in.

| Won't migrate                                                                                                | What to do                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| preact-cli's `preact.config.js` (its webpack config)                                                         | Port what it adds to `denext.config.ts`.                                                       |
| `preact-render-to-string/jsx`, `/stream-node`                                                                | Render with `renderToString` / `renderToReadableStream` from `denext/preact/render-to-string`. |
| Preact's `options.diffed` / `unmount` / `debounceRendering` / `requestAnimationFrame` and the internal hooks | denext never calls them (see [the `options` hooks](#preacts-options-hooks)).                   |
| `useSignalRef` / `createModel` from `@preact/signals`                                                        | Not in `denext/signals`.                                                                       |

| Review                           | What to do                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preact-router`, `wouter-preact` | They run on the aliases; check the navigation and redirects.                                                                                       |
| preset-vite's `prerender`        | denext's SPA mode renders in the browser and does not prerender. For HTML at build time, move the pages to the App Router and run `denext export`. |
| `wmr.config.mjs`                 | WMR plugins are not run; port them to `denext.config.ts`.                                                                                          |

The same list is in [Known limitations](/docs/limitations).

---

## 6. Proof: Preact's own starter

The migration bed
[`tests/migration-bed/preact-vite.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migration-bed/preact-vite.test.ts)
migrates create-preact's Vite template with its router option (`@preact/preset-vite`,
preact-iso's `LocationProvider` / `Router` / `Route` / `useLocation`, an SVG imported as an
asset, CSS imports, `render()` into `#app`). It builds and serves the result, checks its shell
with JavaScript off, and in a headless browser renders the app and navigates a header link on the
client. It adds a preact-iso `lazy()` route whose page holds a `useErrorBoundary` component
catching its child's render error, and an `options.vnode` hook that marks `<main>`: a header link
loads the code-split route through the Router, the boundary renders its error UI, and the hook ran
on the app's own JSX.

Coming from a server-rendered Preact app on Fresh instead? See
[Migrating from Fresh](/docs/migrating-fresh).
