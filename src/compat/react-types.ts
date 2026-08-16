// deno-lint-ignore-file no-explicit-any
/**
 * React-compatible TYPE surface for denext (types only — no runtime).
 *
 * Re-exported from {@link ./react.ts} so `import type { … } from "react"` (via the
 * app's `react` → denext alias) resolves the type names real component libraries
 * (shadcn/ui, class-variance-authority, Radix) rely on: HTMLAttributes families,
 * `forwardRef<T, P>`, `ComponentProps`, `ElementRef`, `ReactNode`, event types, …
 *
 * These map onto denext's own runtime element type (`VNode`) where sensible and
 * stay intentionally permissive (a string index on attribute bags) so valid props
 * are never rejected. Hand-authored to mirror `@types/react` shapes without adding
 * an npm type dependency.
 *
 * @module
 */

import type { VNode } from "../jsx/types.ts";

/** A stable list identity. */
export type Key = string | number;

// --- Nodes & elements --------------------------------------------------------

/** A denext element (React's `ReactElement`). */
export type ReactElement<P = any> = VNode & { props: P };
/** React's `JSXElementConstructor`. */
export type JSXElementConstructor<P> =
  | ((props: P) => ReactNode)
  | (new (props: P) => { render(): ReactNode });
/** Anything renderable as a child (React's `ReactNode`). Accepts denext `VNode`. */
export type ReactNode =
  | VNode
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Iterable<ReactNode>;
/** React's `ReactPortal`. */
export type ReactPortal = VNode;
/** React's `ReactFragment`. */
export type ReactFragment = Iterable<ReactNode>;

// --- Refs --------------------------------------------------------------------

/** A mutable ref cell. */
export interface MutableRefObject<T> {
  current: T;
}
/** A read-ish ref cell (React's `RefObject`). */
export interface RefObject<T> {
  readonly current: T | null;
}
/** A callback ref. */
export type RefCallback<T> = (instance: T | null) => void | (() => void);
/** A ref value (callback or object). */
export type Ref<T> = RefCallback<T> | RefObject<T> | null;
/** Legacy ref (adds string refs to `Ref`). */
export type LegacyRef<T> = Ref<T> | string;
/** The ref a `forwardRef` render fn receives. */
export type ForwardedRef<T> = ((instance: T | null) => void) | MutableRefObject<T | null> | null;
/** Adds a typed `ref` to a component's props. */
export interface RefAttributes<T> {
  ref?: Ref<T> | undefined;
  key?: Key | null | undefined;
}
/** Marks props that carry a `key`. */
export interface Attributes {
  key?: Key | null | undefined;
}

// --- Prop helpers ------------------------------------------------------------

/** Add `children` to props. */
export type PropsWithChildren<P = unknown> = P & { children?: ReactNode | undefined };
/** Strip `ref` from props. */
export type PropsWithoutRef<P> = P extends any ? ("ref" extends keyof P ? Omit<P, "ref"> : P) : P;
/** Add an optional `ref` to props. */
export type PropsWithRef<P> = P;

// --- Component types ---------------------------------------------------------

/** A function component. */
export interface FunctionComponent<P = Record<never, never>> {
  (props: P): ReactNode;
  displayName?: string | undefined;
}
/** Alias for {@link FunctionComponent}. */
export type FC<P = Record<never, never>> = FunctionComponent<P>;
/** A class component's instance shape (minimal). */
export interface Component<P = unknown, S = unknown> {
  props: P;
  state: S;
  render(): ReactNode;
}
/** A class component constructor. */
export interface ComponentClass<P = Record<never, never>> {
  new (props: P): Component<P>;
  displayName?: string | undefined;
}
/** Either a function or class component. */
export type ComponentType<P = Record<never, never>> = FunctionComponent<P> | ComponentClass<P>;
/** A callable "exotic" component (forwardRef/memo/lazy results). */
export interface ExoticComponent<P = Record<never, never>> {
  (props: P): ReactNode;
  readonly $$typeof?: symbol;
}
/** An exotic component with a `displayName`. */
export interface NamedExoticComponent<P = Record<never, never>> extends ExoticComponent<P> {
  displayName?: string | undefined;
}
/** The result of `forwardRef` — callable, ref-forwarding, with a settable name. */
export interface ForwardRefExoticComponent<P> extends NamedExoticComponent<P> {
  defaultProps?: Partial<P> | undefined;
}
/** The result of `memo`. */
export interface MemoExoticComponent<T extends ComponentType<any>>
  extends NamedExoticComponent<React_ComponentProps<T>> {
  readonly type: T;
}
/** The `render` fn passed to `forwardRef`. */
export type ForwardRefRenderFunction<T, P = Record<never, never>> = (
  props: P,
  ref: ForwardedRef<T>,
) => ReactNode;

