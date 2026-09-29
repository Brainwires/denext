/**
 * The automatic JSX runtime third-party code gets in a compat build: denext's
 * ({@link jsx}, {@link jsxs}, {@link jsxDEV}, {@link Fragment}), with each component element
 * recorded as a library element, which keeps React's re-render semantics
 * (`src/runtime/library-elements.ts`). App code uses `denext/jsx-runtime`.
 *
 * @module
 */

import type { Key, VNode, VNodeChildren, VNodeType, VProps } from "./types.ts";
import { Fragment, jsx as appJsx } from "./jsx-runtime.ts";
import { markLibraryElement } from "../runtime/library-elements.ts";

export { Fragment };

/** `jsx` for third-party code: a library element. */
export function jsx(
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
): VNode {
  return markLibraryElement(appJsx(type, props, key));
}

/** `jsxs` for third-party code: a library element. */
export const jsxs: typeof jsx = jsx;

/** `jsxDEV` for third-party code: a library element (the dev-only arguments are ignored). */
export function jsxDEV(
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
): VNode {
  return markLibraryElement(appJsx(type, props, key));
}
