// `next/dynamic`-style lazy component loading.
//
// `dynamic(() => import("./Heavy"))` returns a component that loads its target
// module on demand. Because `deno bundle --code-splitting` turns the dynamic
// `import()` into a separately-served chunk, the heavy component's code is not in
// the route's initial bundle — it is fetched when the component first renders.
//
// Loading rides the existing Suspense machinery: a sync wrapper calls `use()` on
// the cached import promise (the client bans async components, so it must suspend
// synchronously), and a surrounding <Suspense> shows `loading` until it resolves.

import { h } from "../jsx/jsx-runtime.ts";
import { type Component, FRAGMENT, type VNode, type VProps } from "../jsx/types.ts";
import { Suspense, use } from "./suspense.ts";
import { useEffect, useState } from "./hooks.ts";
import { isServer } from "./environment.ts";
import { brand, REACT_LAZY_TYPE } from "./react-brands.ts";

/** A loader returning a module (whose `default` is the component) or the component. */
export type DynamicLoader<P = Record<string, unknown>> =
  | (() => Promise<{ default: Component<P> }>)
  | (() => Promise<Component<P>>);

/** Options for {@linkcode dynamic}. */
export interface DynamicOptions<P = Record<string, unknown>> {
  /**
   * Server-render the component. Defaults to `true`. When `false`, the server
   * renders the `loading` fallback (or nothing) and the component mounts only on
   * the client — for browser-only components (e.g. those touching `window`).
   */
  ssr?: boolean;
  /** Fallback component shown while the target module loads (receives {@link DynamicLoadingProps}). */
  loading?: Component<DynamicLoadingProps>;
  /** Milliseconds before the fallback's `pastDelay` turns true (default 200, like Next). */
  delay?: number;
  /** Milliseconds before the fallback's `timedOut` turns true (default: never). */
  timeout?: number;
}

/** The props `next/dynamic` passes to a `loading` component. */
export interface DynamicLoadingProps {
  /** A load error, when the import rejected (`retry` re-imports). */
  error?: Error | null;
  /** True while the module is loading. */
  isLoading?: boolean;
  /** True once `delay` ms have elapsed (on the server: true). */
  pastDelay?: boolean;
  /** True once `timeout` ms have elapsed without the module (never when `timeout` is unset). */
  timedOut?: boolean;
  /** Re-import the module — after an error or a timeout. */
  retry?: () => void;
}

/** What the server renders for `ssr: false` (no timers on the server). */
const SERVER_LOADING_PROPS: DynamicLoadingProps = {
  error: null,
  isLoading: true,
  pastDelay: true,
  timedOut: false,
  retry: () => {},
};

/** The loader's settled outcome: the component, or the error it rejected with. */
type Loaded<P> = { component: Component<P> } | { error: Error };

/**
 * The fallback while the import is pending: `pastDelay` after `delay` ms, `timedOut` after
 * `timeout` ms (timers cleared on unmount — i.e. when the module arrives).
 */
function LoadingState(
  props: {
    Loading: Component<DynamicLoadingProps>;
    delay: number;
    timeout?: number;
    retry: () => void;
  },
): VNode {
  const [pastDelay, setPastDelay] = useState(props.delay <= 0);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (props.delay > 0) timers.push(setTimeout(() => setPastDelay(true), props.delay));
    if (props.timeout !== undefined && props.timeout > 0) {
      timers.push(setTimeout(() => setTimedOut(true), props.timeout));
    }
    return () => timers.forEach(clearTimeout);
  }, [props.delay, props.timeout]);
  return h(props.Loading, {
    error: null,
    isLoading: true,
    pastDelay,
    timedOut,
    retry: props.retry,
  } as VProps);
}

/**
 * Lazily load a component. Returns a component you can render immediately; its
 * target module is imported on first render (as its own bundle chunk) and shown
 * once resolved, with `loading` displayed meanwhile.
 *
 * @example
 * ```tsx
 * const Chart = dynamic(() => import("./Chart"), { ssr: false, loading: () => <p>…</p> });
 * ```
 *
 * @param loader Returns the dynamic import (its `default` is the component).
 * @param options Rendering options.
 */
