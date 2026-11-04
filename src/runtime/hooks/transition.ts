// The public transition hooks — `startTransition`, `useTransition`, `useOptimistic` — and the
// engine behind them, which drives the client scheduler through the controls it installs
// (runtime/hooks.ts's `TransitionHost`). Here, not in the scheduler, so a bundle carries the
// engine only when the app starts a transition; and through the host, not an import, so a lazily
// loaded chunk that starts one reaches no reconciler file. The scheduler's lanes and its
// time-sliced render stay in every app (Suspense reveals and `useDeferredValue` use them too).

import { getTransitionHost, type TransitionHost, useCallback, useRef, useState } from "../hooks.ts";

/** Callbacks waiting for the transition in flight to settle (`useOptimistic`'s reverts). */
let settledCallbacks: Array<() => void> = [];

/** Run the queued settled-callbacks (after the transition's own completion callback). */
function runSettled(): void {
  const cbs = settledCallbacks;
  settledCallbacks = [];
  for (const cb of cbs) cb();
}

/**
 * Defer `onComplete` (e.g. useTransition's `setPending(false)`) until the current transition
 * flush lands; if nothing is pending, run it on a microtask.
 */
function whenTransitionsFlushed(host: TransitionHost, onComplete: () => void): void {
  if (host.pending()) {
    host.whenFlushed(onComplete);
    host.flush();
  } else {
    queueMicrotask(onComplete);
  }
}

/**
 * Run `cb` as a transition: the state updates it triggers (and, for an async `cb`, those after
 * its `await`s) render on the transition lane, flushed after the browser yields; `onComplete`
 * fires once that flush lands.
 */
function runTransition(host: TransitionHost, cb: () => unknown, onComplete: () => void): void {
  host.begin();
  let result: unknown;
  try {
    // In scoping mode, run the callback inside a fresh transition identity so its
    // updates — including those after an instrumented `await` — are attributable to
    // THIS transition (see the scheduler's scheduleUpdate). Off (null), it is just `cb()`.
    const scope = host.scope();
    result = scope ? scope.run({}, cb) : cb();
  } catch (err) {
    // A synchronous throw in the transition callback must still clear `isPending`
    // — otherwise the transition wedges "pending" forever. Schedule onComplete
    // (after any updates already queued before the throw settle), then rethrow so
    // the error still surfaces, as React does.
    whenTransitionsFlushed(host, onComplete);
    throw err;
  } finally {
    host.end();
  }
  const complete = () => {
    onComplete();
    runSettled();
  };
  // Async transition: the callback returned a thenable. Hold onComplete until the
  // promise settles AND the resulting transition flush lands. Without scoping, the
  // in-flight window keeps ALL updates at transition priority across the await(s)
  // (coarse — see KNOWN-LIMITATIONS); with scoping, priority is governed by identity
  // and the window here only tracks the pending async work for the watchdog.
  if (result != null && typeof (result as { then?: unknown }).then === "function") {
    // Never force-settle a stuck one: the dev watchdog warns instead.
    const disarm = host.beginAsync();
    const settle = () => {
      host.endAsync();
      disarm?.();
      whenTransitionsFlushed(host, complete);
    };
    (result as Promise<unknown>).then(settle, (err) => {
      settle();
      // The async transition has no render boundary to catch a rejection; keep it
      // visible (unhandled) rather than swallowing it, as React does.
      throw err;
    });
    return;
  }
  if (host.inFlight()) host.whenFlushed(complete);
  else queueMicrotask(complete);
}

/**
 * Run `callback` as a low-priority "transition": the callback runs synchronously
 * (like React), but any state updates it triggers are scheduled at transition
 * priority — flushed after the reconciler yields to the browser, so urgent updates
 * and paint/input happen first. Without the client scheduler it just runs the callback. The transition render is time-sliced and interruptible: a
 * higher-priority (sync) update abandons the in-flight transition and restarts it
 * (see the Async transitions guide: /docs/rendering#async-transitions).
 *
 * An **async** callback (`startTransition(async () => { await x; setState() })`) is
 * supported: the transition stays active across the `await`, so updates scheduled
 * after it still land at transition priority. By default denext entangles by a time
 * window while the returned promise is pending; enable `asyncContext` in
 * `denext.config.ts` to scope by transition identity instead, so an unrelated urgent
 * update in that window keeps its priority (see the Async transitions guide /
 * KNOWN-LIMITATIONS).
 */
export function startTransition(callback: () => void): void {
  const host = getTransitionHost();
  if (host) runTransition(host, callback, noop);
  else callback();
}

/** `startTransition`'s completion: nothing waits on it. */
function noop(): void {}

/**
 * Return `[isPending, startTransition]`. `isPending` stays true from the moment the
 * transition starts until its low-priority updates have been flushed — so a pending
 * indicator can paint (and the browser can handle input) before the transition's
 * work runs. For an async callback it is held until the returned promise settles and
 * the resulting flush lands. Falls back to a synchronous run when no client scheduler
 * is installed.
 */
export function useTransition(): [boolean, (callback: () => void) => void] {
  const [isPending, setPending] = useState(false);
  const start = useCallback((callback: () => void) => {
    const host = getTransitionHost();
    if (host) {
      setPending(() => true);
      runTransition(host, callback, () => setPending(() => false));
    } else {
      callback();
    }
  }, []);
  return [isPending, start];
}

/**
 * Show an optimistic value while an async update is in flight. Returns
 * `[optimisticState, addOptimistic]`; call `addOptimistic(action)` to apply an
 * optimistic change over the current `state`. The optimistic value resets to `state`
 * when `state` itself changes AND when the transition/action it was applied in settles
 * (React semantics — a failed action reverts too). `addOptimistic` keeps one identity.
 */
export function useOptimistic<S, A = S>(
  state: S,
  updateFn?: (current: S, action: A) => S,
): [S, (action: A) => void] {
  const store = useRef<{ base: S; value: S }>({ base: state, value: state });
  // Reset the optimistic value whenever the underlying state changes.
  if (!Object.is(store.current.base, state)) {
    store.current = { base: state, value: state };
  }
  const [, force] = useState(0);
  const updater = useRef(updateFn);
  updater.current = updateFn;
  const addOptimistic = useCallback((action: A) => {
    // React's single-arg form has no reducer: the action IS the next optimistic value.
    const fn = updater.current;
    store.current.value = fn ? fn(store.current.value, action) : (action as unknown as S);
    force((n) => n + 1);
    // React discards the optimistic value when the transition/action that applied it
    // settles — success OR failure — whether or not `state` changed. Outside a transition
    // (React warns) it persists until the base `state` changes.
    const revert = () => {
      if (Object.is(store.current.value, store.current.base)) return;
      store.current.value = store.current.base;
      force((n) => n + 1);
    };
    // Inside a transition/action the value reverts when it settles. Outside one React warns and
    // it simply persists until the base state changes (reverting on the next tick would make
    // `addOptimistic` outside a transition a no-op).
    const host = getTransitionHost();
    if (!host) queueMicrotask(revert);
    else if (host.active()) settledCallbacks.push(revert);
  }, []);
  return [store.current.value, addOptimistic];
}
