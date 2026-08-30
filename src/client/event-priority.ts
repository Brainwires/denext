// Tracks whether the reconciler is synchronously executing a DOM event handler.
//
// An update enqueued in this context must keep its natural priority even while an
// async transition is pending: a user interaction (click / keydown / input / …) is
// urgent and must NOT be demoted to transition priority by the coarse async-window
// entanglement the reconciler falls back to without AsyncContext scoping (see
// `scheduleUpdate`). Only updates that occur OUTSIDE any event handler — i.e. an
// async transition's own post-`await` continuations — remain entangled by that
// window. This mirrors React's discrete-event priority and adds no app-wide cost:
// one counter, incremented around the existing shared event-listener wrapper.

let depth = 0;

/** Enter a DOM event handler's synchronous execution (see {@link inEventDispatch}). */
export function beginEventDispatch(): void {
  depth++;
}

/** Leave a DOM event handler's synchronous execution. */
export function endEventDispatch(): void {
  if (depth > 0) depth--;
}

/** True while a DOM event handler is running synchronously. */
export function inEventDispatch(): boolean {
  return depth > 0;
}
