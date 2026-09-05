// React APIs that are pure runtime helpers (no compat-only concern) and live on the root
// `denext` barrel as well as the `react` alias: `cache`, `Activity`, `ViewTransition`.
// Client-safe: the request context is reached through the bridge global the server installs.

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";

/**
 * The current request context (an opaque per-request object), used to make
 * {@linkcode cache} request-scoped during SSR. Read via a global installed by
 * denext's server runtime rather than a static import, so this client-safe shim
 * never pulls `node:async_hooks` into the browser/compat runtime bundle. Off the
 * server (client bundle) the global is absent → `undefined` → persistent memo.
 */
function currentRequestContext(): object | undefined {
  try {
    const get = (globalThis as { __denextCurrentRequestContext?: () => object | undefined })
      .__denextCurrentRequestContext;
    return get ? get() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `React.ViewTransition` (experimental) — the client-driven view-transition wrapper.
 * denext renders it as a transparent passthrough of its children (SSR + hydration safe).
 * **Route-level** view transitions DO apply: a Flight soft-navigation commits inside
 * `document.startViewTransition` where the browser supports it, so the route swap
 * cross-fades (see `withViewTransition` in `src/client/navigation.ts`). The component's
 * per-element props (`name`, `enter`, `exit`, `update`) are not yet honored — that needs
 * this wrapper to emit real `view-transition-name` DOM markers — and the isomorphic/HTML
 * nav paths (async reconcile) don't animate yet either.
 */
export function ViewTransition(props: { children?: VNodeChildren }): VNode {
  return h(Fragment, null, props?.children);
}

/**
 * `React.Activity` (experimental; formerly `unstable_Offscreen`) — wraps a subtree whose
 * rendering can be deprioritized or hidden (`mode="hidden"`). denext has no offscreen
 * scheduler, so it renders as a transparent passthrough of its children (the `mode` prop is
 * accepted and ignored). Lets apps that adopt the API build and render.
 */
export function Activity(
  props: { mode?: "visible" | "hidden"; children?: VNodeChildren },
): VNode {
  return h(Fragment, null, props?.children);
}

/**
 * Max distinct primitive keys held at one node of the off-request persistent
 * {@link cache} memo before the oldest is evicted (bounds unbounded growth).
 */
const CACHE_MAX_PER_NODE = 1024;

/**
 * `React.cache` — memoize a function by its arguments.
 *
 * React's server `cache()` scopes results to a single request via async context;
 * denext already provides that request-scoped variant in `src/server/cache.ts`
 * (which pulls `node:async_hooks`). This is the **client-safe** surface exposed on
 * the `react` package: a plain persistent memo keyed by argument identity, using a
 * nested Map/WeakMap tree (object args keyed by reference, primitives by value) so
 * libraries importing `cache` from `react` resolve and dedupe correctly without
 * dragging server-only APIs into the client bundle.
 *
 * **Lifetime:** during SSR the memo is **request-scoped** (keyed on the current
 * request context, so one request's result is never served to another — matching
 * React and avoiding a cross-request data leak), and the per-request root is
 * garbage-collected with the request. Off-request (a client bundle, or server code
 * outside a request) it falls back to a persistent per-function memo; there, distinct
 * **primitive** args are bounded per node ({@link CACHE_MAX_PER_NODE}, evicting the
 * oldest) so they can't grow without limit (object args use a WeakMap and are freed
 * with the arg). Request-scoped roots stay uncapped (freed with the request, matching
 * React). A throwing `fn` is not cached (it re-runs next call).
 *
 * @param fn The function to memoize.
 * @returns A memoized function returning the cached result for equal arguments.
 */
export function cache<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  interface Node {
    // Present once this node terminates a full argument list.
    hasValue: boolean;
    value: R;
    // Next-argument lookups, split by key kind (object refs vs primitives).
    objects?: WeakMap<object, Node>;
    primitives?: Map<unknown, Node>;
  }
  const newNode = (): Node => ({ hasValue: false, value: undefined as unknown as R });
  // Off-request fallback root (client bundle / non-request server code).
  const persistentRoot = newNode();
  const isPersistent = (root: Node): boolean => root === persistentRoot;
  // Per-request roots, so an SSR render's memo cannot leak into another request.
  const perRequestRoots = new WeakMap<object, Node>();
  const rootFor = (): Node => {
    const ctx = currentRequestContext();
    if (!ctx) return persistentRoot;
    let r = perRequestRoots.get(ctx);
    if (!r) perRequestRoots.set(ctx, r = newNode());
    return r;
  };

  /** The child node for one argument, created on first sight. */
  const childFor = (node: Node, arg: unknown, persistent: boolean): Node => {
    if (typeof arg === "object" && arg !== null || typeof arg === "function") {
      node.objects ??= new WeakMap<object, Node>();
      let next = node.objects.get(arg as object);
      if (!next) node.objects.set(arg as object, next = newNode());
      return next;
    }
    const primitives = node.primitives ??= new Map<unknown, Node>();
    let next = primitives.get(arg);
    if (!next) {
      primitives.set(arg, next = newNode());
      // Off-request only: bound the persistent memo so distinct primitive args
      // can't accumulate without limit. Map preserves insertion order, so the
      // oldest key is evicted first (LRU-ish). Request-scoped roots are left
      // uncapped — they're freed with the request (React's semantics).
      if (persistent && primitives.size > CACHE_MAX_PER_NODE) {
        primitives.delete(primitives.keys().next().value);
      }
    }
    return next;
  };

  return (...args: A): R => {
    const root = rootFor();
    const persistent = isPersistent(root);
    let node = root;
    for (const arg of args) node = childFor(node, arg, persistent);
    if (!node.hasValue) {
      node.value = fn(...args);
      node.hasValue = true;
    }
    return node.value;
  };
}
