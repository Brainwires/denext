// Scheduling: lane bookkeeping (scheduleUpdate), the sync flush, and the time-sliced
// transition machinery (slice budget, continuations, async-transition window and
// watchdog, done-callbacks). The render entry points it drives live above it and are
// injected once through `setFlushHandlers` so the module graph stays acyclic.

import { activeRoots, rootHandleOf } from "./state.ts";
import type { RootHandle } from "./state.ts";
import { devHydrationActive } from "./fiber-utils.ts";
import { setTransitionScheduler } from "../../runtime/hooks.ts";
import { Variable } from "../../runtime/async-context.ts";
import { asyncContextScopingEnabled } from "../../runtime/async-context-mode.ts";
import { inEventDispatch } from "../event-priority.ts";
import { type Fiber, NoLane, SyncLane, TransitionLane } from "./fiber.ts";

// The render entry points this module drives. They live in the work loop, above this
// module, and are injected once by `root.ts` so the fiber module graph stays acyclic
// (hooks → scheduleUpdate → flush → renderRoot → beginWork → hooks would otherwise
// cycle). Held as three plain lets (not an object) so the calls minify to bare names.
let renderRootImpl: (handle: RootHandle, lanes: number) => void = null!;
let beginConcurrentRenderImpl: () => void = null!;
let resumeConcurrentImpl: () => void = null!;

/** Wire the work loop's entry points (called once, at module init, by `root.ts`). */
export function setFlushHandlers(
  renderRoot: (handle: RootHandle, lanes: number) => void,
  beginConcurrentRender: () => void,
  resumeConcurrent: () => void,
): void {
  renderRootImpl = renderRoot;
  beginConcurrentRenderImpl = beginConcurrentRender;
  resumeConcurrentImpl = resumeConcurrent;
}

/** The lanes the current render is processing. */
export let renderLanes = NoLane;
/** True while a render + commit is running (setState during render defers). */
export let duringRender = false;
/** The unit of work in progress, or null between renders. */
export let workInProgress: Fiber | null = null;
// The in-flight concurrent (transition) render, or null when none is running.
export let concurrentHandle: RootHandle | null = null;
export let concurrentWipRoot: Fiber | null = null;

export function setRenderLanes(lanes: number): void {
  renderLanes = lanes;
}

export function setDuringRender(on: boolean): void {
  duringRender = on;
}

export function setWorkInProgress(fiber: Fiber | null): void {
  workInProgress = fiber;
}

/** Register the concurrent render about to start and open its first slice. */
export function startConcurrentRender(handle: RootHandle, wipRoot: Fiber): void {
  concurrentHandle = handle;
  concurrentWipRoot = wipRoot;
  workInProgress = wipRoot;
  startSlice();
}

/** Forget the in-flight concurrent render once its tree has been handed to commit. */
export function clearConcurrentRender(): void {
  concurrentHandle = null;
  concurrentWipRoot = null;
}

/** Drop the in-flight concurrent render: no work-in-progress, no owning root, not rendering. */
export function resetConcurrentState(): void {
  workInProgress = null;
  concurrentWipRoot = null;
  concurrentHandle = null;
  duringRender = false;
}

/**
 * Mark `fiber` (and both its buffers) as having a pending update, propagate the
 * child-lane hint up to the root (marking both buffers so whichever is current
 * sees it), and schedule the appropriate flush.
 */
export function scheduleUpdate(fiber: Fiber): void {
  // With AsyncContext scoping enabled (experimental.asyncContext + the build
  // transform), priority is decided by transition IDENTITY: an update belongs to a
  // transition iff it is enqueued inside that transition's context — which the
  // transform propagates across the user's `await`s. An unrelated urgent update in
  // the pending window carries no transition id, so it stays urgent (the fix).
  // Without scoping, fall back to the time-window depth counters — but an update
  // enqueued synchronously in a DOM event handler is a discrete user interaction
  // and stays urgent even while an async transition is pending (React's model: a
  // click/keydown is never demoted to transition priority). The coarse async window
  // then only entangles updates OUTSIDE any event handler — i.e. the transition's
  // own post-`await` continuations. `transitionDepth > 0` (a synchronous
  // startTransition callback) still wins, so wrapping in startTransition inside a
  // handler is honored.
  const isTransition = asyncCtxScoping
    ? transitionVar.get() != null
    : transitionDepth > 0 || (asyncTransitionDepth > 0 && !inEventDispatch());
  scheduleUpdateLane(fiber, isTransition ? TransitionLane : SyncLane);
}

