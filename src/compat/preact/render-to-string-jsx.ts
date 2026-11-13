/**
 * `denext/preact/render-to-string/jsx` — `preact-render-to-string/jsx` on denext (`denext migrate`
 * maps that specifier here): a tree rendered to pretty-printed, JSX-like markup, the form snapshot
 * tests compare against. `render` (also the default export) renders components through denext's
 * server dispatcher (hooks, context) and writes their host elements; `shallowRender` writes nested
 * components as `<Name … />` instead of rendering them.
 *
 * The output follows preact-render-to-string's pretty renderer: one attribute per line once an
 * element's attributes span more than one, a non-string attribute value as `name={value}` (an
 * object or array in pretty-format's form, `Object { "a": 1 }`, keys sorted; a function as
 * `[Function name]`), `false` DOM attributes and event handlers' absence of a string value
 * dropped, children indented by the `pretty` string (two spaces), and text longer than forty
 * characters on its own line. Options: `jsx` (`false` writes HTML attributes only), `xml`
 * (self-close an empty element), `pretty` (`false` for one line), `shallow`, `functions`,
 * `functionNames`, `skipFalseAttributes`, `sortAttributes`, `allAttributes`.
 *
 * @module
 */

import type { VNode } from "../../jsx/types.ts";
import { FRAGMENT } from "../../jsx/types.ts";
import { createSSRDispatcher, type ProviderScope } from "../../jsx/render-to-string.ts";
import { invokeFunctionComponent } from "../../jsx/server-owner.ts";
import { rootScope } from "../../jsx/tree-id.ts";
import { setDispatcher } from "../../runtime/hooks.ts";
import { PROVIDER } from "../../runtime/context.ts";
import { isComponentType } from "../../runtime/react-brands.ts";
import { isClassComponent } from "../class-detect.ts";
import { renderClassToVNode } from "../class-instance.ts";

/** The options of {@link render} (preact-render-to-string/jsx's). */
export interface Options {
  /** Write attributes in JSX form (`name={value}`); default `true`. */
  jsx?: boolean;
  /** Self-close an element with no children (`<div />`); default `false`. */
  xml?: boolean;
  /** Indent: `true` (a tab), the indent string, or `false` for one line; default two spaces. */
  pretty?: boolean | string;
  /** Write nested components as `<Name … />` instead of rendering them. */
  shallow?: boolean;
  /** Write function-valued attributes; default `true`. */
  functions?: boolean;
  /** Write a function attribute's name (`[Function onClick]`), else `Function`; default `true`. */
  functionNames?: boolean;
  /** Drop `false` attributes (and an empty `class` / `style`) on elements; default `true`. */
  skipFalseAttributes?: boolean;
  /** Sort each element's attributes by name. */
  sortAttributes?: boolean;
  /** Keep `key`, `ref`, `__self` and `__source`. */
  allAttributes?: boolean;
  /** With `shallow`: render the root component (default) or write it too (`false`). */
  renderRootComponent?: boolean;
  /** With `shallow`: write components a component returns too (default `true`). */
  shallowHighOrder?: boolean;
  /** Elements written as void (self-closing) beyond HTML's own. */
  voidElements?: RegExp;
}

type Resolved =
  & Required<Pick<Options, "functions" | "functionNames" | "skipFalseAttributes">>
  & Options
  & { jsx: boolean; indent: string; pretty: boolean | string };