// Internal helper for MemoExoticComponent's props.
type React_ComponentProps<T> = T extends ComponentType<infer P> ? P : Record<never, never>;

/** Props of a component or intrinsic element type (React's `ComponentProps`). */
export type ComponentProps<T> = T extends JSXElementConstructor<infer P> ? P
  : T extends keyof IntrinsicElementInstances ? HTMLAttributes<IntrinsicElementInstances[T]>
  : T extends string ? HTMLAttributes<Element>
  : Record<never, never>;
/** {@link ComponentProps} without `ref`. */
export type ComponentPropsWithoutRef<T> = PropsWithoutRef<ComponentProps<T>>;
/** {@link ComponentProps} with `ref`. */
export type ComponentPropsWithRef<T> = ComponentProps<T>;
/** The ref/instance type of a component or intrinsic element. */
export type ElementRef<T> = T extends keyof IntrinsicElementInstances ? IntrinsicElementInstances[T]
  : unknown;

// --- Style & ARIA ------------------------------------------------------------

/** Inline style object (permissive). */
export interface CSSProperties {
  [key: string]: string | number | undefined;
}
/** ARIA attributes (permissive superset). */
export interface AriaAttributes {
  [key: `aria-${string}`]: any;
  role?: string | undefined;
}

// --- Events ------------------------------------------------------------------

/** Base synthetic event. */
export interface SyntheticEvent<T = Element, E = Event> {
  currentTarget: T;
  target: EventTarget & T;
  nativeEvent: E;
  preventDefault(): void;
  stopPropagation(): void;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  type: string;
  timeStamp: number;
  isDefaultPrevented(): boolean;
  isPropagationStopped(): boolean;
  persist(): void;
}
/** A change event (inputs). */
export interface ChangeEvent<T = Element> extends SyntheticEvent<T> {
  target: EventTarget & T;
}
/** A form event. */
export interface FormEvent<T = Element> extends SyntheticEvent<T> {}
/** A mouse event. */
export interface MouseEvent<T = Element, E = globalThis.MouseEvent> extends SyntheticEvent<T, E> {
  altKey: boolean;
  button: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  pageX: number;
  pageY: number;
}
/** A keyboard event. */
export interface KeyboardEvent<T = Element> extends SyntheticEvent<T, globalThis.KeyboardEvent> {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}
/** A focus event. */
export interface FocusEvent<T = Element, R = Element>
  extends SyntheticEvent<T, globalThis.FocusEvent> {
  relatedTarget: (EventTarget & R) | null;
}
/** A pointer event. */
export interface PointerEvent<T = Element> extends MouseEvent<T, globalThis.PointerEvent> {
  pointerId: number;
  pointerType: string;
}
/** A touch event. */
export interface TouchEvent<T = Element> extends SyntheticEvent<T, globalThis.TouchEvent> {}
/** A clipboard event. */
export interface ClipboardEvent<T = Element> extends SyntheticEvent<T, globalThis.ClipboardEvent> {}
/** A drag event. */
export interface DragEvent<T = Element> extends MouseEvent<T, globalThis.DragEvent> {}
/** A wheel event. */
export interface WheelEvent<T = Element> extends MouseEvent<T, globalThis.WheelEvent> {}
/** An animation event. */
export interface AnimationEvent<T = Element> extends SyntheticEvent<T, globalThis.AnimationEvent> {}
/** A transition event. */
export interface TransitionEvent<T = Element>
  extends SyntheticEvent<T, globalThis.TransitionEvent> {}
/** A UI event. */
export interface UIEvent<T = Element> extends SyntheticEvent<T, globalThis.UIEvent> {}

/** A generic event handler. */
export type EventHandler<E extends SyntheticEvent<any>> = (event: E) => void;
/** Handler for a base synthetic event. */
export type ReactEventHandler<T = Element> = EventHandler<SyntheticEvent<T>>;
/** Mouse event handler. */
export type MouseEventHandler<T = Element> = EventHandler<MouseEvent<T>>;
/** Change event handler. */
export type ChangeEventHandler<T = Element> = EventHandler<ChangeEvent<T>>;
/** Form event handler. */
export type FormEventHandler<T = Element> = EventHandler<FormEvent<T>>;
/** Keyboard event handler. */
export type KeyboardEventHandler<T = Element> = EventHandler<KeyboardEvent<T>>;
/** Focus event handler. */
export type FocusEventHandler<T = Element> = EventHandler<FocusEvent<T>>;
/** Pointer event handler. */
export type PointerEventHandler<T = Element> = EventHandler<PointerEvent<T>>;

