// A tiny in-memory DOM for component testing — just enough for denext's reconciler
// to mount into, plus real event bubbling and a tree the query helpers walk. Kept
// dependency-free (no third-party DOM) and internal; the public surface is the
// {@linkcode TestElement} shape returned by queries.

/** The read-only shape of a rendered element that query helpers return. */
export interface TestElement {
  /** Upper-cased tag name (e.g. `"BUTTON"`). */
  readonly tagName: string;
  /** The element's `node.nodeType` (`1` for elements). */
  readonly nodeType: number;
  /** Concatenated visible text of this element and its descendants. */
  readonly textContent: string;
  /** Serialized inner markup. */
  readonly innerHTML: string;
  /** Serialized markup including this element's own tag. */
  readonly outerHTML: string;
  /** Current form value (for inputs/textareas/selects). */
  readonly value: string;
  /** Whether a checkbox/radio is checked. */
  readonly checked: boolean;
  /** Child element nodes (text nodes omitted). */
  readonly children: TestElement[];
  /** Read an attribute, or `null` if absent. */
  getAttribute(name: string): string | null;
  /** Whether an attribute is present. */
  hasAttribute(name: string): boolean;
}

/** A synthetic event passed to handlers during {@linkcode fireEventOn}. */
export interface TestEvent {
  /** The event type (e.g. `"click"`, `"input"`). */
  type: string;
  /** The element the event was dispatched on. */
  target: DomEl;
  /** The element whose listener is currently running. */
  currentTarget: DomEl;
  /** Whether the event bubbles (all synthetic events here do). */
  bubbles: boolean;
  /** Whether `preventDefault()` was called. */
  defaultPrevented: boolean;
  /** Mark the event's default action as prevented. */
  preventDefault(): void;
  /** Stop the event propagating further up (or down) the tree. */
  stopPropagation(): void;
  /** Arbitrary extra fields provided at dispatch time. */
  [key: string]: unknown;
}

type Listener = (event: TestEvent) => void;

/** Base DOM node. */
class DomNode {
  nodeType = 0;
  parentNode: DomEl | null = null;
  childNodes: DomNode[] = [];

  appendChild(node: DomNode): DomNode {
    node.remove();
    node.parentNode = this as unknown as DomEl;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node: DomNode, ref: DomNode | null): DomNode {
    node.remove();
    node.parentNode = this as unknown as DomEl;
    if (ref === null) {
      this.childNodes.push(node);
    } else {
      const idx = this.childNodes.indexOf(ref);
      if (idx === -1) this.childNodes.push(node);
      else this.childNodes.splice(idx, 0, node);
    }
    return node;
  }

  removeChild(node: DomNode): DomNode {
    const idx = this.childNodes.indexOf(node);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    node.parentNode = null;
    return node;
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

/** A text node. */
export class DomText extends DomNode {
  override nodeType = 3;
  nodeValue: string;
  constructor(value: string) {
    super();
    this.nodeValue = value;
  }
}

/** An element node with attributes, listeners, and a value. */
export class DomEl extends DomNode implements TestElement {
  override nodeType = 1;
  tagName: string;
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<Listener>>();
  captureListeners = new Map<string, Set<Listener>>();
  value = "";
  checked = false;
  ownerDocument: DomDocument | null = null;
  #rawHtml: string | null = null;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "value") this.value = value;
    if (name === "checked") this.checked = true;
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "checked") this.checked = false;
  }

  addEventListener(type: string, fn: Listener, capture = false): void {
    const map = capture ? this.captureListeners : this.listeners;
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener, capture = false): void {
    (capture ? this.captureListeners : this.listeners).get(type)?.delete(fn);
  }

  /** Element children only (text nodes omitted). */
  get children(): DomEl[] {
    return this.childNodes.filter((n): n is DomEl => n.nodeType === 1);
  }

  get outerHTML(): string {
    const attrs = [...this.attributes.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
    const tag = this.tagName.toLowerCase();
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
  get innerHTML(): string {
    if (this.#rawHtml !== null) return this.#rawHtml;
    return this.childNodes.map(serialize).join("");
  }
  set innerHTML(html: string) {
    this.#rawHtml = html === "" ? null : html;
    for (const child of this.childNodes.splice(0)) child.parentNode = null;
  }
  get textContent(): string {
    return this.childNodes.map(textOf).join("");
  }
  set textContent(value: string) {
    for (const child of this.childNodes.splice(0)) child.parentNode = null;
    this.#rawHtml = null;
    if (value !== "") this.appendChild(new DomText(value));
  }
}

function serialize(node: DomNode): string {
  if (node instanceof DomText) return escapeHtml(node.nodeValue);
  if (node instanceof DomEl) return node.outerHTML;
  return "";
}
function textOf(node: DomNode): string {
  if (node instanceof DomText) return node.nodeValue;
  return node.childNodes.map(textOf).join("");
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A minimal document the reconciler creates nodes through. */
export class DomDocument {
  createElement(tag: string): DomEl {
    const el = new DomEl(tag);
    el.ownerDocument = this;
    return el;
  }
  createTextNode(value: string): DomText {
    return new DomText(value);
  }
  #byId = new Map<string, DomEl>();
  register(id: string, el: DomEl): void {
    this.#byId.set(id, el);
  }
  getElementById(id: string): DomEl | null {
    return this.#byId.get(id) ?? null;
  }
}

/**
 * Dispatch an event on `target`, propagating through the tree exactly as a browser
 * would: a capture phase from the root down, then a bubble phase from the target
 * up. denext attaches listeners directly on elements, so this drives both the
 * target's handler and any ancestor (delegated) handlers.
 *
 * @param target The element to dispatch on.
 * @param type The event type (e.g. `"click"`).
 * @param init Extra fields merged onto the event (e.g. `{ key: "Enter" }`).
 */
export function fireEventOn(target: DomEl, type: string, init: Record<string, unknown> = {}): void {
  let stopped = false;
  const event: TestEvent = {
    type,
    target,
    currentTarget: target,
    bubbles: true,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    ...init,
  };
  const path: DomEl[] = [];
  for (let n: DomEl | null = target; n; n = n.parentNode) path.push(n);
  // Capture: root → target.
  for (let i = path.length - 1; i >= 0 && !stopped; i--) {
    event.currentTarget = path[i];
    path[i].captureListeners.get(type)?.forEach((fn) => fn(event));
  }
  // Bubble: target → root.
  for (let i = 0; i < path.length && !stopped; i++) {
    event.currentTarget = path[i];
    path[i].listeners.get(type)?.forEach((fn) => fn(event));
  }
}

/** Depth-first walk of every element under (and including) `root`. */
export function walkElements(root: DomNode): DomEl[] {
  const out: DomEl[] = [];
  const visit = (n: DomNode) => {
    if (n instanceof DomEl) out.push(n);
    for (const c of n.childNodes) visit(c);
  };
  visit(root);
  return out;
}
