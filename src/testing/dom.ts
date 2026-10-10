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
  /** Whether the event bubbles (all but focus/blur/enter/leave/load/error/scroll here). */
  bubbles: boolean;
  /** Set once `stopPropagation()` is called (the DOM's stop-propagation flag). */
  cancelBubble: boolean;
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

// ---- Tree and listener primitives, shared with the repo's reconciler test fakes -------------

/** The node shape the primitives below work on. */
export interface TreeNode {
  parentNode: unknown;
  childNodes: unknown[];
  remove(): void;
}

/** DOM `insertBefore` (`ref` null or not a child: append): move `node` under `parent`. */
export function insertChild<N extends TreeNode>(parent: TreeNode, node: N, ref: unknown): N {
  node.remove();
  node.parentNode = parent;
  const idx = ref === null ? -1 : parent.childNodes.indexOf(ref);
  if (idx === -1) parent.childNodes.push(node);
  else parent.childNodes.splice(idx, 0, node);
  return node;
}

/** DOM `removeChild`: detach `node` from `parent`. */
export function detachChild<N extends TreeNode>(parent: TreeNode, node: N): N {
  const idx = parent.childNodes.indexOf(node);
  if (idx !== -1) parent.childNodes.splice(idx, 1);
  node.parentNode = null;
  return node;
}

/** Detach every child of `parent` (what assigning `innerHTML`/`textContent` starts with). */
export function clearChildren(parent: { childNodes: unknown[] }): void {
  for (const child of parent.childNodes.splice(0)) (child as TreeNode).parentNode = null;
}

/** An element's listener sets, bubble and capture phase, by event type. */
interface ListenerMaps<F> {
  listeners: Map<string, Set<F>>;
  captureListeners: Map<string, Set<F>>;
}

/** The listener methods an element class declares (see {@link listenerMethods}). */
export interface ListenerMethods<F> {
  addEventListener(type: string, fn: F, options?: ListenerOptions): void;
  removeEventListener(type: string, fn: F, options?: ListenerOptions): void;
}

/** The DOM's third listener argument: `useCapture`, or an options bag (only `capture` is read). */
type ListenerOptions = boolean | { capture?: boolean; once?: boolean; passive?: boolean };

/** The listener map `options` selects: capture phase for `true` / `{ capture: true }`. */
function phaseMap<F>(maps: ListenerMaps<F>, options: ListenerOptions | undefined) {
  const capture = typeof options === "boolean" ? options : options?.capture === true;
  return capture ? maps.captureListeners : maps.listeners;
}

/**
 * DOM `addEventListener`/`removeEventListener` over {@link ListenerMaps}, mounted onto an element
 * class's prototype (`Object.assign(Cls.prototype, listenerMethods)`, with the class declaring
 * {@link ListenerMethods} through interface merging).
 */
export const listenerMethods: ListenerMethods<unknown> = {
  addEventListener(this: ListenerMaps<unknown>, type: string, fn: unknown, options?) {
    const map = phaseMap(this, options);
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(fn);
  },
  removeEventListener(this: ListenerMaps<unknown>, type: string, fn: unknown, options?) {
    phaseMap(this, options).get(type)?.delete(fn);
  },
};

/** Base DOM node. */
class DomNode {
  nodeType = 0;
  parentNode: DomEl | null = null;
  childNodes: DomNode[] = [];

  appendChild(node: DomNode): DomNode {
    return insertChild(this, node, null);
  }

  insertBefore(node: DomNode, ref: DomNode | null): DomNode {
    return insertChild(this, node, ref);
  }

  removeChild(node: DomNode): DomNode {
    return detachChild(this, node);
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
    clearChildren(this);
  }
  get textContent(): string {
    return this.childNodes.map(textOf).join("");
  }
  set textContent(value: string) {
    clearChildren(this);
    this.#rawHtml = null;
    if (value !== "") this.appendChild(new DomText(value));
  }
}

// The listener methods (declared on the class through the merged interface below).
Object.assign(DomEl.prototype, listenerMethods);
export interface DomEl extends ListenerMethods<Listener> {}

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

/** Event types that do not bubble (they still run capture listeners on the way down). */
const NON_BUBBLING = new Set(
  "focus blur mouseenter mouseleave pointerenter pointerleave load error scroll".split(" "),
);

/** A node an event visits: its bubble- and capture-phase listener sets, by event type. */
export type ListenerTarget = ListenerMaps<(event: never) => void>;

/**
 * Build an event and propagate it along `path` (the target first, then each ancestor up to the
 * top, which may be a document) as a browser does: a capture phase from the top down, then — for
 * a bubbling type — a bubble phase from the target back up (just the target otherwise).
 * `stopPropagation()` (or setting `cancelBubble`) stops it between nodes. Shared by
 * {@linkcode fireEventOn} and the repo's reconciler test fakes.
 *
 * @param path The propagation path, target first; `path[0]` is the event's `target`.
 * @param type The event type (e.g. `"click"`).
 * @param init Extra fields merged onto the event (they may override `target`).
 */
export function propagateEvent(
  path: readonly ListenerTarget[],
  type: string,
  init: Record<string, unknown> = {},
): void {
  const event: TestEvent = {
    type,
    target: path[0] as DomEl,
    currentTarget: path[0] as DomEl,
    bubbles: !NON_BUBBLING.has(type),
    cancelBubble: false,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.cancelBubble = true;
    },
    ...init,
  };
  const run = (node: ListenerTarget, map: ListenerTarget["listeners"]) => {
    event.currentTarget = node as DomEl;
    map.get(type)?.forEach((fn) => (fn as (event: TestEvent) => void)(event));
  };
  // Capture: top → target.
  for (let i = path.length - 1; i >= 0 && !event.cancelBubble; i--) {
    run(path[i], path[i].captureListeners);
  }
  // Bubble: target → top (just the target for a non-bubbling type).
  const last = event.bubbles ? path.length : 1;
  for (let i = 0; i < last && !event.cancelBubble; i++) run(path[i], path[i].listeners);
}

/**
 * Dispatch an event on `target`, propagating through the tree exactly as a browser
 * would: a capture phase from the root down, then a bubble phase from the target
 * up. denext dispatches most handlers from the root container (event delegation), so
 * this drives both the target's handler and any ancestor handlers.
 *
 * @param target The element to dispatch on.
 * @param type The event type (e.g. `"click"`).
 * @param init Extra fields merged onto the event (e.g. `{ key: "Enter" }`).
 */
export function fireEventOn(target: DomEl, type: string, init: Record<string, unknown> = {}): void {
  const path: DomEl[] = [];
  for (let n: DomEl | null = target; n; n = n.parentNode) path.push(n);
  propagateEvent(path, type, init);
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
