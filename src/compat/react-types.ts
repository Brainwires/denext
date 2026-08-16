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
  /** The current ref value. */
  current: T;
}
/** A read-ish ref cell (React's `RefObject`). */
export interface RefObject<T> {
  /** The current ref value, or `null` before attach. */
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
  /** The forwarded `ref`. */
  ref?: Ref<T> | undefined;
  /** The list-identity `key`. */
  key?: Key | null | undefined;
}
/** Marks props that carry a `key`. */
export interface Attributes {
  /** The list-identity `key`. */
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
  /** Renders the component from its props. */
  (props: P): ReactNode;
  /** Optional name shown in devtools. */
  displayName?: string | undefined;
}
/** Alias for {@link FunctionComponent}. */
export type FC<P = Record<never, never>> = FunctionComponent<P>;
/** A class component's instance shape (minimal). */
export interface Component<P = unknown, S = unknown> {
  /** The instance props. */
  props: P;
  /** The instance state. */
  state: S;
  /** Renders the component. */
  render(): ReactNode;
}
/** A class component constructor. */
export interface ComponentClass<P = Record<never, never>> {
  /** Constructs the component instance from props. */
  new (props: P): Component<P>;
  /** Optional name shown in devtools. */
  displayName?: string | undefined;
}
/** Either a function or class component. */
export type ComponentType<P = Record<never, never>> = FunctionComponent<P> | ComponentClass<P>;
/** A callable "exotic" component (forwardRef/memo/lazy results). */
export interface ExoticComponent<P = Record<never, never>> {
  /** Renders the component from its props. */
  (props: P): ReactNode;
  /** React's element-type marker symbol. */
  readonly $$typeof?: symbol;
}
/** An exotic component with a `displayName`. */
export interface NamedExoticComponent<P = Record<never, never>> extends ExoticComponent<P> {
  /** Optional name shown in devtools. */
  displayName?: string | undefined;
}
/** The result of `forwardRef` — callable, ref-forwarding, with a settable name. */
export interface ForwardRefExoticComponent<P> extends NamedExoticComponent<P> {
  /** Default prop values. */
  defaultProps?: Partial<P> | undefined;
}
/** The result of `memo`. */
export interface MemoExoticComponent<T extends ComponentType<any>>
  extends NamedExoticComponent<React_ComponentProps<T>> {
  /** The memoized inner component type. */
  readonly type: T;
}
/** The `render` fn passed to `forwardRef`. */
export type ForwardRefRenderFunction<T, P = Record<never, never>> = (
  props: P,
  ref: ForwardedRef<T>,
) => ReactNode;

/** Internal helper for MemoExoticComponent's props. */
export type React_ComponentProps<T> = T extends ComponentType<infer P> ? P : Record<never, never>;

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
  /** Any CSS property name mapped to its value. */
  [key: string]: string | number | undefined;
}
/** ARIA attributes (permissive superset). */
export interface AriaAttributes {
  /** Any `aria-*` attribute. */
  [key: `aria-${string}`]: any;
  /** The ARIA `role`. */
  role?: string | undefined;
}

// --- Events ------------------------------------------------------------------

