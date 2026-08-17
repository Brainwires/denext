# denext — Known limitations & behavioral divergences

denext reimplements the React + Next.js surface on Deno with its own tiny
React-equivalent and zero runtime npm dependencies. Compatibility is owed at the
**surface** (imports resolve, public APIs exist and behave correctly so real npm
libraries run); the internals deliberately **diverge where denext can be faster
or leaner** (its own fiber reconciler, an async-only SSR renderer). This document
is the honest catalogue of where the observable behavior differs from React/Next,
and which surfaces are experimental.

Most divergences below are confined to the **next-compat interop path** (running
real npm React libraries via `buildNextCompatPages`); denext's own apps are
unaffected. See [DEPLOYMENT.md](./DEPLOYMENT.md) for operational
responsibilities.

## React behavioral divergences

- **Async `startTransition` entangles by a time _window_, not by transition
  identity — a browser runtime constraint, not an unfinished feature.**
  `startTransition(async () => { await x; setState() })` works: the transition
  stays active across the `await` (post-`await` updates land on the transition
  lane, interruptibly) and `useTransition`'s `isPending` is held until the
  returned promise settles and its flush lands. React scopes entanglement to the
  specific transition's updates using an async-context primitive; **the reconciler
  runs in the browser, where no such primitive exists** (`AsyncLocalStorage` is
  server-only, and TC39 `AsyncContext` is not yet shipped in browsers), so denext
  scopes to a **time window** instead: while _any_ async transition's promise is
  pending, updates are treated as transition-priority. An unrelated urgent update
  during that window is therefore also deferred to the transition flush. The
  window is brief (it closes when the promise settles), and `useActionState`
  tracks its own pending state independent of this path. If the promise _never_
  settles (a bug in the async callback), the window never closes — `isPending`
  stays true. In **development** (`__denextDev`) a watchdog `console.warn`s when
  an async transition has been pending for over ~10s to surface this; it never
  force-settles (that would mask the real never-resolving `await` in production).
- **`unstable_batchedUpdates(fn)` just calls `fn`.** denext already batches
  updates (as does React 18+ automatic batching, which made this a legacy API),
  so this is a no-op wrapper provided for import compatibility; a library relying
  on it to _force_ a flush boundary gets different timing.

## Next.js divergences

- **No Pages Router**, no `getServerSideProps` / `getStaticProps` (App Router
  only).
- **Client navigation between isomorphic routes re-fetches full HTML.** A soft
  navigation to a **Flight** route transfers only the JSON Flight payload (the
  client rebuilds the tree through the app-wide client registry and reconciles
  in place); an isomorphic (non-Flight) route still re-fetches the full HTML
  document and re-runs its route bundle. This also means an isomorphic route's
  already-loaded module is retained across the nav rather than swapped.
  **Recommended path:** give routes where soft-nav cost or module retention
  matters a client/server boundary (`"use client"`/`"use server"`) so they
  qualify as Flight routes.
- **Legacy provider context** (`getChildContext` / `childContextTypes`) is
  unsupported on SSR; only `contextType` reaches parity (across all SSR
  renderers).
- **Strict default CSP** blocks external `<script src>` / stylesheets /
  `<img src>` until opted in per route — third-party widget/script-injecting
  libraries can be blocked by default until you set a per-route `csp`. CSP is
  applied to **buffered** page responses only, not streaming/Flight responses
  (set those at the edge — see [DEPLOYMENT.md](./DEPLOYMENT.md)).
