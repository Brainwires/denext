/**
 * The update priority the host config reports to `react-reconciler`: discrete while a press,
 * focus, key or text event is dispatched (its updates commit synchronously, as React DOM's do),
 * continuous for scroll and layout, else default. The values are React 19's event priorities
 * (their lanes).
 *
 * @module
 */

/** React's `DiscreteEventPriority` (the sync lane). */
export const DISCRETE_PRIORITY = 2;
/** React's `ContinuousEventPriority`. */
export const CONTINUOUS_PRIORITY = 8;
/** React's `DefaultEventPriority`. */
export const DEFAULT_PRIORITY = 32;
/** React's `NoEventPriority`: none set. */
const NO_PRIORITY = 0;

let current = NO_PRIORITY;
let eventPriority = DEFAULT_PRIORITY;

/** The priority React set (`setCurrentUpdatePriority`), or none. */
export function currentUpdatePriority(): number {
  return current;
}

/** React sets the priority of the updates it is about to make. */
export function setCurrentUpdatePriority(priority: number): void {
  current = priority;
}

/** The priority of an update scheduled now: React's own, else the event's. */
export function resolveUpdatePriority(): number {
  return current !== NO_PRIORITY ? current : eventPriority;
}

/**
 * Run `fn` as the handler of an event of `priority`.
 *
 * @param priority The event's priority.
 * @param fn The dispatch.
 */
export function withEventPriority(priority: number, fn: () => void): void {
  const prev = eventPriority;
  eventPriority = priority;
  try {
    fn();
  } finally {
    eventPriority = prev;
  }
}