/** Base synthetic event. */
export interface SyntheticEvent<T = Element, E = Event> {
  /** The element the handler is attached to. */
  currentTarget: T;
  /** The element that dispatched the event. */
  target: EventTarget & T;
  /** The underlying native DOM event. */
  nativeEvent: E;
  /** Cancels the event's default action. */
  preventDefault(): void;
  /** Stops further propagation of the event. */
  stopPropagation(): void;
  /** Whether the event bubbles. */
  bubbles: boolean;
  /** Whether the event is cancelable. */
  cancelable: boolean;
  /** Whether `preventDefault` was called. */
  defaultPrevented: boolean;
  /** The event type name. */
  type: string;
  /** The event creation time. */
  timeStamp: number;
  /** Whether the default action was prevented. */
  isDefaultPrevented(): boolean;
  /** Whether propagation was stopped. */
  isPropagationStopped(): boolean;
  /** No-op retained for React API compatibility. */
  persist(): void;
}
/** A change event (inputs). */
export interface ChangeEvent<T = Element> extends SyntheticEvent<T> {
  /** The changed element. */
  target: EventTarget & T;
}
/** A form event. */
export interface FormEvent<T = Element> extends SyntheticEvent<T> {}
/** A mouse event. */
export interface MouseEvent<T = Element, E = globalThis.MouseEvent> extends SyntheticEvent<T, E> {
  /** Whether the Alt key was held. */
  altKey: boolean;
  /** The pressed mouse button. */
  button: number;
  /** The pointer X relative to the viewport. */
  clientX: number;
  /** The pointer Y relative to the viewport. */
  clientY: number;
  /** Whether the Ctrl key was held. */
  ctrlKey: boolean;
  /** Whether the Meta key was held. */
  metaKey: boolean;
  /** Whether the Shift key was held. */
  shiftKey: boolean;
  /** The pointer X relative to the page. */
  pageX: number;
  /** The pointer Y relative to the page. */
  pageY: number;
}
/** A keyboard event. */
export interface KeyboardEvent<T = Element> extends SyntheticEvent<T, globalThis.KeyboardEvent> {
  /** The logical key value. */
  key: string;
  /** The physical key code. */
  code: string;
  /** Whether the Alt key was held. */
  altKey: boolean;
  /** Whether the Ctrl key was held. */
  ctrlKey: boolean;
  /** Whether the Meta key was held. */
  metaKey: boolean;
  /** Whether the Shift key was held. */
  shiftKey: boolean;
  /** Whether the key is auto-repeating. */
  repeat: boolean;
}
/** A focus event. */
export interface FocusEvent<T = Element, R = Element>
  extends SyntheticEvent<T, globalThis.FocusEvent> {
  /** The element focus moved to/from. */
  relatedTarget: (EventTarget & R) | null;
}
/** A pointer event. */
export interface PointerEvent<T = Element> extends MouseEvent<T, globalThis.PointerEvent> {
  /** The unique pointer identifier. */
  pointerId: number;
  /** The pointer device type. */
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
  /** The element's children. */
  children?: ReactNode | undefined;
  /** Sets raw inner HTML. */
  dangerouslySetInnerHTML?: { __html: string } | undefined;
  /** `onClick` event handler. */
  onClick?: MouseEventHandler<T> | undefined;
  /** `onDoubleClick` event handler. */
  onDoubleClick?: MouseEventHandler<T> | undefined;
  /** `onMouseDown` event handler. */
  onMouseDown?: MouseEventHandler<T> | undefined;
  /** `onMouseUp` event handler. */
  onMouseUp?: MouseEventHandler<T> | undefined;
  /** `onMouseEnter` event handler. */
  onMouseEnter?: MouseEventHandler<T> | undefined;
  /** `onMouseLeave` event handler. */
  onMouseLeave?: MouseEventHandler<T> | undefined;
  /** `onMouseMove` event handler. */
  onMouseMove?: MouseEventHandler<T> | undefined;
  /** `onMouseOver` event handler. */
  onMouseOver?: MouseEventHandler<T> | undefined;
  /** `onMouseOut` event handler. */
  onMouseOut?: MouseEventHandler<T> | undefined;
  /** `onContextMenu` event handler. */
  onContextMenu?: MouseEventHandler<T> | undefined;
  /** `onChange` event handler. */
  onChange?: FormEventHandler<T> | undefined;
  /** `onInput` event handler. */
  onInput?: FormEventHandler<T> | undefined;
  /** `onSubmit` event handler. */
  onSubmit?: FormEventHandler<T> | undefined;
  /** `onReset` event handler. */
  onReset?: FormEventHandler<T> | undefined;
  /** `onKeyDown` event handler. */
  onKeyDown?: KeyboardEventHandler<T> | undefined;
  /** `onKeyUp` event handler. */
  onKeyUp?: KeyboardEventHandler<T> | undefined;
  /** `onKeyPress` event handler. */
  onKeyPress?: KeyboardEventHandler<T> | undefined;
  /** `onFocus` event handler. */
  onFocus?: FocusEventHandler<T> | undefined;
  /** `onBlur` event handler. */
  onBlur?: FocusEventHandler<T> | undefined;
  /** `onPointerDown` event handler. */
  onPointerDown?: PointerEventHandler<T> | undefined;
  /** `onPointerUp` event handler. */
  onPointerUp?: PointerEventHandler<T> | undefined;
  /** `onPointerEnter` event handler. */
  onPointerEnter?: PointerEventHandler<T> | undefined;
  /** `onPointerLeave` event handler. */
  onPointerLeave?: PointerEventHandler<T> | undefined;
  /** `onPointerMove` event handler. */
  onPointerMove?: PointerEventHandler<T> | undefined;
  /** `onScroll` event handler. */
  onScroll?: ReactEventHandler<T> | undefined;
  /** `onWheel` event handler. */
  onWheel?: EventHandler<WheelEvent<T>> | undefined;
  /** `onDrag` event handler. */
  onDrag?: EventHandler<DragEvent<T>> | undefined;
  /** `onDrop` event handler. */
  onDrop?: EventHandler<DragEvent<T>> | undefined;
  /** `onCopy` event handler. */
  onCopy?: EventHandler<ClipboardEvent<T>> | undefined;
  /** `onPaste` event handler. */
  onPaste?: EventHandler<ClipboardEvent<T>> | undefined;
  /** `onCut` event handler. */
  onCut?: EventHandler<ClipboardEvent<T>> | undefined;
  /** `onTouchStart` event handler. */
  onTouchStart?: EventHandler<TouchEvent<T>> | undefined;
  /** `onTouchEnd` event handler. */
  onTouchEnd?: EventHandler<TouchEvent<T>> | undefined;
  /** `onTouchMove` event handler. */
  onTouchMove?: EventHandler<TouchEvent<T>> | undefined;
  /** `onAnimationEnd` event handler. */
  onAnimationEnd?: EventHandler<AnimationEvent<T>> | undefined;
  /** `onTransitionEnd` event handler. */
  onTransitionEnd?: EventHandler<TransitionEvent<T>> | undefined;
}