- **`fetch()` is uncached by default** — matches the Next.js 15 **and** 16
  default (both flipped `fetch` and GET Route Handlers to uncached-by-default);
  stricter only versus Next ≤ 14. Opt in per call with
  `next: { revalidate, tags }` / `cache: "force-cache"` (Next's "previous
  model"). Next 16's `use cache` directive + Cache Components / PPR are
  implemented behind the experimental `cacheComponents` flag — see the **Cache
  Components** section below.
- **ICU message formatting is a compact subset**, not full `intl-messageformat`.
  Interpolation, `number`/`date`/`time`, `plural`/`selectordinal`/`select` (with
  `offset:`/`#`), nested submessages, and **apostrophe escaping** (`''`, quoted
  `'{'`/`'}'`/`'#'`) are supported; `spellout`/`duration` and full number/date
  skeletons are not.

## Next.js drop-in (next-compat pipeline)

An unmodified Next.js **App Router** project can build and run on denext:
`denext migrate` writes a `deno.json` from the app's `package.json`; then
`denext build && denext start` (and `denext dev`) render it. When the project
uses npm React libraries (next-themes, Radix, recharts, …), denext auto-detects
next-compat mode (or set `nextCompat` in `denext.config`) and rewrites every
`react`/`react-dom`/`next/*` import — **including those inside npm packages** — to
denext at bundle time, so the whole app runs on denext's **one** React (no dual
React). The full `next/*` surface is aliased (link, navigation, image, og,
headers, cache, server, font, …).

The **RSC/Flight boundary is preserved** in compat mode: a compat route that
reaches a `"use client"` island renders its Server Components **server-side only**
and hydrates **just the islands** through a react→denext-rewritten flight bundle.
So an `async` data-fetching Server Component (`await db.query()`) works in a
compat route — its code stays on the server and never enters any client bundle;
only the `"use client"` islands (react→denext rewritten, keyed by the same stable
client ids the server tags) ship to the browser. Identity holds because each
island is bundled as its own build entry (a shared runtime chunk), so the page
bundle and the SSR-tagged island resolve to one instance. A compat route with
interactivity but no explicit `"use client"` boundary falls back to full-tree
hydration.

Current boundaries of the drop-in path:

- **`deno check` on a compat app** still reports cross-library type conflicts:
  npm React libs ship their own `@types/react`, structurally distinct from
  denext's own React types, so type-checking (not runtime) surfaces
  `ReactNode`/JSX-component mismatches. Runtime rendering is unaffected.
- **The boundary crawl resolves `@/…` path aliases from the app's `deno.json`**,
  so run `denext build`/`dev` from the **project directory** (its config on the
  cwd) — otherwise island detection can miss `@/`-imported `"use client"` modules
  and treat an interactive route as static.
- **Pages Router is unsupported** (see above) — App Router only.

## Fast Refresh (dev) preserves state for a scoped set of components

`denext dev` does state-preserving Fast Refresh: editing a `.tsx`/`.jsx` module
re-imports the route entry and reconciles in place (via a stable
component-family id) instead of a full reload, keeping `useState`/`useReducer`
state. Scope and fallbacks (it never risks corrupt state — it reloads when
unsure):

- **State is preserved for the route-structural components** the client entry
  registers — the page, its layouts and templates, and (for Flight routes) the
  `"use client"` islands. Components imported transitively and not enumerated by
  the entry remount on refresh (their local state resets); the surrounding
  registered components keep theirs.
- **Editing a component's hook shape** (adding/removing/reordering hooks) is
  detected as an unsafe reconcile and triggers a **full reload** rather than
  reusing mismatched hook cells. (A same-count reorder is not caught — a rare
  edge; hard-reload if state looks stale.)
- **`.css`, `public/` assets, config, middleware, and `.ts` server modules** do
  a **full reload** (not a refresh), since a client re-import can't reflect
  them. A **server component** edit likewise needs a reload to re-render on the
  server.
- Any hydration/render error during a refresh falls back to a full reload.

The refresh runtime is dev-only and DCE'd from production builds (its entries
carry none of it), so `denext build` output is byte-for-byte unaffected.

## React DevTools support (partial, not 100%)

denext registers with the React DevTools extension and reports each commit as a
React-fiber-shaped tree. What works and what doesn't:

- **Works:** the **Components tree** (correct component names, nesting, host
  elements) and **read-only props** in the inspector; element selection; a build
  type reported honestly (development vs production).
