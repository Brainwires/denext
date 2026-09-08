// Client-reconciler seam for `<ViewTransition>` per-element marking. The navigation runtime
// drives a view transition THROUGH this null-default slot, so the always-shipped navigation
// / reconciler code never statically imports the marking logic (view-transition-runtime.ts).
// The generated entry installs the real support (installViewTransitionSupport) ONLY when a
// build scan sees `<ViewTransition>`, so `deno bundle` tree-shakes the marking runtime out of
// an app that never renders one — the same lever the class-component, Activity and Live seams
// use. Without it installed, a `<ViewTransition>` is a transparent passthrough and only the
// route-level cross-fade (navigation.ts always wraps the commit in startViewTransition) applies.

/**
 * One in-flight view transition's marking handle. Scoped per transition (not module-global) so
 * overlapping navigations — a second nav starting while a first is mid-flight — don't share one
 * set of stamped elements: each `begin()` owns its own, so one transition's `clear()` can't wipe
 * another's names (which would silently break the second's shared-element morph).
 */
export interface ActiveViewTransition {
  /** Stamp the now-current (incoming) hosts, inside the transition callback after the commit. */
  markIncoming(): void;
  /** Remove every stamp THIS transition applied (called when the transition finishes). */
  clear(): void;
}

/** The per-element view-transition marking the navigation runtime drives. */
export interface ViewTransitionSupport {
  /**
   * Stamp the CURRENT (outgoing) hosts now (before `startViewTransition`, so the old-state
   * capture sees the names) with `types` fixed for this transition, and return a handle whose
   * `markIncoming`/`clear` operate only on this transition's own elements.
   */
  begin(types: readonly string[]): ActiveViewTransition;
}

let support: ViewTransitionSupport | null = null;

/** Install (or clear, with `null`) the view-transition marking runtime. */
export function setViewTransitionSupport(s: ViewTransitionSupport | null): void {
  support = s;
}

/** The installed marking runtime, or null when the app doesn't use `<ViewTransition>`. */
export function getViewTransitionSupport(): ViewTransitionSupport | null {
  return support;
}

// Transition types (`addTransitionType`) buffer. Always shipped (React's addTransitionType is
// a public API on the barrel), so it collects types regardless of the gate; the navigation
// runtime drains them into `startViewTransition({ types })` and the marking runtime resolves
// per-type `enter`/`exit` class maps against them. A no-op accumulator when unused.
let pendingTypes: string[] = [];

/** Add a type to the next view transition (`React.addTransitionType`). */
export function addTransitionType(type: string): void {
  if (!pendingTypes.includes(type)) pendingTypes.push(type);
}

/**
 * Drain the buffered transition types (the navigation runtime calls this once per transition and
 * passes the result to {@link ViewTransitionSupport.begin}, which fixes them for that transition).
 */
export function takeTransitionTypes(): string[] {
  if (pendingTypes.length === 0) return pendingTypes;
  const t = pendingTypes;
  pendingTypes = [];
  return t;
}
