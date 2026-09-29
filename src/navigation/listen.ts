/**
 * Attach a set of DOM listeners at once and get one function that removes them all (the
 * gestures bind pointer events in groups).
 *
 * @module
 */

/** An element (or anything) that takes DOM listeners. */
export interface ListenerTarget {
  addEventListener(
    type: string,
    fn: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    fn: (event: Event) => void,
    options?: EventListenerOptions,
  ): void;
}

/**
 * Add every `type → handler` of `handlers` to `target`; returns the function that removes them.
 * Handlers take the event's fields they read (a pointer event's `clientX`, …).
 */
export function listenAll(
  target: ListenerTarget,
  // deno-lint-ignore no-explicit-any -- each handler reads its own event shape.
  handlers: Record<string, (event: any) => void>,
): () => void {
  const pairs = Object.entries(handlers) as Array<[string, (event: Event) => void]>;
  for (const [type, fn] of pairs) target.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of pairs) target.removeEventListener(type, fn);
  };
}
