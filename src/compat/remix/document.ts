// The document shell a Remix root renders (`<html lang className={theme}>`, `<head>`,
// `<body className>`), on denext — which owns the real `<html>/<head>/<body>`. The migration
// renames those three tags in the root module to these components, so:
//   • on the SERVER the attributes are recorded for the document assembler (merged onto the
//     real tags) and the children render inline (`<meta>`/`<link>`/`<title>` are hoisted into
//     the head by the renderer; a `<script>` runs where it lands);
//   • on the CLIENT the attributes are applied to `document.documentElement`/`document.body`
//     in a layout effect — and re-applied when they change, so `<html className={theme}>`
//     driven by a theme switch takes effect exactly as in Remix.
// The server-side recorder is a process-global seam (like `matches-bridge.ts`): the compat
// server bundle carries its own copy of this module, so a module-level variable set by the
// framework's server runtime would not be visible to it.

import { h } from "../../jsx/jsx-runtime.ts";
import { Fragment } from "../../jsx/jsx-runtime.ts";
import { useLayoutEffect } from "../../runtime/hooks.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";

/** Attributes of the document element a root rendered (`className`, `lang`, `data-*`…). */
export type DocumentAttrs = Record<string, unknown>;
/** Which real element a set of attributes targets. */
type DocumentPart = "html" | "body";

type Sink = (part: DocumentPart, attrs: DocumentAttrs) => void;
interface DocumentGlobal {
  __denextDocumentAttrsSink?: Sink | null;
}
const store = globalThis as unknown as DocumentGlobal;

/** Wire the server-side recorder (called once by `denext/remix/server`; never on the client). */
export function setDocumentAttrsSink(sink: Sink | null): void {
  store.__denextDocumentAttrsSink = sink;
}

const isBrowser = typeof document !== "undefined" && typeof window !== "undefined";

/** Props that are not attributes. */
const NOT_ATTRS = new Set(["children", "key", "ref", "dangerouslySetInnerHTML"]);

/** Apply `attrs` to a live element: `className` → class, `style` object → styles, the rest as attributes. */
function applyDocumentAttrs(el: Element, attrs: DocumentAttrs): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (!NOT_ATTRS.has(name)) applyDocumentAttr(el, name, value);
  }
}

function applyDocumentAttr(el: Element, name: string, value: unknown): void {
  if (name === "style" && value && typeof value === "object") {
    Object.assign((el as HTMLElement).style, value);
    return;
  }
  const attr = name === "className" ? "class" : name === "htmlFor" ? "for" : name;
  if (value === null || value === undefined || value === false) el.removeAttribute(attr);
  else el.setAttribute(attr, value === true ? "" : String(value));
}

function useDocumentAttrs(part: DocumentPart, props: Record<string, unknown>): void {
  const { children: _children, ...attrs } = props;
  const sink = store.__denextDocumentAttrsSink;
  if (!isBrowser && sink) sink(part, attrs);
  useLayoutEffect(() => {
    if (!isBrowser) return;
    applyDocumentAttrs(part === "html" ? document.documentElement : document.body, attrs);
  }, [JSON.stringify(attrs)]);
}

/** The root's `<html …>`: attributes flow to the real document element; children render through. */
export function DocumentHtml(props: { children?: VNodeChildren; [attr: string]: unknown }): VNode {
  useDocumentAttrs("html", props);
  return h(Fragment, null, props.children);
}

/** The root's `<head>`: its children render inline (head tags are hoisted by the renderer). */
export function DocumentHead(props: { children?: VNodeChildren }): VNode {
  return h(Fragment, null, props.children);
}

/** The root's `<body …>`: attributes flow to the real body; children render through. */
export function DocumentBody(props: { children?: VNodeChildren; [attr: string]: unknown }): VNode {
  useDocumentAttrs("body", props);
  return h(Fragment, null, props.children);
}
