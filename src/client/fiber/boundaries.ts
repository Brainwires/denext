// Suspense retry and error-boundary runtime: retrying a suspended boundary once its
// promise settles, routing event/effect errors to the nearest boundary, and the
// controller the runtime's ErrorBoundary/useErrorBoundary talk to.

import { rootHandleOf } from "./state.ts";
import { componentErrorInfo, findErrorBoundary, isClassBoundary } from "./fiber-utils.ts";
import { reportCaught, reportUncaught } from "./root-callbacks.ts";
import { flushRoots, scheduleTransitionFlush, scheduleUpdate } from "./scheduler.ts";
import {
  type ErrorBoundaryController,
  setBoundaryControllerProvider,
} from "../../runtime/hooks.ts";
import { isControlSignal, isRedirect } from "../../runtime/error-boundary.ts";
import { handleClassError, setClassScheduleUpdate } from "../../compat/class-component.ts";
import { type Fiber, SyncLane, TransitionLane } from "./fiber.ts";
import { currentFiber } from "./hooks-dispatcher.ts";

export function onErrorFor(fiber: Fiber): (err: unknown) => void {
  return (err) => handleEventError(fiber, err);
}

/**
 * Re-run a transition that was kept pending because it re-suspended a revealed
 * boundary (see {@link SUSPENDED_TRANSITION}). The committed fibers still carry the
 * original transition's lanes (only the discarded work-in-progress had them
 * cleared), so re-arming the root's transition lane re-renders exactly the
 * subtrees the transition touched — now that the promise has settled.
 */
export function retrySuspendedTransition(inst: Fiber): void {
  if (inst.unmounted) return; // boundary was unmounted before the promise settled
  const handle = rootHandleOf(inst);
  if (!handle) return;
  handle.pendingLanes |= TransitionLane;
  scheduleTransitionFlush();
}

export function retrySuspense(inst: Fiber): void {
  if (inst.unmounted) return; // boundary was unmounted before the promise settled
  inst.showingFallback = false;
  const st = inst.listState;
  if (st && inst.listIndex != null) {
    // Mark this member ready on the shared state (indexed — the captured fiber may
    // be stale) and re-render every member so they re-evaluate reveal order.
    st.ready[inst.listIndex] = true;
    for (const m of st.members) if (m) scheduleUpdate(m);
  } else {
    scheduleUpdate(inst);
  }
}

export function resetBoundary(inst: Fiber): void {
  inst.__error = undefined;
  scheduleUpdate(inst);
  flushRoots(SyncLane); // event-time (fallback's reset button): commit synchronously
}

function triggerBoundary(inst: Fiber, error: unknown): void {
  if (isControlSignal(error)) throw error;
  if (__DENEXT_CLASS_COMPONENTS__ && isClassBoundary(inst)) {
    if (!handleClassError(inst as never, error, componentErrorInfo(inst))) {
      reportUncaught(inst, error); // the class boundary declined → uncaught
      throw error;
    }
    reportCaught(inst, error);
    scheduleUpdate(inst);
    flushRoots(SyncLane);
    return;
  }
  reportCaught(inst, error);
  inst.__error = error;
  scheduleUpdate(inst);
  // Event-handler / async errors are caught outside render; commit the fallback
  // synchronously so the DOM reflects it immediately (React can't do this).
  flushRoots(SyncLane);
}

function routeToBoundary(inst: Fiber, error: unknown): void {
  const boundary = findErrorBoundary(inst);
  if (!boundary) {
    reportUncaught(inst, error); // no boundary → onUncaughtError, then surface
    throw error;
  }
  triggerBoundary(boundary, error);
}

function handleEventError(inst: Fiber, error: unknown): void {
  if (isRedirect(error)) {
    if (typeof location !== "undefined") location.href = error.url;
    return;
  }
  if (isControlSignal(error)) throw error;
  routeToBoundary(inst, error);
}

/**
 * Route an error thrown by a layout/passive effect to the nearest error boundary.
 * Deferred to a microtask because effects run inside `commitRoot`: routing does a
 * synchronous fallback commit (`flushRoots`), which must not re-enter the current
 * commit. An error with no boundary surfaces as an uncaught microtask (React parity).
 */
export function scheduleEffectError(inst: Fiber, error: unknown): void {
  queueMicrotask(() => handleEventError(inst, error));
}

function makeBoundaryController(inst: Fiber | null): ErrorBoundaryController {
  const boundary = inst ? findErrorBoundary(inst) : null;
  return {
    reset() {
      if (boundary) resetBoundary(boundary);
    },
    captureError(error: unknown) {
      if (boundary) triggerBoundary(boundary, error);
      else if (isControlSignal(error)) throw error;
    },
  };
}

setBoundaryControllerProvider(() => makeBoundaryController(currentFiber));

// Wire the client re-render scheduler into the class runtime (which injects it
// rather than importing this module, keeping the SSR/CLI graph client-free).
setClassScheduleUpdate(scheduleUpdate);
