// memo() and the shallow prop comparison behind the reconciler's component
// bailout. denext components are pure (same props + state + context → same
// output), so the reconciler may skip re-rendering a component whose props are
// shallow-equal and whose visible context is unchanged. `memo()` lets you supply
// a custom comparator; without one, the default shallow comparison already
// applies to every component.

import type { Component } from "../jsx/types.ts";
import { REACT_MEMO_TYPE, TYPEOF_KEY } from "./react-brands.ts";

/** Compares a component's previous and next props; `true` means "skip re-render". */
export type PropsComparator = (
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
) => boolean;

/**
 * Shallow-compare two prop objects: equal when they have the same keys and every
 * value is `Object.is`-equal. This is the default bailout comparator.
 */
export function shallowEqualProps(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Wrap a component so the reconciler bails out of re-rendering it when its props
 * have not meaningfully changed. Without `areEqual`, props are compared with
 * {@link shallowEqualProps} (the same default the reconciler applies to every
 * component); pass `areEqual` for custom control (return `true` to skip the
 * re-render). Context changes always bypass the bailout — a consumer still
 * re-renders when a context it reads changes.
 *
 * @param component The component to memoize.
 * @param areEqual Optional custom comparator (`true` ⇒ skip re-render).
 */
export function memo<P extends object>(
  component: Component<P>,
  areEqual?: (prev: P, next: P) => boolean,
): Component<P> {
  // React's non-callable memo element object: `{ $$typeof, type, compare }`. The
  // renderers resolve the wrapped `type` through `resolveComponentType`; the public
  // return type stays `Component<P>` so the 1.0 surface is unchanged (the runtime
  // value is an object, used only as a JSX element type — never called directly).
  const Memoized = {
    [TYPEOF_KEY]: REACT_MEMO_TYPE,
    type: component,
    compare: (areEqual as unknown as PropsComparator) ?? null,
  };
  return Memoized as unknown as Component<P>;
}

/**
 * Resolve the prop comparator for a `memo` component type: its custom comparator
 * (React's `compare` field) if it has one, otherwise the default
 * {@link shallowEqualProps}. Accepts a plain component type too (⇒ shallow).
 */
export function areEqualOf(type: unknown): PropsComparator {
  const custom = (type as { compare?: unknown })?.compare;
  return typeof custom === "function" ? (custom as PropsComparator) : shallowEqualProps;
}
