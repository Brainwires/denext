/**
 * `denext/preact/compat` — `preact/compat` on denext: the React API (`denext/react`) plus the
 * `react-dom` functions `preact/compat` also exports (`createPortal`, `render`, `hydrate`,
 * `flushSync`, `unstable_batchedUpdates`, `unmountComponentAtNode`, `findDOMNode`) and Preact's
 * own helpers (`createFactory`, `isFragment`, `isMemo`). `createElement` / `cloneElement` are
 * `denext/preact`'s, so Preact's `options.vnode` / `options.event` hooks see compat's elements too.
 *
 * `render(vnode, parent, callback?)` renders synchronously into one root per container (a second
 * call re-renders it, `unmountComponentAtNode(parent)` removes it) and then calls `callback`;
 * `hydrate` does the same over server markup. `flushSync(fn, arg?)` calls `fn(arg)` and flushes.
 *
 * @module
 */

import React from "../react.ts";
import { cloneElement, createElement } from "./mod.ts";
import {
  createRoot,
  flushSync as coreFlushSync,
  hydrateRoot,
  type Root,
} from "../../client/mod.ts";
import { collectDom, type Fiber } from "../../client/fiber/fiber.ts";
import type { VNode, VNodeType, VProps } from "../../jsx/types.ts";
import { isValidElement } from "../../runtime/react-core.ts";
import { Fragment } from "../react.ts";
import { REACT_MEMO_TYPE, TYPEOF_KEY } from "../../runtime/react-brands.ts";

export * from "../react.ts";
// Preact's own factories, so `options.vnode` / `options.event` see compat's elements too.
export { cloneElement, createElement };
export { type Options, options } from "./options.ts";
export { createPortal, unstable_batchedUpdates } from "../react-dom.ts";

/** The root `render` / `hydrate` made for each container, so later calls reuse it. */
const roots = new WeakMap<Element, Root>();

/**
 * Render `vnode` into `parent` (Preact's `render` from `preact/compat`): the first call makes
 * the container's root, a later call re-renders it. The render is synchronous; `callback` runs
 * once the DOM is updated.
 *
 * @param vnode The element to render.
 * @param parent The container.
 * @param callback Called after the render.
 * @returns The container's root.
 */
export function render(vnode: VNode, parent: Element, callback?: () => void): Root {
  let root = roots.get(parent);
  if (!root) {
    root = createRoot(parent);
    roots.set(parent, root);
  }
  root.render(vnode);
  if (typeof callback === "function") callback();
  return root;
}

/**
 * Hydrate `vnode` against the server markup in `parent` (Preact's `hydrate` from
 * `preact/compat`), then call `callback`.
 *
 * @param vnode The element to hydrate.
 * @param parent The container holding the server markup.
 * @param callback Called after hydration.
 * @returns The container's root.
 */
export function hydrate(vnode: VNode, parent: Element, callback?: () => void): Root {
  const root = hydrateRoot(parent, vnode);
  roots.set(parent, root);
  if (typeof callback === "function") callback();
  return root;
}

/**
 * Remove the tree `render` / `hydrate` put in `container` (Preact's `unmountComponentAtNode`).
 *
 * @param container The container.
 * @returns Whether a tree was mounted there.
 */
export function unmountComponentAtNode(container: Element): boolean {
  const root = roots.get(container);
  if (!root) return false;
  roots.delete(container);
  root.unmount();
  return true;
}

/**
 * Run `callback(arg)` and flush every pending update synchronously (Preact's `flushSync`).
 *
 * @param callback The function whose updates are flushed.
 * @param arg An argument passed to `callback`.
 * @returns What `callback` returned.
 */
export function flushSync<R>(callback: () => R): R;
export function flushSync<A, R>(callback: (arg: A) => R, arg: A): R;
export function flushSync<A, R>(callback: (arg?: A) => R, arg?: A): R {
  return coreFlushSync(() => callback(arg)) as R;
}

/**
 * A factory that creates elements of `type` (Preact's `createFactory`):
 * `createFactory("li")(props, ...children)`.
 *
 * @param type The element type.
 * @returns `createElement` bound to `type`.
 */
export function createFactory(
  type: VNodeType,
): (props?: VProps | null, ...children: unknown[]) => VNode {
  return (createElement as (...args: unknown[]) => VNode).bind(null, type) as (
    props?: VProps | null,
    ...children: unknown[]
  ) => VNode;
}

/**
 * Whether `element` is a `Fragment` element (Preact's `isFragment`).
 *
 * @param element The value to check.
 * @returns Whether it is an element whose type is `Fragment`.
 */
export function isFragment(element: unknown): boolean {
  return isValidElement(element) && element.type === (Fragment as unknown);
}

/**
 * Whether `component` is a component `memo()` returned (Preact's `isMemo`).
 *
 * @param component The value to check.
 * @returns Whether it is a memo component.
 */
export function isMemo(component: unknown): boolean {
  if (component === null || (typeof component !== "object" && typeof component !== "function")) {
    return false;
  }
  if ((component as Record<PropertyKey, unknown>)[TYPEOF_KEY] === REACT_MEMO_TYPE) return true;
  const name = (component as { displayName?: unknown }).displayName;
  return typeof name === "string" && name.indexOf("Memo(") === 0;
}

/** The fiber a mounted class instance is attached to. */
function fiberOfInstance(component: object): Fiber | null {
  const internals = (component as { __denext?: { inst?: unknown } }).__denext;
  return (internals?.inst as Fiber | undefined) ?? null;
}

/**
 * The first DOM node a mounted class component rendered, or `component` itself when it is an
 * element (Preact's `findDOMNode`).
 *
 * @param component A class component instance or a DOM element.
 * @returns The node, or `null` when it rendered none (or is not mounted).
 */
export function findDOMNode(component: unknown): Element | Text | null {
  if (component === null || typeof component !== "object") return null;
  if ((component as Partial<Node>).nodeType === 1) return component as Element;
  const fiber = fiberOfInstance(component);
  if (fiber === null) return null;
  // The instance keeps the fiber it mounted with; after an update its alternate may be the
  // committed one, so take the first node of either that is still in the document.
  let first: Element | Text | null = null;
  for (const f of [fiber, fiber.alternate]) {
    if (f === null) continue;
    const nodes: (Element | Text)[] = [];
    collectDom(f, nodes);
    if (nodes.length === 0) continue;
    if (nodes[0].isConnected) return nodes[0];
    first ??= nodes[0];
  }
  return first;
}

/** The default export (`import React from "preact/compat"`), with Preact's factories. */
const PreactCompat: typeof React = {
  ...React,
  createElement,
  cloneElement,
  createFactory,
  findDOMNode,
  flushSync,
  hydrate,
  isFragment,
  isMemo,
  render,
  unmountComponentAtNode,
} as typeof React;
export default PreactCompat;
