// Core virtual DOM types for denext's built-in JSX runtime.
// This is a self-contained mini virtual DOM — no React dependency.

import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  FormHTMLAttributes,
  HTMLAttributes,
  ImgHTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  OlHTMLAttributes,
  OptionHTMLAttributes,
  SelectHTMLAttributes,
  SVGProps,
  TdHTMLAttributes,
  TextareaHTMLAttributes,
} from "../compat/react-types.ts";

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
  /**
   * Intrinsic elements: common tags carry real per-element prop typing (from the
   * React-compatible attribute types in `compat/react-types.ts`), while the string
   * index keeps any other tag — and any attribute not enumerated — permissive so
   * valid props are never rejected.
   */
  interface IntrinsicElements {
    a: AnchorHTMLAttributes<HTMLAnchorElement>;
    button: ButtonHTMLAttributes<HTMLButtonElement>;
    input: InputHTMLAttributes<HTMLInputElement>;
    textarea: TextareaHTMLAttributes<HTMLTextAreaElement>;
    select: SelectHTMLAttributes<HTMLSelectElement>;
    option: OptionHTMLAttributes<HTMLOptionElement>;
    label: LabelHTMLAttributes<HTMLLabelElement>;
    form: FormHTMLAttributes<HTMLFormElement>;
    img: ImgHTMLAttributes<HTMLImageElement>;
    ol: OlHTMLAttributes<HTMLOListElement>;
    td: TdHTMLAttributes<HTMLTableCellElement>;
    th: TdHTMLAttributes<HTMLTableCellElement>;
    div: HTMLAttributes<HTMLDivElement>;
    span: HTMLAttributes<HTMLSpanElement>;
    p: HTMLAttributes<HTMLParagraphElement>;
    h1: HTMLAttributes<HTMLHeadingElement>;
    h2: HTMLAttributes<HTMLHeadingElement>;
    h3: HTMLAttributes<HTMLHeadingElement>;
    h4: HTMLAttributes<HTMLHeadingElement>;
    h5: HTMLAttributes<HTMLHeadingElement>;
    h6: HTMLAttributes<HTMLHeadingElement>;
    ul: HTMLAttributes<HTMLUListElement>;
    li: HTMLAttributes<HTMLLIElement>;
    nav: HTMLAttributes<HTMLElement>;
    header: HTMLAttributes<HTMLElement>;
    footer: HTMLAttributes<HTMLElement>;
    main: HTMLAttributes<HTMLElement>;
    section: HTMLAttributes<HTMLElement>;
    article: HTMLAttributes<HTMLElement>;
    aside: HTMLAttributes<HTMLElement>;
    svg: SVGProps<SVGSVGElement>;
    path: SVGProps<SVGPathElement>;
    /** Any other tag maps to an open-ended, permissive prop bag. */
    // deno-lint-ignore no-explicit-any
    [tagName: string]: any;
  }
}
