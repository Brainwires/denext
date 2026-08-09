/**
 * React-compatible entrypoint for denext.
 *
 * Alias `react` to this module in your project's import map so code (and
 * libraries) that `import ... from "react"` run on denext's runtime:
 *
 * ```jsonc
 * // deno.json
 * "imports": {
 *   "react": "jsr:@denext/denext/react",
 *   "react/jsx-runtime": "jsr:@denext/denext/react/jsx-runtime"
 * }
 * ```
 *
 * It re-exports denext's hooks and helpers under their React names
 * (`createElement`, `Fragment`, all the `use*` hooks, `memo`, `createContext`,
 * `Suspense`, `lazy` = `dynamic`), plus small compat shims for `forwardRef`,
 * `Children`, `cloneElement`, and `isValidElement`. Class components are **not**
 * supported (denext is function-components only) — `Component`/`PureComponent`
 * exist so imports resolve, but throw if constructed.
 *
 * @module
 */

import {
  createContext,
  dynamic,
  Fragment,
  h,
  memo,
  startTransition,
  Suspense,
  use,
  useActionState,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "../../mod.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";

export {
  createContext,
  Fragment,
  memo,
  startTransition,
  Suspense,
  use,
  useActionState,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
};

/** `React.createElement` — denext's hyperscript. */
export const createElement: typeof h = h;
/** `React.lazy` — denext's `dynamic()`. */
export const lazy: typeof dynamic = dynamic;
/** The React version denext reports for compatibility. */
export const version = "19.0.0";
/** `StrictMode` — a no-op passthrough in denext. */
export const StrictMode: typeof Fragment = Fragment;

/**
 * `React.forwardRef` — best-effort. denext threads `ref` through props, so the
 * `render` function receives `(props, props.ref)`.
 *
 * @param render The render function `(props, ref) => element`.
 * @returns A function component.
 */
export function forwardRef<P>(render: (props: P, ref: unknown) => VNode): (props: P) => VNode {
  const component = (props: P) => render(props, (props as { ref?: unknown }).ref ?? null);
  try {
    Object.defineProperty(component, "name", {
      value: (render as { name?: string }).name || "ForwardRef",
    });
  } catch { /* name is read-only on some engines */ }
  return component;
}

/**
 * `React.isValidElement` — true for a denext VNode.
 *
 * @param value Any value.
 * @returns Whether `value` is a renderable element.
 */
export function isValidElement(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/**
 * `React.cloneElement` — shallow-clone `element`, merging `props` and replacing
 * children when any are given.
 *
 * @param element The element to clone.
 * @param props Props to merge over the element's own.
 * @param children Replacement children (optional).
 * @returns The cloned element.
 */
export function cloneElement(
  element: VNode,
  props?: Record<string, unknown>,
  ...children: VNodeChild[]
): VNode {
  const nextProps = { ...(element.props as Record<string, unknown>), ...props };
  if (children.length > 0) nextProps.children = children.length === 1 ? children[0] : children;
  return { ...element, props: nextProps };
}

function toChildArray(children: VNodeChildren): VNodeChild[] {
  const out: VNodeChild[] = [];
  const walk = (c: VNodeChild | VNodeChildren) => {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) c.forEach(walk);
    else out.push(c as VNodeChild);
  };
  walk(children as VNodeChild);
  return out;
}

/** The `React.Children` utility surface. */
export interface ChildrenApi {
  /** Map over children (flattening arrays/holes). */
  map<T>(children: VNodeChildren, fn: (child: VNodeChild, index: number) => T): T[];
  /** Iterate over children. */
  forEach(children: VNodeChildren, fn: (child: VNodeChild, index: number) => void): void;
  /** Count the children. */
  count(children: VNodeChildren): number;
  /** Children as a flat array. */
  toArray(children: VNodeChildren): VNodeChild[];
  /** The single child, or throw. */
  only(children: VNodeChildren): VNodeChild;
}

/** `React.Children` utilities over denext children. */
export const Children: ChildrenApi = {
  /** Map over children (flattening arrays/holes), like `React.Children.map`. */
  map<T>(children: VNodeChildren, fn: (child: VNodeChild, index: number) => T): T[] {
    return toChildArray(children).map(fn);
  },
  /** Iterate over children, like `React.Children.forEach`. */
  forEach(children: VNodeChildren, fn: (child: VNodeChild, index: number) => void): void {
    toChildArray(children).forEach(fn);
  },
  /** Count the children, like `React.Children.count`. */
  count(children: VNodeChildren): number {
    return toChildArray(children).length;
  },
  /** Children as a flat array, like `React.Children.toArray`. */
  toArray(children: VNodeChildren): VNodeChild[] {
    return toChildArray(children);
  },
  /** The single child, or throw — like `React.Children.only`. */
  only(children: VNodeChildren): VNodeChild {
    const arr = toChildArray(children);
    if (arr.length !== 1) throw new Error("React.Children.only expected exactly one child");
    return arr[0];
  },
};

/**
 * Class components are not supported by denext (function components only). This
 * exists so `import { Component } from "react"` resolves; constructing it throws.
 */
export class Component {
  constructor() {
    throw new Error(
      "denext has no class components — use a function component. " +
        "(React.Component exists only so imports resolve.)",
    );
  }
}
export { Component as PureComponent };

/** The default `React` namespace object (`import React from "react"`). */
export default {
  createElement,
  Fragment,
  lazy,
  version,
  StrictMode,
  forwardRef,
  isValidElement,
  cloneElement,
  Children,
  Component,
  PureComponent: Component,
  memo,
  createContext,
  Suspense,
  use,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
};
