// Client-reconciler seam for `<ViewTransition>` per-element marking. The navigation runtime
// drives a view transition THROUGH this null-default slot, so the always-shipped navigation
// / reconciler code never statically imports the marking logic (view-transition-runtime.ts).
// The generated entry installs the real support (installViewTransitionSupport) ONLY when a
// build scan sees `<ViewTransition>`, so `deno bundle` tree-shakes the marking runtime out of
// an app that never renders one — the same lever the class-component, Activity and Live seams
// use. Without it installed, a `<ViewTransition>` is a transparent passthrough and only the
// route-level cross-fade (navigation.ts always wraps the commit in startViewTransition) applies.

/** The per-element view-transition marking the navigation runtime drives. */
export interface ViewTransitionSupport {
  /** Stamp `view-transition-name` (+ classes) on the CURRENT (outgoing) hosts, before capture. */
  markOutgoing(): void;
  /** Stamp them on the now-current (incoming) hosts, inside the transition callback post-commit. */
  markIncoming(): void;
  /** Remove every stamp this transition applied (called when the transition finishes). */
  clear(): void;
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

/** Drain the buffered transition types (the navigation runtime calls this per transition). */
export function takeTransitionTypes(): string[] {
  if (pendingTypes.length === 0) return pendingTypes;
  const t = pendingTypes;
  pendingTypes = [];
  return t;
}

// The types active for the transition currently being set up — navigation drains
// pendingTypes and records them here so the marking runtime (a separate gated module) can
// resolve per-type `enter`/`exit`/`update`/`share` class maps against them.
let activeTypes: readonly string[] = [];

/** Record the types for the in-flight transition (navigation sets this per transition). */
export function setActiveTransitionTypes(types: readonly string[]): void {
  activeTypes = types;
}

/** The in-flight transition's types (the marking runtime resolves class maps against these). */
export function getActiveTransitionTypes(): readonly string[] {
  return activeTypes;
}
