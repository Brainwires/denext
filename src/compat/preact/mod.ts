/**
 * `denext/preact` — Preact's core API (`preact`) on denext, for code written against Preact
 * (a Fresh app's components and islands): `h` / `createElement`, `Fragment`, `Component`,
 * `createContext`, `createRef`, `cloneElement`, `isValidElement`, `toChildArray`, `render`,
 * `hydrate`, `createPortal` (in Preact's core since Preact 11), `options`, and Preact's type
 * names (`ComponentChildren`, `FunctionComponent`, `RenderableProps`, `JSX`, …).
 * `denext migrate --from fresh` maps `preact` here.
 *
 * `options.vnode` and `options.event` are called for the elements these entry points (and
 * `denext/preact/jsx-runtime`) create; Preact's other `options` hooks (`diffed`, `unmount`,
 * `debounceRendering`, `requestAnimationFrame` and the internal ones) are never called, and
 * the `preact/debug` / `preact/devtools` add-ons are not provided.
 *
 * @module
 */

import { h as coreH } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren, VNodeType, VProps } from "../../jsx/types.ts";
import { Children, cloneElement as coreCloneElement } from "../../runtime/react-core.ts";
import type { ComponentClass, FunctionComponent, RefObject } from "../react-types.ts";
import { createdVNode, eventProps } from "./options.ts";

export { Component, createContext, createRef, Fragment, isValidElement } from "../react.ts";
export { createPortal, hydrate, render } from "../react-dom.ts";
export { type Options, options } from "./options.ts";

/**
 * Create an element (Preact's `h` / `createElement`): `h(type, props, ...children)`. The
 * element goes through `options.vnode`, and an intrinsic element's handlers through
 * `options.event` while that hook is set.
 *
 * @param type The element type: a tag name, a component or `Fragment`.
 * @param props Its props, or `null`.
 * @param children Its children.
 * @returns The element.
 */
export function h(type: VNodeType, props: VProps | null, ...children: VNodeChildren[]): VNode {
  return createdVNode(coreH(type, eventProps(type, props), ...children));
}

/** Preact's `createElement`: the same function as {@link h}. */
export const createElement: typeof h = h;

/**
 * Copy an element with props merged over its own and, when given, new children (Preact's
 * `cloneElement`). The copy goes through `options.vnode`.
 *
 * @param element The element to copy.
 * @param props Props to merge over its own.
 * @param children New children.
 * @returns The copy.
 */
export function cloneElement<P>(
  element: VNode,
  props?: Partial<P> | null,
  ...children: VNodeChildren[]
): VNode {
  const merged = eventProps(element.type, (props ?? null) as VProps | null);
  return createdVNode(coreCloneElement(element, merged as never, ...(children as VNodeChild[])));
}

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
