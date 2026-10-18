/**
 * `denext/preact` — Preact's core API (`preact`) on denext, for code written against Preact
 * (a Fresh app's components and islands): `h` / `createElement`, `Fragment`, `Component`,
 * `createContext`, `createRef`, `cloneElement`, `isValidElement`, `toChildArray`, `render`,
 * `hydrate`, `options`, and Preact's type names (`ComponentChildren`, `FunctionComponent`,
 * `RenderableProps`, `JSX`, …). `denext migrate --from fresh` maps `preact` here.
 *
 * Not provided: Preact's `options` render hooks (the object exists, nothing reads it) and the
 * `preact/debug` / `preact/devtools` add-ons.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../../jsx/types.ts";
import { Children } from "../../runtime/react-core.ts";
import type { ComponentClass, FunctionComponent, RefObject } from "../react-types.ts";

export {
  cloneElement,
  Component,
  createContext,
  createElement,
  createRef,
  Fragment,
  isValidElement,
} from "../react.ts";
export { hydrate, render } from "../react-dom.ts";
export { h };

export type { JSX } from "../../jsx/types.ts";
export type {
  Attributes,
  ComponentProps,
  ComponentType,
  Context,
  FunctionComponent,
  Ref,
  RefCallback,
  RefObject,
} from "../react-types.ts";
export type { VNode };

/** Preact's name for anything renderable as a child. */
export type ComponentChildren = VNodeChildren;
/** Preact's name for one child. */
export type ComponentChild = VNodeChild;
/** Preact's older name for {@link FunctionComponent}. */
export type FunctionalComponent<P = Record<never, never>> = FunctionComponent<P>;
/** A function or class component. */
export type AnyComponent<P = Record<never, never>> = FunctionComponent<P> | ComponentClass<P>;
/** A component's props as it receives them: its own plus `children` and `ref`. */
export type RenderableProps<P, RefType = unknown> =
  & P
  & { children?: ComponentChildren; ref?: RefObject<RefType> | ((instance: RefType) => void) };
/** Preact's context object type. */
export type PreactContext<T> = import("../react-types.ts").Context<T>;

/**
 * Flatten `children` into an array of renderable children (Preact's `toChildArray`): nested
 * arrays are flattened and `null` / `undefined` / booleans dropped.
 *
 * @param children The children.
 * @returns The children as a flat array.
 */
export function toChildArray(children: ComponentChildren): VNodeChild[] {
  return Children.toArray(children) as VNodeChild[];
}

/**
 * Preact's `options` hook object. It exists so code that sets a hook loads, but denext's
 * renderer never calls them.
 */
export const options: Record<string, unknown> = {};
