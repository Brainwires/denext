# denext — Known differences

Where denext **deliberately** behaves differently from React or Next.js. Each entry
is an observable behavior, documented so a port knows what to expect — not a gap
waiting to be closed. A surface that is missing, throwing, or wrong is a
_limitation_ and lives in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); an
internal design choice with no observable difference lives in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## React rendering semantics

- **Every function component is implicitly `memo()`-wrapped.** denext's reconciler
  skips re-rendering a component whose props (shallow), context and own state are
  unchanged — the default React only applies under `memo`. Pure components are
  unaffected; a component that reads module-level mutable data, `Date.now()`, or a
  mutated object without a prop/state change will render stale until something it
  depends on changes. Put such inputs in state, a ref read inside an effect, or a
  context. Test suites ported from React that count renders will see fewer renders.
  Deliberate (it is a large part of why denext's runtime is small and fast), not a
  bug — so it is listed here rather than fixed.
- **Errors thrown in DOM event handlers are routed to the nearest error boundary.**
  React lets them reach `window.onerror` and keeps the UI up; denext catches them
  (`onCaughtError` sees them) and shows the boundary's fallback, so one bad click
  swaps out that boundary's subtree. Deliberate — a boundary that never sees the
  most common runtime error in an app is a weak boundary — but it is a behavioral
  difference; wrap the handler body in `try/catch` when you want React's behavior.
- **`useDeferredValue` under `act()` / `flushSync`** — the test renderer's
  synchronous flush collapses the deferred pass, so a test sees the final value at
  once rather than the stale one first. Real event-path rendering defers as React
  does.

## Non-goals

- **Legacy provider context** (`childContextTypes` / `getChildContext`) is an
  **intentional non-goal** — React deprecated this pre-`createContext` API, so
  denext won't chase it. Modern class context (`static contextType`) reaches
  parity; migrate providers to `createContext`.

## Next.js routing and config

- **Config `rewrites` have one phase.** Next distinguishes `beforeFiles` /
  `afterFiles` / `fallback` rewrites; denext runs its single `rewrites` list after
  middleware and before the filesystem (Next's `beforeFiles` position). Middleware
  matchers therefore always see the URL the client asked for.
- **`nodeResolve` is on by default** for the compat (npm React) build — every bare
  npm specifier resolves from the installed `node_modules` through denext's tolerant
  resolver, which is what lets an unmodified pnpm/npm/yarn app build with no
  `package.json` rewrite. Next has no such layer. Set `nodeResolve: false` for
  Deno's strict `npm:` loader.
- **Server-action ids are opaque hashes** of `module#export` (Next's are hashes too,
  but of a build-specific manifest); ids are stable across processes and replicas
  without a build salt.
- **`userAgent().device.type`** is `undefined` for a desktop browser (matching
  ua-parser-js); the older denext value was `"desktop"`.
