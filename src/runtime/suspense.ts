// Suspense primitives shared by the server (streaming SSR) and client runtimes.
//
// A component "suspends" by throwing a thenable. The nearest <Suspense> boundary
// catches it, shows `fallback`, and re-renders its children once the thenable
// settles. `use()` unwraps a promise using this mechanism.

import { FRAGMENT, type VNode, type VNodeChildren, type VProps } from "../jsx/types.ts";
import { brand, REACT_SUSPENSE_TYPE } from "./react-brands.ts";
import { type Context, useContext } from "./hooks.ts";

/** Re-exported so the public Suspense API surface stays fully documentable. */
export type { VNode, VNodeChildren } from "../jsx/types.ts";

/** Marker used as the `type` of a Suspense VNode so the renderer recognizes it. */
export const SUSPENSE: symbol = Symbol.for("denext.suspense");

/** Props for the {@link Suspense} boundary component. */
export interface SuspenseProps {
  /** Content shown while descendants are still suspending. */
  fallback?: VNodeChildren;
  /** Content rendered once nothing beneath the boundary is suspending. */
  children?: VNodeChildren;
}

/** A Suspense boundary. Renders `fallback` until its children stop suspending. */
export function Suspense(props: SuspenseProps): VNode {
  return {
    type: SUSPENSE as unknown as string,
    props: props as unknown as VProps,
    key: null,
  };
}
// Brand so `react-is.isSuspense` recognizes `<Suspense>` elements (whose element
// type is this function, not the internal SUSPENSE marker).
brand(Suspense, REACT_SUSPENSE_TYPE);

/** Props for {@link SuspenseList}. */
export interface SuspenseListProps {
  /** The `<Suspense>` boundaries (and other content) to coordinate. */
  children?: VNodeChildren;
  /** Order in which resolved boundaries reveal — see the limitation note below. */
  revealOrder?: "forwards" | "backwards" | "together";
  /** How to show fallbacks for not-yet-revealed boundaries. */
  tail?: "collapsed" | "hidden";
}

/** Prop key carrying a SuspenseList's `{ revealOrder, tail }` to the reconciler. */
export const SUSPENSE_LIST_PROP: string = "__dnxSuspenseList";

/**
 * `React.SuspenseList` — coordinates the reveal order of sibling `<Suspense>`
 * boundaries. With `revealOrder="forwards"` a boundary stays in its fallback until
 * every boundary before it has revealed (`"backwards"` reverses; `"together"` holds
 * all until the last resolves). `tail="collapsed"` shows only the next boundary's
 * fallback, `"hidden"` shows none.
 *
 * Reveal ordering is enforced on the **client** (and in streaming SSR). During
 * buffered server rendering every boundary has already resolved, so order is moot.
 *
 * @param props The children plus `revealOrder`/`tail`.
 * @returns The children as a Fragment carrying the reveal policy for the reconciler.
 */
export function SuspenseList(props: SuspenseListProps): VNode {
  return {
    type: FRAGMENT as unknown as string,
    props: {
      children: props.children,
      [SUSPENSE_LIST_PROP]: { revealOrder: props.revealOrder, tail: props.tail },
    } as unknown as VProps,
    key: null,
  };
}

/** Tracked promise state attached to a thenable read via `use()`. */
interface TrackedThenable<T> {
  _status?: "pending" | "fulfilled" | "rejected";
  _value?: T;
  _error?: unknown;
  then: Promise<T>["then"];
}

/** True if `value` is a context object created by `createContext` (React 19 `use`). */
function isContextUsable(value: unknown): value is Context<unknown> {
  return typeof value === "function" &&
    typeof (value as { _id?: unknown })._id === "symbol";
}

/**
 * React 19's `use`: read a resource during render. Given a **promise**, unwrap its
 * value, suspending (throwing the promise) while it is pending — the same promise
 * instance must be passed across renders (cache it). Given a **context** (from
 * `createContext`), read its current value like `useContext` — this overload may be
 * called conditionally. Works on the client and under every SSR renderer, since
 * both delegate to the active hook dispatcher.
 */
export function use<T>(usable: Promise<T> | Context<T>): T {
  // `use` is React's primitive for reading a context during render; it may be called
  // conditionally by design, and its lowercase name isn't a `useX` hook — so the
  // hooks-in-component rule (which the `useContext` call here trips) does not apply.
  // deno-lint-ignore denext/hooks-in-component
  if (isContextUsable(usable)) return useContext(usable) as T;
  const tracked = usable as unknown as TrackedThenable<T>;
  if (tracked._status === "fulfilled") return tracked._value as T;
  if (tracked._status === "rejected") throw tracked._error;
  if (tracked._status === undefined) {
    tracked._status = "pending";
    tracked.then(
      (value) => {
        tracked._status = "fulfilled";
        tracked._value = value;
      },
      (error) => {
        tracked._status = "rejected";
        tracked._error = error;
      },
    );
  }
  throw usable;
}

/** True if a caught value is a thenable (i.e. a suspension, not a real error). */
export function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * A tiny cache for turning an async factory into a stable, suspense-friendly
 * resource. Reading it either returns the value or suspends.
 */
export function createResource<T>(factory: () => Promise<T>): () => T {
  let promise: Promise<T> | null = null;
  return function read(): T {
    if (!promise) promise = factory();
    return use(promise);
  };
}
