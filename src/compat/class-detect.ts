/**
 * Tiny, always-present class-component detection — the counterpart to the heavy,
 * gated {@link "./class-component.ts"} runtime.
 *
 * This module is intentionally *not* behind the `__DENEXT_CLASS_COMPONENTS__` gate:
 * even in a function-only build, every render call site cheaply checks
 * {@link isClassComponent} so that a class component used with the flag off produces
 * a guided error ({@link classComponentsDisabledError}) instead of the opaque native
 * "Class constructor cannot be invoked without 'new'". The detection is a single
 * prototype lookup and the error is one string — the *runtime* (lifecycle, setState
 * batching, reconciliation) still lives entirely in `class-component.ts` and is
 * dead-code-eliminated when off.
 *
 * @module
 */

// deno-lint-ignore no-explicit-any -- prototype probing over arbitrary component types.
type Any = any;

/**
 * Whether `type` is a React class component. React marks
 * `Component.prototype.isReactComponent` (an object, so old Jest automock that
 * stripped primitive props still left it); denext's `Component` — and the
 * off-build `DisabledComponent` stub — brand the same way, so this recognizes user
 * subclasses under both settings.
 *
 * @param type A component type (function or class).
 * @returns True for a class extending denext's `Component`/`PureComponent`.
 */
export function isClassComponent(type: unknown): boolean {
  return typeof type === "function" &&
    !!(type as Any).prototype &&
    (type as Any).prototype.isReactComponent != null;
}

/**
 * The error thrown when a class component is rendered while `classComponents` is
 * off — names the exact fix.
 *
 * @returns An `Error` guiding the user to enable `classComponents`.
 */
export function classComponentsDisabledError(): Error {
  return new Error(
    "denext: class components are disabled. Set `classComponents: true` in " +
      "denext.config.ts to enable them (adds the class runtime to the client bundle).",
  );
}
