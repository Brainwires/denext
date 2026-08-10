// A tiny in-memory DOM implementation — just enough for the reconciler tests,
// so denext stays free of a third-party DOM dependency.

export class FakeNode {
  nodeType = 0;
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];

  appendChild(node: FakeNode): FakeNode {
    node.remove();
    node.parentNode = this as unknown as FakeElement;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    node.remove();
    node.parentNode = this as unknown as FakeElement;
    if (ref === null) {
      this.childNodes.push(node);
    } else {
      const idx = this.childNodes.indexOf(ref);
      if (idx === -1) this.childNodes.push(node);
      else this.childNodes.splice(idx, 0, node);
    }
    return node;
  }

  removeChild(node: FakeNode): FakeNode {
    const idx = this.childNodes.indexOf(node);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    node.parentNode = null;
    return node;
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

export class FakeText extends FakeNode {
  override nodeType = 3;
  nodeValue: string;
  constructor(value: string) {
    super();
    this.nodeValue = value;
  }
}

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeElement;
  [key: string]: unknown;
}

export class FakeElement extends FakeNode {
  override nodeType = 1;
  tagName: string;
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<Listener>>();
  captureListeners = new Map<string, Set<Listener>>();
  value = "";
  /** The document that created this element (set by `FakeDocument.createElement`). */
  ownerDocument: FakeDocument | null = null;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "value") this.value = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, fn: Listener, capture = false): void {
    const map = capture ? this.captureListeners : this.listeners;
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener, capture = false): void {
    (capture ? this.captureListeners : this.listeners).get(type)?.delete(fn);
  }

  /** Test helper: fire an event of `type` on this element (capture then bubble). */
  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const event: FakeEvent = {
      type,
      target: this,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    };
    this.captureListeners.get(type)?.forEach((fn) => fn(event));
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }

  /** Serialize to an HTML-ish string for assertions. */
  get outerHTML(): string {
    const attrs = [...this.attributes.entries()]
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("");
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
    for (const child of this.childNodes.splice(0)) child.parentNode = null;
  }
  private _rawHtml: string | null = null;
  get textContent(): string {
    return this.childNodes.map(textOf).join("");
  }
}

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
  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag);
    el.ownerDocument = this;
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
