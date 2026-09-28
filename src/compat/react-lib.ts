/**
 * The `react` module third-party code gets in a compat build: denext's (`./react.ts`), with
 * `createElement` and `cloneElement` recording each component element as a library element,
 * which keeps React's re-render semantics (`src/runtime/library-elements.ts`). App code uses
 * `./react.ts`.
 *
 * @module
 */

import React, {
  cloneElement as appCloneElement,
  createElement as appCreateElement,
} from "./react.ts";
import { markLibraryElement } from "../runtime/library-elements.ts";

export * from "./react.ts";

/** `React.createElement` for third-party code: a library element. */
export const createElement: typeof appCreateElement = (type, props, ...children) =>
  markLibraryElement(appCreateElement(type, props, ...children));

/** `React.cloneElement` for third-party code: a library element. */
export const cloneElement: typeof appCloneElement =
  ((element: unknown, ...rest: unknown[]) =>
    markLibraryElement(
      (appCloneElement as (...a: unknown[]) => unknown)(element, ...rest),
    )) as typeof appCloneElement;

/** The default `React` namespace object, with the library `createElement` / `cloneElement`. */
export default { ...React, createElement, cloneElement };
