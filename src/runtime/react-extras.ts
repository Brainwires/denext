// React APIs that are pure runtime helpers (no compat-only concern) and live on the root
// `denext` barrel as well as the `react` alias: `cache`, `Activity`, `ViewTransition`.
// Client-safe: the request context is reached through the bridge global the server installs.

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VProps } from "../jsx/types.ts";

/**
 * Marker used as the `type` of an {@link Activity} VNode so the reconciler recognizes it
 * (mirrors `SUSPENSE` in `src/runtime/suspense.ts`). An Activity fiber deprioritizes /
 * hides its subtree; the offscreen logic itself is import-gated (installed into the
 * reconciler seam only when the app uses `Activity`, so a bundle that never renders one
 * ships none of it). Recognizing the marker is always cheap; without the gated runtime an
 * Activity fiber is a transparent passthrough of its children (the historical shim).
 */
export const ACTIVITY: symbol = Symbol.for("denext.activity");

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
 * Prop key carrying a `<ViewTransition>`'s config to the reconciler. A symbol so it can't
 * collide with an author prop and so the wrapper's Fragment is treated as a marker
 * (non-plain) Fragment — it keeps its own fiber (like a context Provider / SuspenseList
 * carrier) rather than being unwrapped, so the view-transition marking walk can find it and
 * stamp `view-transition-name` on its host child. The payload is `ViewTransitionMarker`.
 */
export const VIEW_TRANSITION: symbol = Symbol.for("denext.viewTransition");

/** A `<ViewTransition>`'s honored config, stashed under {@link VIEW_TRANSITION} on its Fragment. */
export interface ViewTransitionMarker {
  /** Pairs an outgoing and incoming element by this `view-transition-name` (shared-element morph). */
  name?: string;
  /** `view-transition-class` applied when the element ENTERS (present in the new state only). */
  enter?: string | Record<string, string>;
  /** `view-transition-class` applied when the element EXITS (present in the old state only). */
  exit?: string | Record<string, string>;
  /** `view-transition-class` applied when the element persists across the transition (morph). */
  update?: string | Record<string, string>;
  /** `view-transition-class` applied to a shared (name-paired) element. */
  share?: string | Record<string, string>;
}

/**
 * `React.ViewTransition` (experimental) — the client-driven view-transition wrapper. It
 * renders as a transparent passthrough of its children (SSR + hydration safe) carrying its
 * config as a Fragment marker; the client marking walk stamps real `view-transition-name`
 * (and `view-transition-class`) DOM markers on its host child around a transition, so a
 * `name`-paired element morphs between routes and `enter`/`exit`/`update`/`share` select the
 * animation. **Route-level** transitions apply too: a soft navigation commits inside
 * `document.startViewTransition` where the browser supports it (see `withViewTransition` in
 * `src/client/navigation.ts`). The offscreen marking is import-gated (installed only when the
 * app uses `ViewTransition`); without it, the wrapper is a plain passthrough and only the
 * route-level cross-fade applies.
 */
export function ViewTransition(
  props: {
    name?: string;
    enter?: string | Record<string, string>;
    exit?: string | Record<string, string>;
    update?: string | Record<string, string>;
    share?: string | Record<string, string>;
    children?: VNodeChildren;
  },
): VNode {
  const marker: ViewTransitionMarker = {
    name: props?.name,
    enter: props?.enter,
    exit: props?.exit,
    update: props?.update,
    share: props?.share,
  };
  return h(Fragment, { [VIEW_TRANSITION as unknown as string]: marker }, props?.children);
}

/**
 * `React.Activity` (experimental; formerly `unstable_Offscreen`) — wraps a subtree whose
 * rendering can be deprioritized or hidden. `mode="hidden"` keeps the subtree mounted but
 * removed from the layout (`display:none`), tears down its effects, and preserves its state
 * (`useState`/`useRef` cells) so `mode="visible"` restores the SAME instances instantly; a
 * subtree that MOUNTS hidden is pre-rendered at transition priority so it never blocks the
 * initial paint. The offscreen scheduler is import-gated: it is installed into the
 * reconciler only when the app uses `Activity` (a build-time scan), so a bundle that never
 * renders one pays nothing. Without it installed (or with `mode="visible"`), the wrapper is
 * a transparent passthrough of its children.
 */
export function Activity(
  props: { mode?: "visible" | "hidden"; children?: VNodeChildren },
): VNode {
  return {
    type: ACTIVITY as unknown as string,
    props: (props ?? {}) as unknown as VProps,
    key: null,
  };
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
