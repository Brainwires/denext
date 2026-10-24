/**
 * Preact's `options` hook object on denext, shared by `denext/preact`, `denext/preact/compat`,
 * `denext/preact/hooks` and `denext/preact/jsx-runtime`. denext calls the hooks it can honour:
 *
 * - `vnode(vnode)` — after each element the Preact entry points create (`h`, `createElement`,
 *   `cloneElement`, the Preact JSX runtime).
 * - `event(e)` — before an event handler an intrinsic element created through those entry
 *   points runs; a non-undefined return value is passed to the handler in the event's place.
 * - `useDebugValue(value)` — from `useDebugValue` in `denext/preact/hooks`.
 *
 * The rest are never called: denext's reconciler does not run Preact's diff, so `diffed`,
 * `unmount`, `requestAnimationFrame`, `debounceRendering`, `__suspenseDidResolve`, `attr`,
 * `_addHookName` and Preact's mangled internal hooks (`__b`, `__r`, `__c`, `__e`, `__h`, …) can
 * be set but have no effect. The vnode passed to `vnode` is denext's element (`type`, `props`,
 * `key`; the `ref` is in `props`), not Preact's internal shape.
 *
 * @module
 */

import type { VNode, VNodeType, VProps } from "../../jsx/types.ts";

/** Preact's `options` hooks (`import { options } from "preact"`). */
export interface Options {
  /** Called with each element the Preact entry points create. */
  vnode?(vnode: VNode): void;
  /** Never called on denext (no unmount hook in its reconciler). */
  unmount?(vnode: VNode): void;
  /** Never called on denext (no per-vnode diff hook in its reconciler). */
  diffed?(vnode: VNode): void;
  /** Called with each DOM event before the handler runs; a returned value replaces the event. */
  event?(e: Event): unknown;
  /** Never called on denext (its scheduler runs effects). */
  requestAnimationFrame?(callback: () => void): void;
  /** Never called on denext (its scheduler batches renders). */
  debounceRendering?(cb: () => void): void;
  /** Called by `useDebugValue` from `denext/preact/hooks`. */
  useDebugValue?(value: string | number): void;
  /** Never called on denext. */
  _addHookName?(name: string | number): void;
  /** Never called on denext. */
  __suspenseDidResolve?(vnode: VNode, cb: () => void): void;
  /** Never called on denext (no precompiled-JSX attribute hook). */
  attr?(name: string, value: unknown): string | void;
  /** Preact's internal hooks may be set; denext never calls them. */
  [hook: string]: unknown;
}

/** The one `options` object every Preact entry point shares. */
export const options: Options = {};

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
  options.vnode?.(vnode);
  return vnode;
}
