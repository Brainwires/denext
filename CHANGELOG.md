# Changelog

All notable changes to **denext** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-08-08

The React Server Components release: a real `"use client"`/`"use server"`
boundary built bundler-lessly on Deno, plus the App Router features that were
previously shipped scoped-down. Server Actions folded into `"use server"` are
built with the same defensive posture as 0.4.0 (Next.js's worst CVEs were here).

### Added

- **Flight / RSC boundary (`"use client"` / `"use server"`)** — a true Server
  Components boundary with no third-party bundler. The server still SSRs client
  modules for first paint but emits them as **references** in a **Flight** payload
  (`#__denext_flight` island); only client modules ship to the browser. Directives
  are parsed by a real tokenizer (not a regex), the app-wide client/server split
  is discovered by crawling Deno's own module graph (`deno info`), and client
  islands are tagged as references via ESM singletons. `"use server"` exports
  auto-register and are stripped from the browser bundle by redirecting each
  server module to a generated client stub through a `deno bundle` import map —
  proven by byte-grep tests that server-component and server-action code are
  **provably absent** from the client bundle. `useId` is re-based per island so
  hydration ids stay aligned; streaming Flight interleaves boundary rows.
  Undirected modules stay **isomorphic** (opt-in, fully backward compatible).
  `serverAction("id", fn)` still works. The default remains the whole-tree
  isomorphic hydration for routes with no boundary.
- **Parallel routes done right** — `@slot` folders become full routable subtrees
  (their own segments, dynamic params, `layout`/`loading`/`error`), matched
  against the current URL with a new **`default.tsx`** convention, and
  **layout-scoped** so a slot spans every route under its layout (the canonical
  `@modal/(.)photo/[id]` intercept-in-slot modal works on soft nav).
- **Layout-relative `useSelectedLayoutSegment(s)`** — each layout now sees only
  the path segments **below its own level** (route groups add no depth), via a
  segment-depth provider wrapped around each layout on both server and client.
- **Dynamic OG images** — an `opengraph-image.{tsx,ts,jsx,js}` convention served
  at `/opengraph-image`. The default export may return an **SVG VNode**
  (serialized to `image/svg+xml`, no rasterizer dependency), a **`Uint8Array`**
  (served `image/png` — bring-your-own rasterizer), or a **`Response`** (verbatim).
  `og:image` auto-populates to its absolute URL when a page sets none.
- **`useTranslations()`** — a real message-catalog hook. `I18nConfig.messages`
  maps locale → catalog; the active catalog is provided to SSR and embedded in the
  hydration payload, so `t("greeting", { name })` interpolates `{var}` placeholders
  server-side and on the client (re-read on soft navigation). Correct under the
  Flight boundary too.
- **Hardening & loose ends** — a **pluggable draft-token store**
  (`setDraftTokenStore` / `DraftTokenStore`) for multi-instance deployments
  (default in-memory; server-minted-token security preserved); **`<html lang>`**
  now reflects the active locale; and an **absolute-URL helper**
  (`requestOrigin` / `absoluteUrl`).

### Security

- **Directive scan can't be hidden by a banner** — `readDirective` now grows its
  read window until the module's directive prologue is conclusively resolved,
  instead of reading a fixed 1 KB head. A license banner longer than the window
  could previously hide a `"use server"` directive, failing open and leaking the
  server module into the client bundle.
- **`X-Forwarded-*` untrusted by default** — `requestOrigin`/`absoluteUrl` (used
  to auto-populate `og:image`) now ignore `X-Forwarded-Proto`/`-Host` unless a
  deployment opts in via `trustForwardedHeaders` (trusted reverse proxy) or pins
  the origin with `canonicalOrigin`, closing a header-spoofing vector.

## [0.4.0] - 2026-08-07

Server-first features: mutations, caching, and SEO — with Server Actions built
defensively (Next.js's worst CVEs were here).

### Added

- **Route segment config** — page/layout modules may `export const dynamic`,
  `revalidate`, `dynamicParams`, `runtime`, etc. The effective config is merged
  down the layout chain (shortest `revalidate` wins) and drives static/dynamic
  rendering; the static export skips `dynamic: "force-dynamic"` routes.
- **Data cache & Incremental Static Regeneration** — `cache()` (per-request
  memoization), `unstable_cache` + `cachedFetch` (cross-request TTL + tags),
  and `revalidatePath`/`revalidateTag`. The production server serves a rendered
  **page cache** for routes that opt in via `revalidate`/`force-static`; the
  default (`dynamic: "auto"`, `revalidate: false`) is **never cached**, so pages
  reading `cookies()`/`headers()` stay per-request.
- **Server Actions** — `serverAction(id, handler)` registers a server function
  dispatched over `POST /_denext/action/<id>`, usable as a `<form action>` (with
  no-JS **progressive enhancement**) or via `useActionState`. **Security:** every
  action request is enforced **same-origin** (Origin, then Referer, deny when
  absent) as a CSRF defense; POST-only; only registered ids resolve; handler
  errors are logged server-side but returned to the client as a generic message;
  redirects are forced to 303 and the no-JS redirect target is restricted to a
  same-origin path. Plus `serverOnly()`/`clientOnly()` boundary guards.
- **Metadata files** — `app/sitemap.ts` → `/sitemap.xml`, `app/robots.ts` →
  `/robots.txt`, `app/manifest.ts` → `/manifest.webmanifest`, and `app/favicon.ico`.
- **Document metadata hoisting** — render `<title>`/`<meta>`/`<link>` anywhere in
  the tree (React 19); they are hoisted into `<head>` during SSR (in-tree
  `<title>` wins over the `metadata` export).
- **Asset & navigation ergonomics** — `<Image>` (lazy/async/`priority`/`srcSet`),
  `<Script>` strategies, `localFont` + `<FontFace>` (`@font-face`), `useParams()`,
  `<Link prefetch>` (hover + viewport prefetch with a client HTML cache), and
  `draftMode()` (httpOnly preview cookie).

## [0.3.0] - 2026-08-07

Four "owns-both-halves" wins — things possible because denext owns the
reconciler, the router, the middleware runner, **and** the linter together.

### Added

- **Composable, ordered middleware** — `middleware.ts` / `proxy.ts` may now export
  an **ordered array** of handlers (or `{ handler, config }` entries) instead of a
  single function. They run in order: a `Response` short-circuits the chain, a
  `rewrite()` threads its URL into every later entry, and `next({ headers })`
  accumulates headers across the chain. Per-entry `config.matcher` gates individual
  entries. New `composeMiddleware()`; single-function exports keep working
  unchanged. 7 tests.
- **i18n routing (optional default-locale prefix)** — `/about` serves the default
  locale, `/fr/about` serves `fr`; the locale is peeled at request time (the router
  core is untouched) and merged into route `params`, so pages, layouts, templates,
  and client hydration all see `params.locale`. New `useLocale()` client hook,
  `peelLocale`, `detectLocale`/`parseAcceptLanguage`, and a ready-made
  `localeMiddleware` (cookie + `Accept-Language` negotiation) that composes into the
  chain above. Config comes from a `serve({ i18n })` option or a
  `denext.config.{ts,js}` export; static export emits one variant per locale. 10 tests.
- **Convention registry + parallel & intercepting routes** —
  - The scanner's hardcoded file-convention regexes are now a **table-driven
    registry** with a `registerConvention()` seam and a post-scan
    `registerRouteSynthesizer()` hook (extension points for derived routes). A
    golden-manifest test locks scanner output so the refactor is provably
    behavior-preserving.
  - **Parallel routes** — `@slot` folders are collected and rendered into the
    nearest layout as **named props** (server and client), without creating
    standalone routes.
  - **Intercepting routes** — `(.)`, `(..)`, `(..)(..)`, and `(...)` folders are
    parsed (fixing a bug where `(..)` was mis-stripped as a route group) and match
    **only on soft navigation** (via the existing `x-denext-nav` header); a hard load
    falls through to the real route. 8 tests.
- **Error-boundary superpowers** — beyond what React can do:
  - `useErrorBoundary()` returns `{ reset, captureError }` — `captureError(e)` routes
    an error (including async/`setTimeout` failures) to the nearest boundary's
    fallback; `reset()` retries its children.
  - Errors thrown in **event handlers and form actions** are caught and routed to the
    nearest boundary (React silently drops these). A rejected async handler/action is
    routed too.

  6 tests.

### Fixed

- **Client error boundaries no longer swallow control signals.** `redirect()`,
  `notFound()`, `forbidden()`, and `unauthorized()` thrown during client render now
  bubble past `<ErrorBoundary>` (matching the server renderer) instead of rendering
  the error fallback. A `redirect()` from an event handler performs a client
  navigation rather than showing a fallback.

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

[0.5.0]: https://jsr.io/@denext/denext@0.5.0
[0.4.0]: https://jsr.io/@denext/denext@0.4.0
[0.3.0]: https://jsr.io/@denext/denext@0.3.0
[0.2.0]: https://jsr.io/@denext/denext@0.2.0
[0.1.2]: https://jsr.io/@denext/denext@0.1.2
[0.1.1]: https://jsr.io/@denext/denext@0.1.1
[0.1.0]: https://jsr.io/@denext/denext@0.1.0
