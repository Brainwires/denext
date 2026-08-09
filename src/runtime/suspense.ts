// Suspense primitives shared by the server (streaming SSR) and client runtimes.
//
// A component "suspends" by throwing a thenable. The nearest <Suspense> boundary
// catches it, shows `fallback`, and re-renders its children once the thenable
// settles. `use()` unwraps a promise using this mechanism.

import type { VNode, VNodeChildren, VProps } from "../jsx/types.ts";
import { brand, REACT_SUSPENSE_TYPE } from "./react-brands.ts";

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

/** Tracked promise state attached to a thenable read via `use()`. */
interface TrackedThenable<T> {
  _status?: "pending" | "fulfilled" | "rejected";
  _value?: T;
  _error?: unknown;
  then: Promise<T>["then"];
}

/**
 * Read a promise's value, suspending (throwing the promise) while it is pending.
 * The same promise instance must be passed across renders (cache it).
 */
export function use<T>(thenable: Promise<T>): T {
  const tracked = thenable as unknown as TrackedThenable<T>;
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
  throw thenable;
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
