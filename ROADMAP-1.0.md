# denext — Road to 1.0.0

denext is at **0.12.0**, intended to be the **last 0.x minor**: the next release
after 0.12.0 is **1.0.0**, with only patches in between. 0.12.0 landed the
release-readiness batch (npm-interop crash-class fixes, the small remaining
Next-16 features, security/ops hardening, test-gate tightening, and DevTools
honesty). This document tracks the larger, behavior-changing work deliberately
**deferred to 1.0.0** so 0.12.0 could stabilize.

Each item is a genuine reconciler/scheduler feature or a larger subsystem — not a
boundary shim — and is called out as a divergence in
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

## Reconciler / scheduler

- **Async `startTransition` / `useTransition`.** Detect a thenable return, keep the
  transition active across the `await` (an async transition context so post-`await`
  updates still tag `TransitionLane`), and hold `isPending` until the promise
  settles and its flush lands. Interacts with the existing abandon/restart-on-
  interrupt logic. (Today: synchronous; the `useActionState` form path is unaffected.)
- **`useInsertionEffect` fires pre-mutation.** Give it its own commit sub-phase that
  runs before DOM mutation (CSS-in-JS correctness), instead of sharing
  `useLayoutEffect`'s post-mutation timing.
- **Suspense re-suspend — Offscreen for the urgent path (remaining half).**
  ✅ _Done in 0.12.0:_ a `startTransition` / `useDeferredValue` update that
  re-suspends an already-revealed boundary now keeps the current content (no
  fallback flash) and preserves its state — React's recommended pattern. **Still
  to do:** even on an **urgent** (non-transition) re-suspend that _does_ show the
  fallback, keep the old subtree mounted-but-hidden (`display:none`) and reveal
  the same instances on resolve, instead of remounting (React's Offscreen). This
  is the one case that still loses local state.
- **True React `forwardRef`/`memo` element-object shape** (`{ $$typeof, type }`).
  Only if a concrete library need justifies it — it requires the reconciler to
  resolve element types through `.type`/`.render` rather than calling the value,
  which touches every internal call-site. The current enumerable-brand function
  form already satisfies `react-is` and field-reading libraries, so this is
  low-priority and explicitly weighed against denext's reconciler performance.

## Architecture

- **RSC/Flight-payload client navigation.** Replace the full-HTML re-fetch on soft
  navigation with an RSC/Flight payload, and make `useLinkStatus` per-`<Link>`
  scoped as a consequence.
- **Built-in optional concurrency / CPU ceiling.** An opt-in in-process limit so a
  single instance can self-protect, complementing (not replacing) the required edge
  ceiling documented in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Developer experience

- **Fast Refresh (state-preserving HMR).** Replace the dev server's full-page
  reload with a module-scoped, hook-state-preserving refresh (denext's own leaner
  mechanism, not a wholesale react-refresh port), falling back to a full reload when
  a change can't be applied safely. The stubbed refresh hooks
  (`findHostInstancesForRefresh`/`scheduleRefresh`/`setRefreshHandler`) are the
  attachment points.
- **DevTools depth.** Hooks/state inspection, editing/override hooks, context
  inspection, the Profiler tab, and source links/owner stacks (a `react-jsxdev`
  compile path). These need React's internal re-render inspection machinery denext
  doesn't currently expose. See the DevTools section of KNOWN-LIMITATIONS.
- **Dev error overlay + source maps.**

## Test infrastructure

- **Un-dormant the SQLite cache suite in CI.** `tests/sqlite-cache.test.ts`
  self-skips because its backend package (`rsqlite-wasm`) is not yet published to a
  resolvable registry. Once it is (npm or JSR), map it and move the suite onto the
  blocking path.
- **Coverage gating.** A `test:coverage` task exists (report-only); consider gating
  on a coverage floor once a baseline is established.
- **Move the real-npm next-compat e2e suite onto blocking CI** (currently nightly,
  needs npm install). The fast react-only build guard now runs on every PR.

## Won't do

- **Pages Router**, `getServerSideProps` / `getStaticProps` — App Router only.