export function dynamic<P = Record<string, unknown>>(
  loader: DynamicLoader<P>,
  options: DynamicOptions<P> = {},
): Component<P> {
  const ssr = options.ssr ?? true;
  const Loading = options.loading;
  const delay = options.delay ?? 200;

  // Cache the import promise so `use()` receives a stable thenable across renders (a fresh
  // promise every render would suspend forever). It never rejects: a failed import settles
  // to `{ error }` so the fallback can show it (with `retry`) instead of the nearest error
  // boundary swallowing the whole subtree.
  let promise: Promise<Loaded<P>> | null = null;
  function load(): Promise<Loaded<P>> {
    if (!promise) {
      promise = (async (): Promise<Loaded<P>> => {
        try {
          const mod: unknown = await loader();
          const component = (mod as { default?: Component<P> }).default ?? mod;
          return { component: component as Component<P> };
        } catch (err) {
          return { error: err instanceof Error ? err : new Error(String(err)) };
        }
      })();
    }
    return promise;
  }

  // Suspends synchronously via use() until the module loads, then renders it.
  function LazyInner(props: P & { __retry: () => void }): VNode {
    const { __retry: retry, ...rest } = props;
    // ssr:false — skip loading on the server; the client mounts it after paint.
    if (!ssr && isServer()) {
      return Loading ? h(Loading, SERVER_LOADING_PROPS as VProps) : h(FRAGMENT, {});
    }
    const loaded = use(load());
    if ("error" in loaded) {
      if (!Loading) throw loaded.error; // no fallback to show it in → the error boundary
      return h(Loading, {
        error: loaded.error,
        isLoading: false,
        pastDelay: true,
        timedOut: false,
        retry,
      } as VProps);
    }
    return h(loaded.component as Component<unknown>, rest as VProps);
  }

  function DynamicComponent(props: P): VNode {
    // `retry` forgets the settled import and remounts the lazy child (a new key), so the
    // next render imports again — after an error, or a timeout the fallback reported.
    const [attempt, setAttempt] = useState(0);
    const retry = () => {
      promise = null;
      setAttempt((n) => n + 1);
    };
    return h(Suspense, {
      fallback: Loading
        ? h(LoadingState, { Loading, delay, timeout: options.timeout, retry })
        : undefined,
      children: h(LazyInner as Component<unknown>, {
        ...(props as VProps),
        __retry: retry,
        key: attempt,
      }),
    });
  }
  // Brand so `react-is.isLazy` recognizes a `lazy`/`dynamic` component.
  brand(DynamicComponent, REACT_LAZY_TYPE);
  return DynamicComponent as Component<P>;
}

/**
 * `React.lazy(() => import("./C"))` — a component that **suspends to the nearest
 * ancestor `<Suspense fallback>`** while its module loads. Unlike {@link dynamic}
 * (which wraps its own internal Suspense boundary + `loading` option), `lazy` adds
 * no boundary of its own, so the surrounding `<Suspense>` fallback shows during
 * load — matching React. The target module's `default` export is the component.
 *
 * @param loader Returns the dynamic import whose `default` is the component.
 */
export function lazy<P = Record<string, unknown>>(
  loader: () => Promise<{ default: Component<P> }>,
): Component<P> {
  let promise: Promise<Component<P>> | null = null;
  function load(): Promise<Component<P>> {
    if (!promise) promise = Promise.resolve(loader()).then((mod) => mod.default);
    return promise;
  }
  // Suspends synchronously via use(); the nearest <Suspense> catches it.
  function LazyComponent(props: P): VNode {
    const Resolved = use(load());
    return h(Resolved as Component<unknown>, props as VProps);
  }
  brand(LazyComponent, REACT_LAZY_TYPE);
  return LazyComponent as Component<P>;
}
