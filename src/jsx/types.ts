// Core virtual DOM types for denext's built-in JSX runtime.
// This is a self-contained mini virtual DOM — no React dependency.

export type Key = string | number | null | undefined;

/** A component is a function that receives props and returns a renderable node. */
export type Component<P = Record<string, unknown>> = (
  props: P & { children?: VNodeChildren },
) => VNode | Promise<VNode>;

/** The type field of a VNode: an intrinsic tag name, a component fn, or a fragment marker. */
// deno-lint-ignore no-explicit-any -- components accept heterogeneous prop shapes.
export type VNodeType = string | Component<any> | typeof FRAGMENT;

export const FRAGMENT = Symbol.for("denext.fragment");
export const TEXT = Symbol.for("denext.text");

/** Props passed to a virtual node. `children` is normalized separately. */
export interface VProps {
  [key: string]: unknown;
  children?: VNodeChildren;
  key?: Key;
}

/** A single virtual DOM node. */
export interface VNode {
  type: VNodeType;
  props: VProps;
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

export type VNodeChildren = VNodeChild | VNodeChild[];

/** JSX namespace so `.tsx` files typecheck against our runtime. */
export declare namespace JSX {
  interface Element extends VNode {}
  interface ElementChildrenAttribute {
    children: unknown;
  }
  // Permissive intrinsic elements: every lowercase tag accepts arbitrary props.
  interface IntrinsicElements {
    [tagName: string]: Record<string, unknown> & { key?: Key };
  }
}
