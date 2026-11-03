// Hook dispatcher shared between server rendering and client hydration.
//
// Public hooks (`useState`, `useEffect`, …) delegate to whichever dispatcher is
// currently installed. SSR installs a read-only dispatcher; the client
// reconciler installs one bound to a live component instance.

import type { Component } from "../jsx/types.ts";
import type { DependencyList } from "../compat/react-types.ts";

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
 *
 * The optional hooks (`useReducer`, `useId`, `useSyncExternalStore`, `useInsertionEffect`,
 * `useMemoCache`, `useDeferredValue`) are implemented by the server dispatcher and left off the
 * client fiber dispatcher: there each one lives in its own module, which its public hook
 * (src/runtime/hooks/) calls when the installed dispatcher has no such method — so a client bundle
 * carries a hook's code only when the app calls the hook.
 */
export interface Dispatcher {
  /** Create a state cell initialized to `initial` (or its return value if lazy). */
  useState<S>(initial: S | (() => S)): [S, StateUpdater<S>];
  /**
   * Create a reducer-driven state cell and its dispatch function. Supports
   * React's lazy initializer: when `init` is given, the initial state is
   * `init(initialArg)`.
   */
  useReducer?<S, A, I = S>(
    reducer: (state: S, action: A) => S,
    initialArg: I,
    init?: (arg: I) => S,
  ): [S, (action: A) => void];
  /** Register a side effect that runs when its dependencies change. */
  useEffect(effect: () => EffectCleanup, deps?: DependencyList): void;
  /** Memoize the result of `factory`, recomputing only when `deps` change. */
  useMemo<T>(factory: () => T, deps?: DependencyList): T;
  /** Create a stable mutable ref object initialized to `initial`. */
  useRef<T>(initial: T): { current: T };
  /** Read the current value of a context created with `createContext`. */
  useContext<T>(context: Context<T>): T;
  /** Return a unique, stable id that matches between server render and hydration. */
  useId?(): string;
  /** Subscribe to an external store, re-rendering when its snapshot changes. */
  useSyncExternalStore?<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
  /** Like {@link useEffect}, but runs synchronously after DOM mutations (client). */
  useLayoutEffect(effect: () => EffectCleanup, deps?: DependencyList): void;
  /** Like {@link useLayoutEffect}, but for pre-layout style injection (CSS-in-JS). */
  useInsertionEffect?(effect: () => EffectCleanup, deps?: DependencyList): void;
  /**
   * Return a stable, per-component array of `size` cache slots (the auto-memo
   * compiler's target). Slots start as {@link MEMO_CACHE_SENTINEL}; generated code
   * fills and reuses them across renders to keep values referentially stable.
   */
  useMemoCache?(size: number): unknown[];
  /**
   * Return a deferred copy of `value` (render-phase). The server dispatcher returns
   * `initialValue ?? value`; the client's true deferral (via priority lanes) is its own
   * module (see above).
   */
  useDeferredValue?<T>(value: T, initialValue?: T): T;
  /**
   * Record a custom hook's debug label for the inspector. Optional and cell-free: only
   * the client fiber dispatcher implements it (and only in development); SSR renderers
   * omit it, so the public {@link useDebugValue} is a no-op there. `format` is stored,
   * not called — the inspector applies it lazily when it reads the value.
   */
  useDebugValue?(value: unknown, format?: (value: unknown) => unknown): void;
  /**
   * Memoize `fn` itself until `deps` change. Optional: without it the public
   * {@link useCallback} goes through {@link Dispatcher.useMemo} with a factory returning
   * `fn` — a closure per call, which the client fiber dispatcher avoids by implementing this.
   */
  useCallback?<T>(fn: T, deps?: DependencyList): T;
  /**
   * The rendering component's owner stack, formatted as React's `captureOwnerStack()`.
   * Optional: the client fiber dispatcher implements it in development, and the server
   * dispatcher answers it once the dev server installs the server owner stack; without either
   * the public `captureOwnerStack()` returns `null`.
   */
  captureOwnerStack?(): string | null;
}

/**
 * Fill value for freshly-allocated {@link useMemoCache} slots. Generated code
 * compares a slot against this sentinel to decide whether it holds a real value
 * yet. Exposed so the compiler runtime and hand-written code agree on it.
 *
 * It is React's own sentinel (`Symbol.for("react.memo_cache_sentinel")`), which React
 * Compiler output tests each slot against inline, so code the React Compiler emitted
 * runs on denext's `useMemoCache` (as its `c` from `react/compiler-runtime`) unchanged.
 */
