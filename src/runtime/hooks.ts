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
  /** Return a unique, stable id that matches between server render and hydration. */
  useId(): string;
  /** Subscribe to an external store, re-rendering when its snapshot changes. */
  useSyncExternalStore<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
  /** Like {@link useEffect}, but runs synchronously after DOM mutations (client). */
  useLayoutEffect(effect: () => EffectCleanup, deps?: unknown[]): void;
}

/** A mutable ref object or a callback ref, as accepted by `ref`/`useImperativeHandle`. */
export type Ref<T> = { current: T | null } | ((value: T | null) => void) | null | undefined;

/**
 * A context object created by `createContext`. It is itself usable as a
 * provider element (`<MyContext value={v}>…</MyContext>`, React 19 style) and
 * also exposes the classic `.Provider` component. `useContext(MyContext)` reads
 * the nearest provided value, falling back to the default.
 */
export interface Context<T> extends Component<{ value: T }> {
  /** Unique identity used to match providers with consumers at render time. */
  _id: symbol;
  /** Value returned by `useContext` when no matching provider is present. */
  _defaultValue: T;
  /** Component that supplies `value` to descendant consumers (classic form). */
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

/**
 * Return a unique, stable id string. The value is deterministic across the
 * server render and client hydration (ids are assigned in render order), so it
 * is safe to use for `id`/`htmlFor`/`aria-*` attributes without a mismatch.
 */
export function useId(): string {
  return dispatcher().useId();
}

/**
 * Subscribe to an external (non-React) store and re-render when it changes.
 * `subscribe` registers a change listener and returns an unsubscribe function;
 * `getSnapshot` reads the current value; `getServerSnapshot` (optional) provides
 * the value used during server rendering.
 */
export function useSyncExternalStore<T>(
  subscribe: (onChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T {
  return dispatcher().useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
}

/**
 * Like {@link useEffect}, but on the client it runs synchronously after the DOM
 * is mutated and before the browser paints — use it for layout reads/writes that
 * must happen before the user sees the frame. A no-op during server rendering.
 */
export function useLayoutEffect(
  effect: () => EffectCleanup,
  deps?: unknown[],
): void {
  return dispatcher().useLayoutEffect(effect, deps);
}

/**
 * Return a deferred copy of `value` that lags behind during rapid updates,
 * letting urgent renders finish first. In this build the deferred value updates
 * on the next commit (a simplified, non-interruptible approximation of React's
 * concurrent behavior).
 */
export function useDeferredValue<T>(value: T): T {
  const [deferred, setDeferred] = useState(value);
  useEffect(() => {
    if (!Object.is(deferred, value)) setDeferred(() => value);
  }, [value]);
  return deferred;
}

/**
 * Run `callback` as a low-priority "transition" update. In this build it simply
 * runs the callback (updates are not interruptible), provided for API
 * compatibility with React's concurrent transitions.
 */
export function startTransition(callback: () => void): void {
  callback();
}

/**
 * Return `[isPending, startTransition]`. `isPending` is true while the most
 * recent transition's updates are being applied. Simplified (non-interruptible)
 * relative to React's concurrent implementation.
 */
export function useTransition(): [boolean, (callback: () => void) => void] {
  const [isPending, setPending] = useState(false);
  const start = useCallback((callback: () => void) => {
    setPending(() => true);
    startTransition(callback);
    queueMicrotask(() => setPending(() => false));
  }, []);
  return [isPending, start];
}

/**
 * Show an optimistic value while an async update is in flight. Returns
 * `[optimisticState, addOptimistic]`; call `addOptimistic(action)` to apply an
 * optimistic change over the current `state`. The optimistic value resets to
 * `state` whenever `state` itself changes (e.g. once the real update lands).
 */
export function useOptimistic<S, A>(
  state: S,
  updateFn: (current: S, action: A) => S,
): [S, (action: A) => void] {
  const store = useRef<{ base: S; value: S }>({ base: state, value: state });
  // Reset the optimistic value whenever the underlying state changes.
  if (!Object.is(store.current.base, state)) {
    store.current = { base: state, value: state };
  }
  const [, force] = useState(0);
  const addOptimistic = useCallback((action: A) => {
    store.current.value = updateFn(store.current.value, action);
    force((n) => n + 1);
  }, [updateFn]);
  return [store.current.value, addOptimistic];
}

/**
 * Customize the value exposed on a parent's `ref` for the current component.
 * `create` builds the imperative handle; it re-runs when `deps` change.
 */
export function useImperativeHandle<T>(
  ref: Ref<T>,
  create: () => T,
  deps?: unknown[],
): void {
  useLayoutEffect(() => {
    const handle = create();
    if (typeof ref === "function") ref(handle);
    else if (ref) ref.current = handle;
    return () => {
      if (typeof ref === "function") ref(null);
      else if (ref) ref.current = null;
    };
  }, deps);
}

/**
 * Imperative control over the nearest enclosing error boundary, returned by
 * {@link useErrorBoundary}.
 */
export interface ErrorBoundaryController {
  /** Clear the boundary's error and re-attempt rendering its children. */
  reset(): void;
  /**
   * Show the nearest boundary's fallback for `error`. Use this to route errors
   * that a boundary cannot catch on its own — rejected promises, `setTimeout`
   * callbacks, and other async failures.
   */
  captureError(error: unknown): void;
}

// The client reconciler registers a provider that resolves the controller for
// the component currently rendering. On the server it stays null (SSR is
// one-shot, so the returned controller is inert).
let boundaryControllerProvider: (() => ErrorBoundaryController) | null = null;

/** Internal: install the client's error-boundary controller resolver. */
export function setBoundaryControllerProvider(
  provider: (() => ErrorBoundaryController) | null,
): void {
  boundaryControllerProvider = provider;
}

const INERT_BOUNDARY: ErrorBoundaryController = {
  reset() {},
  captureError() {},
};

/**
 * Access the nearest enclosing error boundary imperatively. Returns a
 * {@link ErrorBoundaryController} whose `captureError(e)` shows that boundary's
 * fallback (handy for async errors a boundary cannot catch during render) and
 * whose `reset()` retries its children. Inert during server rendering.
 */
export function useErrorBoundary(): ErrorBoundaryController {
  return boundaryControllerProvider ? boundaryControllerProvider() : INERT_BOUNDARY;
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
