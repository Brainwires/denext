# Changelog

All notable changes to **denext** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-07

### Added

- **React 19 hook parity** — `useId` (deterministic across server render and
  client hydration), `useSyncExternalStore`, `useLayoutEffect`,
  `useDeferredValue`, `useTransition`/`startTransition`, and `useImperativeHandle`
  (with React 19 **ref-as-prop** — components receive `ref` in props, no
  `forwardRef`). Context objects are now usable **directly as a provider element**
  (`<MyContext value={v}>`, React 19 style) in addition to `<MyContext.Provider>`.
  (`useTransition`/`useDeferredValue` are simplified, non-interruptible
  approximations in this synchronous renderer.) 11 tests.
- **Router completeness** — new App Router special files and helpers:
  - `template.tsx` (wraps like a layout, conceptually re-mounted), `global-error.tsx`
    (replaces the whole tree on an uncaught render error → 500).
  - `forbidden()` / `unauthorized()` control signals (like `notFound()`) that render
    `forbidden.tsx` / `unauthorized.tsx` (nearest up the tree) with a real `403` / `401`;
    they bubble past error boundaries.
  - `useSelectedLayoutSegment()` / `useSelectedLayoutSegments()` (reactive; simplified,
    not layout-relative). The manifest scanner and client entry were extended to cover
    the new files. 7 tests.
- **Server ergonomics** — `redirect()`/`permanentRedirect()` control signals
  (throw from a server component → `307`/`308`), and a per-request async context
  (Deno `AsyncLocalStorage`) powering `cookies()` and `headers()` from
  `denext/server` (read request cookies/headers; `cookies().set()`/`delete()`
  queue `Set-Cookie` on the response). Added the client `useOptimistic` hook. 6 tests.
- **Form actions** — the React 19 `useActionState` and `useFormStatus` hooks, plus
  `<form action={fn}>` interception (submit calls the action with the form's
  `FormData`). Actions run on the client (typically calling a route handler);
  denext does **not** implement Next.js's bundler-transformed `"use server"` RPC.
  4 tests.
- **Static generation & SEO** — `denext export` pre-renders the whole app to a
  static, host-anywhere directory (`out/`): every page plus dynamic routes
  enumerated by `generateStaticParams`, with client bundles and `public/` assets
  copied in (still hydratable). Added `generateMetadata` (async) support and an
  expanded `Metadata` type (`keywords`, `robots`, `canonical`, `openGraph`,
  `icon`) rendered into `<head>`. 4 tests.

## [0.1.2] - 2026-08-07

### Fixed

- **JSR module-doc detection** — `jsx-runtime.ts`'s top JSDoc lacked an `@module` tag, so deno doc
  attached it to the first export instead of treating it as a module doc, failing JSR's "module docs
  in all entrypoints" check (`./jsx-runtime` and `./jsx-dev-runtime` both map to this file). Added the
  tag; all entrypoints now expose a recognized module doc.

## [0.1.1] - 2026-08-07

### Security

- **Fixed an XSS via unsafe attribute names in SSR and hydration.** An attribute name containing
  tag/attribute-delimiter characters — reachable when a component spreads untrusted keys, e.g.
  `<div {...untrusted}>` — could break out of the tag and inject markup. `serializeAttributes`
  (server) and the client reconciler now drop names failing `isValidAttrName` (rejects whitespace,
  quotes, `< > / =`, and control characters; `data-*`/`aria-*`/`xml:lang` stay valid). Attribute
  _values_ were already escaped; this closes the name vector. Added 5 security regression tests.

### Added

- **Full API documentation** — JSDoc on every exported symbol across all public entrypoints and
  module docs on each entrypoint (`deno doc --lint` is clean), taking JSR documentation coverage to
  100%.
- **CI & release automation** — a GitHub Actions `CI` workflow (fmt / lint / type-check / tests /
  `deno doc --lint`) and a `Publish to JSR` workflow that runs on `v*` tags with `id-token: write`,
  so releases carry **build provenance**.

## [0.1.0] - 2026-08-07

### Added

- **`denext` executable + packaging**:
  - `deno task compile` produces a standalone `denext` binary via `deno compile`. Fixed the compiled
    case where bundling shelled out to the wrong executable — `denoExecutable()` now resolves the
    real `deno` (via `DENO_BIN`, `~/.deno/bin/deno`, or `PATH`) instead of `Deno.execPath()` (which
    is `denext` in a compiled binary). `start` runs fully standalone; `dev`/`build` still need a
    `deno` for client bundling.
  - Exposed `./cli` and `./lint-plugin` exports, so `deno install`/`deno run jsr:@denext/denext/cli`
    and the lint plugin work from the published package.
  - Added a `publish.exclude` (tests, examples, build output, binary) — `deno publish --dry-run`
    passes with no slow-type errors, so the package is JSR-ready.
  - README: "The `denext` command" (install/compile/task) and "Using denext as a package" sections.
