// React APIs that are pure runtime helpers (no compat-only concern) and live on the root
// `denext` barrel as well as the `react` alias: `cache`, `Activity`, `ViewTransition`.
// Client-safe: the request context is reached through the bridge global the server installs.

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VProps } from "../jsx/types.ts";
import { brandOf, isComponentType, REACT_LAZY_TYPE, resolveComponentType } from "./react-brands.ts";

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
  /** `view-transition-class` for any trigger whose own prop is unset (`"auto"`: the browser default). */
  default?: string | Record<string, string>;
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
 * Where a `<ViewTransition>`'s host instances get their names. React counts a boundary's host
 * instances in tree order and names them `name`, `name_1`, `name_2`, …; here a component's hosts
 * are only known once it renders, so each position is a path (one index per component level). A
 * component that is the LAST position at its level continues its parent's count (nothing follows
 * it to collide with), which keeps React's flat names for the usual shapes.
 */
interface VTScope {
  /** The boundary's config (its `name` is the base name). */
  m: ViewTransitionMarker;
  /** The component levels above this one (empty at the `<ViewTransition>` itself). */
  path: number[];
  /** The next position at this level (Fragments and arrays are flat; a component opens a level). */
  n: number;
  /** The component scope at the last position taken so far (null when a host took it). */
  tail: VTScope | null;
}

/** A host child's config: the boundary's, with the name suffixed by its position. */
function markerAt(scope: VTScope, i: number): string {
  const path = scope.path.concat(i);
  const name = scope.m.name;
  // The first host keeps the bare name (it pairs with a single-element boundary elsewhere).
  // Paths are prefix-free (a position is a host OR a component), so each suffix is unique and
  // stable across renders.
  const suffixed = name == null || name === "auto" || path.every((x) => x === 0)
    ? name
    : `${name}_${path.join("_")}`;
  return JSON.stringify(suffixed === name ? scope.m : { ...scope.m, name: suffixed });
}

/** Mark `children` as one level of a boundary (see {@link VTScope}), starting at position `n`. */
function markLevel(
  children: VNodeChildren,
  m: ViewTransitionMarker,
  path: number[],
  n: number,
): VNodeChildren {
  const scope: VTScope = { m, path, n, tail: null };
  const out = markHosts(children, scope);
  // The last position is a component: it continues this level's count.
  if (scope.tail) {
    scope.tail.n = scope.tail.path.at(-1)!;
    scope.tail.path = path;
  }
  return out;
}

/** The element brand + its props, with `props` replaced. */
function withProps(el: VNode, props: Record<string, unknown>): VNode {
  return { ...el, props: props as VProps };
}

/** A component whose rendered output must be marked: a plain function, `memo` or `forwardRef`. */
function expandable(type: unknown): boolean {
  if (!isComponentType(type)) return false;
  const t = type as { prototype?: { isReactComponent?: unknown } } & Record<symbol, unknown>;
  // A class can't be called; a lazy one hasn't loaded; a client reference must not run on the
  // server (Flight emits it as a reference). Those carry the config as a prop instead, which the
  // client's marking runtime resolves to the component's nearest host nodes.
  return !t.prototype?.isReactComponent && brandOf(type) !== REACT_LAZY_TYPE &&
    t[Symbol.for("denext.clientRef")] == null;
}

const VT_SCOPE: unique symbol = /* @__PURE__ */ Symbol("denext.vtScope");
const expanders = /* @__PURE__ */ new WeakMap<
  object,
  (props: Record<PropertyKey, unknown>) => unknown
>();

/**
 * The stand-in that renders `type` and marks its output's nearest host nodes. One per component
 * type (cached), so a child whose type changes remounts as it would unwrapped, and its hooks
 * stay on one fiber.
 */
function expanderFor(type: object): (props: Record<PropertyKey, unknown>) => unknown {
  let x = expanders.get(type);
  if (!x) {
    const { fn, forwardsRef } = resolveComponentType(type);
    const call = fn as (props: unknown, ref?: unknown) => unknown;
    x = (props) => {
      const { [VT_SCOPE]: scope, ...rest } = props;
      let out;
      if (forwardsRef) {
        const { ref, ...noRef } = rest;
        out = call(noRef, ref);
      } else out = call(rest);
      const { m, path, n } = scope as VTScope;
      const mark = (o: unknown) => markLevel(o as VNodeChildren, m, path, n);
      return out instanceof Promise ? out.then(mark) : mark(out);
    };
    const named = type as { displayName?: string; name?: string };
    (x as { displayName?: string }).displayName = named.displayName ?? named.name ??
      (fn as { name?: string })?.name;
    expanders.set(type, x);
  }
  return x;
}