/** Like {@link scheduleUpdate} but with an explicit lane (e.g. a self-scheduled deferral). */
export function scheduleUpdateLane(fiber: Fiber, lane: number): void {
  if (fiber == null) return; // an SSR class setState has no reconciler fiber
  fiber.lanes |= lane;
  if (fiber.alternate) fiber.alternate.lanes |= lane;
  let node = fiber.return;
  while (node !== null) {
    node.childLanes |= lane;
    if (node.alternate) node.alternate.childLanes |= lane;
    node = node.return;
  }
  const handle = rootHandleOf(fiber);
  if (!handle) return;
  handle.pendingLanes |= lane;
  if (duringRender) return; // picked up by the render-again loop
  if (lane & TransitionLane) scheduleTransitionFlush();
  else scheduleSyncFlush();
}

let syncScheduled = false;

export function scheduleSyncFlush(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    // An urgent (sync) update interrupts any in-flight transition render: abandon
    // its off-DOM work-in-progress (nothing committed, nothing to roll back) and
    // reschedule the transition to restart from the committed sync state.
    abandonConcurrent();
    flushRoots(SyncLane);
    for (const handle of activeRoots) ensureScheduled(handle);
  });
}

/** Render every root with pending work in `lanes`, to completion (never yields). */
export function flushRoots(lanes: number): void {
  for (const handle of activeRoots) {
    if ((handle.pendingLanes & lanes) !== NoLane) renderRootImpl(handle, lanes);
  }
}

/** Re-arm the sync/transition schedulers if `handle` still has pending work. */
export function ensureScheduled(handle: RootHandle): void {
  if ((handle.pendingLanes & SyncLane) !== NoLane) scheduleSyncFlush();
  if ((handle.pendingLanes & TransitionLane) !== NoLane) scheduleTransitionFlush();
}

// ---- Time-sliced transition scheduling -------------------------------------
// Transition-lane updates render on the concurrent path: the work loop checks a
// frame budget between units of work and yields via MessageChannel, resuming on
// the next slice, so a heavy transition never blocks paint/input. The tree is
// built off-DOM and committed only when the render drains — and a sync update can
// interrupt and restart it (see abandonConcurrent). The sync lane, by contrast,
// always runs to completion in renderRoot.

const FRAME_BUDGET_MS = 5;
let sliceStart = 0;
let unitsThisSlice = 0;

/** Open a new time slice: reset the frame budget clock and the unit counter. */
export function startSlice(): void {
  sliceStart = performance.now();
  unitsThisSlice = 0;
}

/** Test seam: when > 0, yield after every N units (deterministic multi-slice). */
let yieldEvery = 0;

/** Test-only: force the transition loop to yield after every `n` units of work. */
export function __setYieldEveryForTests(n: number): void {
  yieldEvery = n;
}

// Manual slicing: when on, the transition kick and slice continuations are not
// auto-scheduled (no setTimeout / MessageChannel) but recorded, so a test can
// drive them one at a time via __pumpForTests() for deterministic interruption.
let manualSlicing = false;
let pendingKick = false;

/** Test-only: drive transition slices manually instead of via the event loop. */
export function __setManualSlicingForTests(on: boolean): void {
  manualSlicing = on;
  pendingKick = false;
}

/** Test-only: run one pending transition step (kick or slice). Returns did-work. */
export function __pumpForTests(): boolean {
  if (pendingKick) {
    pendingKick = false;
    beginConcurrentRenderImpl();
    return true;
  }
  if (continuationScheduled) {
    continuationScheduled = false;
    resumeConcurrentImpl();
    return true;
  }
  return false;
}

export function shouldYield(): boolean {
  if (yieldEvery > 0) return ++unitsThisSlice >= yieldEvery;
  return (performance.now() - sliceStart) >= FRAME_BUDGET_MS;
}

let transitionDepth = 0;

// Async transitions in flight: `startTransition(async () => …)` whose returned
// promise has not yet settled. Without AsyncContext scoping denext cannot instrument
// the user's `await`, so while any async transition is pending its window entangles
// updates at transition priority (see scheduleUpdate) — this is how a post-`await`
// `setState` still lands on TransitionLane and how `isPending` is held until the async
// work settles. With scoping enabled this window no longer governs PRIORITY (identity
// does — see transitionVar); it only tracks the pending async work for the watchdog.
let asyncTransitionDepth = 0;

