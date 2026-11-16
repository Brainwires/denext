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
let discrete = 0;

// React's DiscreteEventPriority events (`getEventPriority`). An urgent update one of them causes
// runs its commit's passive effects (useEffect) at the end of that commit, and pending passive
// effects are flushed before one is dispatched, so an effect a click set up (a `window`
// listener closing a menu) is in place before the next input event — the browser runs input
// tasks ahead of the timer the effects would otherwise wait for.
// Prefixes suffice (`key` is keydown / keyup / keypress, `select` selectstart / selectionchange).
const DISCRETE =
  /^((dbl|aux)?click|contextmenu|key|(pointer|mouse)(down|up)|(pointer|touch)cancel|touch(start|end)|(before)?input|change|focus|blur|submit|reset|composition|copy|cut|paste|drag(start|end)|drop|select|invalid|cancel|close|play$|pause|ratechange|seeked|volumechange|resize|fullscreenchange|hashchange|popstate)/;

/** Flushes pending passive effects before a discrete event; installed by the root module. */
let beforeDiscrete: (() => void) | null = null;

/** Install the pending-passive-effects flush run before a discrete event is dispatched. */
export function setBeforeDiscreteEvent(fn: () => void): void {
  beforeDiscrete = fn;
}

/**
 * Enter a DOM event handler's synchronous execution (see {@link inEventDispatch}); true when
 * `type` is a discrete event. Pass the result to {@link endEventDispatch}.
 */
export function beginEventDispatch(type: string): boolean {
  const d = DISCRETE.test(type);
  if (d) {
    beforeDiscrete?.(); // outside the event's priority, as React flushes before dispatching
    discrete++;
  }
  depth++;
  return d;
}

/** Leave a DOM event handler's synchronous execution (`d`: what begin returned). */
export function endEventDispatch(d: boolean): void {
  if (depth > 0) depth--;
  if (d && discrete > 0) discrete--;
}

/** True while a DOM event handler is running synchronously. */
export function inEventDispatch(): boolean {
  return depth > 0;
}

/**
 * True while a discrete event is being handled: dispatched by the reconciler, or (React's
 * `window.event` read) any native listener of one, the app's own `addEventListener` included.
 */
export function inDiscreteEvent(): boolean {
  return discrete > 0 || DISCRETE.test((globalThis as { event?: Event }).event?.type as string);
}