- **Does not work (post-1.0):** **hooks/state inspection** (React's DevTools
  reconstructs hooks by re-rendering the component with a special dispatcher
  through the renderer's internals, which denext's reconciler doesn't expose —
  version-sensitive backend work deferred past 1.0), **editing props/state /
  override hooks**, **context inspection**, the **Profiler tab**, and **source
  links / owner stacks** (needs a `react-jsxdev` compile path). Suspense/Portal/
  Class fibers are reported as function components.

`denext dev` provides a **standalone dev error overlay** (independent of the
extension): runtime errors, unhandled rejections, and server-pushed build/bundle
errors surface as a full-screen overlay, dismissed on the next successful edit.

If you need full hooks/Profiler inspection today, that remains a React-on-Node
capability; denext's tree/props view covers the common "what is rendering and
with what props" case.

## Experimental / unstable APIs (may change upstream)

denext implements these still-`unstable_`-prefixed (or intentionally internal)
surfaces for compatibility. They track APIs upstream still treats as unstable, so
they **may change or be removed** as those stabilize:

- `unstable_cache` (Next data cache) — still `unstable_` in Next 16; `use cache`
  (see below) is its successor, but `unstable_cache` remains valid.
- `unstable_batchedUpdates` (see the no-op note above) — legacy since React 18's
  automatic batching; retained for import compatibility.
- `useMemoCache` / `c` (React Compiler runtime) — an **internal** runtime helper
  the compiler emits, not a user-called API. The React Compiler reached **1.0
  (stable)** in Oct 2025, so the contract is stable; it is listed here only
  because it is internal, not because it is expected to break.

Now stable upstream and no longer treated as unstable by denext (kept here as a
migration note): **`useEffectEvent`** stabilized in **React 19.2** — denext exports
it as a stable hook. **`setRequestLocale`** (next-intl) stabilized in **v3.22**;
denext exports the stable name, with `unstable_setRequestLocale` retained as a
deprecated alias.

Not implemented (by design, for now): React `taint*` APIs, `Activity`,
`ViewTransition`; Next `dynamicIO` and `taint`. (Cache Components / PPR **are**
implemented behind `experimental.cacheComponents` — see below.)

## Cache Components (`use cache` + PPR) — experimental

Enabled with `experimental: { cacheComponents: true }` in `denext.config`. The
`use cache` directive (module-top or function-body) compiles into cross-request
server caching, and a cacheable page renders a request-independent **static
shell** (cached once) with dynamic subtrees (`cookies()`/`headers()` behind a
Suspense boundary) as **per-request holes**.
`cacheLife`/`cacheTag`/`revalidateTag`/ `updateTag`/`refresh` are all available.
When the flag is **off**, `use cache` is an inert string and the render path is
byte-for-byte unchanged.

First-landing scope — deliberate limitations:

- **Streamed holes.** The cached shell (its `<head>` rebuilt per request) is
  flushed immediately with each hole showing its fallback; each hole's real
  content then streams in as a `<template>` + a `__dnxSwap` script, and the
  hydration scripts + client entry are emitted **last** so the client hydrates the
  completed document. Because the body is streamed there is no per-response
  content-hash CSP — a streamed PPR response relies on an **edge/proxy CSP** (see
  DEPLOYMENT.md); it is already `private, no-store`. The shell — including
  `use cache` islands — still renders once and is cached; only the dynamic holes
  run per request.
- **PPR engages only for already-cacheable pages** (those opted in via
  `revalidate`/`force-static`). It lifts the all-or-nothing rule where **any**
  dynamic read disqualified the whole page from caching: now the shell caches
  and the dynamic parts become holes. A page with no caching opt-in still
  renders fully per request.
- **Flight / client-island routes fall through** to the normal render (PPR is
  not applied); they can still use `use cache` at the data layer.

## Class components are opt-in (next-compat build)

In the **next-compat build**, class components are gated behind
`classComponents: true` (so a function-only project pays nothing for the class
runtime). With the flag off, a class-based library bundles fine but throws a
guided error at first render. The default `denext build`/`dev` path always
compiles the class runtime in, so this only affects next-compat bundling.
