/**
 * Preact's `options` hook object on denext, shared by `denext/preact`, `denext/preact/compat`,
 * `denext/preact/hooks` and `denext/preact/jsx-runtime`. denext calls the hooks where Preact does:
 *
 * - `vnode(vnode)` — after each element the Preact entry points create (`h`, `createElement`,
 *   `cloneElement`, the Preact JSX runtime).
 * - `event(e)` — before an event handler an intrinsic element created through those entry
 *   points runs; a non-undefined return value is passed to the handler in the event's place.
 * - `useDebugValue(value)` — from `useDebugValue` in `denext/preact/hooks`.
 * - `attr(name, value)` — from `jsxAttr` in `denext/preact/jsx-runtime` (precompiled JSX); a
 *   returned string replaces the attribute's HTML.
 * - `_diff` / `__b(vnode)` — as each element is created through those entry points, after
 *   `vnode` (denext has no per-vnode diff to call it before).
 * - `_render` / `__r(vnode)` — before each component renders, in the browser.
 * - `diffed(vnode)` — for each component, element and text node a commit rendered or changed,
 *   once its DOM is in place, children before their parent (before layout effects run).
 * - `_commit` / `__c(rootVNode, [])` — once per commit, after its layout effects.
 * - `unmount(vnode)` — for each component, element and text node removed, parent first, before
 *   its cleanups run.
 * - `debounceRendering(cb)` — schedules the render a state update needs (default: a microtask).
 * - `requestAnimationFrame(cb)` — schedules the `useEffect` flush after a commit (default: a task).
 *
 * The vnode each hook gets is denext's element (`type`, `props`, `key`; the `ref` is in
 * `props`), not Preact's internal shape (`_children`, `_component`, `_dom`), so a tool that walks
 * Preact's internals (the `preact/devtools` bridge) finds nothing to read; `_catchError` / `__e`,
 * `_hook` / `__h`, `_root` / `__`, `_addHookName` and `__suspenseDidResolve` can be set but are
 * not called.
 *
 * @module
 */

import type { VNode, VNodeType, VProps } from "../../jsx/types.ts";
import {
  type PreactOptionHooks,
  setPreactOptions,
} from "../../client/fiber/preact-options-seam.ts";

/** Preact's `options` hooks (`import { options } from "preact"`). */
export interface Options {
  /** Called with each element the Preact entry points create. */
  vnode?(vnode: VNode): void;
  /** Called with each vnode removed from the tree, parent first. */
  unmount?(vnode: VNode): void;
  /** Called with each vnode a commit rendered or changed, once its DOM is in place. */
  diffed?(vnode: VNode): void;
  /** Called with each DOM event before the handler runs; a returned value replaces the event. */
  event?(e: Event): unknown;
  /** Schedules the `useEffect` flush after a commit (default: a task). */
  requestAnimationFrame?(callback: () => void): void;
  /** Schedules the render a state update needs (default: a microtask). */
  debounceRendering?(cb: () => void): void;
  /** Called by `useDebugValue` from `denext/preact/hooks`. */
  useDebugValue?(value: string | number): void;
  /** Never called on denext. */
  _addHookName?(name: string | number): void;
  /** Never called on denext. */
  __suspenseDidResolve?(vnode: VNode, cb: () => void): void;
  /** Called by `jsxAttr` (precompiled JSX); a returned string is the attribute's HTML. */
  attr?(name: string, value: unknown): string | void;
  /** Before each component renders (mangled `__r`). */
  _render?(vnode: VNode): void;
  /** After each commit (mangled `__c`), with the root vnode and an empty commit queue. */
  _commit?(vnode: VNode, commitQueue: unknown[]): void;
  /** Preact's other internal hooks may be set; denext does not call them. */
  [hook: string]: unknown;
}

/** The one `options` object every Preact entry point shares. */
export const options: Options = {};

// The reconciler reads the render, diff, commit, unmount and scheduling hooks off this object.
setPreactOptions(options as PreactOptionHooks);

/** Each handler's event-hook wrapper, so a re-render keeps the same function. */
const wrapped = new WeakMap<(e: Event) => unknown, (e: Event) => unknown>();

/** `handler` behind {@link Options.event}, read when the event fires. */
function eventWrapper(handler: (e: Event) => unknown): (e: Event) => unknown {
  let w = wrapped.get(handler);
  if (!w) {
    w = function (this: unknown, e: Event) {
      const replaced = options.event ? options.event(e) : undefined;
      return handler.call(this, (replaced === undefined ? e : replaced) as Event);
    };
    wrapped.set(handler, w);
  }
  return w;
}

/** An event prop (`onClick`, `onclick`, `onPointerDownCapture`). */
const EVENT_PROP = /^on./;

/**
 * An intrinsic element's props with each handler routed through {@link Options.event} (only
 * while that hook is set; otherwise `props` is returned as it is).
 *
 * @param type The element type.
 * @param props Its props.
 * @returns The props to create the element with.
 */
export function eventProps(type: VNodeType, props: VProps | null): VProps | null {
  if (!options.event || typeof type !== "string" || props === null) return props;
  let out: Record<string, unknown> | null = null;
  for (const name in props) {
    const value = (props as Record<string, unknown>)[name];
    if (typeof value !== "function" || !EVENT_PROP.test(name)) continue;
    out ??= { ...props };
    out[name] = eventWrapper(value as (e: Event) => unknown);
  }
  return (out ?? props) as VProps;
}

/**
 * Hand a newly created element to {@link Options.vnode}.
 *
 * @param vnode The element.
 * @returns The same element.
 */
export function createdVNode(vnode: VNode): VNode {
  elementHook?.(vnode);
  options.vnode?.(vnode);
  // Preact's `_diff` (mangled `__b`) runs before a vnode is diffed; denext has no per-vnode diff,
  // so it runs as the element is created, before any render reads its props (what class-name
  // rewriters such as Fresh's twind plugin rely on).
  const diff = (options.__b ?? options._diff) as ((v: VNode) => void) | undefined;
  diff?.(vnode);
  return vnode;
}

/** An internal hook run before `options.vnode` (Fresh's `csp({ useNonce })` sets one). */
let elementHook: ((vnode: VNode) => void) | null = null;

/**
 * Set the internal element hook {@link createdVNode} runs before `options.vnode`, which an app's
 * own `options.vnode` cannot replace.
 *
 * @param hook The hook, or null.
 */
export function setElementHook(hook: ((vnode: VNode) => void) | null): void {
  elementHook = hook;
}