const VOID = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;
const UNSAFE_NAME = /[\s\n\\/='"\0<>]/;
const NAMESPACE_REPLACE = /^(xlink|xmlns|xml)([A-Z])/;
const HTML_LOWER_CASE =
  /^(?:accessK|auto[A-Z]|cell|ch|col|cont|cross|dateT|encT|form[A-Z]|frame|hrefL|inputM|maxL|minL|noV|playsI|popoverT|readO|rowS|src[A-Z]|tabI|useM|item[A-Z])/;
const SVG_CAMEL_CASE =
  /^ac|^ali|arabic|basel|cap|clipPath$|clipRule$|color|dominant|enable|fill|flood|font|glyph[^R]|horiz|image|letter|lighting|marker[^WUH]|overline|panose|pointe|paint|rendering|shape|stop|strikethrough|stroke|text[^L]|transform|underline|unicode|units|^v[^i]|^w|^xH/;
const HTML_ENUMERATED = new Set(["draggable", "spellcheck"]);
const PRESERVE_WHITESPACE = new Set(["pre", "textarea"]);
const NON_DIMENSIONAL = new Set([
  "animation-iteration-count",
  "border-image-outset",
  "border-image-slice",
  "border-image-width",
  "box-flex",
  "box-flex-group",
  "box-ordinal-group",
  "column-count",
  "fill-opacity",
  "flex",
  "flex-grow",
  "flex-negative",
  "flex-order",
  "flex-positive",
  "flex-shrink",
  "flood-opacity",
  "font-weight",
  "grid-column",
  "grid-row",
  "line-clamp",
  "line-height",
  "opacity",
  "order",
  "orphans",
  "stop-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "tab-size",
  "widows",
  "z-index",
  "zoom",
]);

/** Preact's entity encoding: `"`, `&` and `<`. */
function encode(value: string): string {
  return value.replace(/["&<]/g, (c) => c === '"' ? "&quot;" : c === "&" ? "&amp;" : "&lt;");
}

/** Indent every line after a line break by `char`. */
function indent(s: string, char: string): string {
  return String(s).replace(/(\n+)/g, `$1${char}`);
}

/** Longer than forty characters, multi-line, or holding markup. */
function isLarge(s: string): boolean {
  return s.length > 40 || s.includes("\n") || s.includes("<");
}

/** A style object as CSS text (numbers get `px` unless the property is dimensionless). */
function styleText(style: Record<string, unknown>): string | undefined {
  let out = "";
  for (const prop in style) {
    const value = style[prop];
    if (value == null || value === "") continue;
    const name = prop[0] === "-" ? prop : prop.replace(/[A-Z]/g, "-$&").toLowerCase();
    const px = typeof value === "number" && !name.startsWith("--") && !NON_DIMENSIONAL.has(name);
    out += `${name}:${value}${px ? "px;" : ";"}`;
  }
  return out || undefined;
}

/** `children` flattened, without `null` / `undefined` / `false`. */
function flatChildren(out: unknown[], children: unknown): unknown[] {
  if (Array.isArray(children)) { for (const c of children) flatChildren(out, c); }
  else if (children != null && children !== false) out.push(children);
  return out;
}

const unnamed: unknown[] = [];

/** A component's name, as Preact writes it in a shallow render. */
function componentName(type: unknown): string {
  const t = type as { displayName?: string; name?: string };
  if (t.displayName) return t.displayName;
  if (type !== Function && t.name) return t.name;
  const source = Function.prototype.toString.call(type);
  const named = /^\s*function\s+([^( ]+)/.exec(source)?.[1];
  if (named) return named;
  let index = unnamed.indexOf(type);
  if (index < 0) index = unnamed.push(type) - 1;
  return `UnnamedComponent${index}`;
}

/** An element: a branded one, or a bare `{ type, props }` (what a context provider returns). */
function isElement(value: unknown): value is VNode {
  return value !== null && typeof value === "object" && "type" in value && "props" in value;
}

/** One render pass: the options, and the provider scopes `useContext` reads. */
interface Pass {
  opts: Resolved;
  scopes: ProviderScope[];
}

/** pretty-format's form of a value (the subset an attribute value takes). */
function prettyFormat(value: unknown, pass: Pass, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") {
    return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object") return String(value);
  if (isElement(value)) return renderNode(value, pass, true, false, undefined);
  if (Array.isArray(value)) {
    if (value.length === 0) return "Array []";
    const items = value.map((v) => pad + prettyFormat(v, pass, depth + 1));
    return `Array [\n${items.join(",\n")}\n${close}]`;
  }
  const keys = Object.keys(value).sort();
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name || "Object";
  if (keys.length === 0) return `${ctor} {}`;
  const rows = keys.map((k) =>
    `${pad}${JSON.stringify(k)}: ${
      prettyFormat((value as Record<string, unknown>)[k], pass, depth + 1)
    }`
  );
  return `${ctor} {\n${rows.join(",\n")}\n${close}}`;
}

/**
 * The JSX form of an attribute (preact-render-to-string/jsx's `attributeHook`): `null` to let
 * the HTML rules write it, `""` to drop it, else the text to append.
 */
function jsxAttribute(
  name: string,
  value: unknown,
  pass: Pass,
  isComponent: boolean,
): string | null {
  const { opts } = pass;
  if (name === "dangerouslySetInnerHTML") return null;
  const type = typeof value;
  if (value == null || (type === "function" && !opts.functions)) return "";
  if (
    opts.skipFalseAttributes && !isComponent &&
    (value === false || ((name === "class" || name === "style") && value === ""))
  ) return "";
  if (type === "string") return `\n${opts.indent}${name}="${encode(value as string)}"`;
  let text: string;
  if (type === "function" && !opts.functionNames) text = "Function";
  else {
    text = prettyFormat(value, pass);
    if (text.includes("\n")) text = `${indent("\n" + text, opts.indent)}\n`;
  }
  return indent(`\n${name}={${text}}`, opts.indent);
}

/** Preact's fixed attribute renames. */
const RENAMED: Record<string, string> = {
  defaultValue: "value",
  defaultChecked: "checked",
  defaultSelected: "selected",
  acceptCharset: "accept-charset",
  httpEquiv: "http-equiv",
};

/** Whether a prop keeps its name and is written as a string (`data-*`, `aria-*`, enumerated). */
function stringified(name: string, value: unknown): boolean {
  return (name.at(4) === "-" || HTML_ENUMERATED.has(name)) && value != null;
}

/** An SVG presentation attribute's hyphenated name (`strokeWidth` → `stroke-width`). */
function svgName(name: string): string {
  if (!SVG_CAMEL_CASE.test(name)) return name;
  return name === "panose1" ? "panose-1" : name.replace(/([A-Z])/g, "-$1").toLowerCase();
}

/** An attribute's HTML name (Preact's renames), or null to skip it. */
function attributeName(
  name: string,
  props: Record<string, unknown>,
  svg: boolean,
  value: unknown,
): string | null {
  if (name in RENAMED) return RENAMED[name];
  if (name === "className") return props.class !== undefined ? null : "class";
  if (NAMESPACE_REPLACE.test(name)) return name.replace(NAMESPACE_REPLACE, "$1:$2").toLowerCase();
  if (stringified(name, value)) return name;
  if (svg) return svgName(name);
  return HTML_LOWER_CASE.test(name) ? name.toLowerCase() : name;
}

/** What an element's attributes write, and the children / raw HTML they carry. */
interface ElementAttrs {
  text: string;
  children: unknown;
  html: string | undefined;
  selectValue: unknown;
}

/** The element an attribute belongs to, for {@link writeAttribute}. */
interface AttrTarget {
  tag: string;
  props: Record<string, unknown>;
  isComponent: boolean;
  svg: boolean;
}

/** Whether a prop is never written (a reserved name, or one an attribute cannot hold). */
function skipped(raw: string, opts: Resolved): boolean {
  if (UNSAFE_NAME.test(raw)) return true;
  return !opts.allAttributes && ["key", "ref", "__self", "__source"].includes(raw);
}

/** A value as Preact writes it: a style object as CSS, an `aria-*` boolean as a string. */
function normalizedValue(raw: string, name: string, value: unknown): unknown {
  if (stringified(raw, value)) return `${value}`;
  if (name === "style" && value && typeof value === "object") {
    return styleText(value as Record<string, unknown>);
  }
  if (name[0] === "a" && name[1] === "r" && typeof value === "boolean") return String(value);
  return value;
}

/** Whether a value is written as an attribute at all (Preact skips `false`, `null`, functions). */
function writable(value: unknown): boolean {
  return (Boolean(value) || value === 0 || value === "") && typeof value !== "function";
}

/** Write a `value` attribute: a `<select>`'s is remembered, its matching `<option>` selected. */
function valueAttribute(out: ElementAttrs, el: AttrTarget, value: unknown): void {
  if (el.tag === "select") {
    out.selectValue = value;
    return;
  }
  // deno-lint-ignore eqeqeq
  if (el.tag === "option" && out.selectValue == value && el.props.selected === undefined) {
    out.text += " selected";
  }
  out.text += ` value="${encode(`${value}`)}"`;
}

/**
 * The props that are not attributes: an event handler (skipped), `dangerouslySetInnerHTML` (the
 * element's raw HTML) and a `<textarea>`'s `value` (its text). True when `name` was one.
 */
function specialProp(out: ElementAttrs, el: AttrTarget, name: string, value: unknown): boolean {
  if (name[0] === "o" && name[1] === "n") return true;
  if (name === "dangerouslySetInnerHTML") {
    out.html = (value as { __html?: string } | null)?.__html;
    return true;
  }
  if (el.tag !== "textarea" || name !== "value") return false;
  out.children = value;
  return true;
}

/** Write one attribute the HTML way (the jsx hook passed on it). */
function htmlAttribute(
  out: ElementAttrs,
  el: AttrTarget,
  name: string,
  value: unknown,
  opts: Resolved,
) {
  if (specialProp(out, el, name, value) || !writable(value)) return;
  const bare = value === true || value === "";
  if (bare && !opts.xml) {
    out.text += ` ${name}`;
    return;
  }
  const v = bare ? name : value;
  if (name === "value") valueAttribute(out, el, v);
  else out.text += ` ${name}="${encode(`${v}`)}"`;
}

/** Write one prop of an element (or a shallow component) into `out`. */
function writeAttribute(out: ElementAttrs, el: AttrTarget, raw: string, pass: Pass): void {
  const { opts } = pass;
  if (raw === "children") {
    out.children = el.props[raw];
    return;
  }
  if (skipped(raw, opts)) return;
  let name = attributeName(raw, el.props, el.svg, el.props[raw]);
  if (name === null) return;
  if (name === "htmlFor") {
    if (el.props.for) return;
    name = "for";
  }
  const value = normalizedValue(raw, name, el.props[raw]);
  const hooked = opts.jsx ? jsxAttribute(name, value, pass, el.isComponent) : null;
  if (hooked !== null) out.text += hooked;
  else htmlAttribute(out, el, name, value, opts);
}

/** Write an element's (or a shallow component's) attributes. */
function writeAttributes(el: AttrTarget, pass: Pass, selectValue: unknown): ElementAttrs {
  const out: ElementAttrs = { text: "", children: undefined, html: undefined, selectValue };
  const names = Object.keys(el.props);
  if (pass.opts.sortAttributes) names.sort();
  for (const raw of names) writeAttribute(out, el, raw, pass);
  return out;
}

/** Render a component: a class instance's tree, or the function's result under the dispatcher. */
function invoke(type: unknown, props: Record<string, unknown>, pass: Pass): unknown {
  if (isClassComponent(type)) return renderClassToVNode(type, props, undefined);
  const prev = setDispatcher(createSSRDispatcher(pass.scopes, { scope: rootScope() }));
  try {
    const out = invokeFunctionComponent(type, props);
    if (out instanceof Promise) {
      out.catch(() => {});
      throw new Error("preact-render-to-string/jsx renders synchronously: an async component");
    }
    return out;
  } finally {
    setDispatcher(prev);
  }
}

/** Render children (an array: one per line when pretty). */
function renderChildren(
  node: unknown,
  pass: Pass,
  inner: boolean,
  svg: boolean,
  selectValue: unknown,
): string {
  if (Array.isArray(node)) {
    return node.map((c) => renderNode(c, pass, inner, svg, selectValue)).join(
      pass.opts.pretty ? "\n" : "",
    );
  }
  return renderNode(node, pass, inner, svg, selectValue);
}

/** A Fragment's children (a context provider's under its value). */
function renderFragment(
  props: Record<string, unknown>,
  pass: Pass,
  svg: boolean,
  selectValue: unknown,
): string {
  const provider = props[PROVIDER as unknown as string] as
    | { id: symbol; value: unknown }
    | undefined;
  const children = flatChildren([], props.children);
  if (provider) pass.scopes.push(new Map([[provider.id, provider.value]]));
  try {
    return renderChildren(children, pass, pass.opts.shallowHighOrder !== false, svg, selectValue);
  } finally {
    if (provider) pass.scopes.pop();
  }
}

/** Render one node (see the module comment). */
function renderNode(
  node: unknown,
  pass: Pass,
  inner: boolean,
  svg: boolean,
  selectValue: unknown,
): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return typeof node === "function" ? "" : encode(`${node}`);
  if (Array.isArray(node)) return renderChildren(node, pass, inner, svg, selectValue);
  if (!isElement(node)) return "";
  const props = ((node as VNode).props ?? {}) as Record<string, unknown>;
  const type = (node as VNode).type as unknown;
  if (type === FRAGMENT) return renderFragment(props, pass, svg, selectValue);
  if (!isComponentType(type)) {
    return renderElement({ tag: String(type), props, isComponent: false, svg }, pass, selectValue);
  }
  const { opts } = pass;
  if (opts.shallow && (inner || opts.renderRootComponent === false)) {
    const el = { tag: componentName(type), props, isComponent: true, svg };
    return renderElement(el, pass, selectValue);
  }
  const rendered = invoke(type, props, pass);
  return renderChildren(rendered, pass, opts.shallowHighOrder !== false, svg, selectValue);
}

/** An element's opening tag: its attributes on one line when they fit, else one per line. */
function openTag(tag: string, attrs: string, pretty: boolean): string {
  let s = `<${tag}${attrs}`;
  if (pretty) {
    const sub = s.replace(/\n\s*/, " ");
    if (sub !== s && !sub.includes("\n")) s = sub;
    else if (s.includes("\n")) s += "\n";
  }
  return s + ">";
}

/** The SVG mode an element's children render in. */
function childSvgMode(el: AttrTarget): boolean {
  if (el.tag === "svg") return true;
  return el.tag === "foreignObject" ? false : el.svg;
}

/** Push a rendered child, merging it into the previous piece when both are text. */
function pushPiece(pieces: string[], ret: string, pretty: boolean, lastText: boolean): boolean {
  const isText = pretty && ret[0] !== "<";
  if (lastText && isText) pieces[pieces.length - 1] += ret;
  else pieces.push(ret);
  return isText;
}

/** An element's rendered children (text runs merged; indented when any is large). */
function childPieces(
  el: AttrTarget,
  children: unknown[],
  open: string,
  pass: Pass,
  selectValue: unknown,
): string[] {
  const { opts } = pass;
  const pretty = Boolean(opts.pretty) && !PRESERVE_WHITESPACE.has(el.tag);
  const svg = childSvgMode(el);
  const pieces: string[] = [];
  let large = pretty && open.includes("\n");
  let lastText = false;
  for (const child of children) {
    const ret = renderNode(child, pass, true, svg, selectValue);
    large ||= pretty && isLarge(ret);
    if (ret) lastText = pushPiece(pieces, ret, pretty, lastText);
  }
  if (!pretty || !large) return pieces;
  return pieces.map((p) => "\n" + opts.indent + indent(p, opts.indent));
}

/** An element's raw `dangerouslySetInnerHTML`, indented onto its own line when large. */
function innerHtml(
  html: string | undefined,
  opts: Resolved,
  preserve: boolean,
): string | undefined {
  if (!html || !opts.pretty || preserve || !isLarge(html)) return html;
  return "\n" + opts.indent + indent(html, opts.indent);
}

/** Render an element (or a shallow component written as one). */
function renderElement(el: AttrTarget, pass: Pass, selectValue: unknown): string {
  const { opts } = pass;
  const { tag } = el;
  const preserve = Boolean(opts.pretty) && PRESERVE_WHITESPACE.has(tag);
  const attrs = writeAttributes(el, pass, selectValue);
  let s = openTag(tag, attrs.text, Boolean(opts.pretty));
  if (UNSAFE_NAME.test(tag)) throw new Error(`${tag} is not a valid HTML tag name in ${s}`);
  const html = innerHtml(attrs.html, opts, preserve);
  const children = html || attrs.children == null ? undefined : flatChildren([], attrs.children);
  const pieces = children?.length ? childPieces(el, children, s, pass, attrs.selectValue) : [];
  if (html || pieces.length) s += html ?? pieces.join("");
  else if (opts.xml) return s.slice(0, -1) + " />";
  return closeTag(s, el, opts, !children && !html, preserve);
}

/** Close an element: a void one self-closes, a multi-line one ends on its own line. */
function closeTag(
  s: string,
  el: AttrTarget,
  opts: Resolved,
  empty: boolean,
  preserve: boolean,
): string {
  const isVoid = VOID.test(el.tag) || (opts.voidElements?.test(el.tag) ?? false);
  if (isVoid && empty) return s.replace(/>$/, " />");
  if (opts.pretty && !preserve && s.includes("\n")) s += "\n";
  return `${s}</${el.tag}>`;
}

/** Resolve the options the way preact-render-to-string/jsx defaults them. */
function resolve(options: Options | undefined): Resolved {
  const opts = {
    jsx: true,
    xml: false,
    functions: true,
    functionNames: true,
    skipFalseAttributes: true,
    pretty: "  " as boolean | string,
    ...options,
  };
  const indentChar = typeof opts.pretty === "string" ? opts.pretty : "\t";
  return { ...opts, indent: indentChar };
}

/**
 * Render a tree to pretty-printed, JSX-like markup (preact-render-to-string/jsx's default export).
 *
 * @param vnode The tree.
 * @param _context A legacy context object (ignored on denext; `createContext` providers work).
 * @param options The output options.
 * @returns The markup.
 */
export function render(vnode: unknown, _context?: unknown, options?: Options): string {
  return renderNode(vnode, { opts: resolve(options), scopes: [] }, false, false, undefined);
}

/**
 * {@link render} with nested components written as `<Name … />` (`{ shallow: true }`).
 *
 * @param vnode The tree.
 * @param context A legacy context object (ignored on denext).
 * @param options The output options.
 * @returns The markup.
 */
export function shallowRender(vnode: unknown, context?: unknown, options?: Options): string {
  return render(vnode, context, { shallow: true, ...options });
}

export default render;
