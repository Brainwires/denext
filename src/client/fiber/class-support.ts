// Client-reconciler seam for the React class-component runtime. The reconciler calls
// class support THROUGH this null-default slot so its prod-shipped modules never
// statically import src/compat/class-component.ts (the reconciler half, ~2.5 KB). That
// module ships as the on-demand `denext/class-runtime` chunk: the generated route/Flight
// entry installs it statically when the build scan saw a class in the app's own sources,
// and otherwise loads it (`loadClassRuntime`, class-loader.ts) before hydrating when the
// server-rendered document carries the `#__denext_classes` marker — so a function-only
// page never fetches it, the same lever the DevTools-bridge and Live seams use.
//
// A top-level self-install in class-component.ts is impossible: the `Component` base the
// `react` alias imports lives in class-base.ts precisely so nothing in the main graph
// references the runtime module. Hence the install is entry-emitted (or lazily loaded).

// Types only — and from the EAGER base module: a type edge to class-component.ts would make the
// bundler treat the on-demand runtime as shared by the main graph and hoist it out of its chunk.
import type { ClassRenderResult, ReconcilerInstance } from "../../compat/class-base.ts";

/** The class-runtime functions the client reconciler calls. Supplied by class-component.ts. */
export interface ClassSupport {
  handleClassError(
    inst: ReconcilerInstance,
    error: unknown,
    info: { componentStack?: string },
  ): boolean;
  renderClassInstance(inst: ReconcilerInstance): ClassRenderResult;
  hasErrorLifecycle(type: unknown): boolean;
  captureSnapshot(inst: ReconcilerInstance): void;
  unmountClassInstance(inst: ReconcilerInstance): void;
}

let support: ClassSupport | null = null;

/** Install (or clear, with `null`) the class runtime. Called by installClassSupport(). */
export function setClassSupport(s: ClassSupport | null): void {
  support = s;
}

/** The installed class runtime, or null in a function-only bundle. */
export function getClassSupport(): ClassSupport | null {
  return support;
}

// Reverse dependency: class `setState`/`forceUpdate` re-render via the reconciler's
// scheduler. The reconciler injects it here at init; class-component.ts reads it. Kept in
// the seam so neither side statically imports the other. No-op default (safe on the SSR
// render path, which never schedules a client update).
// deno-lint-ignore no-explicit-any -- matches the reconciler's Fiber/Instance type.
let classScheduleUpdate: (inst: any) => void = () => {};

/** Register the reconciler's `scheduleUpdate` for class setState/forceUpdate (at init). */
// deno-lint-ignore no-explicit-any -- matches the reconciler's Fiber/Instance type.
export function setClassScheduleUpdate(fn: (inst: any) => void): void {
  classScheduleUpdate = fn;
}

/** The reconciler's `scheduleUpdate`, for class-component.ts's setState/forceUpdate. */
// deno-lint-ignore no-explicit-any -- matches the reconciler's Fiber/Instance type.
export function getClassScheduleUpdate(): (inst: any) => void {
  return classScheduleUpdate;
}
