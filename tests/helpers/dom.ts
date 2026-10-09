// A tiny in-memory DOM implementation — just enough for the reconciler tests,
// so denext stays free of a third-party DOM dependency. The child-list and listener
// primitives are denext/testing's own (src/testing/dom.ts).

import {
  clearChildren,
  detachChild,
  insertChild,
  type ListenerMethods,
  listenerMethods,
} from "../../src/testing/dom.ts";

export class FakeNode {
  nodeType = 0;
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];

  appendChild(node: FakeNode): FakeNode {
    return insertChild(this, node, null);
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    return insertChild(this, node, ref);
  }

  removeChild(node: FakeNode): FakeNode {
    return detachChild(this, node);
  }

  // fallow-ignore-next-line unused-class-member -- DOM API: the runtime and insertChild call it
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  /** DOM `append` — variadic, accepts nodes or strings (strings become text nodes). */
  append(...kids: (FakeNode | string)[]): void {
    for (const kid of kids) {
      this.appendChild(typeof kid === "string" ? new FakeText(kid) : kid);
    }
  }

  /** DOM `replaceChildren` — clear existing children, then append the given ones. */
  replaceChildren(...kids: (FakeNode | string)[]): void {
    clearChildren(this);
    this.append(...kids);
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  /** In a document: the topmost ancestor is its `<html>` (the node was attached under it). */
  get isConnected(): boolean {
    if (this.parentNode) return this.parentNode.isConnected;
    return this instanceof FakeElement && this.tagName === "HTML";
  }
}

class FakeText extends FakeNode {
  override nodeType = 3;
  nodeValue: string;
  constructor(value: string) {
    super();
    this.nodeValue = value;
  }
}

type Listener = (event: FakeEvent) => void;

/** Event types that do not bubble (they still run capture listeners on the way down). */
const NON_BUBBLING = new Set(
  "focus blur mouseenter mouseleave pointerenter pointerleave load error scroll".split(" "),
);

export interface FakeEvent {
  type: string;
  target: FakeElement;
  [key: string]: unknown;
}

/** A minimal CSSStyleDeclaration: enough for per-property inline-style patching. */
class FakeCSSStyleDeclaration {
  private props = new Map<string, string>();
  // Mirror browser serialization semantics: `getAttribute("style")`/`outerHTML`
  // return the RAW string when style was last set via `setAttribute("style", …)`
  // (e.g. denext's Offscreen `display:none !important` hide, which sets a string),
  // but switch to normalized `k:v;` cssText once ANY per-property mutation happens
  // (patchStyle's `setProperty`/`removeProperty` path). Without this, round-tripping
  // a raw string through the prop map would append a spurious trailing `;`.
  private raw: string | null = null;
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
    this.raw = null;
  }
  removeProperty(name: string): void {
    this.props.delete(name);
    this.raw = null;
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? "";
  }
  get size(): number {
    return this.props.size;
  }
  get cssText(): string {
    if (this.raw != null) return this.raw;
    let s = "";
    for (const [k, v] of this.props) s += `${k}:${v};`;
    return s;
  }
  set cssText(text: string) {
    this.props.clear();
    for (const decl of text.split(";")) {
      const i = decl.indexOf(":");
      if (i === -1) continue;
      const k = decl.slice(0, i).trim();
      if (k) this.props.set(k, decl.slice(i + 1).trim());
    }
    this.raw = text;
  }
}