// --- HTML / SVG attribute bags ----------------------------------------------

/** Attributes common to every HTML element (permissive: unknown attrs allowed). */
export interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
  /** The `class` attribute. */
  className?: string | undefined;
  /** The `id` attribute. */
  id?: string | undefined;
  /** Inline styles. */
  style?: CSSProperties | undefined;
  /** The `title` attribute. */
  title?: string | undefined;
  /** The `tabindex` attribute. */
  tabIndex?: number | undefined;
  /** The `hidden` attribute. */
  hidden?: boolean | undefined;
  /** The text-direction attribute. */
  dir?: string | undefined;
  /** The `lang` attribute. */
  lang?: string | undefined;
  /** The `slot` attribute. */
  slot?: string | undefined;
  /** The element `ref`. */
  ref?: Ref<T> | undefined;
  /** The list-identity `key`. */
  key?: Key | null | undefined;
  /** Suppresses hydration mismatch warnings. */
  suppressHydrationWarning?: boolean | undefined;
  /** Suppresses `contentEditable` child warnings. */
  suppressContentEditableWarning?: boolean | undefined;
  /** The `contenteditable` attribute. */
  contentEditable?: boolean | "true" | "false" | "inherit" | undefined;
  /** The `draggable` attribute. */
  draggable?: boolean | undefined;
  /** The `spellcheck` attribute. */
  spellCheck?: boolean | undefined;
  /** The `translate` attribute. */
  translate?: "yes" | "no" | undefined;
  /** Permissive tail: data-*, custom, and any attribute we didn't enumerate. */
  [key: string]: any;
}
/** `<button>` attributes. */
export interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The button `type` attribute. */
  type?: "submit" | "reset" | "button" | undefined;
  /** The `disabled` attribute. */
  disabled?: boolean | undefined;
  /** The associated `form` id. */
  form?: string | undefined;
  /** The `name` attribute. */
  name?: string | undefined;
  /** The `value` attribute. */
  value?: string | number | readonly string[] | undefined;
  /** The `autofocus` attribute. */
  autoFocus?: boolean | undefined;
}
/** `<input>` attributes. */
export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The input `type` attribute. */
  type?: string | undefined;
  /** The `value` attribute. */
  value?: string | number | readonly string[] | undefined;
  /** The initial uncontrolled value. */
  defaultValue?: string | number | readonly string[] | undefined;
  /** The `checked` attribute. */
  checked?: boolean | undefined;
  /** The initial uncontrolled checked state. */
  defaultChecked?: boolean | undefined;
  /** The `placeholder` attribute. */
  placeholder?: string | undefined;
  /** The `disabled` attribute. */
  disabled?: boolean | undefined;
  /** The `readonly` attribute. */
  readOnly?: boolean | undefined;
  /** The `required` attribute. */
  required?: boolean | undefined;
  /** The `name` attribute. */
  name?: string | undefined;
  /** The `autocomplete` attribute. */
  autoComplete?: string | undefined;
  /** The `autofocus` attribute. */
  autoFocus?: boolean | undefined;
  /** The `min` attribute. */
  min?: string | number | undefined;
  /** The `max` attribute. */
  max?: string | number | undefined;
  /** The `step` attribute. */
  step?: string | number | undefined;
  /** The `maxlength` attribute. */
  maxLength?: number | undefined;
  /** The `minlength` attribute. */
  minLength?: number | undefined;
  /** The `pattern` attribute. */
  pattern?: string | undefined;
  /** The `accept` attribute. */
  accept?: string | undefined;
  /** The `multiple` attribute. */
  multiple?: boolean | undefined;
}
/** `<a>` attributes. */
export interface AnchorHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The `href` attribute. */
  href?: string | undefined;
  /** The `target` attribute. */
  target?: string | undefined;
  /** The `rel` attribute. */
  rel?: string | undefined;
  /** The `download` attribute. */
  download?: any;
  /** The `hreflang` attribute. */
  hrefLang?: string | undefined;
  /** The `type` attribute. */
  type?: string | undefined;
  /** The `referrerpolicy` attribute. */
  referrerPolicy?: string | undefined;
}
/** `<textarea>` attributes. */
export interface TextareaHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The `value` attribute. */
  value?: string | number | readonly string[] | undefined;
  /** The initial uncontrolled value. */
  defaultValue?: string | number | readonly string[] | undefined;
  /** The `placeholder` attribute. */
  placeholder?: string | undefined;
  /** The `rows` attribute. */
  rows?: number | undefined;
  /** The `cols` attribute. */
  cols?: number | undefined;
  /** The `disabled` attribute. */
  disabled?: boolean | undefined;
  /** The `readonly` attribute. */
  readOnly?: boolean | undefined;
  /** The `required` attribute. */
  required?: boolean | undefined;
  /** The `name` attribute. */
  name?: string | undefined;
  /** The `maxlength` attribute. */
  maxLength?: number | undefined;
}
/** `<select>` attributes. */
export interface SelectHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The `value` attribute. */
  value?: string | number | readonly string[] | undefined;
  /** The initial uncontrolled value. */
  defaultValue?: string | number | readonly string[] | undefined;
  /** The `disabled` attribute. */
  disabled?: boolean | undefined;
  /** The `multiple` attribute. */
  multiple?: boolean | undefined;
  /** The `required` attribute. */
  required?: boolean | undefined;
  /** The `name` attribute. */
  name?: string | undefined;
  /** The `size` attribute. */
  size?: number | undefined;
}
/** `<option>` attributes. */
export interface OptionHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The `value` attribute. */
  value?: string | number | readonly string[] | undefined;
  /** The `disabled` attribute. */
  disabled?: boolean | undefined;
  /** The `label` attribute. */
  label?: string | undefined;
  /** The `selected` attribute. */
  selected?: boolean | undefined;
}
/** `<label>` attributes. */
export interface LabelHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The `for` attribute. */
  htmlFor?: string | undefined;
  /** The associated `form` id. */
  form?: string | undefined;
}
/** `<form>` attributes. */
export interface FormHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The `action` attribute or action function. */
  action?: string | ((formData: FormData) => void | Promise<void>) | undefined;
  /** The `method` attribute. */
  method?: string | undefined;
  /** The `enctype` attribute. */
  encType?: string | undefined;
  /** The `target` attribute. */
  target?: string | undefined;
  /** The `novalidate` attribute. */
  noValidate?: boolean | undefined;
  /** The `autocomplete` attribute. */
  autoComplete?: string | undefined;
}
/** `<img>` attributes. */
export interface ImgHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The `src` attribute. */
  src?: string | undefined;
  /** The `alt` attribute. */
  alt?: string | undefined;
  /** The `width` attribute. */
  width?: number | string | undefined;
  /** The `height` attribute. */
  height?: number | string | undefined;
  /** The `loading` attribute. */
  loading?: "eager" | "lazy" | undefined;
  /** The `srcset` attribute. */
  srcSet?: string | undefined;
  /** The `sizes` attribute. */
  sizes?: string | undefined;
  /** The `decoding` attribute. */
  decoding?: "async" | "auto" | "sync" | undefined;
  /** The `referrerpolicy` attribute. */
  referrerPolicy?: string | undefined;
}
/** `<ol>` attributes. */
export interface OlHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The `start` attribute. */
  start?: number | undefined;
  /** The `reversed` attribute. */
  reversed?: boolean | undefined;
  /** The list marker `type` attribute. */
  type?: "1" | "a" | "A" | "i" | "I" | undefined;
}
/** `<td>`/`<th>` attributes. */
export interface TdHTMLAttributes<T> extends HTMLAttributes<T> {
  /** The `colspan` attribute. */
  colSpan?: number | undefined;
  /** The `rowspan` attribute. */
  rowSpan?: number | undefined;
  /** The `headers` attribute. */
  headers?: string | undefined;
  /** The `scope` attribute. */
  scope?: string | undefined;
}
/** SVG element attributes (permissive). */
export interface SVGAttributes<T> extends AriaAttributes, DOMAttributes<T> {
  /** The `class` attribute. */
  className?: string | undefined;
  /** The `id` attribute. */
  id?: string | undefined;
  /** Inline styles. */
  style?: CSSProperties | undefined;
  /** The element `ref`. */
  ref?: Ref<T> | undefined;
  /** The list-identity `key`. */
  key?: Key | null | undefined;
  /** The `width` attribute. */
  width?: number | string | undefined;
  /** The `height` attribute. */
  height?: number | string | undefined;
  /** The `viewBox` attribute. */
  viewBox?: string | undefined;
  /** The `fill` attribute. */
  fill?: string | undefined;
  /** The `stroke` attribute. */
  stroke?: string | undefined;
  /** The `xmlns` attribute. */
  xmlns?: string | undefined;
  /** Permissive tail: any SVG attribute we didn't enumerate. */
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
  /** The `<a>` instance type. */
  a: HTMLAnchorElement;
  /** The `<button>` instance type. */
  button: HTMLButtonElement;
  /** The `<div>` instance type. */
  div: HTMLDivElement;
  /** The `<form>` instance type. */
  form: HTMLFormElement;
  /** The `<h1>` instance type. */
  h1: HTMLHeadingElement;
  /** The `<h2>` instance type. */
  h2: HTMLHeadingElement;
  /** The `<h3>` instance type. */
  h3: HTMLHeadingElement;
  /** The `<img>` instance type. */
  img: HTMLImageElement;
  /** The `<input>` instance type. */
  input: HTMLInputElement;
  /** The `<label>` instance type. */
  label: HTMLLabelElement;
  /** The `<li>` instance type. */
  li: HTMLLIElement;
  /** The `<ol>` instance type. */
  ol: HTMLOListElement;
  /** The `<option>` instance type. */
  option: HTMLOptionElement;
  /** The `<p>` instance type. */
  p: HTMLParagraphElement;
  /** The `<select>` instance type. */
  select: HTMLSelectElement;
  /** The `<span>` instance type. */
  span: HTMLSpanElement;
  /** The `<table>` instance type. */
  table: HTMLTableElement;
  /** The `<textarea>` instance type. */
  textarea: HTMLTextAreaElement;
  /** The `<ul>` instance type. */
  ul: HTMLUListElement;
  /** The `<svg>` instance type. */
  svg: SVGSVGElement;
}
