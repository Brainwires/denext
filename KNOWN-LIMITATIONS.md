# denext — Known limitations & behavioral divergences

denext reimplements the React + Next.js surface on Deno with its own tiny
React-equivalent and zero runtime npm dependencies. Compatibility is owed at the
**surface** (imports resolve, public APIs exist and behave correctly so real npm
libraries run); the internals deliberately **diverge where denext can be faster
or leaner** (its own fiber reconciler, an async-only SSR renderer,
function-based `forwardRef`/`memo` brands). This document is the honest
catalogue of where the observable behavior differs from React/Next, and which
surfaces are experimental.

Most divergences below are confined to the **next-compat interop path** (running
real npm React libraries via `buildNextCompatPages`); denext's own apps are
unaffected. See [DEPLOYMENT.md](./DEPLOYMENT.md) for operational
responsibilities and [ROADMAP-1.0.md](./ROADMAP-1.0.md) for what's planned
before 1.0.0.

## React behavioral divergences

- **Async `startTransition` entangles by _window_, not by transition identity.**
  `startTransition(async () => { await x; setState() })` now works: the
  transition stays active across the `await` (post-`await` updates land on the
  transition lane, interruptibly) and `useTransition`'s `isPending` is held
  until the returned promise settles and its flush lands. Because denext cannot
  instrument the user's `await` (no async-context / await hook), the
  entanglement is scoped to a **time window**: while _any_ async transition's
  promise is pending, updates are treated as transition-priority. So an
  unrelated urgent update that happens during that window is also deferred to
  the transition flush (React scopes to the specific transition). The window is
  brief (it closes when the promise settles), and `useActionState` tracks its
  own pending state independent of this path. If the promise _never_ settles (a
  bug in the async callback), the window never closes — `isPending` stays true
  and updates stay entangled indefinitely. In **development** (`__denextDev`) a
  watchdog `console.warn`s when an async transition has been pending for over
  ~10s to surface this; it never force-settles (that would mask the real
  never-resolving `await` in production).
- **Offscreen hides via the `hidden` attribute, not inline `display:none`.** On
  an urgent (non-transition) re-suspend of an already-revealed boundary, denext
  keeps the primary subtree mounted-but-hidden and reveals the same instances on
  resolve (state preserved), matching React's Offscreen. It hides the subtree
  with the `hidden` attribute (`display:none` via the UA stylesheet) rather than
  React's inline `display:none`; CSS that overrides `[hidden]` could defeat it
  (an anti-pattern).
- **`SuspenseList tail="hidden"` behaves like `"collapsed"`.**
- **`preload`/`preinit`/`preconnect`/`prefetchDNS` are client-only no-ops during
  SSR** — no `<link rel=preload>` resource hints are emitted into the server
  HTML.
- **`cloneElement` merges all props uniformly** (it does not special-case
  `key`/`ref` the way React does); **`isValidElement` is a structural
  (`type`+`props`) check** that can accept a non-element with that shape.
- **`unstable_batchedUpdates(fn)` just calls `fn`.** denext already batches
  updates, so this is a no-op wrapper; a library relying on it to _force_ a
  flush boundary gets different timing.

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

denext implements these experimental or `unstable_`-prefixed surfaces for
compatibility. They track experimental React/Next APIs and **may change or be
removed** as those stabilize — treat them as unstable:

- `useEffectEvent` (experimental React hook)
- `useMemoCache` / `c` (React Compiler runtime)
- `unstable_cache` (Next data cache)
- `unstable_batchedUpdates` (see the no-op note above)
- `unstable_setRequestLocale` (next-intl)

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

- **Buffered resume, not streamed.** Holes are rendered and spliced into the
  cached shell **server-side** each request (a complete buffered document, so
  the existing hash-based CSP applies unchanged). The win is that the shell —
  including `use cache` islands — renders once and is cached; only the dynamic
  holes run per request. True hole **streaming** (progressive flush) is a later
  enhancement.
- **PPR engages only for already-cacheable pages** (those opted in via
  `revalidate`/`force-static`). It lifts the all-or-nothing rule where **any**
  dynamic read disqualified the whole page from caching: now the shell caches
  and the dynamic parts become holes. A page with no caching opt-in still
  renders fully per request.
- **`useId` across a shell/hole boundary** uses separate id spaces (the shell
  prerender and the per-request hole resume each count from zero), so a
  `useId()` that must match between the static shell and a dynamic hole may not
  align. Keep `useId` usage within one side of a boundary.
- **Flight / client-island routes fall through** to the normal render (PPR is
  not applied); they can still use `use cache` at the data layer.
- **Per-page metadata is assumed static** (`generateMetadata` runs in the normal
  request context; a shell's `<head>` is cached, so per-request metadata is not
  reflected in the cached shell).

## Class components are opt-in (next-compat build)

In the **next-compat build**, class components are gated behind
`classComponents: true` (so a function-only project pays nothing for the class
runtime). With the flag off, a class-based library bundles fine but throws a
guided error at first render. The default `denext build`/`dev` path always
compiles the class runtime in, so this only affects next-compat bundling.