// The current transition's identity, propagated across the user's `await`s by the
// build transform when `experimental.asyncContext` is on. `scheduleUpdate` reads it
// (in scoping mode) so only updates enqueued inside a transition's context are
// deferred; unrelated urgent updates in the pending window keep their priority.
const transitionVar = new Variable<object | null>();

// Seeded from the build-swapped `const` (false by default; the build redirects the
// module to `true` under experimental.asyncContext). A mutable so tests can drive the
// scoping path without the build; production reads the seed and never calls the setter.
let asyncCtxScoping = asyncContextScopingEnabled;

/** Test-only: toggle AsyncContext transition scoping (production uses the build seed). */
export function __setAsyncContextScoping(on: boolean): void {
  asyncCtxScoping = on;
}

// Dev-only: how long an async transition may stay pending before we warn it looks
// wedged (a never-settling `await` in `startTransition(async …)`). Overridable for
// tests via __setAsyncTransitionWarnMs.
let asyncTransitionWarnMs = 10_000;

/** Test-only: set the async-transition watchdog threshold (ms). */
export function __setAsyncTransitionWarnMs(ms: number): void {
  asyncTransitionWarnMs = ms;
}

/**
 * Arm a dev-only timer that warns if an async transition is still pending after
 * {@link asyncTransitionWarnMs}. No-op (returns undefined) outside dev, so prod pays
 * nothing. The timer is unref'd so it never keeps a process alive on its own.
 */
function armAsyncTransitionWatchdog(): ReturnType<typeof setTimeout> | undefined {
  if (!devHydrationActive()) return undefined;
  const timer = setTimeout(() => {
    console.warn(
      "denext: an async transition has been pending for over " +
        `${Math.round(asyncTransitionWarnMs / 1000)}s. A never-settling await inside ` +
        "startTransition(async () => …) holds isPending true and keeps entangling " +
        "updates at transition priority. Ensure the async work resolves or rejects.",
    );
  }, asyncTransitionWarnMs);
  // Under Deno a pending timer keeps the loop alive; unref so the watchdog alone
  // can't. Guarded: `Deno` is undefined in the browser bundle.
  if (typeof Deno !== "undefined") {
    (Deno as { unrefTimer?: (id: number) => void }).unrefTimer?.(timer as unknown as number);
  }
  return timer;
}

/** Disarm the watchdog once the async transition settles. */
function clearAsyncTransitionWatchdog(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}

let transitionScheduled = false;

let transitionTimer: ReturnType<typeof setTimeout> | undefined;

const transitionDoneCallbacks: Array<() => void> = [];

// The time-slicing continuation scheduler (browser-hydration equivalent of React's
// MessageChannel scheduler). The channel is created lazily on first real use — a
// MessageChannel with a live `onmessage` listener is a ref'd handle that keeps
// Deno's event loop alive forever, so constructing it at module scope would hang
// any non-browser process (CLI, SSR, tests) that merely imports this module. It is
// only ever pumped in the browser via scheduleContinuation(); manual-slicing tests
// pump through __pumpForTests() and must never construct it.
let yieldChannel: MessageChannel | undefined;

let continuationScheduled = false;

export function scheduleContinuation(): void {
  if (continuationScheduled) return;
  continuationScheduled = true;
  if (manualSlicing) return; // pumped via __pumpForTests()
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => {
      continuationScheduled = false;
      resumeConcurrentImpl();
    };
  }
  yieldChannel.port2.postMessage(null);
}

export function scheduleTransitionFlush(): void {
  if (transitionScheduled || concurrentHandle !== null || pendingKick) return;
  if (manualSlicing) {
    pendingKick = true;
    return;
  }
  transitionScheduled = true;
  transitionTimer = setTimeout(() => {
    transitionTimer = undefined;
    transitionScheduled = false;
    beginConcurrentRenderImpl();
  }, 0);
}

/** Whether any active root (optionally excluding one) has `lane` pending. */
export function anyRootHasLane(lane: number, except: RootHandle | null = null): boolean {
  for (const h of activeRoots) {
    if (h !== except && (h.pendingLanes & lane) !== NoLane) return true;
  }
  return false;
}

