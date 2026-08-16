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

> **Status (development branch, post-0.12.0):** most of the slate below has since
> **landed** on the 1.0 development branch — marked **✅ Landed** per item. The
> version is deliberately still **held at 0.12.0** (no tag/publish yet), so these
> ship when 1.0.0 is cut. What genuinely remains: DevTools depth, dev source maps,
> a few test-infra chores, and stabilizing the newly-landed **Cache Components**.

## Reconciler / scheduler

- **Async `startTransition` / `useTransition`.** ✅ **Landed** — detects a thenable
  return, keeps the transition active across the `await` (post-`await` updates still
  tag `TransitionLane`), and holds `isPending` until the promise settles and its
  flush lands. Interacts with the existing abandon/restart-on-interrupt logic;
  entanglement is scoped to a time window (see KNOWN-LIMITATIONS). The
  `useActionState` form path is unaffected. — `src/client/fiber/reconciler.ts`.
- **`useInsertionEffect` fires pre-mutation.** ✅ **Landed** — it has its own commit
  sub-phase that runs before DOM mutation (CSS-in-JS correctness), instead of sharing
  `useLayoutEffect`'s post-mutation timing. — `src/client/fiber/fiber.ts`.
- **Suspense re-suspend — Offscreen for the urgent path.** ✅ **Landed** — a
  `startTransition` / `useDeferredValue` update that re-suspends an already-revealed
  boundary keeps the current content (no fallback flash) and preserves its state; and
  on an **urgent** (non-transition) re-suspend, the old subtree is kept
  mounted-but-hidden and the same instances are revealed on resolve, instead of
  remounting (React's Offscreen). denext hides via the `hidden` attribute rather than
  inline `display:none` — see KNOWN-LIMITATIONS. — `src/client/fiber/fiber.ts`.
- **True React `forwardRef`/`memo` element-object shape** (`{ $$typeof, type }`).
  ✅ **Landed** — the reconciler resolves element types through `.type`/`.render`
  rather than calling the value, matching React's non-callable element-object shape
  (beyond the earlier enumerable-brand function form). — `src/client/fiber/`,
  `src/runtime/react-brands.ts`.

## Architecture

- **RSC/Flight-payload client navigation.** ✅ **Landed** — a soft navigation to a
  Flight route transfers the RSC/Flight payload instead of re-fetching full HTML, and
  `useLinkStatus` is per-`<Link>` scoped as a consequence. (Isomorphic/non-Flight
  routes still re-fetch HTML — see KNOWN-LIMITATIONS.) — `src/client/`, `src/server/`.
- **Built-in optional concurrency / CPU ceiling.** ✅ **Landed** — an opt-in
  in-process limit (`maxConcurrency`) so a single instance can self-protect,
  complementing (not replacing) the required edge ceiling documented in
  [DEPLOYMENT.md](./DEPLOYMENT.md). — `src/server/app.ts`.

## Cache Components (`use cache` + PPR) — stabilization

✅ **Landed (experimental, `experimental.cacheComponents`)** — the `use cache`
directive (module + function-body, via a build-time swc transform), `cacheLife` /
`cacheTag` / `revalidateTag(tag, profile)` / `updateTag` / `refresh`, and Partial
Prerendering (a cacheable page renders a request-independent static shell with
per-request dynamic holes). Off by default; render path unchanged when off. See
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

**Remaining for 1.0 (the documented first-landing caveats):**

- **Streamed hole resume.** Today holes are spliced into the cached shell
  server-side (buffered); stream them progressively for a faster TTFB.
- **`useId` across a shell/hole boundary.** The prerender and per-request resume
  count from separate id spaces; unify them so `useId` matches across the boundary.
- **PPR + Flight/client-island routes.** Flight routes currently fall through to the
  normal render; extend PPR to them.
- **Per-request metadata on a PPR page** (today the cached shell's `<head>` is static).

## next/image (Next 16 alignment)

✅ **Landed** — `qualities`, `minimumCacheTTL`, `localPatterns`, `formats` (incl.
**AVIF** via `@jsquash/avif`), `maximumRedirects`, and the `dangerouslyAllowLocalIP`
escape hatch; the `q` param is applied and output format is negotiated from `Accept`.
— `src/server/image-optimizer.ts`, `src/server/config.ts`.

## Developer experience

- **Fast Refresh (state-preserving HMR).** ✅ **Landed** — the dev server does a
  module-scoped, hook-state-preserving refresh (denext's own leaner mechanism, via
  component families), falling back to a full reload when a change can't be applied
  safely. Scope + fallbacks are documented in KNOWN-LIMITATIONS. — `src/build/`,
  `src/client/fiber/`.
- **DevTools depth.** Hooks/state inspection, editing/override hooks, context
  inspection, the Profiler tab, and source links/owner stacks (a `react-jsxdev`
  compile path). These need React's internal re-render inspection machinery denext
  doesn't currently expose. See the DevTools section of KNOWN-LIMITATIONS.
- **Dev error overlay + source maps.** ◑ Error overlay ✅ **Landed** (runtime
  errors, unhandled rejections, and server-pushed build errors over SSE); **dev
  source maps** are still to do.

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
