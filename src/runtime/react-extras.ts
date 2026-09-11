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
 * DOM attribute a `<ViewTransition>` stamps onto its host child, carrying its config as JSON.
 * A DOM attribute (not a fiber/VNode marker) is what survives BOTH server rendering and the
 * Flight boundary: a Fragment's props are dropped in Flight, and server components aren't
 * re-run on the client, so a symbol-keyed VNode marker never reaches the browser tree — but a
 * host element's attributes do. The client marking runtime finds these elements by this
 * attribute and stamps `view-transition-name` / `view-transition-class` around a transition.
 */
export const DNX_VT_ATTR = "data-dnx-vt";

/**
 * The current request context (an opaque per-request object), used to make
 * {@linkcode cache} request-scoped during SSR. Read via a global installed by
 * denext's server runtime rather than a static import, so this client-safe shim
 * never pulls `node:async_hooks` into the browser/compat runtime bundle. Off the
 * server (client bundle) the global is absent → `undefined`.
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

/** A `<ViewTransition>`'s honored config, JSON-encoded into {@link DNX_VT_ATTR} on its host child. */
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

/** The single VNode element child of a `<ViewTransition>`, or null (text / none / many). */
function singleElementChild(children: VNodeChildren): VNode | null {
  const one = Array.isArray(children) ? (children.length === 1 ? children[0] : null) : children;
  return one != null && typeof one === "object" && "type" in (one as object) ? one as VNode : null;
}

/**
 * `React.ViewTransition` (experimental) — the client-driven view-transition wrapper. It is
 * transparent (no DOM node of its own) and carries its config by stamping the {@link DNX_VT_ATTR}
 * attribute onto its **single host child** (a DOM attribute survives server rendering AND the
 * Flight boundary, unlike a VNode marker). Around a soft navigation the import-gated marking
 * runtime finds these elements and applies real `view-transition-name` (and
 * `view-transition-class` from `enter`/`exit`/`update`/`share`), so a `name` shared across
 * routes morphs one element into the other. **Route-level** transitions apply regardless: a soft
 * navigation commits inside `document.startViewTransition` where the browser supports it (see
 * `withViewTransition` in `src/client/navigation.ts`). Without the gated runtime, or for a
 * wrapper whose child isn't a single element (nothing to mark), it is a plain passthrough.
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
  const marker: ViewTransitionMarker = {};
  if (props?.name != null) marker.name = props.name;
  if (props?.enter != null) marker.enter = props.enter;
  if (props?.exit != null) marker.exit = props.exit;
  if (props?.update != null) marker.update = props.update;
  if (props?.share != null) marker.share = props.share;
  const child = singleElementChild(props?.children ?? null);
  // Nothing to pair (no name/class) or no single element to stamp → transparent passthrough.
  if (child === null || Object.keys(marker).length === 0) {
    return h(Fragment, null, props?.children);
  }
  // Clone the child, adding the config attribute. On a host element it lands in the DOM (and
  // the Flight payload); on a component child the author must forward it — like React, whose
  // ViewTransition also requires a single element child. Spread the child so its element brand
  // (`$$typeof`) and any other fields survive — a rebuilt `{ type, key, props }` would make
  // `isValidElement`/`react-is` misclassify the wrapped child.
  return { ...child, props: { ...(child.props ?? {}), [DNX_VT_ATTR]: JSON.stringify(marker) } };
}

/**
 * `React.Activity` (experimental; formerly `unstable_Offscreen`) — wraps a subtree whose
 * rendering can be deprioritized or hidden. `mode="hidden"` keeps the subtree mounted but
 * removed from the layout (`display:none !important`), tears down its effects, and preserves its state
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
 * Max distinct primitive keys held at one node of the client-side persistent
 * {@link cache} memo before the oldest is evicted (bounds unbounded growth).
 */
const CACHE_MAX_PER_NODE = 1024;

/**
 * Whether this code runs in a browser (the client bundle). On the server the only
 * memo scope React recognizes is the current request, so with no request context a
 * server-side `cache()` call is not memoized at all — matching React's "no
 * dispatcher" branch. Evaluated per call (not at module load) so a test can stub it.
 */
function inBrowser(): boolean {
  return typeof document !== "undefined";
}

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
 * **Lifetime (React's semantics):** during SSR the memo is **request-scoped** (keyed
 * on the current request context, so one request's result is never served to
 * another — matching React and avoiding a cross-request data leak), and the
 * per-request root is garbage-collected with the request. **Server code outside a
 * request** (a scheduled task, a script, module init) is **not memoized** — `fn` runs
 * on every call, exactly as React's `cache()` does with no dispatcher active — so a
 * result can never persist across logical calls. **In the browser** (the client
 * bundle, where React memoizes per render pool) it is a persistent per-function memo
 * whose distinct **primitive** args are bounded per node ({@link CACHE_MAX_PER_NODE},
 * evicting the oldest) so they can't grow without limit (object args use a WeakMap
 * and are freed with the arg). Request-scoped roots stay uncapped (freed with the
 * request, matching React). A throwing `fn` is not cached (it re-runs next call).
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
  // Browser (client bundle) root: a persistent per-function memo.
  const persistentRoot = newNode();
  const isPersistent = (root: Node): boolean => root === persistentRoot;
  // Per-request roots, so an SSR render's memo cannot leak into another request.
  const perRequestRoots = new WeakMap<object, Node>();
  // The memo root for this call, or null when React wouldn't memoize at all: server
  // code with no request context (no dispatcher → React calls `fn` straight through).
  const rootFor = (): Node | null => {
    const ctx = currentRequestContext();
    if (!ctx) return inBrowser() ? persistentRoot : null;
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
    if (root === null) return fn(...args);
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