/** The DOM event-handler surface shared by every element (permissive). */
export interface DOMAttributes<T> {
  children?: ReactNode | undefined;
  dangerouslySetInnerHTML?: { __html: string } | undefined;
  onClick?: MouseEventHandler<T> | undefined;
  onDoubleClick?: MouseEventHandler<T> | undefined;
  onMouseDown?: MouseEventHandler<T> | undefined;
  onMouseUp?: MouseEventHandler<T> | undefined;
  onMouseEnter?: MouseEventHandler<T> | undefined;
  onMouseLeave?: MouseEventHandler<T> | undefined;
  onMouseMove?: MouseEventHandler<T> | undefined;
  onMouseOver?: MouseEventHandler<T> | undefined;
  onMouseOut?: MouseEventHandler<T> | undefined;
  onContextMenu?: MouseEventHandler<T> | undefined;
  onChange?: FormEventHandler<T> | undefined;
  onInput?: FormEventHandler<T> | undefined;
  onSubmit?: FormEventHandler<T> | undefined;
  onReset?: FormEventHandler<T> | undefined;
  onKeyDown?: KeyboardEventHandler<T> | undefined;
  onKeyUp?: KeyboardEventHandler<T> | undefined;
  onKeyPress?: KeyboardEventHandler<T> | undefined;
  onFocus?: FocusEventHandler<T> | undefined;
  onBlur?: FocusEventHandler<T> | undefined;
  onPointerDown?: PointerEventHandler<T> | undefined;
  onPointerUp?: PointerEventHandler<T> | undefined;
  onPointerEnter?: PointerEventHandler<T> | undefined;
  onPointerLeave?: PointerEventHandler<T> | undefined;
  onPointerMove?: PointerEventHandler<T> | undefined;
  onScroll?: ReactEventHandler<T> | undefined;
  onWheel?: EventHandler<WheelEvent<T>> | undefined;
  onDrag?: EventHandler<DragEvent<T>> | undefined;
  onDrop?: EventHandler<DragEvent<T>> | undefined;
  onCopy?: EventHandler<ClipboardEvent<T>> | undefined;
  onPaste?: EventHandler<ClipboardEvent<T>> | undefined;
  onCut?: EventHandler<ClipboardEvent<T>> | undefined;
  onTouchStart?: EventHandler<TouchEvent<T>> | undefined;
  onTouchEnd?: EventHandler<TouchEvent<T>> | undefined;
  onTouchMove?: EventHandler<TouchEvent<T>> | undefined;
  onAnimationEnd?: EventHandler<AnimationEvent<T>> | undefined;
  onTransitionEnd?: EventHandler<TransitionEvent<T>> | undefined;
}

// --- HTML / SVG attribute bags ----------------------------------------------

