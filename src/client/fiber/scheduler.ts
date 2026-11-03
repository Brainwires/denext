// Scheduling: lane bookkeeping (scheduleUpdate), the sync flush, and the time-sliced
// transition machinery (slice budget, continuations, async-transition window and
// watchdog, done-callbacks). The render entry points it drives live above it and are
// injected once through `setFlushHandlers` so the module graph stays acyclic.

import { activeRoots, rootHandleOf } from "./state.ts";
import { componentDisplayName } from "../../runtime/react-brands.ts";
import { setTransitionHost } from "../../runtime/hooks.ts";
import type { RootHandle } from "./state.ts";
import { devHydrationActive } from "./fiber-utils.ts";
import { Variable } from "../../runtime/async-context.ts";
import { transitionScope } from "../../runtime/async-context-mode.ts";
import { inEventDispatch } from "../event-priority.ts";
import {
  type Fiber,
  ForceRenderBit,
  NoLane,
  StateUpdateBit,
  SyncLane,
  TransitionLane,
} from "./fiber.ts";

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
 * Record WHY `fiber` has a pending update, on both buffers (whichever ends up current
 * must see it): a state setter (eligible for begin-work's no-op state bailout) or a
 * forced re-render (a Suspense retry, a store change, a boundary reset — never bailed).
 */
function markUpdateSource(fiber: Fiber, fromState: boolean): void {
  const bit = fromState ? StateUpdateBit : ForceRenderBit;
  fiber.bits |= bit;
  if (fiber.alternate) fiber.alternate.bits |= bit;
}

/**
 * Schedule a `useSyncExternalStore` subscriber at SYNC priority, whatever transition is
 * in flight — React's `forceStoreRerender`, which hard-codes `SyncLane` for exactly this
 * reason. An external store has ALREADY mutated, so its subscribers cannot be split
 * across lanes: if one subscriber's notify happens to land inside a `startTransition`
 * (or inside the pending window of an async one) while another's lands outside it, the
 * sync half re-renders against the new store while the transition half still shows the
 * old one — React's definition of tearing. Concretely, a child subscribed to one item's
 * store re-renders alone (its ancestor's list update parked on TransitionLane, so the
 * props-equal bailout clones straight past it) and its selector throws on the item the
 * store no longer has — TanStack Router's `matchStores` invariant, which blanks the
 * route. Store updates must never be time-sliced; only the lane is forced, the
 * `forceRender` marking is the same as any other non-state update.
 */
export function scheduleStoreUpdate(fiber: Fiber): void {
  markUpdateSource(fiber, false);
  const handle = rootHandleOf(fiber);
  if (handle) handle.syncPassive = true;
  scheduleUpdateLane(fiber, SyncLane);
}

/**
 * Mark `fiber` (and both its buffers) as having a pending update, propagate the
 * child-lane hint up to the root (marking both buffers so whichever is current
 * sees it), and schedule the appropriate flush.
 */
export function scheduleUpdate(fiber: Fiber, fromState = false): void {
  markUpdateSource(fiber, fromState);
  // With AsyncContext scoping enabled (`asyncContext` + the build
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
  const isTransition = transitionVar
    ? transitionVar.get() != null
    : transitionDepth > 0 || (asyncTransitionDepth > 0 && !inEventDispatch());
  scheduleUpdateLane(fiber, isTransition ? TransitionLane : SyncLane);
}

/** Like {@link scheduleUpdate} but with an explicit lane (e.g. a self-scheduled deferral). */
/**
 * The component type whose update was scheduled most recently — named when the render loop
 * gives up. The type, not the fiber: a module-level fiber reference outlives the component's
 * unmount and pins its hook state (and, through its links, its whole deleted subtree).
 */
let lastScheduledType: unknown = undefined;

/**
 * Display name of the component that scheduled the most recent update. The work loop's
 * "Maximum update depth exceeded" error names it, so an effect/state ping-pong in a large
 * app (2,700 islands) can be traced to a component instead of a minified chunk offset.
 */
export function lastUpdateSourceName(): string {
  return lastScheduledType !== undefined ? componentDisplayName(lastScheduledType) : "unknown";
}

export function scheduleUpdateLane(fiber: Fiber, lane: number): void {
  if (fiber == null) return; // an SSR class setState has no reconciler fiber
  lastScheduledType = fiber.vnode.type;
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
  if (lane & SyncLane) handle.reveal = false; // urgent work joins it: no longer a pure reveal
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
// build transform when `asyncContext` is on. `scheduleUpdate` reads it
// (in scoping mode) so only updates enqueued inside a transition's context are
// deferred; unrelated urgent updates in the pending window keep their priority.
// Non-null exactly when scoping is on: seeded from the build-swapped mode module (`null` by
// default; under `asyncContext` the build redirects it to a module exporting a `Variable`),
// so without `asyncContext` the AsyncContext `Variable` never enters the bundle. Mutable so
// tests can drive the scoping path without the build; production reads the seed and never
// calls the setter.
let transitionVar: Variable<object | null> | null = transitionScope;
let scopingVar: Variable<object | null> | null = transitionVar;

/** Test-only: toggle AsyncContext transition scoping (production uses the build seed). */
export function __setAsyncContextScoping(on: boolean): void {
  scopingVar ??= new Variable<object | null>();
  transitionVar = on ? scopingVar : null;
}

// Dev-only: how long an async transition may stay pending before we warn it looks
// wedged (a never-settling `await` in `startTransition(async …)`).
const ASYNC_TRANSITION_WARN_MS = 10_000;

/**
 * Arm a dev-only timer that warns if an async transition is still pending after
 * {@link ASYNC_TRANSITION_WARN_MS}; returns its disarm, or undefined outside dev. The timer is
 * unref'd so it never keeps a process alive on its own. Installed by the dev entries
 * ({@linkcode installAsyncTransitionWatchdog}, via `installDevtools`), so a production bundle
 * carries neither the timer nor its message: the transition pays one `?.`.
 */
function armAsyncTransitionWatchdog(): (() => void) | undefined {
  if (!devHydrationActive()) return undefined;
  const timer = setTimeout(() => {
    console.warn(
      "denext: an async transition has been pending for over " +
        `${ASYNC_TRANSITION_WARN_MS / 1000}s. A never-settling await inside ` +
        "startTransition(async () => …) holds isPending true and keeps entangling " +
        "updates at transition priority. Ensure the async work resolves or rejects.",
    );
  }, ASYNC_TRANSITION_WARN_MS);
  // Under Deno a pending timer keeps the loop alive; unref so the watchdog alone
  // can't. Guarded: `Deno` is undefined in the browser bundle.
  if (typeof Deno !== "undefined") {
    (Deno as { unrefTimer?: (id: number) => void }).unrefTimer?.(timer as unknown as number);
  }
  return () => clearTimeout(timer);
}

let watchdog: (() => (() => void) | undefined) | null = null;

/** Install (or, with `false`, remove) the dev-only async-transition watchdog. */
export function installAsyncTransitionWatchdog(on = true): void {
  watchdog = on ? armAsyncTransitionWatchdog : null;
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
// pump through __pumpForTests() and must never construct it. It is closed again once a
// slice schedules no further one (the sliced render finished or stopped), so a non-browser
// process that ran a transition (a component test) is not held open by it either.
let yieldChannel: MessageChannel | undefined;

let continuationScheduled = false;

export function scheduleContinuation(): void {
  if (continuationScheduled) return;
  continuationScheduled = true;
  if (manualSlicing) return; // pumped via __pumpForTests()
  if (!yieldChannel) {
    const channel = yieldChannel = new MessageChannel();
    channel.port1.onmessage = () => {
      continuationScheduled = false;
      resumeConcurrentImpl();
      // Slicing went idle: let the channel go.
      if (!continuationScheduled) {
        channel.port1.close(), channel.port2.close(), yieldChannel = undefined;
      }
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

// The transition engine (`startTransition` / `useTransition` / `useOptimistic`'s settle) lives
// with those hooks in src/runtime/hooks/transition.ts, so an app that never starts a transition
// ships none of it. It drives this scheduler through the host below, installed in the leaf slot
// runtime/hooks.ts keeps: the hooks' module imports nothing of the reconciler, so a lazily loaded
// chunk that starts a transition reaches no reconciler file (one that did would split the startup
// chunks along that edge).
setTransitionHost({
  begin: () => void transitionDepth++,
  end: () => void transitionDepth--,
  scope: () => transitionVar,
  beginAsync: () => {
    asyncTransitionDepth++;
    // Dev-only watchdog: an async transition whose promise never settles holds `isPending` true
    // forever (and, without scoping, keeps entangling updates); returns its disarm.
    return watchdog?.();
  },
  endAsync: () => void asyncTransitionDepth--,
  active: () => transitionDepth > 0 || asyncTransitionDepth > 0,
  inFlight: () => transitionScheduled || concurrentHandle !== null,
  pending: () => transitionScheduled || concurrentHandle !== null || anyRootHasLane(TransitionLane),
  flush: scheduleTransitionFlush,
  whenFlushed: (cb) => void transitionDoneCallbacks.push(cb),
});
