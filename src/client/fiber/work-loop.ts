// The work loop: renderRoot (the synchronous render-and-commit loop) and the
// time-sliced concurrent render for the transition lane.

import { activeRoots, fiberToRoot } from "./state.ts";
import type { RootHandle } from "./state.ts";
import {
  abandonConcurrent,
  anyRootHasLane,
  clearConcurrentRender,
  concurrentHandle,
  concurrentWipRoot,
  ensureScheduled,
  resetConcurrentState,
  runTransitionDone,
  scheduleContinuation,
  scheduleSyncFlush,
  scheduleTransitionFlush,
  setDuringRender,
  setRenderLanes,
  settleTransitions,
  setWorkInProgress,
  shouldYield,
  startConcurrentRender,
  startSlice,
  workInProgress,
} from "./scheduler.ts";
import { beginWork } from "./begin-work.ts";
import { completeWork } from "./complete-work.ts";
import { handleThrow, SUSPENDED_TRANSITION } from "./unwind.ts";
import { commitRoot, flushPassiveEffects } from "./commit.ts";
import { createWorkInProgress, type Fiber, NoLane, SyncLane, TransitionLane } from "./fiber.ts";
import { beginHydration, endHydration } from "./hydration.ts";

function performUnitOfWork(unit: Fiber): Fiber | null {
  let next: Fiber | null;
  try {
    next = beginWork(unit);
  } catch (thrown) {
    return handleThrow(unit, thrown);
  }
  if (next === null) {
    try {
      return completeUnitOfWork(unit);
    } catch (thrown) {
      return handleThrow(unit, thrown);
    }
  }
  return next;
}

function completeUnitOfWork(unit: Fiber): Fiber | null {
  let node: Fiber | null = unit;
  do {
    completeWork(node);
    if (node.sibling !== null) return node.sibling;
    node = node.return;
  } while (node !== null);
  return null;
}

export function beginConcurrentRender(): void {
  let handle: RootHandle | null = null;
  for (const h of activeRoots) {
    if ((h.pendingLanes & TransitionLane) !== NoLane) {
      handle = h;
      break;
    }
  }
  if (!handle) {
    runTransitionDone();
    return;
  }
  flushPassiveEffects();
  handle.pendingLanes &= ~TransitionLane;
  setRenderLanes(TransitionLane);
  const wipRoot = createWorkInProgress(handle.current, null);
  fiberToRoot.set(wipRoot, handle);
  wipRoot.pendingElement = handle.pendingElement;
  wipRoot.host = wipRoot;
  startConcurrentRender(handle, wipRoot);
  resumeConcurrent();
}

/**
 * A transition re-suspended a revealed boundary: discard this render and keep the
 * current tree (old content stays on screen — no fallback flash). The transition
 * remains pending (do NOT run transition-done, so useTransition's isPending stays true)
 * until retrySuspendedTransition re-arms it once the promise settles. The committed
 * fibers keep their transition lanes, so the retry re-renders the right subtrees.
 * (useId values are cached per hook cell on the persistent fibers, so the retry reuses
 * them automatically.) Only OTHER roots that still have queued transition work are
 * re-armed — this root's lane was consumed and is intentionally left pending.
 */
function discardSuspendedTransition(rootHandle: RootHandle): void {
  resetConcurrentState();
  if (anyRootHasLane(TransitionLane, rootHandle)) scheduleTransitionFlush();
}

/**
 * A render/commit that escaped without an error boundary must not wedge the scheduler:
 * reset the concurrent WIP state, clear the (broken) transition lane so it is not
 * retried into an infinite flap, and settle pending transitions before the caller
 * surfaces the error (as an uncaught render error, like React).
 */
function recoverFromConcurrentError(rootHandle: RootHandle): void {
  rootHandle.pendingLanes &= ~TransitionLane;
  resetConcurrentState();
  settleTransitions();
}

export function resumeConcurrent(): void {
  if (workInProgress === null || concurrentWipRoot === null) return; // abandoned
  const rootHandle = concurrentHandle!;
  try {
    resumeConcurrentInner();
  } catch (thrown) {
    if (thrown === SUSPENDED_TRANSITION) {
      discardSuspendedTransition(rootHandle);
      return;
    }
    recoverFromConcurrentError(rootHandle);
    throw thrown;
  }
}