/** Attributes common to every HTML element (permissive: unknown attrs allowed). */
export interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
  className?: string | undefined;
  id?: string | undefined;
  style?: CSSProperties | undefined;
  title?: string | undefined;
  tabIndex?: number | undefined;
  hidden?: boolean | undefined;
  dir?: string | undefined;
  lang?: string | undefined;
  slot?: string | undefined;
  ref?: Ref<T> | undefined;
  key?: Key | null | undefined;
  suppressHydrationWarning?: boolean | undefined;
  suppressContentEditableWarning?: boolean | undefined;
  contentEditable?: boolean | "true" | "false" | "inherit" | undefined;
  draggable?: boolean | undefined;
  spellCheck?: boolean | undefined;
  translate?: "yes" | "no" | undefined;
  // Permissive tail: data-*, custom, and any attribute we didn't enumerate.
  [key: string]: any;
}
/** `<button>` attributes. */
export interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> {
  type?: "submit" | "reset" | "button" | undefined;
  disabled?: boolean | undefined;
  form?: string | undefined;
  name?: string | undefined;
  value?: string | number | readonly string[] | undefined;
  autoFocus?: boolean | undefined;
}
/** `<input>` attributes. */
export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
  type?: string | undefined;
  value?: string | number | readonly string[] | undefined;
  defaultValue?: string | number | readonly string[] | undefined;
  checked?: boolean | undefined;
  defaultChecked?: boolean | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  required?: boolean | undefined;
  name?: string | undefined;
  autoComplete?: string | undefined;
  autoFocus?: boolean | undefined;
  min?: string | number | undefined;
  max?: string | number | undefined;
  step?: string | number | undefined;
  maxLength?: number | undefined;
  minLength?: number | undefined;
  pattern?: string | undefined;
  accept?: string | undefined;
  multiple?: boolean | undefined;
}
/** `<a>` attributes. */
export interface AnchorHTMLAttributes<T> extends HTMLAttributes<T> {
  href?: string | undefined;
  target?: string | undefined;
  rel?: string | undefined;
  download?: any;
  hrefLang?: string | undefined;
  type?: string | undefined;
  referrerPolicy?: string | undefined;
}
/** `<textarea>` attributes. */
export interface TextareaHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string | number | readonly string[] | undefined;
  defaultValue?: string | number | readonly string[] | undefined;
  placeholder?: string | undefined;
  rows?: number | undefined;
  cols?: number | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  required?: boolean | undefined;
  name?: string | undefined;
  maxLength?: number | undefined;
}
/** `<select>` attributes. */
export interface SelectHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string | number | readonly string[] | undefined;
  defaultValue?: string | number | readonly string[] | undefined;
  disabled?: boolean | undefined;
  multiple?: boolean | undefined;
  required?: boolean | undefined;
  name?: string | undefined;
  size?: number | undefined;
}
/** `<option>` attributes. */
export interface OptionHTMLAttributes<T> extends HTMLAttributes<T> {
  value?: string | number | readonly string[] | undefined;
  disabled?: boolean | undefined;
  label?: string | undefined;
  selected?: boolean | undefined;
}
/** `<label>` attributes. */
export interface LabelHTMLAttributes<T> extends HTMLAttributes<T> {
  htmlFor?: string | undefined;
  form?: string | undefined;
}
/** `<form>` attributes. */
export interface FormHTMLAttributes<T> extends HTMLAttributes<T> {
  action?: string | ((formData: FormData) => void | Promise<void>) | undefined;
  method?: string | undefined;
  encType?: string | undefined;
  target?: string | undefined;
  noValidate?: boolean | undefined;
  autoComplete?: string | undefined;
}
/** `<img>` attributes. */
export interface ImgHTMLAttributes<T> extends HTMLAttributes<T> {
  src?: string | undefined;
  alt?: string | undefined;
  width?: number | string | undefined;
  height?: number | string | undefined;
  loading?: "eager" | "lazy" | undefined;
  srcSet?: string | undefined;
  sizes?: string | undefined;
  decoding?: "async" | "auto" | "sync" | undefined;
  referrerPolicy?: string | undefined;
}
/** `<ol>` attributes. */
export interface OlHTMLAttributes<T> extends HTMLAttributes<T> {
  start?: number | undefined;
  reversed?: boolean | undefined;
  type?: "1" | "a" | "A" | "i" | "I" | undefined;
}
/** `<td>`/`<th>` attributes. */
export interface TdHTMLAttributes<T> extends HTMLAttributes<T> {
  colSpan?: number | undefined;
  rowSpan?: number | undefined;
  headers?: string | undefined;
  scope?: string | undefined;
}
/** SVG element attributes (permissive). */
export interface SVGAttributes<T> extends AriaAttributes, DOMAttributes<T> {
  className?: string | undefined;
  id?: string | undefined;
  style?: CSSProperties | undefined;
  ref?: Ref<T> | undefined;
  key?: Key | null | undefined;
  width?: number | string | undefined;
  height?: number | string | undefined;
  viewBox?: string | undefined;
  fill?: string | undefined;
  stroke?: string | undefined;
  xmlns?: string | undefined;
  [key: string]: any;
}
/** Alias for {@link SVGAttributes} (React's `SVGProps`). */
export type SVGProps<T> = SVGAttributes<T>;
/** React's `HTMLProps`. */
export type HTMLProps<T> = HTMLAttributes<T>;
/** React's `DetailedHTMLProps` — element attributes plus `ref`/`key`. */
export type DetailedHTMLProps<E extends HTMLAttributes<T>, T> = E;

// --- Intrinsic element → instance type (for ElementRef) ----------------------

/** Map of intrinsic tag → its DOM instance type (subset; falls back to Element). */
export interface IntrinsicElementInstances {
  a: HTMLAnchorElement;
  button: HTMLButtonElement;
  div: HTMLDivElement;
  form: HTMLFormElement;
  h1: HTMLHeadingElement;
  h2: HTMLHeadingElement;
  h3: HTMLHeadingElement;
  img: HTMLImageElement;
  input: HTMLInputElement;
  label: HTMLLabelElement;
  li: HTMLLIElement;
  ol: HTMLOListElement;
  option: HTMLOptionElement;
  p: HTMLParagraphElement;
  select: HTMLSelectElement;
  span: HTMLSpanElement;
  table: HTMLTableElement;
  textarea: HTMLTextAreaElement;
  ul: HTMLUListElement;
  svg: SVGSVGElement;
}
