// Hook dispatcher shared between server rendering and client hydration.
//
// Public hooks (`useState`, `useEffect`, …) delegate to whichever dispatcher is
// currently installed. SSR installs a read-only dispatcher; the client
// reconciler installs one bound to a live component instance.

import type { Component } from "../jsx/types.ts";

/** Re-exported so the public `Context` type can reference it. */
export type { Component } from "../jsx/types.ts";

/**
 * State setter returned by {@link useState}. Accepts either the next value or an
 * updater function that receives the previous value and returns the next one.
 */
export type StateUpdater<S> = (value: S | ((prev: S) => S)) => void;

/**
 * Optional cleanup returned by an effect callback: either nothing, or a function
 * run before the effect re-runs and on unmount.
 */
export type EffectCleanup = void | (() => void);

/**
 * The set of hook implementations backing the public hook functions. A
 * dispatcher is installed for the duration of a render (SSR or client) and each
 * public hook simply delegates to the currently installed dispatcher.
 */
export interface Dispatcher {
  /** Create a state cell initialized to `initial` (or its return value if lazy). */
  useState<S>(initial: S | (() => S)): [S, StateUpdater<S>];
  /** Create a reducer-driven state cell and its dispatch function. */
  useReducer<S, A>(
    reducer: (state: S, action: A) => S,
    initial: S,
  ): [S, (action: A) => void];
  /** Register a side effect that runs when its dependencies change. */
  useEffect(effect: () => EffectCleanup, deps?: unknown[]): void;
  /** Memoize the result of `factory`, recomputing only when `deps` change. */
  useMemo<T>(factory: () => T, deps?: unknown[]): T;
  /** Create a stable mutable ref object initialized to `initial`. */
  useRef<T>(initial: T): { current: T };
  /** Read the current value of a context created with `createContext`. */
  useContext<T>(context: Context<T>): T;
}

/**
 * A context object created by `createContext`, holding its default value and a
 * `Provider` component used to supply a value to descendants during rendering.
 */
export interface Context<T> {
  /** Unique identity used to match providers with consumers at render time. */
  _id: symbol;
  /** Value returned by `useContext` when no matching provider is present. */
  _defaultValue: T;
  /** Component that supplies `value` to descendant consumers. */
  Provider: Component<{ value: T }>;
}

let currentDispatcher: Dispatcher | null = null;

/**
 * Install `d` as the active dispatcher for the current render and return the
 * previously installed dispatcher (or `null`) so it can be restored afterward.
 */
export function setDispatcher(d: Dispatcher | null): Dispatcher | null {
  const prev = currentDispatcher;
  currentDispatcher = d;
  return prev;
}

function dispatcher(): Dispatcher {
  if (!currentDispatcher) {
    throw new Error(
      "Hooks can only be called while rendering a component (no dispatcher installed).",
    );
  }
  return currentDispatcher;
}

/** Declare a piece of local component state and a setter to update it. */
export function useState<S>(initial: S | (() => S)): [S, StateUpdater<S>] {
  return dispatcher().useState(initial);
}

/** Manage component state with a reducer, returning the state and a dispatch. */
export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initial: S,
): [S, (action: A) => void] {
  return dispatcher().useReducer(reducer, initial);
}

/** Run a side effect after render, re-running whenever `deps` change. */
export function useEffect(effect: () => EffectCleanup, deps?: unknown[]): void {
  return dispatcher().useEffect(effect, deps);
}

/** Memoize `factory`'s result, recomputing only when `deps` change. */
export function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  return dispatcher().useMemo(factory, deps);
}

/** Return a memoized version of `fn` that only changes when `deps` change. */
export function useCallback<T extends (...args: never[]) => unknown>(
  fn: T,
  deps?: unknown[],
): T {
  return dispatcher().useMemo(() => fn, deps);
}

/** Create a mutable ref object whose `.current` persists across renders. */
export function useRef<T>(initial: T): { current: T } {
  return dispatcher().useRef(initial);
}

/** Read the current value of `context` from the nearest enclosing provider. */
export function useContext<T>(context: Context<T>): T {
  return dispatcher().useContext(context);
}

/** Shallow compare two dependency arrays for hook memoization. */
export function depsChanged(
  prev: unknown[] | undefined,
  next: unknown[] | undefined,
): boolean {
  if (prev === undefined || next === undefined) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}