export class FakeElement extends FakeNode {
  override nodeType = 1;
  tagName: string;
  attributes = new Map<string, string>();
  /** Inline style, patched per-property (mirrors the `style` attribute below). */
  style = new FakeCSSStyleDeclaration();
  listeners = new Map<string, Set<Listener>>();
  captureListeners = new Map<string, Set<Listener>>();
  value = "";
  /** The document that created this element (set by `FakeDocument.createElement`). */
  ownerDocument: FakeDocument | null = null;
  /** The element's namespace URI (set by `createElementNS`; null for plain HTML). */
  namespaceURI: string | null = null;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    if (name === "style") {
      this.style.cssText = value;
      return;
    }
    this.attributes.set(name, value);
    if (name === "value") this.value = value;
  }
  getAttribute(name: string): string | null {
    if (name === "style") return this.style.size ? this.style.cssText : null;
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }
  // fallow-ignore-next-line unused-class-member -- the islands runtime calls it through the DOM
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }
  // fallow-ignore-next-line unused-class-member -- the islands runtime calls it through the DOM
  getAttributeNames(): string[] {
    return [...this.attributes.keys(), ...(this.style.size ? ["style"] : [])];
  }
  removeAttribute(name: string): void {
    if (name === "style") {
      this.style.cssText = "";
      return;
    }
    this.attributes.delete(name);
  }

  /** `defaultValue` reflects an `<input>`'s `value` attribute (a `<textarea>`'s text). */
  // fallow-ignore-next-line unused-class-member -- the reconciler sets it through the DOM
  set defaultValue(v: string) {
    if (this.tagName === "TEXTAREA") this.textContent = String(v);
    else this.setAttribute("value", String(v));
  }
  /** `defaultChecked` reflects the `checked` attribute. */
  // fallow-ignore-next-line unused-class-member -- the reconciler sets it through the DOM
  set defaultChecked(v: boolean) {
    if (v) this.setAttribute("checked", "");
    else this.removeAttribute("checked");
  }

  /** A `<select>`'s options: its descendant `<option>`s (through `<optgroup>`s). */
  // fallow-ignore-next-line unused-class-member -- the reconciler reads it through the DOM
  get options(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (!(c instanceof FakeElement)) continue;
        if (c.tagName === "OPTION") out.push(c);
        else walk(c);
      }
    };
    walk(this);
    return out;
  }

  /** No-op focus (the panel focuses its search box; tests just need it not to throw). */
  focus(): void {}

  /** A zeroed layout box — enough for the DevTools highlight overlay math. */
  getBoundingClientRect(): { top: number; left: number; width: number; height: number } {
    return { top: 0, left: 0, width: 0, height: 0 };
  }

  /**
   * Test helper: fire an event of `type` at this element and propagate it as a browser does —
   * capture from the topmost ancestor down, then (for a bubbling type) bubble back up — so
   * handlers delegated to the root container run. `stopPropagation()` stops it.
   */
  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const path: FakeElement[] = [this];
    for (let n = this.parentNode; n instanceof FakeElement; n = n.parentNode) path.push(n);
    const event: FakeEvent = {
      type,
      target: this,
      currentTarget: this,
      bubbles: !NON_BUBBLING.has(type),
      cancelBubble: false,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        event.cancelBubble = true;
      },
      ...extra,
    };
    for (let i = path.length - 1; i >= 0 && !event.cancelBubble; i--) {
      event.currentTarget = path[i];
      path[i].captureListeners.get(type)?.forEach((fn) => fn(event));
    }
    const last = event.bubbles ? path.length : 1;
    for (let i = 0; i < last && !event.cancelBubble; i++) {
      event.currentTarget = path[i];
      path[i].listeners.get(type)?.forEach((fn) => fn(event));
    }
  }

  /** Serialize to an HTML-ish string for assertions. */
  get outerHTML(): string {
    let attrs = [...this.attributes.entries()]
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("");
    if (this.style.size) attrs += ` style="${this.style.cssText}"`;
    const inner = this.childNodes.map(serialize).join("");
    return `<${this.tagName.toLowerCase()}${attrs}>${inner}</${this.tagName.toLowerCase()}>`;
  }
  get innerHTML(): string {
    if (this._rawHtml !== null) return this._rawHtml;
    return this.childNodes.map(serialize).join("");
  }
  /** Assigning innerHTML replaces children with raw markup (dangerouslySetInnerHTML). */
  set innerHTML(html: string) {
    this._rawHtml = html === "" ? null : html;
    clearChildren(this);
  }
  private _rawHtml: string | null = null;
  get textContent(): string {
    return this.childNodes.map(textOf).join("");
  }
  /** Assigning textContent replaces children with a single text node. */
  set textContent(value: string) {
    clearChildren(this);
    this._rawHtml = null;
    if (value !== "") this.appendChild(new FakeText(value));
  }
}

// The listener methods (declared on the class through the merged interface below).
Object.assign(FakeElement.prototype, listenerMethods);
export interface FakeElement extends ListenerMethods<Listener> {}

function serialize(node: FakeNode): string {
  if (node instanceof FakeText) return node.nodeValue;
  if (node instanceof FakeElement) return node.outerHTML;
  return "";
}
function textOf(node: FakeNode): string {
  if (node instanceof FakeText) return node.nodeValue;
  return node.childNodes.map(textOf).join("");
}

export class FakeDocument {
  /** The document body — created on first access, matching a real `document.body`. */
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  private docListeners = new Map<string, Set<(event: FakeEvent) => void>>();

  /** The document head (a client runtime appends `<link>`s here). */
  readonly head: FakeElement;

  constructor() {
    this.documentElement = this.createElement("html");
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  /** Only what the client runtimes ask for: `link[rel="stylesheet"]` and prefetch anchors. */
  querySelectorAll(selector: string): FakeElement[] {
    if (selector === 'link[rel="stylesheet"]') {
      return this.head.childNodes.filter((c): c is FakeElement =>
        c instanceof FakeElement && c.tagName === "LINK" &&
        ((c as { rel?: string }).rel ?? c.getAttribute("rel")) === "stylesheet"
      );
    }
    return [];
  }

  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag);
    el.ownerDocument = this;
    return el;
  }

  /** Document-level listeners (the panel's Ctrl+Shift+D + element-picker handlers). */
  addEventListener(
    type: string,
    fn: (event: FakeEvent) => void,
    _capture?: boolean | { capture?: boolean; once?: boolean },
  ): void {
    if (!this.docListeners.has(type)) this.docListeners.set(type, new Set());
    this.docListeners.get(type)!.add(fn);
  }
  removeEventListener(
    type: string,
    fn: (event: FakeEvent) => void,
    _capture?: boolean | { capture?: boolean },
  ): void {
    this.docListeners.get(type)?.delete(fn);
  }
  /** Test helper: fire a document-level event of `type`. */
  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const event = {
      type,
      target: extra.target ?? null,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    } as unknown as FakeEvent;
    this.docListeners.get(type)?.forEach((fn) => fn(event));
  }
  createElementNS(ns: string, tag: string): FakeElement {
    const el = new FakeElement(tag);
    el.ownerDocument = this;
    el.namespaceURI = ns;
    return el;
  }
  createTextNode(value: string): FakeText {
    return new FakeText(value);
  }
  private byId = new Map<string, FakeElement>();
  register(id: string, el: FakeElement): void {
    this.byId.set(id, el);
  }
  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }
}

/** Build a fresh document + container element for a test. */
export function makeDom(): { doc: FakeDocument; container: FakeElement } {
  const doc = new FakeDocument();
  const container = doc.createElement("div");
  return { doc, container };
}
