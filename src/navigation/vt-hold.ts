/**
 * Holding off the router's View Transition while a navigator shows a kept screen itself (a
 * claimed pop, a tab switch): the router still re-renders the route in the background, and
 * that commit must not freeze the page for a transition in the middle of the navigator's own
 * animation.
 *
 * @module
 */

/** Outstanding holds. */
let holds = 0;

/** Whether this browser runs same-document View Transitions right now. */
export function viewTransitionsOn(): boolean {
  return typeof document !== "undefined" &&
    typeof (document as { startViewTransition?: unknown }).startViewTransition === "function";
}

/**
 * Hide `document.startViewTransition` (an own property shadowing the prototype's) until the
 * returned release runs, so the router's next commit lands directly. Nested holds release
 * together; each release is idempotent. A no-op where View Transitions are missing.
 */
export function suspendViewTransitions(): () => void {
  if (typeof document === "undefined") return () => {};
  const doc = document as unknown as Record<string, unknown>;
  if (holds === 0) {
    if (typeof doc.startViewTransition !== "function") return () => {};
    try {
      Object.defineProperty(doc, "startViewTransition", {
        value: undefined,
        configurable: true,
        writable: true,
      });
    } catch {
      return () => {};
    }
  }
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) delete doc.startViewTransition;
  };
}
