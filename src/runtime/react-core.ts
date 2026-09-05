// React's element/ref/Children core, shared by the `react` compat module AND the `denext`
// root barrel. Lives outside `src/compat` so the root barrel can export it without a cycle
// (the compat module imports the root barrel for hooks).

import type { Key, VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";
import type {
  ForwardedRef,
  ForwardRefExoticComponent,
  PropsWithoutRef,
  ReactNode,
  RefAttributes,
} from "../compat/react-types.ts";
import {
  brandOf,
  REACT_ELEMENT_TYPE,
  REACT_FORWARD_REF_TYPE,
  REACT_LEGACY_ELEMENT_TYPE,
  TYPEOF_KEY,
} from "./react-brands.ts";

/**
 * `React.createRef` — create a mutable ref object `{ current: null }` (used by
 * class components and imperative code).
 *
 * @returns A ref object with a `current` field initialized to `null`.
 */
export function createRef<T = unknown>(): { current: T | null } {
  return { current: null };
}

/**
 * `React.forwardRef` — best-effort. denext threads `ref` through props, so the
 * `render` function receives `(props, props.ref)`.
 *
 * @param render The render function `(props, ref) => element`.
 * @returns A function component.
 */
export function forwardRef<T, P = Record<never, never>>(
  render: (props: P, ref: ForwardedRef<T>) => ReactNode,
): ForwardRefExoticComponent<PropsWithoutRef<P> & RefAttributes<T>> {
  // React's non-callable forwardRef element object: `{ $$typeof, render }`. The
  // renderers resolve it through `resolveComponentType` and invoke `render(props,
  // ref)` (denext threads `ref` via props). The public type is
  // ForwardRefExoticComponent (callable, ref-forwarding, with a settable
  // `displayName`) to match React's `forwardRef<T, P>` — the value is used only as
  // a JSX element type.
  const component = { [TYPEOF_KEY]: REACT_FORWARD_REF_TYPE, render };
  return component as unknown as ForwardRefExoticComponent<PropsWithoutRef<P> & RefAttributes<T>>;
}

/**
 * `React.isValidElement` — true only for a value carrying the React element brand
 * (`$$typeof`), matching React. A plain `{ type, props }` object without the brand is
 * rejected, so config/data objects that happen to share that shape are not mistaken
 * for elements.
 *
 * @param value Any value.
 * @returns Whether `value` is a renderable element.
 */
export function isValidElement(value: unknown): value is VNode {
  const b = brandOf(value);
  return b === REACT_ELEMENT_TYPE || b === REACT_LEGACY_ELEMENT_TYPE;
}

/**
 * `React.cloneElement` — shallow-clone `element`, merging `config` over its props and
 * replacing children when any are given. `key` and `ref` are special-cased the way
 * React does: a `key`/`ref` in `config` overrides, otherwise the original element's is
 * preserved, and neither is left in the merged props as a component-visible prop.
 *
 * @param element The element to clone.
 * @param config Props to merge over the element's own (may carry `key`/`ref`).
 * @param children Replacement children (optional).
 * @returns The cloned element.
 */
export function cloneElement(
  element: VNode,
  config?: Record<string, unknown>,
  ...children: VNodeChild[]
): VNode {
  // Start from the original props, then overlay config — but pull key/ref out so they
  // never merge into the component-visible prop bag (React keeps them off props).
  const nextProps: Record<string, unknown> = { ...(element.props as Record<string, unknown>) };
  const { key, ref } = overlayConfig(nextProps, element, config);
  // Re-attach ref via props (denext threads ref through props.ref), and drop key from
  // props so it stays a top-level field only.
  if (ref !== undefined) nextProps.ref = ref;
  else delete nextProps.ref;
  delete nextProps.key;
  if (children.length > 0) nextProps.children = children.length === 1 ? children[0] : children;
  return { ...element, props: nextProps, key: key ?? null };
}

/** Overlay `config` onto `props` in place; `key`/`ref` are returned, not merged. */
function overlayConfig(
  props: Record<string, unknown>,
  element: VNode,
  config: Record<string, unknown> | undefined,
): { key: Key | null | undefined; ref: unknown } {
  let key = element.key;
  let ref = (element.props as { ref?: unknown }).ref;
  if (config == null) return { key, ref };
  if (config.key !== undefined) key = config.key as Key;
  if (config.ref !== undefined) ref = config.ref;
  for (const k in config) {
    if (k !== "key" && k !== "ref") props[k] = config[k];
  }
  return { key, ref };
}

// ── React.Children ─────────────────────────────────────────────────────────────
// `map`/`toArray` reproduce React's `mapChildren` key scheme exactly: every element in
// the output is a clone keyed by its POSITION — `.` + (its escaped user key `$k`, else
// its base-36 index), `:` between nested-array levels — so a server render and a client
// hydrate over the same tree derive byte-identical keys. A callback that returns an
// element carrying a different key than its input prepends `<thatKey>/`, as React does.

/** React's `getElementKey`: `$` + the user key (`=` → `=0`, `:` → `=2`), else the index. */
function elementKey(child: VNodeChild, index: number): string {
  const key = isValidElement(child) ? child.key : null;
  if (key == null) return index.toString(36);
  return "$" + String(key).replace(/[=:]/g, (m) => (m === "=" ? "=0" : "=2"));
}

/** React's `escapeUserProvidedKey`: double every `/` run so it can't read as a separator. */
const escapeKeyPrefix = (text: string): string => text.replace(/\/+/g, "$&/");

/** React treats `undefined` and booleans as an empty (`null`) leaf — the callback still runs. */
const asLeaf = (c: unknown): VNodeChild =>
  c === undefined || typeof c === "boolean" ? null : (c as VNodeChild);

/** A non-array, non-string iterable (a `Set`, a generator) React flattens like an array. */
function iterableChildren(c: unknown): Iterable<VNodeChild> | null {
  if (c == null || typeof c !== "object" || Array.isArray(c)) return null;
  const it = (c as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  return typeof it === "function" ? (c as Iterable<VNodeChild>) : null;
}

type ChildMapper = (child: VNodeChild, index: number) => unknown;

/** The accumulator threaded through one `mapChildren` walk. */
interface MapWalk {
  out: unknown[];
  fn: ChildMapper;
  /** Running leaf index handed to `fn`. */
  count: number;
}

/**
 * Clone `mapped` under React's combined key: `prefix` + (`<own key>/` when it differs
 * from the input's) + `childKey`.
 */
function rekey(mapped: VNode, child: VNodeChild, prefix: string, childKey: string): VNode {
  const inputKey = isValidElement(child) ? child.key : null;
  const own = mapped.key != null && mapped.key !== inputKey
    ? escapeKeyPrefix(String(mapped.key)) + "/"
    : "";
  return cloneElement(mapped, { key: prefix + own + childKey });
}

/**
 * React's `mapIntoArray`: walk `children`, call `walk.fn` on every leaf, and push the
 * re-keyed results onto `walk.out`. `prefix` is the escaped key prefix inherited from an
 * enclosing callback-returned array; `name` is the positional name accumulated so far.
 */
function mapIntoArray(children: VNodeChildren, prefix: string, name: string, walk: MapWalk): void {
  const list = Array.isArray(children) ? children : iterableChildren(children);
  if (list) {
    const next = name === "" ? "." : name + ":";
    let i = 0;
    for (const c of list) mapIntoArray(c, prefix, next + elementKey(c, i++), walk);
    return;
  }
  const leaf = asLeaf(children);
  if (leaf !== null && typeof leaf === "object" && !isValidElement(leaf)) {
    throw new Error(
      "Objects are not valid as a React child (found: object). If you meant to render a " +
        "collection of children, use an array instead.",
    );
  }
  // A lone top-level child is named as if it were wrapped in an array (so does React).
  const childKey = name === "" ? "." + elementKey(leaf, 0) : name;
  const mapped = walk.fn(leaf, walk.count++);
  if (Array.isArray(mapped)) {
    const sub: MapWalk = { out: walk.out, fn: (c) => c, count: 0 };
    mapIntoArray(mapped as VNodeChildren, escapeKeyPrefix(childKey) + "/", "", sub);
  } else if (mapped != null) {
    walk.out.push(isValidElement(mapped) ? rekey(mapped, leaf, prefix, childKey) : mapped);
  }
}

/** React's `mapChildren`: flatten, call `fn` per leaf, and re-key every element result. */
function mapChildren(children: VNodeChildren, fn: ChildMapper): unknown[] {
  const walk: MapWalk = { out: [], fn, count: 0 };
  mapIntoArray(children, "", "", walk);
  return walk.out;
}

/** True when `children` is a single valid element — what `Children.only` accepts. */
const isOnlyChild = (c: unknown): c is VNode => isValidElement(c);

/** The `React.Children` utility surface. */
export interface ChildrenApi {
  /** Map over children (flattening arrays/iterables); element results are re-keyed by position. */
  map<T>(children: VNodeChildren, fn: (child: VNodeChild, index: number) => T): T[];
  /** Iterate over children (holes are visited as `null`, like React). */
  forEach(children: VNodeChildren, fn: (child: VNodeChild, index: number) => void): void;
  /** Count the leaves, holes included (React counts `[null, "a"]` as 2). */
  count(children: VNodeChildren): number;
  /** Children as a flat array; every element is a clone keyed by its position. */
  toArray(children: VNodeChildren): VNodeChild[];
  /** The single child, or throw. */
  only(children: VNodeChildren): VNodeChild;
}

/** `React.Children` utilities over denext children. */
export const Children: ChildrenApi = {
  /**
   * Map over children, like `React.Children.map`: arrays and iterables are flattened, the
   * callback also runs for `null`/`undefined`/boolean leaves (as `null`), and `null`/
   * `undefined` results are dropped. `null`/`undefined` children return them unchanged.
   */
  map<T>(children: VNodeChildren, fn: (child: VNodeChild, index: number) => T): T[] {
    if (children == null) return children as unknown as T[];
    return mapChildren(children, fn) as T[];
  },
  /** Iterate over children, like `React.Children.forEach` (no cloning). */
  forEach(children: VNodeChildren, fn: (child: VNodeChild, index: number) => void): void {
    mapChildren(children, (c, i) => void fn(c, i));
  },
  /** Count the children, like `React.Children.count`. */
  count(children: VNodeChildren): number {
    let n = 0;
    Children.forEach(children, () => void n++);
    return n;
  },
  /** Children as a flat array, like `React.Children.toArray` (elements re-keyed). */
  toArray(children: VNodeChildren): VNodeChild[] {
    return mapChildren(children, (c) => c) as VNodeChild[];
  },
  /** The single ELEMENT child (as authored), or throw — like `React.Children.only`. */
  only(children: VNodeChildren): VNodeChild {
    if (!isOnlyChild(children)) {
      throw new Error("React.Children.only expected to receive a single React element child.");
    }
    return children;
  },
};
