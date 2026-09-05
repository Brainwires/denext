// Throw handling during render: a thenable suspends the nearest Suspense boundary, an
// error is captured by the nearest error boundary, control signals propagate.

import {
  componentErrorInfo,
  findErrorBoundary,
  findSuspense,
  isClassBoundary,
} from "./fiber-utils.ts";
import { reportCaught, reportUncaught } from "./root-callbacks.ts";
import { retrySuspendedTransition, retrySuspense } from "./boundaries.ts";

import { isThenable } from "../../runtime/suspense.ts";
import { isControlSignal, isRedirect } from "../../runtime/error-boundary.ts";
import { handleClassError } from "../../compat/class-component.ts";
import { type Fiber, NoLane, TransitionLane } from "./fiber.ts";
import { concurrentWipRoot, renderLanes } from "./scheduler.ts";
import { dropHydrationCursor, isHydrating } from "./hydration.ts";

/**
 * Thrown by {@link handleThrow} to abandon a *transition* render that re-suspended
 * an already-revealed boundary — so denext keeps the currently-committed content
 * (no fallback flash) instead of committing the fallback, matching React's
 * recommended `startTransition`/`useDeferredValue` behavior. Caught in
 * {@link resumeConcurrent}; the transition stays pending (isPending true) until the
 * promise settles and the retry commits. Distinct object identity so it is never
 * confused with a user throw.
 */
export const SUSPENDED_TRANSITION: { readonly denextSuspendedTransition: true } = {
  denextSuspendedTransition: true,
};

/**
 * Re-seed a boundary's children from its committed alternate so its next beginWork
 * reconciles the fallback / error UI against the committed list.
 */
function reseedBoundary(boundary: Fiber): void {
  boundary.child = boundary.alternate ? boundary.alternate.child : null;
  boundary.deletions = null;
}

/**
 * Transition-aware Suspense: when a transition (startTransition / useDeferredValue)
 * re-suspends a boundary that is CURRENTLY revealed (its committed state shows content,
 * not a fallback), keep showing that content instead of flashing the fallback —
 * React's recommended pattern. This also preserves the subtree's state (it is never
 * unmounted). Excludes SuspenseList members (their reveal ordering owns the fallback
 * decision) and the initial reveal (no committed content to keep). Only ever true on
 * the concurrent render path, so the sentinel it leads to is caught by resumeConcurrent.
 */
function keepsRevealedContent(suspense: Fiber): boolean {
  const revealed = suspense.alternate != null && suspense.alternate.showingFallback !== true;
  const inList = suspense.listState != null && suspense.listState.revealOrder != null;
  return (renderLanes & TransitionLane) !== NoLane && concurrentWipRoot !== null &&
    revealed && !inList;
}

/**
 * Switch `suspense` to its fallback. Offscreen (urgent re-suspend of a boundary that
 * has committed primary content): keep that primary mounted-but-hidden and show the
 * fallback alongside, so the reveal restores the same instances (state preserved)
 * instead of remounting. Not for a SuspenseList member (its reveal ordering owns the
 * fallback) nor during hydration (the fallback must mount fresh, adopting no server
 * DOM). The committed primary is either shown content (revealed) or an already-hidden
 * Offscreen primary. Rendering restarts from the committed child list: Offscreen
 * beginWork reconciles [primary…, fallback…] against it (primary preserved + hidden);
 * the plain path reconciles the fallback against it (remount).
 */
function prepareFallbackRender(suspense: Fiber): void {
  suspense.showingFallback = true;
  const inList = suspense.listState != null && suspense.listState.revealOrder != null;
  const hasCommittedPrimary = suspense.alternate != null &&
    (suspense.alternate.showingFallback !== true || suspense.alternate.offscreen === true);
  suspense.offscreen = hasCommittedPrimary && !inList && !isHydrating;
  // Suspended → not ready, for SuspenseList ordering (indexed on the shared state).
  if (suspense.listState && suspense.listIndex != null) {
    suspense.listState.ready[suspense.listIndex] = false;
  }
  reseedBoundary(suspense);
  if (isHydrating) dropHydrationCursor();
}

/** A component suspended: hand the render to its nearest Suspense boundary. */
function handleSuspend(sourceFiber: Fiber, thenable: Promise<unknown>): Fiber {
  const suspense = findSuspense(sourceFiber);
  if (!suspense) throw thenable;
  if (keepsRevealedContent(suspense)) {
    thenable.then(
      () => retrySuspendedTransition(suspense),
      () => retrySuspendedTransition(suspense),
    );
    throw SUSPENDED_TRANSITION;
  }
  prepareFallbackRender(suspense);
  thenable.then(() => retrySuspense(suspense), () => retrySuspense(suspense));
  return suspense;
}

/**
 * A component threw: capture the error in the nearest boundary (class
 * `componentDidCatch`/`getDerivedStateFromError`, or a function `<ErrorBoundary>`) and
 * hand the render to it; with no boundary — or a class boundary that declined — report
 * it as uncaught and surface it.
 */
function handleRenderError(sourceFiber: Fiber, thrown: unknown): Fiber {
  const boundary = findErrorBoundary(sourceFiber);
  if (!boundary) {
    reportUncaught(sourceFiber, thrown); // no boundary → onUncaughtError, then surface
    throw thrown;
  }
  if (isClassBoundary(boundary)) {
    if (!handleClassError(boundary as never, thrown, componentErrorInfo(boundary))) {
      reportUncaught(sourceFiber, thrown); // the class boundary declined → uncaught
      throw thrown;
    }
    reportCaught(boundary, thrown);
    boundary.lanes = NoLane; // drop the self-scheduled update; we re-render inline
  } else {
    reportCaught(boundary, thrown);
    boundary.__error = thrown;
  }
  reseedBoundary(boundary);
  return boundary;
}

/**
 * Handle a throw during begin/completeWork: a thenable suspends the nearest
 * Suspense (commit its fallback, retry when it settles); a genuine error routes
 * to the nearest error boundary (function fallback, or class error lifecycle);
 * control signals and unhandled throws re-throw to abort the render.
 */
export function handleThrow(sourceFiber: Fiber, thrown: unknown): Fiber | null {
  if (isThenable(thrown)) return handleSuspend(sourceFiber, thrown);
  // `redirect()` during a client render: Next navigates. Leave the current DOM as it is (the
  // page is about to unload) and stop this render.
  if (isRedirect(thrown) && typeof location !== "undefined") {
    location.assign(thrown.url);
    return null;
  }
  if (isControlSignal(thrown)) throw thrown;
  return handleRenderError(sourceFiber, thrown);
}
