// Elements created by third-party code (npm packages) keep React's re-render semantics.
//
// denext skips re-rendering a component whose props are shallow-equal (every function component
// is implicitly `memo()`-wrapped, KNOWN-DIFFERENCES.md). App code is written for that, but a
// library written for React may rely on a child re-rendering whenever the library's component
// does: React Navigation's `useComponent` content reads the navigator's latest render function
// from a ref, so skipping it froze expo-router/ui's tabs on their first screen. The compat build
// resolves `react` and `react/jsx-runtime` for importers inside `node_modules` to variants whose
// `createElement` / `jsx` mark the element ({@linkcode LIBRARY_ELEMENT}) (`src/compat/react-lib.ts`,
// `src/jsx/jsx-runtime-lib.ts`); the reconciler then skips such an element's component only
// when its props object is the very one it rendered (React's own bailout: the parent did not
// re-render), unless the component is a `memo()`.

/**
 * The mark a library element carries (a symbol key: never serialized, and a plain property read
 * in the reconciler, which keeps this module out of bundles that never create one).
 */
export const LIBRARY_ELEMENT: unique symbol = Symbol.for("dnx.lib") as never;

/**
 * Mark `element` as created by third-party code, when its type is a component.
 *
 * @param element The element `createElement` / `jsx` just built.
 * @returns The element.
 */
export function markLibraryElement<T>(element: T): T {
  const type = (element as { type?: unknown }).type;
  if (typeof type === "function" || (typeof type === "object" && type !== null)) {
    (element as Record<symbol, unknown>)[LIBRARY_ELEMENT] = true;
  }
  return element;
}

/**
 * Whether `element` was created by third-party code (see {@linkcode markLibraryElement}).
 *
 * @param element A vnode.
 * @returns Whether it keeps React's re-render semantics.
 */
export function isLibraryElement(element: object): boolean {
  return (element as Record<symbol, unknown>)[LIBRARY_ELEMENT] === true;
}
