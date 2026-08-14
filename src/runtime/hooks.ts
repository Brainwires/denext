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
  /**
   * Create a reducer-driven state cell and its dispatch function. Supports
   * React's lazy initializer: when `init` is given, the initial state is
   * `init(initialArg)`.
   */
  useReducer<S, A, I = S>(
    reducer: (state: S, action: A) => S,
    initialArg: I,
    init?: (arg: I) => S,
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
  /** Like {@link useLayoutEffect}, but for pre-layout style injection (CSS-in-JS). */
  useInsertionEffect(effect: () => EffectCleanup, deps?: unknown[]): void;
  /**
   * Return a stable, per-component array of `size` cache slots (the auto-memo
   * compiler's target). Slots start as {@link MEMO_CACHE_SENTINEL}; generated code
   * fills and reuses them across renders to keep values referentially stable.
   */
  useMemoCache(size: number): unknown[];
  /**
   * Return a deferred copy of `value` (render-phase). Optional: only the client
   * fiber dispatcher implements true deferral (via priority lanes); SSR renderers
   * omit it and the public {@link useDeferredValue} wrapper returns the value
   * directly.
   */
  useDeferredValue?<T>(value: T, initialValue?: T): T;
}

/**
 * Fill value for freshly-allocated {@link useMemoCache} slots. Generated code
 * compares a slot against this sentinel to decide whether it holds a real value
 * yet. Exposed so the compiler runtime and hand-written code agree on it.
 */
export const MEMO_CACHE_SENTINEL: unique symbol = Symbol.for("denext.memo_cache_sentinel");

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
  /** Legacy render-prop consumer: `<Ctx.Consumer>{value => …}</Ctx.Consumer>`. */
  Consumer: Component<{ children: (value: T) => unknown }>;
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

/**
 * Manage component state with a reducer, returning the state and a dispatch.
 * With a lazy `init`, the initial state is `init(initialArg)` (React parity).
 */
export function useReducer<S, A, I = S>(
  reducer: (state: S, action: A) => S,
  initialArg: I,
  init?: (arg: I) => S,
): [S, (action: A) => void] {
  return dispatcher().useReducer(reducer, initialArg, init);
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

/**
 * Return a **stable** callback that always sees the latest props/state — React
 * 19.2's `useEffectEvent`. Use it for the "event" part of an Effect that should
 * not itself be a dependency (so the Effect doesn't re-run when the handler's
 * closure changes). Do not call the returned function during render.
 *
 * @param handler The event handler; its latest version is always invoked.
 * @returns A referentially-stable function forwarding to the latest `handler`.
 */
export function useEffectEvent<A extends unknown[], R>(
  handler: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(handler);
  ref.current = handler; // keep the latest closure each render
  return useMemo(() => (...args: A) => ref.current(...args), []);
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
 * Run `effect` synchronously at commit in its own pre-mutation phase — before any
 * DOM mutation and before layout effects — intended for CSS-in-JS libraries (emotion,
 * styled-components) and animation libraries (motion) to inject styles before the DOM
 * is read. It must NOT read layout or use refs. A no-op during server rendering.
 *
 * @param effect The insertion effect; may return a cleanup.
 * @param deps Dependency array controlling when it re-runs.
 */
export function useInsertionEffect(
  effect: () => EffectCleanup,
  deps?: unknown[],
): void {
  return dispatcher().useInsertionEffect(effect, deps);
}

/**
 * Return a stable, per-component array of `size` cache slots. This is the
 * primitive the build-time auto-memo compiler emits into: generated code reads
 * and writes these slots to memoize expensive expressions and keep JSX/props
 * referentially stable so the reconciler can bail out of unchanged subtrees. You
 * can use it by hand too, but it is intended for generated code.
 *
 * Slots are initialized to {@link MEMO_CACHE_SENTINEL}; treat a slot still equal
 * to the sentinel as "not yet computed".
 */
export function useMemoCache(size: number): unknown[] {
  return dispatcher().useMemoCache(size);
}

/**
 * Label a custom hook's value for React DevTools. A no-op at runtime (React itself
 * only invokes it when DevTools is attached), provided for API compatibility.
 *
 * @param _value The value to display.
 * @param _format Optional formatter, applied lazily by DevTools only.
 */
export function useDebugValue<T>(_value: T, _format?: (value: T) => unknown): void {
  // Intentionally empty — DevTools-only in React.
}

/**
 * Return a deferred copy of `value` that lags behind during rapid updates, letting
 * urgent renders finish first. On the client this is a true **render-phase**
 * deferral (React-accurate): during an urgent render the hook returns the previous
 * value and schedules a low-priority transition to catch up, so the deferred
 * update is time-sliced and interruptible and the value never trails by an extra
 * commit. The optional `initialValue` (React 19) is returned on the first render,
 * with a transition scheduled to reach `value`. On the server (no lane scheduler)
 * it returns `initialValue ?? value`.
 *
 * @param value The value to defer.
 * @param initialValue Optional value to show on the first render before deferral.
 */
export function useDeferredValue<T>(value: T, initialValue?: T): T {
  const d = dispatcher();
  if (d.useDeferredValue) return d.useDeferredValue(value, initialValue);
  return initialValue !== undefined ? initialValue : value;
}

/**
 * Run `callback` as a low-priority "transition": the callback runs synchronously
 * (like React), but any state updates it triggers are scheduled at transition
 * priority — flushed after the reconciler yields to the browser, so urgent updates
 * and paint/input happen first. On the server (no scheduler installed) it just runs
 * the callback. The transition render is time-sliced and interruptible: a
 * higher-priority (sync) update abandons the in-flight transition and restarts it
 * (see the migration guide's concurrency note).
 */
export function startTransition(callback: () => void): void {
  if (transitionScheduler) transitionScheduler(callback, () => {});
  else callback();
}

/**
 * Return `[isPending, startTransition]`. `isPending` stays true from the moment the
 * transition starts until its low-priority updates have been flushed — so a pending
 * indicator can paint (and the browser can handle input) before the transition's
 * work runs. Falls back to a synchronous run when no client scheduler is installed.
 */
export function useTransition(): [boolean, (callback: () => void) => void] {
  const [isPending, setPending] = useState(false);
  const start = useCallback((callback: () => void) => {
    if (transitionScheduler) {
      setPending(() => true);
      transitionScheduler(callback, () => setPending(() => false));
    } else {
      callback();
    }
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
 * Low-priority (transition) scheduler, installed by the client reconciler. Runs
 * `cb` marking any state updates it triggers as transition updates (flushed after
 * the browser yields, so urgent updates + paint happen first), then fires
 * `onComplete` once that transition flush lands. Null on the server (SSR is
 * one-shot), where transitions just run synchronously.
 */
let transitionScheduler:
  | ((cb: () => void, onComplete: () => void) => void)
  | null = null;

/** Internal: install the client's low-priority transition scheduler. */
export function setTransitionScheduler(
  fn: ((cb: () => void, onComplete: () => void) => void) | null,
): void {
  transitionScheduler = fn;
}

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