/**
 * Re-arm across ALL roots: a transition update on another root that arrived mid-flight
 * was skipped by scheduleTransitionFlush's in-flight guard and must be picked up now.
 * The transition done-callbacks are held until no root has transition work left, so one
 * root finishing doesn't clear another's pending indicator early.
 */
export function settleTransitions(): void {
  if (anyRootHasLane(TransitionLane)) scheduleTransitionFlush();
  else runTransitionDone();
}

export function abandonConcurrent(): void {
  if (concurrentWipRoot === null) return;
  const handle = concurrentHandle!;
  handle.pendingLanes |= TransitionLane;
  resetConcurrentState();
  scheduleTransitionFlush();
}

/**
 * flushSync support: cancel any scheduled transition macrotask and reclaim an in-flight
 * slice, so everything (sync + transition) can be rendered to completion synchronously.
 */
export function reclaimTransitions(): void {
  if (transitionTimer !== undefined) {
    clearTimeout(transitionTimer);
    transitionTimer = undefined;
  }
  transitionScheduled = false;
  if (concurrentWipRoot !== null) {
    concurrentHandle!.pendingLanes |= TransitionLane;
    resetConcurrentState();
  }
}

export function runTransitionDone(): void {
  const dones = transitionDoneCallbacks.splice(0);
  for (const d of dones) d();
}

/** True if any root still has transition-lane work pending or in flight. */
function transitionPending(): boolean {
  if (transitionScheduled || concurrentHandle !== null) return true;
  for (const h of activeRoots) {
    if ((h.pendingLanes & TransitionLane) !== NoLane) return true;
  }
  return false;
}

/**
 * Defer `onComplete` (e.g. useTransition's `setPending(false)`) until the current
 * transition flush lands; if nothing is pending, clear it on a microtask.
 */
function scheduleTransitionComplete(onComplete: () => void): void {
  if (transitionPending()) {
    transitionDoneCallbacks.push(onComplete);
    scheduleTransitionFlush();
  } else {
    queueMicrotask(onComplete);
  }
}

setTransitionScheduler((cb, onComplete) => {
  transitionDepth++;
  let result: unknown;
  try {
    // In scoping mode, run the callback inside a fresh transition identity so its
    // updates — including those after an instrumented `await` — are attributable to
    // THIS transition (see scheduleUpdate + transitionVar). Off, this DCEs to `cb()`.
    result = asyncCtxScoping ? transitionVar.run({}, cb) : cb();
  } catch (err) {
    // A synchronous throw in the transition callback must still clear `isPending`
    // — otherwise the transition wedges "pending" forever. Schedule onComplete
    // (after any updates already queued before the throw settle), then rethrow so
    // the error still surfaces, as React does.
    scheduleTransitionComplete(onComplete);
    throw err;
  } finally {
    transitionDepth--;
  }
  // Async transition: the callback returned a thenable. Hold onComplete until the
  // promise settles AND the resulting transition flush lands. Without scoping, the
  // in-flight window keeps ALL updates at transition priority across the await(s)
  // (coarse — see KNOWN-LIMITATIONS); with scoping, priority is governed by identity
  // (transitionVar, propagated across the user's awaits) and the window here only
  // tracks the pending async work for the watchdog.
  if (result != null && typeof (result as { then?: unknown }).then === "function") {
    asyncTransitionDepth++;
    // Dev-only watchdog: an async transition whose promise never settles holds
    // `isPending` true forever (and, without scoping, keeps entangling updates).
    // Warn (once per stuck transition) so the footgun is visible in development;
    // never force-settle — that would mask the real never-resolving await in prod.
    const watchdog = armAsyncTransitionWatchdog();
    const settle = () => {
      asyncTransitionDepth--;
      clearAsyncTransitionWatchdog(watchdog);
      scheduleTransitionComplete(onComplete);
    };
    (result as Promise<unknown>).then(settle, (err) => {
      settle();
      // The async transition has no render boundary to catch a rejection; keep it
      // visible (unhandled) rather than swallowing it, as React does.
      throw err;
    });
    return;
  }
  if (transitionScheduled || concurrentHandle !== null) {
    transitionDoneCallbacks.push(onComplete);
  } else queueMicrotask(onComplete);
});