export const MEMO_CACHE_SENTINEL: unique symbol = /* @__PURE__ */ Symbol.for(
  "react.memo_cache_sentinel",
);

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

// The active dispatcher lives on globalThis (keyed by a global Symbol) rather than
// in a module-local, so that when a next-compat server bundle inlines its own copy
// of the denext runtime, that copy and denext's own source renderer — two module
// instances in one process — share ONE dispatcher. Without this, hooks in a
// compat-bundled component read a second, always-empty dispatcher slot and throw
// "no dispatcher installed" even though the renderer installed one. For a normal
// single-instance app this is equivalent to a module-local.
const DISPATCHER_KEY = Symbol.for("denext.currentDispatcher");
interface DispatcherHolder {
  [DISPATCHER_KEY]?: Dispatcher | null;
}

/**
 * Install `d` as the active dispatcher for the current render and return the
 * previously installed dispatcher (or `null`) so it can be restored afterward.
 */
export function setDispatcher(d: Dispatcher | null): Dispatcher | null {
  const holder = globalThis as DispatcherHolder;
  const prev = holder[DISPATCHER_KEY] ?? null;
  holder[DISPATCHER_KEY] = d;
  return prev;
}

/**
 * Uninstall `d` if it is still the active dispatcher, at the end of a render (or of a piece of a
 * streamed one). A dispatcher left installed after its render keeps the renderer, and through it
 * the finished request's render state and the request itself, alive in the process-global slot
 * until another render replaces it, and makes {@linkcode rendering} report a render that is over.
 * A render still running installs its dispatcher again before each component it calls, so this is
 * safe whenever no component is executing.
 *
 * @param d The dispatcher of the render that finished.
 */
export function releaseDispatcher(d: Dispatcher): void {
  const holder = globalThis as DispatcherHolder;
  if (holder[DISPATCHER_KEY] === d) holder[DISPATCHER_KEY] = null;
}

/**
 * Whether denext is rendering a component right now (its dispatcher is installed). React's
 * hooks hand a call to a `react-reconciler` renderer's dispatcher only when denext is not.
 */
export function rendering(): boolean {
  return ((globalThis as DispatcherHolder)[DISPATCHER_KEY] ?? null) !== null;
}

/**
 * The dispatcher installed for the component rendering now.
 *
 * @returns The active dispatcher.
 * @throws When no component is rendering (a hook called outside a render).
 */
export function activeDispatcher(): Dispatcher {
  const current = (globalThis as DispatcherHolder)[DISPATCHER_KEY] ?? null;
  if (!current) {
    throw new Error(
      "Hooks can only be called while rendering a component (no dispatcher installed).",
    );
  }
  return current;
}

/** Declare local component state with no initial value (`S | undefined`). */
export function useState<S = undefined>(): [S | undefined, StateUpdater<S | undefined>];
/** Declare a piece of local component state and a setter to update it. */
export function useState<S>(initial: S | (() => S)): [S, StateUpdater<S>];
export function useState<S>(
  initial?: S | (() => S),
): [S | undefined, StateUpdater<S | undefined>] {
  // React allows the no-arg form (`useState<S>()`), yielding `S | undefined`.
  return activeDispatcher().useState(initial as S) as [S | undefined, StateUpdater<S | undefined>];
}

/** Run a side effect after render, re-running whenever `deps` change. */
export function useEffect(effect: () => EffectCleanup, deps?: DependencyList): void {
  return activeDispatcher().useEffect(effect, deps);
}

/** Memoize `factory`'s result, recomputing only when `deps` change. */
export function useMemo<T>(factory: () => T, deps?: DependencyList): T {
  return activeDispatcher().useMemo(factory, deps);
}

/** Return a memoized version of `fn` that only changes when `deps` change. */
export function useCallback<T extends (...args: never[]) => unknown>(
  fn: T,
  deps?: DependencyList,
): T {
  const d = activeDispatcher();
  return d.useCallback ? d.useCallback(fn, deps) : memoizedCallback(d, fn, deps);
}

/** {@link useCallback} on a dispatcher without its own: a memo whose factory returns `fn`. */
function memoizedCallback<T>(d: Dispatcher, fn: T, deps?: DependencyList): T {
  return d.useMemo(() => fn, deps);
}

/**
 * Create a mutable ref object whose `.current` persists across renders. React's three
 * signatures: `useRef<T>(value)` → `{ current: T }`, `useRef<T>(null)` → `{ current: T | null }`
 * (the DOM-ref idiom), `useRef<T>()` → `{ current: T | undefined }`.
 */
