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
  ReactNode,
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
  /**
   * React element brand (`Symbol.for("react.transitional.element")`). Present on
   * every element `createElement`/`jsx`/`h` produces, matching React's element
   * shape so `isValidElement` (and libraries that read `element.$$typeof`) can
   * recognize a real element rather than any `{ type, props }`-shaped object.
   */
  $$typeof?: symbol;
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
  /**
   * What may be used as a JSX tag (TS 5.1+). Admitting a function that returns
   * `ReactNode` (not just `JSX.Element`) is what lets real React component
   * libraries — whose components are typed `(props) => ReactNode` and can return
   * `string`/`null`/`undefined` — be used as JSX without a return-type mismatch.
   * denext's own components (returning `VNode`/`Promise<VNode>`) are covered too,
   * since `VNode` is a `ReactNode`.
   */
  // deno-lint-ignore no-explicit-any
  type ElementType<P = any> =
    | string
    | ((props: P) => ReactNode | Promise<ReactNode>)
    // deno-lint-ignore no-explicit-any
    | (new (props: P) => { render(): ReactNode; props: any; state: any });
  /** The type produced by a JSX expression. */
  interface Element extends VNode {}
  /** Tells TypeScript which prop carries a component's children. */
  interface ElementChildrenAttribute {
    /** The property name (`children`) used to pass children. */
    children: unknown;
  }
  /**
   * Props TypeScript admits on EVERY JSX element — intrinsic tags and components
   * alike — regardless of the element's own prop type. denext puts the resumability
   * hydration directives here so `<Island client:visible />` type-checks on any
   * component without each one re-declaring them. The runtime strips every
   * `client:*` key before it reaches the DOM (see `parseStrategy` in
   * `runtime/lazy-directive.ts`), so these are authoring markers, not real props.
   */
  interface IntrinsicAttributes {
    /** Optional reconciliation key for this element. */
    key?: Key;
    /** Hydrate this client island eagerly, per-island (`client:load`). */
    "client:load"?: boolean;
    /** Hydrate when the main thread is idle (`client:idle`). */
    "client:idle"?: boolean;
    /** Hydrate when the island scrolls into view (`client:visible`). */
    "client:visible"?: boolean;
    /** Hydrate on first interaction — focus/pointer/keydown (`client:interaction`). */
    "client:interaction"?: boolean;
    /**
     * Hydrate when a CSS media query matches. The query is the attribute value:
     * `client:media="(min-width: 800px)"`. Bare `client:media` (boolean) is accepted
     * for symmetry but a query string is the useful form.
     */
    "client:media"?: boolean | string;
    /** Render on the client only, skipping SSR entirely (`client:only`). */
    "client:only"?: boolean;
  }
  /**
   * Intrinsic elements: common tags carry real per-element prop typing (from the
   * React-compatible attribute types in `compat/react-types.ts`), while the string
   * index keeps any other tag — and any attribute not enumerated — permissive so
   * valid props are never rejected.
   */
  interface IntrinsicElements {
    /** The `<a>` (anchor) element. */
    a: AnchorHTMLAttributes<HTMLAnchorElement>;
    /** The `<button>` element. */
    button: ButtonHTMLAttributes<HTMLButtonElement>;
    /** The `<input>` element. */
    input: InputHTMLAttributes<HTMLInputElement>;
    /** The `<textarea>` element. */
    textarea: TextareaHTMLAttributes<HTMLTextAreaElement>;
    /** The `<select>` element. */
    select: SelectHTMLAttributes<HTMLSelectElement>;
    /** The `<option>` element. */
    option: OptionHTMLAttributes<HTMLOptionElement>;
    /** The `<label>` element. */
    label: LabelHTMLAttributes<HTMLLabelElement>;
    /** The `<form>` element. */
    form: FormHTMLAttributes<HTMLFormElement>;
    /** The `<img>` element. */
    img: ImgHTMLAttributes<HTMLImageElement>;
    /** The `<ol>` (ordered list) element. */
    ol: OlHTMLAttributes<HTMLOListElement>;
    /** The `<td>` (table cell) element. */
    td: TdHTMLAttributes<HTMLTableCellElement>;
    /** The `<th>` (table header cell) element. */
    th: TdHTMLAttributes<HTMLTableCellElement>;
    /** The `<div>` element. */
    div: HTMLAttributes<HTMLDivElement>;
    /** The `<span>` element. */
    span: HTMLAttributes<HTMLSpanElement>;
    /** The `<p>` (paragraph) element. */
    p: HTMLAttributes<HTMLParagraphElement>;
    /** The `<h1>` heading element. */
    h1: HTMLAttributes<HTMLHeadingElement>;
    /** The `<h2>` heading element. */
    h2: HTMLAttributes<HTMLHeadingElement>;
    /** The `<h3>` heading element. */
    h3: HTMLAttributes<HTMLHeadingElement>;
    /** The `<h4>` heading element. */
    h4: HTMLAttributes<HTMLHeadingElement>;
    /** The `<h5>` heading element. */
    h5: HTMLAttributes<HTMLHeadingElement>;
    /** The `<h6>` heading element. */
    h6: HTMLAttributes<HTMLHeadingElement>;
    /** The `<ul>` (unordered list) element. */
    ul: HTMLAttributes<HTMLUListElement>;
    /** The `<li>` (list item) element. */
    li: HTMLAttributes<HTMLLIElement>;
    /** The `<nav>` element. */
    nav: HTMLAttributes<HTMLElement>;
    /** The `<header>` element. */
    header: HTMLAttributes<HTMLElement>;
    /** The `<footer>` element. */
    footer: HTMLAttributes<HTMLElement>;
    /** The `<main>` element. */
    main: HTMLAttributes<HTMLElement>;
    /** The `<section>` element. */
    section: HTMLAttributes<HTMLElement>;
    /** The `<article>` element. */
    article: HTMLAttributes<HTMLElement>;
    /** The `<aside>` element. */
    aside: HTMLAttributes<HTMLElement>;
    /** The `<svg>` root element. */
    svg: SVGProps<SVGSVGElement>;
    /** The SVG `<path>` element. */
    path: SVGProps<SVGPathElement>;
    /** Any other tag maps to an open-ended, permissive prop bag. */
    // deno-lint-ignore no-explicit-any
    [tagName: string]: any;
  }
}
