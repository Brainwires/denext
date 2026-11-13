/**
 * `denext/preact/jsx-runtime` — the automatic JSX runtime for code written against Preact
 * (`jsxImportSource: "preact"`; `denext migrate` maps `preact/jsx-runtime` here). It is denext's
 * own runtime, plus Preact Signals' DOM-prop binding: a signal passed to an intrinsic element
 * (`<input value={text} />`) becomes its value, read while the owning component renders, so that
 * component follows the signal. A signal child stays a signal (it renders its value in place).
 * Each element goes through Preact's `options.vnode`, and an intrinsic element's handlers through
 * `options.event` while it is set (see `denext/preact`'s `options`).
 *
 * @module
 */

import { Fragment, jsx as coreJsx, jsxDEV as coreJsxDEV } from "../../jsx/jsx-runtime.ts";
import type { Key, VNode, VNodeChildren, VNodeType, VProps } from "../../jsx/types.ts";
import { isSignal } from "../../runtime/signal-brand.ts";
import { isValidElement } from "../../runtime/react-core.ts";
import { createdVNode, eventProps, options } from "./options.ts";

export { Fragment };
export type { JSX } from "../../jsx/types.ts";

/** An intrinsic element's props with each signal-valued prop (but `children`) read. */
function unwrapSignals(type: VNodeType, props: VProps | null): VProps | null {
  if (typeof type !== "string" || props === null) return props;
  let out: Record<string, unknown> | null = null;
  for (const name in props) {
    const value = (props as Record<string, unknown>)[name];
    if (name === "children" || !isSignal(value)) continue;
    out ??= { ...props };
    out[name] = (value as unknown as { value: unknown }).value;
  }
  return (out ?? props) as VProps;
}

/**
 * JSX factory (automatic runtime) with signal-valued DOM props bound and Preact's `options`
 * hooks applied.
 *
 * @param type The element type.
 * @param props Its props.
 * @param key Its key.
 * @returns The element.
 */
export function jsx(
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
): VNode {
  return createdVNode(coreJsx(type, eventProps(type, unwrapSignals(type, props)), key));
}

/** JSX factory for static children (automatic runtime); see {@link jsx}. */
export const jsxs: typeof jsx = jsx;

/**
 * Development JSX factory (`react-jsxdev`) with signal-valued DOM props bound.
 *
 * @param type The element type.
 * @param props Its props.
 * @param key Its key.
 * @param isStatic Static children.
 * @param source The JSX's source location.
 * @param self The `this` of the call site.
 * @returns The element.
 */
export function jsxDEV(
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
  isStatic?: boolean,
  source?: unknown,
  self?: unknown,
): VNode {
  return createdVNode(
    coreJsxDEV(type, eventProps(type, unwrapSignals(type, props)), key, isStatic, source, self),
  );
}

// ── Deno's precompiled JSX (`"jsx": "precompile"`) ──────────────────────────────────
//
// Deno's precompile transform turns a tree of intrinsic elements into one call:
// `jsxTemplate(["<div class=\"a\" ", ">", "</div>"], jsxAttr("id", id), jsxEscape(text))`. The
// static strings are HTML; each expression sits either inside a tag (a `jsxAttr` string) or
// between tags (a `jsxEscape`d child, or an element a component call made). denext parses the
// template once into an element tree, so the result renders on the server and in the browser
// like the same JSX through `jsx()`.