- **Port handling** (`src/server/serve-utils.ts`): when no `--port` is given, `dev`/`start` now
  auto-select an open port (trying 3000, 3001, … up to 10), logging each fallback, instead of
  crashing with `AddrInUse`. When `--port` **is** given, that exact port is required — an in-use
  port fails immediately with a clean, single-line error (exit 1). 4 tests.
- **Tooling config & clean baseline**: explicit, customizable `deno fmt` settings
  (`useTabs`/`lineWidth`/`indentWidth`/`semiColons`/`singleQuote`/`proseWrap`/`exclude`) and lint
  config in `deno.json`, plus `fmt`/`lint`/`check` tasks. The whole repo is now `deno fmt` clean and
  `deno lint` clean (including the denext hook rules).
- **Deno-native lint plugin** (`src/lint/denext-plugin.ts`): React/denext hook rules enforced by
  `deno lint` (no ESLint/npm) — `denext/rules-of-hooks` (no conditional hooks),
  `denext/hooks-in-component` (hooks only in components/`useX` hooks, not callbacks), and
  `denext/no-hooks-in-async` (hooks in async server components have no client effect). Wired into
  both `deno.json` files; 8 tests via `Deno.lint.runPlugin`.
- **Root not-found rendering**: unmatched page requests render the app's root `not-found.tsx`
  (within the root layout) with a `404` status, instead of a generic message. The manifest now
  tracks `rootNotFound`.
- **README + LICENSE**: full documentation (quick start, routing conventions, API surface,
  middleware, linting, architecture, limitations) and an MIT license. The example app
  (`examples/hello`) gained its own `deno.json` so it runs as a realistic standalone project.
- **Client-side navigation** (`src/client/navigation.ts`): SPA soft navigation without full reloads.
  - `<Link href>` renders a normal SSR anchor and navigates on the client; global click delegation
    also intercepts plain internal `<a>` links.
  - `navigate()` fetches the target page's server HTML, swaps the hydration root, updates
    `<title>` + history (push/replace/`popstate`), and re-runs the route bundle to hydrate; falls
    back to a full load on cross-origin or failure.
  - Router hooks: `useRouter()` (`push`/`replace`/`back`/`forward`/`refresh`), reactive
    `usePathname()` and `useSearchParams()`.
  - Route bundles now boot via `startClient()` (hydrate + install navigation).
- **App Router special files** (`loading.tsx`, `error.tsx`, `not-found.tsx`) and the primitives
  behind them (`src/runtime/error-boundary.ts`):
  - `<ErrorBoundary fallback>` renders a fallback (given `error` + `reset`) when a descendant throws
    during render — server (string + streaming) and client, with a working `reset()`.
  - `notFound()` throws a sentinel that bubbles past error boundaries to render the not-found UI
    with a real `404` status.
  - The manifest scanner captures the nearest `loading`/`error`/`not-found` per page (inherited down
    the tree); the render pipeline wraps each page in its error boundary and a `<Suspense>` whose
    fallback is `loading.tsx`; the client entry mirrors the same wrapping for hydration.
- **Root middleware** (`src/server/middleware.ts`): a `middleware.ts` (or `proxy.ts` alias) at the
  project root runs before routing. Handlers return a `Response` (short-circuit), `redirect()`,
  `rewrite()` (internal re-route), or `next()` (continue, optionally injecting response headers).
  Supports a `config.matcher` (`:name`, `:name*`, `*` patterns). Loaded by dev (hot-reloaded) and
  prod servers; exported from `denext/server`.
- **Suspense + streaming SSR** (`src/runtime/suspense.ts`, `src/jsx/render-to-stream.ts`): a
  `<Suspense fallback>` boundary, a `use()` primitive that unwraps promises by suspending, and
  `createResource()`.
  - `renderToReadableStream()` flushes the shell with each boundary's fallback, then streams each
    boundary's real content as it resolves plus an inline swap script — supporting multiple
    concurrent and nested boundaries.
  - `renderToString()` transparently resolves Suspense (no streaming).
  - Client reconciler supports Suspense: shows the fallback while a descendant suspends and swaps in
    real content when the promise settles.
