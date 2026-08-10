// Core virtual DOM types for denext's built-in JSX runtime.
// This is a self-contained mini virtual DOM — no React dependency.

/** A stable identity for a VNode among its siblings, used to keep lists reconciled. */
export type Key = string | number | null | undefined;

/** A component is a function that receives props and returns a renderable node. */
export type Component<P = Record<string, unknown>> = (
  props: P & { children?: VNodeChildren },
) => VNode | Promise<VNode>;

/** The type field of a VNode: an intrinsic tag name, a component fn, or a fragment marker. */
// deno-lint-ignore no-explicit-any -- components accept heterogeneous prop shapes.
export type VNodeType = string | Component<any> | typeof FRAGMENT;

/** Marker used as a VNode `type` to group children without a wrapping element. */
export const FRAGMENT: unique symbol = Symbol.for("denext.fragment");
/** Marker identifying a text node in the virtual DOM. */
export const TEXT: unique symbol = Symbol.for("denext.text");
/**
 * Marker used as a VNode `type` for a portal: its children mount into a separate
 * DOM `target` (carried in props) while keeping their position in the component
 * and context tree. Backs `createPortal`.
 */
export const PORTAL: unique symbol = Symbol.for("denext.portal");

/** Props passed to a virtual node. `children` is normalized separately. */
export interface VProps {
  /** Arbitrary attributes and props passed through to the node. */
  [key: string]: unknown;
  /** Child nodes to render inside this node. */
  children?: VNodeChildren;
  /** Optional reconciliation key for this node. */
  key?: Key;
}

/** A single virtual DOM node. */
export interface VNode {
  /** What to render: an intrinsic tag, a component function, or the fragment marker. */
  type: VNodeType;
  /** Props for this node, including its normalized `children`. */
  props: VProps;
  /** Resolved reconciliation key, or `null` when none was supplied. */
  key: Key;
  /** Populated by the reconciler on the client; never present during SSR. */
  _dom?: Node | null;
  /** Rendered child VNodes, filled in during reconciliation. */
  _rendered?: VNode[] | null;
  /** Hook state cell list for function components (client only). */
  _hooks?: unknown[];
}

/** Anything that can appear as a child in JSX. */
export type VNodeChild =
  | VNode
  | string
  | number
  | boolean
  | null
  | undefined;

/** One child or an array of children, as accepted by JSX. */
export type VNodeChildren = VNodeChild | VNodeChild[];

/** JSX namespace so `.tsx` files typecheck against our runtime. */
export declare namespace JSX {
  /** The type produced by a JSX expression. */
  interface Element extends VNode {}
  /** Tells TypeScript which prop carries a component's children. */
  interface ElementChildrenAttribute {
    /** The property name (`children`) used to pass children. */
    children: unknown;
  }
  /** Permissive intrinsic elements: every lowercase tag accepts arbitrary props. */
  interface IntrinsicElements {
    /** Any tag name maps to an open-ended prop bag with an optional key. */
    [tagName: string]: Record<string, unknown> & { key?: Key };
  }
}
