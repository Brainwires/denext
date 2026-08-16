/// <reference path="../globals.d.ts" />
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
 * `Suspense`, `lazy` = `dynamic`, `Profiler`, `act`), plus small compat shims for
 * `forwardRef`, `createRef`, `Children`, `cloneElement`, and `isValidElement`. Class
 * components (`Component`/`PureComponent`) are supported when enabled via
 * `classComponents` in the next-compat build (they throw a guided error when off).
 *
 * @module
 */

import {
  createContext,
  dynamic,
  Fragment,
  h,
  memo,
  Profiler,
  startTransition,
  Suspense,
  SuspenseList,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useFormState,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "../../mod.ts";
import { act } from "../client/mod.ts";
import type { Key, VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";
import type {
  ForwardedRef,
  ForwardRefExoticComponent,
  PropsWithoutRef,
  ReactNode,
  RefAttributes,
} from "./react-types.ts";
import {
  brandOf,
  REACT_ELEMENT_TYPE,
  REACT_FORWARD_REF_TYPE,
  REACT_LEGACY_ELEMENT_TYPE,
  TYPEOF_KEY,
} from "../runtime/react-brands.ts";
import { StrictMode } from "../runtime/strict-mode.ts";
// Side-effect: install the un-bundled `globalThis` default so the bare
// `__DENEXT_CLASS_COMPONENTS__` reads below resolve in dev/test (folds out of builds).
import "../runtime/class-flag.ts";
import {
  Component as RealComponent,
  PureComponent as RealPureComponent,
} from "./class-component.ts";

export {
  act,
  createContext,
  Fragment,
  memo,
  Profiler,
  startTransition,
  Suspense,
  SuspenseList,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useFormState,
  useId,
  useImperativeHandle,
  useInsertionEffect,
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
/** The React version denext reports for compatibility (matches the surface it tracks,
 * incl. the now-stable `useEffectEvent` from React 19.2). */
export const version = "19.2.0";
/** `React.StrictMode` — dev double-invoke of renders/effects; a Fragment otherwise. */
export { StrictMode };

// The React-compatible TYPE surface (HTMLAttributes families, forwardRef generics,
// ComponentProps, ElementRef, ReactNode, events, …) so `import type { … } from
// "react"` resolves through the app's react→denext alias.
export type * from "./react-types.ts";
// The `Component` value export below (React's class base) shadows the same-named
// instance interface that `export type *` surfaces, which would leave that interface
// unreachable in the public type graph. Re-export the interface symbol under an
// explicit alias so it stays public and `ComponentClass`'s construct signature can
// reference it. Type-only; no runtime or semantic change.
export type { Component as ComponentInstance } from "./react-types.ts";

/**
 * `React.createRef` — create a mutable ref object `{ current: null }` (used by
 * class components and imperative code).
 *
 * @returns A ref object with a `current` field initialized to `null`.
 */
export function createRef<T = unknown>(): { current: T | null } {
  return { current: null };
}

/**
 * `React.forwardRef` — best-effort. denext threads `ref` through props, so the
 * `render` function receives `(props, props.ref)`.
 *
 * @param render The render function `(props, ref) => element`.
 * @returns A function component.
 */
export function forwardRef<T, P = Record<never, never>>(
  render: (props: P, ref: ForwardedRef<T>) => ReactNode,
): ForwardRefExoticComponent<PropsWithoutRef<P> & RefAttributes<T>> {
  // React's non-callable forwardRef element object: `{ $$typeof, render }`. The
  // renderers resolve it through `resolveComponentType` and invoke `render(props,
  // ref)` (denext threads `ref` via props). The public type is
  // ForwardRefExoticComponent (callable, ref-forwarding, with a settable
  // `displayName`) to match React's `forwardRef<T, P>` — the value is used only as
  // a JSX element type.
  const component = { [TYPEOF_KEY]: REACT_FORWARD_REF_TYPE, render };
  return component as unknown as ForwardRefExoticComponent<PropsWithoutRef<P> & RefAttributes<T>>;
}

/**
 * `React.cache` — memoize a function by its arguments.
 *
 * React's server `cache()` scopes results to a single request via async context;
 * denext already provides that request-scoped variant in `src/server/cache.ts`
 * (which pulls `node:async_hooks`). This is the **client-safe** surface exposed on
 * the `react` package: a plain persistent memo keyed by argument identity, using a
 * nested Map/WeakMap tree (object args keyed by reference, primitives by value) so
 * libraries importing `cache` from `react` resolve and dedupe correctly without
 * dragging server-only APIs into the client bundle.
 *
 * **Lifetime:** unlike React's request-scoped cache, this memo lives for the
 * lifetime of the returned function. Object args are held weakly (GC-able), but
 * distinct **primitive** args accumulate in a Map that is never evicted — so do
 * not wrap a function you call with high-cardinality primitive args (ids,
 * timestamps, query strings) at module scope, or memory will grow unbounded. A
 * throwing `fn` is not cached (it re-runs next call).
 *
 * @param fn The function to memoize.
 * @returns A memoized function returning the cached result for equal arguments.
 */
export function cache<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  interface Node {
    // Present once this node terminates a full argument list.
    hasValue: boolean;
    value: R;
    // Next-argument lookups, split by key kind (object refs vs primitives).
    objects?: WeakMap<object, Node>;
    primitives?: Map<unknown, Node>;
  }
  const root: Node = { hasValue: false, value: undefined as unknown as R };

  return (...args: A): R => {
    let node = root;
    for (const arg of args) {
      if (typeof arg === "object" && arg !== null || typeof arg === "function") {
        node.objects ??= new WeakMap<object, Node>();
        let next = node.objects.get(arg as object);
        if (!next) {
          next = { hasValue: false, value: undefined as unknown as R };
          node.objects.set(arg as object, next);
        }
        node = next;
      } else {
        node.primitives ??= new Map<unknown, Node>();
        let next = node.primitives.get(arg);
        if (!next) {
          next = { hasValue: false, value: undefined as unknown as R };
          node.primitives.set(arg, next);
        }
        node = next;
      }
    }
    if (!node.hasValue) {
      node.value = fn(...args);
      node.hasValue = true;
    }
    return node.value;
  };
}

/**
 * `React.isValidElement` — true only for a value carrying the React element brand
 * (`$$typeof`), matching React. A plain `{ type, props }` object without the brand is
 * rejected, so config/data objects that happen to share that shape are not mistaken
 * for elements.
 *
 * @param value Any value.
 * @returns Whether `value` is a renderable element.
 */
export function isValidElement(value: unknown): value is VNode {
  const b = brandOf(value);
  return b === REACT_ELEMENT_TYPE || b === REACT_LEGACY_ELEMENT_TYPE;
}

/**
 * `React.cloneElement` — shallow-clone `element`, merging `config` over its props and
 * replacing children when any are given. `key` and `ref` are special-cased the way
 * React does: a `key`/`ref` in `config` overrides, otherwise the original element's is
 * preserved, and neither is left in the merged props as a component-visible prop.
 *
 * @param element The element to clone.
 * @param config Props to merge over the element's own (may carry `key`/`ref`).
 * @param children Replacement children (optional).
 * @returns The cloned element.
 */
export function cloneElement(
  element: VNode,
  config?: Record<string, unknown>,
  ...children: VNodeChild[]
): VNode {
  // Start from the original props, then overlay config — but pull key/ref out so they
  // never merge into the component-visible prop bag (React keeps them off props).
  const nextProps: Record<string, unknown> = { ...(element.props as Record<string, unknown>) };
  let key = element.key;
  let ref = (element.props as { ref?: unknown }).ref;
  if (config != null) {
    if (config.key !== undefined) key = config.key as Key;
    if (config.ref !== undefined) ref = config.ref;
    for (const k in config) {
      if (k === "key" || k === "ref") continue;
      nextProps[k] = config[k];
    }
  }
  // Re-attach ref via props (denext threads ref through props.ref), and drop key from
  // props so it stays a top-level field only.
  if (ref !== undefined) nextProps.ref = ref;
  else delete nextProps.ref;
  delete nextProps.key;
  if (children.length > 0) nextProps.children = children.length === 1 ? children[0] : children;
  return { ...element, props: nextProps, key: key ?? null };
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
// when off, they're a stub whose constructor throws a guided error — and because the
// real classes are referenced only inside the bare `__DENEXT_CLASS_COMPONENTS__`
// branch, the off build folds the ternary and drops class-component.ts entirely
// (zero cost). The stub is branded `isReactComponent` so the always-present detector
// (class-detect.ts) still recognizes user subclasses off, routing them to the guided
// error at render rather than an opaque native "cannot invoke class" failure.

/** Stub used when `classComponents` is off — construction throws a guided error. */
class DisabledComponent {
  constructor() {
    throw new Error(
      "denext: class components are disabled. Set `classComponents: true` in " +
        "denext.config.ts to enable them (adds the class runtime to the client bundle).",
    );
  }
}
(DisabledComponent.prototype as { isReactComponent?: unknown }).isReactComponent = true;

/** `React.Component` — real base class when `classComponents` is on, else a guard. */
export const Component: typeof RealComponent = __DENEXT_CLASS_COMPONENTS__
  ? RealComponent
  : (DisabledComponent as unknown as typeof RealComponent);
/** `React.PureComponent` — real when `classComponents` is on, else a guard. */
export const PureComponent: typeof RealPureComponent = __DENEXT_CLASS_COMPONENTS__
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
  createRef,
  cache,
  isValidElement,
  cloneElement,
  Children,
  Component,
  PureComponent,
  memo,
  Profiler,
  createContext,
  Suspense,
  SuspenseList,
  use,
  act,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useFormState,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
};
