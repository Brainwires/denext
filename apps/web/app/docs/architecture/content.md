---
title: Architecture
slug: architecture
lead: How denext differs underneath the React surface — its own reconciler, an async-only SSR renderer, the concurrency model, soft navigation, request-scoped cache, and Pages-Router-as-a-plugin; deliberate design choices, invisible to correct API usage.
---

denext's promise is the **React/Next.js surface**: imports resolve, public APIs
exist, and they behave correctly for correct usage. _Underneath_ that surface,
denext is its own engine — its own fiber reconciler, an async-only SSR renderer,
its own Flight boundary and cache. That is not incidental; it is **where the wins
come from** (~7× smaller output, 0 KB JS on a static route, resumability, live
components — see [MISSION.md](https://github.com/Brainwires/denext/blob/main/MISSION.md)).

These internal differences are **deliberate design choices, invisible to correct
API usage**. They are catalogued here so they aren't mistaken for limitations. A
genuine surface gap — an API that's missing, throws, or behaves observably wrong —
lives in [KNOWN-LIMITATIONS.md](/docs/limitations), and each is cross-linked
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
  does); a component that genuinely awaits throws a guided error. The **Node-stream** APIs
  (`renderToPipeableStream`/`renderToStaticNodeStream`) are a thin adapter over the Web
  renderer and buffer rather than apply `Writable` backpressure — denext targets the Web
  stream. Tracked in [KNOWN-LIMITATIONS.md](/docs/limitations).

## Concurrency: fiber-based, time-sliced, and interruptible

denext renders on a **fiber architecture**. The client reconciler builds the
next tree as resumable units of work over a double-buffered fiber tree and
commits it atomically. This section is precise about what that gives you.

### Two lanes

- **Sync (default) lane** — urgent updates (`setState` outside a transition, the
  initial `render()`/`hydrateRoot()`, `flushSync`, `act`) render **and commit to
  completion synchronously**. Nothing about the timing your code observes has
  changed.
- **Transition lane** — updates inside `startTransition`/`useTransition`, and
  `useDeferredValue`, render on the **concurrent path** below.

### What the transition lane does

1. **Resumable work loop.** Rendering proceeds as discrete units of work over
   the fiber tree (`child`/`sibling`/`return`), so it can pause and resume at
   any node.
2. **Time-slicing.** The loop checks a ~5 ms frame budget between units and
   **yields via `MessageChannel`**, continuing on the next slice — so a heavy
   transition never blocks paint or input. `isPending` paints immediately and
   clears when the transition commits.
3. **Interrupt-and-restart.** A sync update that arrives while a transition is
   in flight **abandons** the transition's in-progress work, commits the urgent
   update immediately, and **restarts** the transition from the
   freshly-committed state (`useId` counters are snapshot/restored so the
   restart is deterministic).
4. **Double-buffering / atomic commit.** The next tree is built **off-DOM**
   (`current` + `workInProgress` buffers); an interrupted or discarded
   transition never shows partial DOM. The work-in-progress tree becomes
   `current` in a single swap at commit.
5. **Render / commit phase split.** `beginWork`/`completeWork` build the tree
   with no live-DOM mutation; a separate commit phase does deletions, prop
   updates, placement, the atomic swap, then effects — so a render can be
   dropped or restarted safely.

`useDeferredValue` trails the urgent render and coalesces rapid changes;
`useOptimistic` applies an optimistic value until the real update lands.

### Effect phases

Effects are split exactly as React splits them:

- **Layout phase (synchronous, before paint):** `useLayoutEffect`,
  `useInsertionEffect`, and class `componentDidMount`/`componentDidUpdate` run
  synchronously during commit, so DOM measurements and style injection see the
  committed tree with no flicker.
- **Passive phase (scheduled, after paint):** `useEffect` and
  `useSyncExternalStore` subscriptions run on a task scheduled after the commit.
  They are flushed before the next render and inside `flushSync`/`act`, so
  ordering is deterministic. (In tests, assert a `useEffect` side effect only
  after a `flushSync()` or `await act(...)` — the same requirement as React.)

### Concurrent rendering

denext implements React's concurrent-rendering model: a resumable fiber
work loop, time-slicing, priority lanes with interrupt-and-restart,
double-buffering with atomic commit, and the render/commit + layout/passive
phase split. The sync (default) lane still renders and commits synchronously, so
`render()`/`hydrateRoot()`/`flushSync()`/`act()` remain synchronous.

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

The **dev server bundles each route independently and lazily** for fast rebuilds,
whereas `denext build` runs a single code-split pass that hoists the client runtime into
one shared chunk. A production page therefore shares exactly one runtime instance across
route entries; the dev server does not guarantee that. The production build is the source
of truth for runtime-singleton behavior, so verify a release against `denext build`
output, not only the dev server.

## `React.cache` is request-scoped during SSR

A `cache()`d function's result is keyed to the current request, so one request's value
is never served to another — request isolation, matching React's own model. Server code
outside a request is not memoized at all (React's "no dispatcher" behavior), so a stale
result can never survive across logical calls; in the browser it's a bounded per-function
memo (React memoizes per render pool there). This is **correctness**, not a reduced
capability.

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
[`@denext/pages-router`](https://github.com/Brainwires/denext/tree/main/packages/pages-router). Same surface; a leaner core that
doesn't carry two routers for the apps that use one. See [the plugin guide](/docs/plugins).

## next-compat build choices

Running unmodified Next.js App Router projects (npm React libraries included) is a
**feature** — every `react`/`react-dom`/`next/*` import is rewritten to denext's one
React at bundle time. A few deliberate build defaults on that path:

- **`skipLibCheck: true`** — `denext migrate` sets it (as Next.js/CRA do), so `deno
  check` validates _your_ `.tsx`, not npm libraries' bundled `.d.ts` against denext's
  React type shim. Residual library type edges are type-only, never runtime.
- **`classComponents`** — on every build path the class runtime is an on-demand chunk
  (see [KNOWN-DIFFERENCES.md](/docs/differences)); the next-compat build additionally
  folds the flag through an esbuild `define`, so `classComponents: false` also strips the
  reconciler's class guards from that bundle. `true` imports the runtime statically.
- **Run `denext build`/`dev` from the project directory** — the client/server boundary
  crawl resolves `@/…` path aliases from the app's `deno.json` on the cwd.

## The surface promise is machine-verified

The claim at the top of this file — imports resolve and the public APIs _exist_ with the
right shape — is not a hope, it is a **gate in the test suite**. A signature-parity tool
(`scripts/parity/`, gate test `tests/react-parity.test.ts`) diffs denext's compat surface
against the real thing and fails on any deviation.

It reads both surfaces and compares them structurally:

- **The real surface** — the latest `react` / `react-dom` / `next` (+ `next-intl`,
  `@types/*`) — is extracted with the **TypeScript compiler API**, because `@types/react`
  ships its API as `export = React` (a namespace `deno doc` won't flatten).
- **denext's surface** — `src/compat/**` — is extracted with **`deno doc`**, which
  resolves denext's import map and `jsr:` deps.
- The diff is **structural, not nominal**: it checks export presence, value-vs-type,
  function arity/optionality, and object/namespace members — and is deliberately
  **tolerant of internal type differences** (denext's `VNode` where React writes
  `ReactElement`, its own `Root`, etc.). That tolerance is the whole point of this
  document: the _surface_ must match; the _internals_ are free to differ.

Determinism comes from a committed baseline (`tests/fixtures/react-surface.baseline.json`)
plus a burn-down **known-gaps ledger** (`react-parity-known-gaps.json`, currently empty —
zero deviations) and a small **waivers** list of intentional, documented non-mirrors
(`unstable_*`/`experimental_*` APIs, the ~1.8k generative `next/font/*` per-font exports,
removed-legacy `react-is` modes). The gate runs **offline** in the normal suite (real
side is the committed baseline; denext side is local `deno doc`); a weekly `parity-drift`
CI job re-installs true-latest npm and reports upstream surface changes without failing
the build.

```sh
deno task parity:refresh   # rewrite the baseline from the latest npm React/Next
deno task parity:gaps      # regenerate the known-gaps ledger after closing/accepting one
deno task parity:drift     # report upstream surface drift (non-blocking)
```

A genuine surface gap the tool accepts (a waiver) is an intentional non-implementation,
catalogued alongside the others in [KNOWN-LIMITATIONS.md](/docs/limitations).

## Islands, resumability, live components

These are **capabilities React/Next don't have**, made possible by owning the
reconciler and Flight boundary: per-component lazy hydration (`client:*` directives),
resumability (interactive with no up-front hydration), and live server components
(server push over WebSocket). They're covered in [FEATURES.md](/docs/features); their
current _bounded scope_ (as still-growing, denext-original features) is the one honest
place they touch [KNOWN-LIMITATIONS.md](/docs/limitations).

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

**See also:** [MISSION.md](https://github.com/Brainwires/denext/blob/main/MISSION.md) (why these choices win) ·
[FEATURES.md](/docs/features) (what's shipped) ·
[KNOWN-LIMITATIONS.md](/docs/limitations) (genuine surface gaps).
