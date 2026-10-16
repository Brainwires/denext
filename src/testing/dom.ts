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

// ---- innerHTML: markup parsed into child nodes, as a browser does ----------------------------

/** How {@link parseHtmlInto} builds the nodes it parses: an element or a text node at a time. */
interface HtmlNodeBuilder {
  /** A new element named `tag` (lower-case), with no attributes or children. */
  element(tag: string): TreeNode & { setAttribute(name: string, value: string): void };
  /** A new text node holding `value` (character references already decoded). */
  text(value: string): TreeNode;
}

/** Elements with no content or end tag. */
const VOID_ELEMENTS = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
/** Elements whose content is text up to their end tag (never parsed as markup). */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);
/** A start or end tag: `/`, the name, the attribute run, and a self-closing `/`. */
const TAG_RE =
  /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
/** One attribute of a tag's attribute run, with its double-, single- or unquoted value. */
const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const NAMED_REFS: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** Decode the character references a browser would (`&amp;`, `&#38;`, `&#x26;`, …). */
function decodeRefs(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (ref, body: string) => {
    if (body[0] !== "#") return NAMED_REFS[body.toLowerCase()] ?? ref;
    const hex = body[1] === "x" || body[1] === "X";
    const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
  });
}

/**
 * Parse `html` into child nodes of `parent`, as assigning `innerHTML` does in a browser: elements
 * with their attributes, text with character references decoded, void elements (`<br>`,
 * `<input>`) closed, the text of `<script>` / `<style>` / `<textarea>` / `<title>` left
 * unparsed, comments dropped, an end tag closing up to its open element (a stray one is
 * ignored), and a `<` that starts no tag kept as text. Shared by the `denext/testing` DOM and
 * the repo's reconciler test fakes, so a reconciler that prunes nodes it does not own removes
 * injected markup in a test exactly as it would in a page.
 *
 * @param parent The node the parsed nodes are appended to (its children are not cleared).
 * @param html The markup.
 * @param build Creates the element and text nodes.
 */
function parseHtmlInto(parent: TreeNode, html: string, build: HtmlNodeBuilder): void {
  new HtmlFragmentParser(html, build, parent).run();
}

/** The state of one {@link parseHtmlInto}: the input, the open elements and pending text. */
class HtmlFragmentParser {
  #i = 0;
  #text = "";
  readonly #open: TreeNode[];
  readonly #names: string[] = [""];

  constructor(readonly html: string, readonly build: HtmlNodeBuilder, parent: TreeNode) {
    this.#open = [parent];
  }

  run(): void {
    const { html } = this;
    while (this.#i < html.length) {
      const lt = html.indexOf("<", this.#i);
      const end = lt === -1 ? html.length : lt;
      this.#text += html.slice(this.#i, end);
      this.#i = end;
      if (lt !== -1) this.#markup(lt);
    }
    this.#flush();
  }

  /** The markup at `lt` (a `<`): a comment, a tag, or a `<` that is only text. */
  #markup(lt: number): void {
    if (this.html.startsWith("<!--", lt)) {
      this.#flush();
      const end = this.html.indexOf("-->", lt + 4);
      this.#i = end === -1 ? this.html.length : end + 3;
      return;
    }
    TAG_RE.lastIndex = lt;
    const tag = TAG_RE.exec(this.html);
    if (tag === null) {
      this.#text += "<";
      this.#i = lt + 1;
      return;
    }
    this.#flush();
    this.#i = TAG_RE.lastIndex;
    const name = tag[2].toLowerCase();
    if (tag[1] === "/") this.#close(name);
    else this.#start(name, tag[3], tag[4] === "/");
  }

  /** A start tag: the element, its attributes, then its content (unless void or raw text). */
  #start(name: string, attrs: string, selfClosing: boolean): void {
    const el = this.build.element(name);
    for (const a of attrs.matchAll(ATTR_RE)) {
      el.setAttribute(a[1], decodeRefs(a[2] ?? a[3] ?? a[4] ?? ""));
    }
    insertChild(this.#current(), el, null);
    if (RAW_TEXT_ELEMENTS.has(name)) this.#rawText(name, el);
    else if (!VOID_ELEMENTS.has(name) && !selfClosing) {
      this.#open.push(el);
      this.#names.push(name);
    }
  }

  /** An end tag closes its open element and every one inside it; a stray one is ignored. */
  #close(name: string): void {
    const at = this.#names.lastIndexOf(name);
    if (at > 0) this.#open.length = this.#names.length = at;
  }

  /** A raw-text element's content, as one text node, through its end tag. */
  #rawText(name: string, el: TreeNode): void {
    const { html } = this;
    const close = html.toLowerCase().indexOf(`</${name}`, this.#i);
    const body = html.slice(this.#i, close === -1 ? html.length : close);
    const escapable = name === "textarea" || name === "title";
    if (body !== "") insertChild(el, this.build.text(escapable ? decodeRefs(body) : body), null);
    const gt = close === -1 ? -1 : html.indexOf(">", close);
    this.#i = gt === -1 ? html.length : gt + 1;
  }

  #current(): TreeNode {
    return this.#open[this.#open.length - 1];
  }

  /** Append the pending text as one text node. */
  #flush(): void {
    if (this.#text !== "") {
      insertChild(this.#current(), this.build.text(decodeRefs(this.#text)), null);
    }
    this.#text = "";
  }
}

/**
 * Replace `el`'s children with `html` parsed (an `innerHTML` assignment), elements made through
 * `el`'s document when it has one.
 */
export function replaceWithMarkup<
  E extends TreeNode & { setAttribute(n: string, v: string): void },
>(
  el: TreeNode & { ownerDocument: { createElement(tag: string): E } | null },
  html: string,
  make: { element(tag: string): E; text(value: string): TreeNode },
): void {
  clearChildren(el);
  parseHtmlInto(el, html, {
    element: (tag) => el.ownerDocument?.createElement(tag) ?? make.element(tag),
    text: make.text,
  });
}

/** Replace `el`'s children with one text node holding `value` (a `textContent` assignment). */
export function replaceWithText(el: TreeNode, value: string, text: (v: string) => TreeNode): void {
  clearChildren(el);
  if (value !== "") insertChild(el, text(value), null);
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
    return this.childNodes.map(serialize).join("");
  }
  /** Assigning innerHTML replaces the children with the parsed markup, as a browser does. */
  set innerHTML(html: string) {
    replaceWithMarkup(this, html, DOM_NODES);
  }
  get textContent(): string {
    return this.childNodes.map(textOf).join("");
  }
  set textContent(value: string) {
    replaceWithText(this, value, DOM_NODES.text);
  }
}

/** How this DOM's elements and text nodes are made outside a document. */
const DOM_NODES = {
  element: (tag: string) => new DomEl(tag),
  text: (value: string) => new DomText(value),
};

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
