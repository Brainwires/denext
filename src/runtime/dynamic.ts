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
import { isServer } from "./environment.ts";

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
  /** Fallback component shown while the target module loads. */
  loading?: Component<P>;
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

  // Cache the import promise so `use()` receives a stable thenable across renders
  // (a fresh promise every render would suspend forever).
  let promise: Promise<Component<P>> | null = null;
  function load(): Promise<Component<P>> {
    if (!promise) {
      promise = Promise.resolve(loader()).then((mod) => {
        const resolved = (mod as { default?: Component<P> }).default ?? (mod as Component<P>);
        return resolved;
      });
    }
    return promise;
  }

  // Suspends synchronously via use() until the module loads, then renders it.
  function LazyInner(props: P): VNode {
    // ssr:false — skip loading on the server; the client mounts it after paint.
    if (!ssr && isServer()) {
      return Loading ? h(Loading, props as VProps) : h(FRAGMENT, {});
    }
    const Resolved = use(load());
    return h(Resolved as Component<unknown>, props as VProps);
  }

  function DynamicComponent(props: P): VNode {
    return h(Suspense, {
      fallback: Loading ? h(Loading, props as VProps) : undefined,
      children: h(LazyInner as Component<unknown>, props as VProps),
    });
  }
  return DynamicComponent as Component<P>;
}
