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
import { brand, REACT_FORWARD_REF_TYPE } from "../runtime/react-brands.ts";
import { CLASS_COMPONENTS_ENABLED } from "../runtime/class-flag.ts";
import {
  Component as RealComponent,
  PureComponent as RealPureComponent,
} from "./class-component.ts";

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
  // Brand so `react-is.isForwardRef` (and libraries reading `$$typeof`, e.g.
  // Radix `Slot`) recognize it; `render` is exposed as React does.
  brand(component, REACT_FORWARD_REF_TYPE, { render });
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

// Class components are gated by `classComponents` (denext.config.ts). When enabled,
// `Component`/`PureComponent` are the real class runtime (from class-component.ts);
// when off, they're a stub whose constructor throws a guided error — and because
// the real classes are referenced only inside the `CLASS_COMPONENTS_ENABLED` branch,
// the off build folds the ternary and drops class-component.ts entirely (zero cost).

/** Stub used when `classComponents` is off — construction throws a guided error. */
class DisabledComponent {
  constructor() {
    throw new Error(
      "denext: class components are disabled. Set `classComponents: true` in " +
        "denext.config.ts to enable them (adds the class runtime to the client bundle).",
    );
  }
}

/** `React.Component` — real base class when `classComponents` is on, else a guard. */
export const Component: typeof RealComponent = CLASS_COMPONENTS_ENABLED
  ? RealComponent
  : (DisabledComponent as unknown as typeof RealComponent);
/** `React.PureComponent` — real when `classComponents` is on, else a guard. */
export const PureComponent: typeof RealPureComponent = CLASS_COMPONENTS_ENABLED
  ? RealPureComponent
  : (DisabledComponent as unknown as typeof RealPureComponent);

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
  PureComponent,
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