- **Project scaffolding**: `deno.json` with a self-contained JSX toolchain
  (`jsxImportSource: "denext"`), standard-library-only import map, and dev/start/ build/test tasks.
  No runtime npm dependencies.
- **JSX runtime** (`src/jsx/`): a self-contained mini virtual DOM. `jsx`/`jsxs`/ `jsxDEV`/`Fragment`
  for the automatic runtime, plus a classic `h()` helper. No React dependency.
- **Server-side rendering** (`src/jsx/render-to-string.ts`): `renderToString` supporting function
  components (sync and async), fragments, context providers, correct HTML escaping, void elements,
  boolean attributes, style-object serialization, and `dangerouslySetInnerHTML`.
- **Hooks** (`src/runtime/hooks.ts`): swappable-dispatcher `useState`, `useReducer`, `useEffect`,
  `useMemo`, `useCallback`, `useRef`, `useContext`, shared between server and (upcoming) client
  runtimes.
- **Context** (`src/runtime/context.ts`): `createContext` with provider/consumer resolution during
  rendering.
- **File-based router** (`src/router/`): Next.js App Router-style conventions — `page`, `layout`,
  `route` files; static, dynamic (`[slug]`), catch-all (`[...rest]`), and optional catch-all
  (`[[...rest]]`) segments; route groups (`(group)`); specificity-ordered matching; filesystem
  manifest scanner.
- **HTTP server** (`src/server/`): request handler dispatching to API routes, server-rendered pages,
  static assets, or a 404. Includes:
  - Page render pipeline composing the layout chain around a page and merging layout + page
    `metadata` (title/description/meta/head).
  - Full HTML document assembly with `<head>` metadata and a hydration bootstrap (serialized route
    data + client module script).
  - API dispatch by HTTP method (`GET`/`POST`/… exports) with automatic `HEAD` from `GET` and
    `405` + `Allow` for unsupported methods.
  - Static file serving from `public/` with path-traversal protection and content-type detection.
  - `serve()` helper over `Deno.serve`, and an injectable module loader.
- **Client runtime** (`src/client/`): a small virtual-DOM reconciler with real hooks and in-place
  DOM patching. Includes:
  - `createRoot` (fresh mount) and `hydrateRoot` (adopts server markup in place, binding events
    without recreating nodes; self-heals on mismatch).
  - Full hooks on the client (`useState`/`useReducer`/`useEffect` with dependency tracking +
    cleanup, `useMemo`/`useRef`/`useContext`).
  - Keyed children reconciliation that preserves element identity across reorders; microtask-batched
    updates with a `flushSync` escape hatch.
  - Context provider/consumer resolution through the live instance tree.
  - `bootstrap.ts` browser entry that rebuilds the server's tree from the embedded hydration payload
    and hydrates `#__denext`.
  - Injectable `document` (`setDocument`) so the reconciler stays DOM-agnostic and testable without
    a third-party DOM.
- **Toolchain & CLI** (`src/build/`, `cli.ts`): dev/build/start commands driven by Deno's own
  toolchain — **no third-party bundler**.
  - Browser bundling via `deno bundle`: one entry per route (page + layouts + client runtime as a
    single module graph, preserving context identity).
  - `denext dev`: SSR + on-demand per-route bundling + live reload over SSE, with a filesystem
    watcher and generation-based module/bundle cache busting.
  - `denext build`: pre-bundles + minifies each route to `.denext/client/` and writes a build
    manifest.
  - `denext start`: serves SSR pages plus the pre-built, immutably-cached client bundles.
- **Example app** (`examples/hello/`): App Router demo — root layout, an interactive home page
  (`useState`/`useEffect` hydration), a static about page, a dynamic async blog route
  (`/blog/[slug]`), an API route, and CSS. Verified end-to-end: SSR, hydration payload, API
  GET/POST, static serving, dynamic params, and the production build/start path.
- **Tests**: coverage for the JSX runtime, SSR renderer, route-segment matching, the manifest
  scanner, the request handler, static serving, the client reconciler (hydration, keyed reordering,
  effects, context), and the build layer (route ids, generated entries), Suspense/streaming, error
  boundaries and `notFound()`, middleware, client navigation, and the lint plugin — 75 passing.
  Ships a tiny in-memory DOM shim so reconciler tests need no third-party DOM.

[0.2.0]: https://jsr.io/@denext/denext@0.2.0
[0.1.2]: https://jsr.io/@denext/denext@0.1.2
[0.1.1]: https://jsr.io/@denext/denext@0.1.1
[0.1.0]: https://jsr.io/@denext/denext@0.1.0
