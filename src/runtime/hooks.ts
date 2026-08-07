// Hook dispatcher shared between server rendering and client hydration.
//
// Public hooks (`useState`, `useEffect`, …) delegate to whichever dispatcher is
// currently installed. SSR installs a read-only dispatcher; the client
// reconciler installs one bound to a live component instance.

export type StateUpdater<S> = (value: S | ((prev: S) => S)) => void;
export type EffectCleanup = void | (() => void);

export interface Dispatcher {
  useState<S>(initial: S | (() => S)): [S, StateUpdater<S>];
  useReducer<S, A>(
    reducer: (state: S, action: A) => S,
    initial: S,
  ): [S, (action: A) => void];
  useEffect(effect: () => EffectCleanup, deps?: unknown[]): void;
  useMemo<T>(factory: () => T, deps?: unknown[]): T;
  useRef<T>(initial: T): { current: T };
  useContext<T>(context: Context<T>): T;
}

export interface Context<T> {
  _id: symbol;
  _defaultValue: T;
  Provider: import("../jsx/types.ts").Component<{ value: T }>;
}

let currentDispatcher: Dispatcher | null = null;

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

export function useState<S>(initial: S | (() => S)): [S, StateUpdater<S>] {
  return dispatcher().useState(initial);
}

export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initial: S,
): [S, (action: A) => void] {
  return dispatcher().useReducer(reducer, initial);
}

export function useEffect(effect: () => EffectCleanup, deps?: unknown[]): void {
  return dispatcher().useEffect(effect, deps);
}

export function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  return dispatcher().useMemo(factory, deps);
}

export function useCallback<T extends (...args: never[]) => unknown>(
  fn: T,
  deps?: unknown[],
): T {
  return dispatcher().useMemo(() => fn, deps);
}

export function useRef<T>(initial: T): { current: T } {
  return dispatcher().useRef(initial);
}

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
