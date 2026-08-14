# denext — Known limitations & behavioral divergences

denext reimplements the React + Next.js surface on Deno with its own tiny
React-equivalent and zero runtime npm dependencies. Compatibility is owed at the
**surface** (imports resolve, public APIs exist and behave correctly so real npm
libraries run); the internals deliberately **diverge where denext can be faster
or leaner** (its own fiber reconciler, an async-only SSR renderer, function-based
`forwardRef`/`memo` brands). This document is the honest catalogue of where the
observable behavior differs from React/Next, and which surfaces are experimental.

Most divergences below are confined to the **next-compat interop path** (running
real npm React libraries via `buildNextCompatPages`); denext's own apps are
unaffected. See [DEPLOYMENT.md](./DEPLOYMENT.md) for operational responsibilities
and [ROADMAP-1.0.md](./ROADMAP-1.0.md) for what's planned before 1.0.0.

## React behavioral divergences

- **`useInsertionEffect` fires at commit, not before DOM mutation.** denext's
  dispatcher treats it like `useLayoutEffect` (runs in the commit phase, after
  mutation). CSS-in-JS libraries that rely on style insertion happening _before_
  layout reads can see a flash/measurement difference. (Deferred: fire pre-mutation.)
- **`startTransition` / `useTransition` don't await async callbacks.** The
  transition scheduler is synchronous: a thenable returned from
  `startTransition(async () => …)` is not awaited, so updates after an `await`
  land as a normal (sync) update and `isPending` clears at the synchronous flush.
  The common form path (`useActionState`) tracks its own pending state and works
  regardless; only ad-hoc async `startTransition` is affected.
- **`forwardRef` / `memo` are branded _functions_, not React's object shape.**
  They are callable functions carrying enumerable `$$typeof` + `render`/`type`/
  `compare` brands (so `react-is` and libraries reading those fields work), rather
  than React's non-callable `{ $$typeof, type }` element objects. This is a
  deliberate, faster divergence — denext's reconciler calls the value directly
  instead of resolving through a `.type`/`.render` indirection. Libraries that
  assert the _exact_ React object shape (rare) will see a function.
- **Suspense re-suspend remounts and loses local state.** When a boundary
  re-suspends, denext remounts the subtree on resolve; React keeps it
  mounted-but-hidden and preserves state.
- **`SuspenseList tail="hidden"` behaves like `"collapsed"`.**
- **`preload`/`preinit`/`preconnect`/`prefetchDNS` are client-only no-ops during
  SSR** — no `<link rel=preload>` resource hints are emitted into the server HTML.
- **`cloneElement` merges all props uniformly** (it does not special-case
  `key`/`ref` the way React does); **`isValidElement` is a structural
  (`type`+`props`) check** that can accept a non-element with that shape.
- **`unstable_batchedUpdates(fn)` just calls `fn`.** denext already batches
  updates, so this is a no-op wrapper; a library relying on it to _force_ a flush
  boundary gets different timing.

## Next.js divergences

- **No Pages Router**, no `getServerSideProps` / `getStaticProps` (App Router only).
- **Client navigation re-fetches full HTML**, not an RSC/Flight-only payload.
- **Legacy provider context** (`getChildContext` / `childContextTypes`) is
  unsupported on SSR; only `contextType` reaches parity (across all SSR renderers).
- **Strict default CSP** blocks external `<script src>` / stylesheets / `<img src>`
  until opted in per route — third-party widget/script-injecting libraries can be
  blocked by default until you set a per-route `csp`. CSP is applied to **buffered**
  page responses only, not streaming/Flight responses (set those at the edge — see
  [DEPLOYMENT.md](./DEPLOYMENT.md)).
- **`fetch()` is uncached by default** (stricter than Next's default caching).
- **ICU message formatting is a compact subset**, not full `intl-messageformat`.
- **`useLinkStatus` is global, not per-`<Link>` scoped.** denext's soft navigation
  is a single global operation, so `useLinkStatus().pending` reflects whether _any_
  navigation is in flight rather than one enclosing link's.

## React DevTools support (partial, not 100%)

denext registers with the React DevTools extension and reports each commit as a
React-fiber-shaped tree. What works and what doesn't:

- **Works:** the **Components tree** (correct component names, nesting, host
  elements) and **read-only props** in the inspector; element selection; a build
  type reported honestly (development vs production).
- **Does not work (deferred to 1.0.0):** **hooks/state inspection** (React's
  DevTools reconstructs hooks by re-rendering the component with a special
  dispatcher through the renderer's internals, which denext's reconciler doesn't
  expose), **editing props/state / override hooks**, **context inspection**, the
  **Profiler tab**, and **source links / owner stacks** (needs a `react-jsxdev`
  compile path). Suspense/Portal/Class fibers are reported as function components.

If you need full hooks/Profiler inspection today, that remains a React-on-Node
capability; denext's tree/props view covers the common "what is rendering and with
what props" case.

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
`ViewTransition`; Next `dynamicIO`, PPR (Partial Prerendering), and `taint`.

## Class components are opt-in (next-compat build)

In the **next-compat build**, class components are gated behind
`classComponents: true` (so a function-only project pays nothing for the class
runtime). With the flag off, a class-based library bundles fine but throws a
guided error at first render. The default `denext build`/`dev` path always
compiles the class runtime in, so this only affects next-compat bundling.