/**
 * Render units of the concurrent tree until it is drained or the slice budget is spent.
 * do/while so each slice makes at least one unit of progress (a shouldYield that fires
 * on the first check would otherwise spin forever).
 */
function renderSlice(): void {
  setRenderLanes(TransitionLane);
  startSlice();
  setDuringRender(true);
  let wip: Fiber | null = workInProgress;
  try {
    do {
      wip = performUnitOfWork(wip!);
    } while (wip !== null && !shouldYield());
  } finally {
    setWorkInProgress(wip);
    setDuringRender(false);
  }
}

/** The concurrent tree is fully rendered: commit it and re-arm whatever is queued. */
function finishConcurrentRender(): void {
  const handle = concurrentHandle!;
  const wipRoot = concurrentWipRoot!;
  clearConcurrentRender();
  setDuringRender(true);
  try {
    commitRoot(handle, wipRoot);
  } finally {
    setDuringRender(false);
  }
  if (anyRootHasLane(SyncLane)) scheduleSyncFlush();
  settleTransitions();
}

function resumeConcurrentInner(): void {
  if (workInProgress === null || concurrentWipRoot === null) return;
  renderSlice();
  if (workInProgress === null) {
    finishConcurrentRender();
    return;
  }
  // An urgent (sync) update born during this slice (a render-phase setState)
  // interrupts the transition instead of waiting for it to finish.
  if ((concurrentHandle!.pendingLanes & SyncLane) !== NoLane) {
    abandonConcurrent();
    scheduleSyncFlush();
    return;
  }
  scheduleContinuation(); // yielded mid-tree; resume on the next slice
}

const MAX_RENDER_PASSES = 50;

export function renderRoot(handle: RootHandle, lanes: number): void {
  let guard = 0;
  do {
    // Flush pending passive effects before EACH render+commit iteration, not just once
    // before the loop. This loop renders AND commits every iteration; the next
    // iteration's `createWorkInProgress` reuses a fiber's alternate buffer and clears
    // its `passiveEffects`, so a passive effect scheduled + committed in an earlier
    // iteration (already queued in `pendingPassive`) would be stranded — its buffer
    // wiped before the deferred flush ran it. React flushes passive effects before any
    // new unit of work for exactly this reason (it manifested as a Base UI dialog never
    // unmounting on close: the root's unmount-watcher effect was stranded, so the exit
    // never completed and the dialog could not reopen).
    flushPassiveEffects();
    if (++guard > MAX_RENDER_PASSES) {
      // A component is scheduling updates during render in a loop. Clear the lane
      // so we don't hang, then surface it (React throws the same way).
      handle.pendingLanes &= ~lanes;
      throw new Error(
        "denext: Maximum update depth exceeded. A component repeatedly schedules " +
          "an update during render (e.g. calling setState unconditionally while rendering).",
      );
    }
    handle.pendingLanes &= ~lanes; // clear the lanes we're about to process
    setRenderLanes(lanes);
    const wipRoot = createWorkInProgress(handle.current, null);
    fiberToRoot.set(wipRoot, handle);
    wipRoot.pendingElement = handle.pendingElement;
    wipRoot.host = wipRoot;
    setDuringRender(true);
    const hydrate = handle.hydrate;
    if (hydrate) beginHydration(handle.container);
    let wip: Fiber | null = wipRoot;
    setWorkInProgress(wip);
    try {
      while (wip !== null) wip = performUnitOfWork(wip);
    } finally {
      setWorkInProgress(wip);
      setDuringRender(false);
      if (hydrate) {
        endHydration();
        handle.hydrate = false;
      }
    }
    commitRoot(handle, wipRoot);
  } while ((handle.pendingLanes & lanes) !== NoLane);
  // A lower-priority lane (e.g. a transition scheduled by useDeferredValue during
  // this synchronous render) won't be re-entered by the loop above — arm its flush.
  ensureScheduled(handle);
}