/** One node of a parsed template. */
type TemplateNode = string | TemplateSlot | TemplateElement;
/** An expression between tags: the index of its argument. */
interface TemplateSlot {
  slot: number;
}
/** An element of a parsed template. */
interface TemplateElement {
  tag: string;
  /** Static attributes, and the index of each `jsxAttr` expression inside the tag. */
  attrs: Array<[string, string | true] | number>;
  children: TemplateNode[];
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;

/** HTML text with its character references decoded. */
function decodeEntities(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(ENTITY, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
    const code = ref[1] === "x" || ref[1] === "X"
      ? parseInt(ref.slice(2), 16)
      : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/** The attributes in `text` (`a="1" b`), decoded, pushed onto `out`. */
function parseAttributes(text: string, out: Array<[string, string | true]>): void {
  ATTRIBUTE.lastIndex = 0;
  for (let m = ATTRIBUTE.exec(text); m !== null; m = ATTRIBUTE.exec(text)) {
    const raw = m[2] ?? m[3] ?? m[4];
    out.push([m[1], raw === undefined ? true : decodeEntities(raw)]);
  }
}

/** The end of the markup construct at `from` (`-->` of a comment, `>` otherwise), past it. */
function markupEnd(str: string, from: number, close: string): number {
  const at = str.indexOf(close, from);
  return at === -1 ? str.length : at + close.length;
}

/** A template's parser: its strings in order, with an expression slot between each two. */
class TemplateParser {
  readonly top: TemplateNode[] = [];
  private readonly stack: TemplateElement[] = [];
  /** The element whose open tag is being read, and its attribute text so far. */
  private open: TemplateElement | null = null;
  private attrText = "";
  private text = "";

  /** The node list new children go to. */
  private children(): TemplateNode[] {
    return this.stack.length ? this.stack[this.stack.length - 1].children : this.top;
  }

  private flushText(): void {
    if (this.text !== "") this.children().push(decodeEntities(this.text));
    this.text = "";
  }

  private flushAttrs(): void {
    const parsed: Array<[string, string | true]> = [];
    parseAttributes(this.attrText, parsed);
    this.open!.attrs.push(...parsed);
    this.attrText = "";
  }

  /** Read one static string. */
  read(str: string): void {
    let i = 0;
    while (i < str.length) i = this.open !== null ? this.readTag(str, i) : this.readContent(str, i);
  }

  /** Read an open tag's attribute text from `i`; returns where reading continues. */
  private readTag(str: string, i: number): number {
    const end = str.indexOf(">", i);
    if (end === -1) {
      this.attrText += str.slice(i);
      return str.length;
    }
    let body = str.slice(i, end);
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);
    this.attrText += body;
    this.flushAttrs();
    const el = this.open!;
    this.open = null;
    this.children().push(el);
    if (!selfClosing && !VOID_TAGS.has(el.tag.toLowerCase())) this.stack.push(el);
    return end + 1;
  }

  /** Read text and the next tag from `i`; returns where reading continues. */
  private readContent(str: string, i: number): number {
    const lt = str.indexOf("<", i);
    this.text += str.slice(i, lt === -1 ? str.length : lt);
    if (lt === -1) return str.length;
    this.flushText();
    if (str.startsWith("<!--", lt)) return markupEnd(str, lt + 4, "-->");
    if (str[lt + 1] === "/") {
      const end = markupEnd(str, lt, ">");
      this.close(str.slice(lt + 2, end).replace(/>$/, "").trim());
      return end;
    }
    const name = /^[^\s/>]*/.exec(str.slice(lt + 1))![0];
    this.open = { tag: name, attrs: [], children: [] };
    return lt + 1 + name.length;
  }

  /** Close the innermost open element named `name` (and any left open inside it). */
  private close(name: string): void {
    const at = this.stack.findLastIndex((el) => el.tag === name);
    if (at !== -1) this.stack.length = at;
  }

  /** The expression slot `index` between two strings. */
  slot(index: number): void {
    if (this.open !== null) {
      // Inside a tag: a `jsxAttr` result, read when the template is used.
      this.flushAttrs();
      this.open.attrs.push(index);
      return;
    }
    this.flushText();
    this.children().push({ slot: index });
  }

  /** The parsed tree, once every string is read. */
  finish(): TemplateNode[] {
    this.flushText();
    return this.top;
  }
}

/** Parse a template's static strings into its element tree. */
function parseTemplate(strings: readonly string[]): TemplateNode[] {
  const parser = new TemplateParser();
  for (let s = 0; s < strings.length; s++) {
    parser.read(strings[s]);
    if (s < strings.length - 1) parser.slot(s);
  }
  return parser.finish();
}

/** Each template's parsed tree (Deno hoists the strings array to a module constant). */
const parsedTemplates = new WeakMap<readonly string[], TemplateNode[]>();

/** A `jsxEscape`d child back as a child: escaped text decoded, arrays mapped. */
function slotChild(value: unknown): unknown {
  if (typeof value === "string") return decodeEntities(value);
  if (Array.isArray(value)) return value.map(slotChild);
  return value;
}

/** An element's props from its static attributes and its `jsxAttr` expressions. */
function templateProps(
  attrs: TemplateElement["attrs"],
  exprs: readonly unknown[],
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const parsed: Array<[string, unknown]> = [];
  for (const attr of attrs) {
    if (typeof attr !== "number") parsed.push(attr);
    else {
      const expr = exprs[attr];
      if (typeof expr === "string") parseAttributes(expr, parsed as Array<[string, string | true]>);
      else if (expr instanceof TemplateAttr) parsed.push([expr.prop, expr.value]);
    }
  }
  for (const [name, value] of parsed) props[name] = value;
  return props;
}

/** Build one template node's element (or child) from the call's expressions. */
function buildNode(node: TemplateNode, exprs: readonly unknown[]): unknown {
  if (typeof node === "string") return node;
  if ("slot" in node) return slotChild(exprs[node.slot]);
  const props = templateProps(node.attrs, exprs);
  const kids = node.children.map((c) => buildNode(c, exprs));
  if (kids.length > 0) props.children = kids.length === 1 ? kids[0] : kids;
  const key = props.key as Key | undefined;
  delete props.key;
  return jsx(node.tag, props as VProps, key);
}

/**
 * Build the elements of a precompiled JSX template (Deno's `"jsx": "precompile"` transform
 * emits these calls; not meant to be called by hand). One root element is returned as it is,
 * several in a `Fragment`.
 *
 * @param templates The template's static HTML strings.
 * @param exprs The expressions between them: `jsxAttr` strings inside tags, children between.
 * @returns The element tree.
 */
export function jsxTemplate(templates: readonly string[], ...exprs: unknown[]): VNode {
  let tree = parsedTemplates.get(templates);
  if (!tree) {
    tree = parseTemplate(templates);
    parsedTemplates.set(templates, tree);
  }
  const nodes = tree.map((n) => buildNode(n, exprs));
  if (nodes.length === 1 && nodes[0] !== null && typeof nodes[0] === "object") {
    return nodes[0] as VNode;
  }
  return jsx(Fragment as VNodeType, { children: nodes } as VProps);
}

/** CSS properties whose number takes no `px` (Preact's `IS_NON_DIMENSIONAL`). */
const IS_NON_DIMENSIONAL = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
const CSS_UPPER = /[A-Z]/g;
const cssNames: Record<string, string> = {};
const ATTR_ESCAPE = /["&<]/g;
const ATTR_ENTITIES: Record<string, string> = { '"': "&quot;", "&": "&amp;", "<": "&lt;" };

/** Preact's entity encoding: `"`, `&` and `<`. */
function encodeEntities(value: string): string {
  return value.replace(ATTR_ESCAPE, (c) => ATTR_ENTITIES[c]);
}

/**
 * An attribute of a precompiled template that has no HTML (an event handler, another function,
 * a `ref` or a `key`): an empty `String`, so code that joins `jsxAttr` results into markup gets
 * `""` as from Preact, carrying the value for {@linkcode jsxTemplate}'s element.
 */
class TemplateAttr extends String {
  constructor(readonly prop: string, readonly value: unknown) {
    super("");
  }
}

/** A {@linkcode TemplateAttr}, typed as the empty string it serializes as. */
function carried(prop: string, value: unknown): string {
  return new TemplateAttr(prop, value) as unknown as string;
}

/** Preact's capture suffix: `Capture`, but not the end of `(got|lost)PointerCapture`. */
const CAPTURE_SUFFIX = /(PointerCapture)$|Capture$/i;

/**
 * The element prop of a function-valued template attribute: Deno's precompile transform writes
 * an event prop in lower case (`onclick`, `onclickcapture`), and denext's elements take the
 * React spelling (`onClick`, `onClickCapture`), as Preact's own diff reads either.
 */
function handlerProp(name: string): string {
  if (name.length < 3 || name[0] !== "o" || name[1] !== "n") return name;
  let event = name.slice(2);
  const bare = event.replace(CAPTURE_SUFFIX, "$1");
  const capture = bare !== event;
  event = bare;
  return "on" + event[0].toUpperCase() + event.slice(1) + (capture ? "Capture" : "");
}

/**
 * Serialize one attribute of a precompiled JSX template (Preact's `jsxAttr`): `name="value"`,
 * a bare `name` for `true`, and `""` for `null`, `false` and an object (but a `style` object,
 * written as CSS). A value with `valueOf` (a signal) is read first, and `options.attr` may
 * return the string itself.
 *
 * An event handler (or any function), a `ref` and a `key` have no HTML either, so they too
 * serialize as `""`, as in Preact; but the empty string denext returns is a `String` object
 * that carries the value, so the element {@linkcode jsxTemplate} builds keeps its handlers
 * (`onclick` becomes `onClick`), its ref and its key once it mounts in the browser.
 *
 * @param name The attribute name.
 * @param value Its value.
 * @returns The attribute's HTML.
 */
export function jsxAttr(name: string, value: unknown): string {
  if (options.attr) {
    const result = options.attr(name, value);
    if (typeof result === "string") return result;
  }
  if (name === "ref" || name === "key") {
    return value == null ? "" : carried(name, value);
  }
  if (typeof value === "function") return carried(handlerProp(name), value);
  if (value !== null && typeof value === "object" && typeof value.valueOf === "function") {
    value = value.valueOf();
  }
  if (name === "style" && value !== null && typeof value === "object") {
    return name + '="' + encodeEntities(styleText(value as Record<string, unknown>)) + '"';
  }
  if (value === true) return name;
  if (!isSerializable(value)) return "";
  return name + '="' + encodeEntities(String(value)) + '"';
}

/** Whether an attribute value is written: not `null`, `false`, a function or an object. */
function isSerializable(value: unknown): boolean {
  return value != null && value !== false && typeof value !== "function" &&
    typeof value !== "object";
}

/** A style object as CSS text, as Preact's `jsxAttr` writes it. */
function styleText(style: Record<string, unknown>): string {
  let css = "";
  for (const prop in style) {
    const val = style[prop];
    if (val == null || val === "") continue;
    const cssName = prop[0] === "-"
      ? prop
      : (cssNames[prop] ??= prop.replace(CSS_UPPER, "-$&").toLowerCase());
    css += cssName + ":" + val + (needsPx(cssName, val) ? "px;" : ";");
  }
  return css;
}

/** Whether a numeric style value takes `px` (not a custom property or a unitless one). */
function needsPx(cssName: string, val: unknown): boolean {
  return typeof val === "number" && !cssName.startsWith("--") && !IS_NON_DIMENSIONAL.test(cssName);
}

/**
 * Escape a dynamic child of a precompiled JSX template (Preact's `jsxEscape`): `null`, a boolean
 * or a function becomes `null`, an element (or a signal) stays as it is, an array becomes a new
 * array of its escaped items, and anything else becomes its entity-encoded text. Unlike Preact,
 * which escapes an array in place, the caller's array is left as it is, so rendering the same
 * array again (a module constant, a state value) does not escape its text twice.
 *
 * @param value The child.
 * @returns The escaped child.
 */
export function jsxEscape<T>(value: T): string | null | VNode | Array<string | null | VNode> {
  if (value == null || typeof value === "boolean" || typeof value === "function") return null;
  if (typeof value === "object") {
    if (isValidElement(value) || isSignal(value)) return value as unknown as VNode;
    if (Array.isArray(value)) return value.map(jsxEscape) as Array<string | null | VNode>;
  }
  return encodeEntities(String(value));
}