export function useRef<T>(initial: T): { current: T };
/** `useRef<T>(null)` — the DOM-ref idiom: `current` is `T | null`. */
export function useRef<T>(initial: T | null): { current: T | null };
/** `useRef<T>()` — an initially-undefined cell. */
export function useRef<T = undefined>(): { current: T | undefined };
/** Implementation signature. */
export function useRef<T>(initial?: T): { current: T | undefined } {
  return activeDispatcher().useRef(initial);
}

/** Read the current value of `context` from the nearest enclosing provider. */
export function useContext<T>(context: Context<T>): T {
  return activeDispatcher().useContext(context);
}

/**
 * Like {@link useEffect}, but on the client it runs synchronously after the DOM
 * is mutated and before the browser paints — use it for layout reads/writes that
 * must happen before the user sees the frame. A no-op during server rendering.
 */
export function useLayoutEffect(
  effect: () => EffectCleanup,
  deps?: DependencyList,
): void {
  return activeDispatcher().useLayoutEffect(effect, deps);
}

/**
 * Label a custom hook's value for the DevTools inspector. In development on the client
 * the value is recorded against the rendering component — without taking a hook cell, so
 * adding or removing a call never shifts hook state (Fast Refresh keeps it) — and shown
 * on the hook row it follows in the panel, `denext_hook_state` and the MCP snapshot.
 * `format` is never called during render: the inspector applies it lazily, only when it
 * reads the value. In production and during server rendering this is a no-op.
 *
 * @param value The value to display.
 * @param format Optional formatter, applied lazily by the inspector only.
 */
export function useDebugValue<T>(value: T, format?: (value: T) => unknown): void {
  // Read the slot directly rather than through activeDispatcher(): like React's, a stray call
  // outside a render stays a silent no-op instead of throwing.
  (globalThis as DispatcherHolder)[DISPATCHER_KEY]?.useDebugValue?.(
    value,
    format as ((value: unknown) => unknown) | undefined,
  );
}

/**
 * The owner stack at the call site (`React.captureOwnerStack`): the installed dispatcher's,
 * read from the slot directly so a call outside a render returns `null` instead of throwing.
 *
 * @returns The owner stack, or `null` (production, the server, or outside a render).
 */
export function currentOwnerStack(): string | null {
  return (globalThis as DispatcherHolder)[DISPATCHER_KEY]?.captureOwnerStack?.() ?? null;
}

/**
 * Customize the value exposed on a parent's `ref` for the current component.
 * `create` builds the imperative handle; it re-runs when `deps` change.
 */
export function useImperativeHandle<T>(
  ref: Ref<T>,
  create: () => T,
  deps?: DependencyList,
): void {
  useLayoutEffect(() => {
    const handle = create();
    if (typeof ref === "function") ref(handle);
    else if (ref) ref.current = handle;
    return () => {
      if (typeof ref === "function") ref(null);
      else if (ref) ref.current = null;
    };
  }, deps ? [...deps, ref] : deps); // React: the ref is part of the effect's inputs
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
 * The client scheduler's transition controls, which the transition engine (hooks/transition.ts)
 * drives. The scheduler installs them when it loads; without them (no reconciler loaded) a
 * transition's callback simply runs.
 */
export interface TransitionHost {
  /** Enter a synchronous transition callback: updates it schedules take the transition lane. */
  begin(): void;
  /** Leave it. */
  end(): void;
  /** The AsyncContext transition scope (`asyncContext` builds), else `null`. */
  scope(): { run<T>(value: object, fn: () => T): T } | null;
  /** An async transition started; returns the dev watchdog's disarm, if any. */
  beginAsync(): (() => void) | undefined;
  /** An async transition settled. */
  endAsync(): void;
  /** Whether a transition (sync or async) is in progress. */
  active(): boolean;
  /** Whether a transition flush is scheduled or rendering. */
  inFlight(): boolean;
  /** Whether any transition work is pending: in flight, or queued on a root. */
  pending(): boolean;
  /** Schedule a transition flush. */
  flush(): void;
  /** Run `cb` when the transition work in flight has been flushed. */
  whenFlushed(cb: () => void): void;
}

let transitionHost: TransitionHost | null = null;

/** Internal: the client scheduler installs its transition controls. */
export function setTransitionHost(host: TransitionHost | null): void {
  transitionHost = host;
}

/**
 * The installed transition controls.
 *
 * @returns The scheduler's {@linkcode TransitionHost}, or `null` when no reconciler is loaded.
 */
export function getTransitionHost(): TransitionHost | null {
  return transitionHost;
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
  prev: DependencyList | undefined,
  next: DependencyList | undefined,
): boolean {
  if (prev === undefined || next === undefined) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}
