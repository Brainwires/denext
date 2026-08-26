# denext — Architecture (how it differs underneath the surface)

denext's promise is the **React/Next.js surface**: imports resolve, public APIs
exist, and they behave correctly for correct usage. _Underneath_ that surface,
denext is its own engine — its own fiber reconciler, an async-only SSR renderer,
its own Flight boundary and cache. That is not incidental; it is **where the wins
come from** (8–9× smaller output, 0 KB JS on a static route, resumability, live
components — see [MISSION.md](./MISSION.md)).

These internal differences are **deliberate design choices, invisible to correct
API usage**. They are catalogued here so they aren't mistaken for limitations. A
genuine surface gap — an API that's missing, throws, or behaves observably wrong —
lives in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md), and each is cross-linked
below where one exists.

## Its own reconciler + an async-only SSR renderer

denext ships a small React-compatible core instead of React itself, and its server
renderer is **async-first** (streaming-native, no legacy synchronous path). You use
the same surface — components, hooks, `Suspense`, `renderToReadableStream` — and get
smaller bundles and first-class streaming.

- _Surface intact:_ the async render APIs (`renderToReadableStream`) and every hook
  behave as documented.
- _One surface consequence:_ `renderToString`/`renderToStaticMarkup` render the
  **synchronously-renderable** subset over the same walker (Suspense → fallback, as React
  does); a component that genuinely awaits throws a guided error. Only the **Node-stream**
  APIs (`renderToPipeableStream`/`renderToStaticNodeStream`) can't exist here — denext
  targets the Web stream. Tracked in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

## Soft navigation: two mechanisms, one correct behavior

A soft (SPA) navigation always lands you on the right page. _How_ it rebuilds depends
on the route:

- **Flight routes** (`"use client"`/`"use server"` boundary) transfer a JSON Flight
  payload and reconcile a **retained root from a registry** — the fast path, no module
  re-evaluation.
- **Isomorphic routes** answer with a compact JSON payload (`{title, data, entry,
  styles}`) and re-inject the entry, re-evaluating the route module.

Navigation is correct either way; the Flight path is simply faster. Give a route a
client/server boundary to opt it onto the registry path. This is a performance gradient,
not a limitation.

## `React.cache` is request-scoped during SSR

A `cache()`d function's result is keyed to the current request, so one request's value
is never served to another — request isolation, matching React's own model. Off-request
(or on the client) it's a persistent per-function memo. This is **correctness**, not a
reduced capability.

## Automatic batching (so `unstable_batchedUpdates` is a no-op)

denext batches updates automatically (the React 18+ model). `unstable_batchedUpdates(fn)`
therefore just calls `fn` — its job is already done. The wrapper exists only for import
compatibility.

## `fetch()` is uncached by default

Matches the Next 15 **and** 16 default (both flipped `fetch` and GET Route Handlers to
uncached-by-default). Opt in per call with `next: { revalidate, tags }` /
`cache: "force-cache"`. This is parity with current Next, not a denext-specific choice.

## Pages Router is a first-party plugin, not core

denext's built-in router is the **App Router**. The **full** Next.js Pages Router —
`getServerSideProps`/`getStaticProps`/`getStaticPaths`/`getInitialProps`,
`_app`/`_document`, `pages/api/*`, and `useRouter` with events, shallow routing,
`<Link>` prefetch, and i18n locale routing — ships as opt-in
[`@denext/pages-router`](./packages/pages-router). Same surface; a leaner core that
doesn't carry two routers for the apps that use one. See [PLUGINS.md](./PLUGINS.md).

## next-compat build choices

Running unmodified Next.js App Router projects (npm React libraries included) is a
**feature** — every `react`/`react-dom`/`next/*` import is rewritten to denext's one
React at bundle time. A few deliberate build defaults on that path:

- **`skipLibCheck: true`** — `denext migrate` sets it (as Next.js/CRA do), so `deno
  check` validates _your_ `.tsx`, not npm libraries' bundled `.d.ts` against denext's
  React type shim. Residual library type edges are type-only, never runtime.
- **Class-runtime dead-code-elimination** — class components are gated behind a
  compile-time `classComponents` flag in the next-compat build, so a function-only
  project ships **zero** bytes of the class runtime. Turn it on and classes work; the
  standard `deno bundle` path always includes the (small) runtime.
- **Run `denext build`/`dev` from the project directory** — the client/server boundary
  crawl resolves `@/…` path aliases from the app's `deno.json` on the cwd.

## Islands, resumability, live components

These are **capabilities React/Next don't have**, made possible by owning the
reconciler and Flight boundary: per-component lazy hydration (`client:*` directives),
resumability (interactive with no up-front hydration), and live server components
(server push over WebSocket). They're covered in [FEATURES.md](./FEATURES.md); their
current _bounded scope_ (as still-growing, denext-original features) is the one honest
place they touch [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

### qrl handler extraction: captures are supplied live at hydration

In a `resumable` route the build transform (`src/build/qrl-transform.ts`) auto-wraps an
inline event handler as `qrl(() => import("<segment>"), id, [captures])`: the handler's
code moves to a code-split segment, and the values it closes over (component-local
signals/stores/props) are passed positionally and read back with `capturedScope()`.

The `qrl(...)` call runs during the owning component's render/hydration, so `captures`
are the component's **live** objects — a captured signal is the real reactive box, and a
write re-renders the owner exactly as an in-place handler would. A click on an
as-yet-unhydrated island hydrates it first (its handlers auto-pick the `interaction`
strategy) and then runs the handler. This mirrors the Server-Actions rule — a boundary
carries a stable id, behavior attaches lazily — and is a **design choice, not a gap**:
the handler is extracted only when the extraction is provably sound (no reference to a
module-scope non-import binding, no JSX/`this`/`arguments` in the handler); anything else
is left exactly as written and keeps working on the resume-by-hydrate path.

### AsyncContext across `await`: a build transform, because runtime can't

A native `await` exposes no runtime hook — it never calls a patched
`Promise.prototype.then`, so no Zone.js-style monkeypatch can carry context across it.
Scoping an async `startTransition` by transition identity therefore needs either the
engine's own `AsyncContext` (unshipped) or a build transform. denext ships the latter,
opt-in via `experimental.asyncContext`: `src/build/async-context-transform.ts` brackets
each `await`/`for await` (`const $ = __asyncScope(); try { … await __asyncAwait($, X) … }
finally { __asyncScopeEnd($); }`) so the frame's context is restored on resume **and** the
ambient context is restored on completion — no trailing leak, so an urgent update after a
transition settles is never mis-scoped. The runtime primitive (`src/runtime/async-context.ts`)
is a first-party `AsyncContext` (`Variable` + `Snapshot`); the reconciler reads a build-swapped
mode `const` to choose identity scoping vs the default window. Like the qrl/auto-memo passes it
touches only the **client** bundle (the server runs the original source, and the helpers are
pure context bookkeeping), so SSR/hydration stay aligned.

---

**See also:** [MISSION.md](./MISSION.md) (why these choices win) ·
[FEATURES.md](./FEATURES.md) (what's shipped) ·
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) (genuine surface gaps).
