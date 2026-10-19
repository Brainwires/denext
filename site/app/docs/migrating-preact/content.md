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
  `preact/jsx-runtime`, `preact/jsx-dev-runtime`, `@preact/signals`, `@preact/signals/utils`
  and `@preact/signals-core` (and preact-iso's entry points, when the app uses it) to their
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

| Module              | What it provides                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `denext/preact`     | `h` / `createElement`, `Fragment`, `Component`, `createContext`, `createRef`, `cloneElement`, `isValidElement`, `toChildArray`, `render`, `hydrate`, `options`, and Preact's type names (`ComponentChildren`, `FunctionComponent`, `RenderableProps`, `JSX`, ...). `options` exists so code that sets a hook loads; denext's renderer never calls its hooks. |
| `denext/signals`    | Preact Signals: see [Preact Signals](/docs/signals).                                                                                                                                                                                                                                                                                                         |
| `denext/preact-iso` | preact-iso's contract on denext's hooks and `<Suspense>`: `LocationProvider` (same-origin link clicks and back / forward navigate on the client), `useLocation`, `Router`, `Route`, `useRoute`, `exec`, `lazy` (with `.preload()`), `ErrorBoundary`, `hydrate`, `prerender` (returns `{ html, links }`) and `locationStub`.                                  |

Where `denext/preact-iso` differs from preact-iso:

- While a `lazy()` route loads, `<Router>` renders nothing in its place; preact-iso keeps the
  previous route on screen.
- `onLoadStart` is not called.
- `hydrate()` renders on the client: a denext SPA has no server markup to hydrate.

---

## 4. Other routers

**preact-router** and **wouter-preact** keep running as they are, on the Preact aliases: their
links and `route()` navigate on the client as before. `migrate --check` lists them for review, so
you check the navigation and redirects.

---

## 5. What `migrate --check` reports

`denext migrate --check` reports `source: "preact"`, with each finding naming the files it was
found in.

| Won't migrate                                         | What to do                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| preact-cli's `preact.config.js` (its webpack config)  | Port what it adds to `denext.config.ts`.                     |
| `useErrorBoundary`                                    | Catch with `<ErrorBoundary>` from denext.                    |
| `preact-render-to-string`                             | Render with `renderToString` from `denext/react-dom/server`. |
| Preact's `options` hooks                              | denext's renderer does not call them.                        |
| `useSignalRef` / `createModel` from `@preact/signals` | Not in `denext/signals`.                                     |

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
client.

Coming from a server-rendered Preact app on Fresh instead? See
[Migrating from Fresh](/docs/migrating-fresh).