/**
 * Mark the nearest host nodes of `children` with the boundary's config (React's
 * `applyViewTransitionToHostInstances`): a host element takes the attribute and is not entered;
 * Fragments, arrays, Suspense, providers and portals are looked through; text can't be named; a
 * component is rendered through {@link expanderFor} so ITS output is marked; a nested
 * `<ViewTransition>` marks its own.
 */
function markHosts(children: VNodeChildren, scope: VTScope): VNodeChildren {
  if (Array.isArray(children)) return children.map((c) => markHosts(c, scope)) as VNodeChildren;
  if (children == null || typeof children !== "object" || !("type" in children)) return children;
  const el = children as VNode;
  const { type } = el;
  const props = (el.props ?? {}) as Record<PropertyKey, unknown>;
  if (typeof type === "string" || (isComponentType(type) && !expandable(type))) {
    scope.tail = null;
    return withProps(el, { ...props, [DNX_VT_ATTR]: markerAt(scope, scope.n++) });
  }
  if (type === ViewTransition) return el;
  if (expandable(type)) {
    const inner: VTScope = { m: scope.m, path: scope.path.concat(scope.n++), n: 0, tail: null };
    scope.tail = inner;
    return {
      ...el,
      type: expanderFor(type as object) as never,
      props: { ...props, [VT_SCOPE]: inner } as VProps,
    };
  }
  // Fragment / Suspense / Activity / provider / portal: their content is this boundary's.
  const next = { ...props };
  if ("children" in props) next.children = markHosts(props.children as VNodeChildren, scope);
  if (props.fallback != null) next.fallback = markHosts(props.fallback as VNodeChildren, scope);
  return withProps(el, next);
}

/**
 * `React.ViewTransition` (experimental) — the client-driven view-transition wrapper. It is
 * transparent (no DOM node of its own) and carries its config by stamping the {@link DNX_VT_ATTR}
 * attribute onto its **nearest host nodes** (a DOM attribute survives server rendering AND the
 * Flight boundary, unlike a VNode marker): a host child, every host in a Fragment or a list (the
 * first keeps `name`, the others get React's `name_<i>` suffix), and the hosts a component child
 * renders. Text directly inside is not animated (it can't be named). The import-gated marking
 * runtime finds these elements and applies real `view-transition-name` (an automatic one when
 * `name` is unset) and `view-transition-class` (`enter`/`exit`/`update`/`share`, else `default`;
 * `"none"` opts out):
 *
 * - **Same-page updates** (React's triggers): a commit made only of Transition work — a
 *   `startTransition` update, a `useDeferredValue` catch-up, a Suspense reveal — runs inside
 *   `document.startViewTransition` when a wrapped element enters, exits, is shared (a `name` that
 *   leaves one place and enters another) or updates (its content mutated or its layout moved).
 *   An urgent update never animates, and neither does a `useSyncExternalStore` change (React
 *   renders a store change synchronously even inside `startTransition`).
 * - **Soft navigations** commit inside `document.startViewTransition` (see `withViewTransition`
 *   in `src/client/navigation.ts`), so a `name` shared across routes morphs one element into the
 *   other; the route-level cross-fade applies regardless.
 *
 * Where the browser lacks the View Transitions API the commit simply applies.
 */
export function ViewTransition(
  props: {
    name?: string;
    default?: string | Record<string, string>;
    enter?: string | Record<string, string>;
    exit?: string | Record<string, string>;
    update?: string | Record<string, string>;
    share?: string | Record<string, string>;
    children?: VNodeChildren;
  },
): VNode {
  const marker: ViewTransitionMarker = {};
  for (const k of ["name", "default", "enter", "exit", "update", "share"] as const) {
    if (props?.[k] != null) (marker as Record<string, unknown>)[k] = props[k];
  }
  // A wrapper with no config still marks its hosts: like React's, it participates under an
  // automatic name. Clones keep each element's brand (`$$typeof`) and key.
  const out = markLevel(props?.children ?? null, marker, [], 0);
  return out != null && typeof out === "object" && !Array.isArray(out)
    ? out as VNode
    : h(Fragment, null, out);
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
