/**
 * React-compatible `react-dom` entrypoint for denext.
 *
 * Alias `react-dom` to this module in your import map:
 *
 * ```jsonc
 * "imports": { "react-dom": "jsr:@denext/denext/react-dom" }
 * ```
 *
 * It exposes the React 18+ client API (`createRoot`, `hydrateRoot`, `flushSync`),
 * legacy `render`/`hydrate` wrappers, and a working client-side `createPortal`.
 *
 * @module
 */

import { REACT_COMPAT_VERSION } from "./react-version.ts";
import { createPortal, createRoot, flushSync, hydrateRoot, type Root } from "../client/mod.ts";
import type { VNode } from "../jsx/types.ts";
import {
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
} from "./react-dom-preload.ts";
import { useFormState, useFormStatus } from "../runtime/actions.ts";

export { createPortal, createRoot, flushSync, hydrateRoot };
export {
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
} from "./react-dom-preload.ts";
export type {
  PreconnectOptions,
  PreinitOptions,
  PreloadModuleOptions,
  PreloadOptions,
} from "./react-dom-preload.ts";
// React 19 ships these form hooks from `react-dom` (not `react`); libraries that
// import them from here must resolve to denext's implementations.
export { useFormState, useFormStatus } from "../runtime/actions.ts";
export type { FormStatus } from "../runtime/actions.ts";

/** The React version denext reports for compatibility (aligned with `react`'s
 * reported version — the 19.2 surface it tracks). */
export const version: string = REACT_COMPAT_VERSION;

/**
 * `ReactDOM.unstable_batchedUpdates` — denext already batches state updates
 * (`scheduleUpdate` coalesces them into one microtask flush), so this simply runs
 * `fn(arg)`. Provided so libraries that import it (dnd-kit, react-redux, …) resolve.
 *
 * @param fn The function whose updates are (already) batched.
 * @param arg Optional argument passed to `fn`.
 * @returns Whatever `fn` returns.
 */
export function unstable_batchedUpdates<A, R>(fn: (a: A) => R, arg?: A): R {
  return fn(arg as A);
}

/**
 * Legacy `ReactDOM.render` — wraps `createRoot(container).render(element)`.
 *
 * @param element The element to render.
 * @param container The mount container.
 * @returns The created root.
 */
export function render(element: VNode, container: Element): Root {
  const root = createRoot(container);
  root.render(element);
  return root;
}

/**
 * Legacy `ReactDOM.hydrate` — wraps `hydrateRoot(container, element)`.
 *
 * @param element The element to hydrate.
 * @param container The container holding server markup.
 * @returns The created root.
 */
export function hydrate(element: VNode, container: Element): Root {
  return hydrateRoot(container, element);
}

/** The default `ReactDOM` namespace object (`import ReactDOM from "react-dom"`). */
export default {
  createRoot,
  hydrateRoot,
  flushSync,
  render,
  hydrate,
  createPortal,
  unstable_batchedUpdates,
  preload,
  preloadModule,
  preinit,
  preinitModule,
  preconnect,
  prefetchDNS,
  requestFormReset,
  useFormStatus,
  useFormState,
  version,
};
