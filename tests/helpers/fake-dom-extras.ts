// The DOM members the in-memory DOM (./dom.ts) leaves out and a FragmentInstance calls: tree
// queries (`contains`, `getRootNode`, `compareDocumentPosition`, `parentElement`), event dispatch
// on any node (text included), focus tracking (`activeElement`, `focus` / `blur` firing a capture
// `focus` on the document), and stub layout (`getClientRects`, `createRange`, `scrollIntoView`
// recording its calls). Installed onto the fake's prototypes by `installFakeDomExtras()`;
// idempotent. Nothing in the fake's own behaviour changes, except that `focus()` now focuses.

import { FakeDocument, FakeElement, FakeNode } from "./dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const DISCONNECTED = 1;
const PRECEDING = 2;
const FOLLOWING = 4;
const CONTAINS = 8;
const CONTAINED_BY = 16;
const IMPLEMENTATION_SPECIFIC = 32;

/** `node` and its ancestors, outermost first. */
function chain(node: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  for (let n: FakeNode | null = node; n !== null; n = n.parentNode) out.unshift(n);
  return out;
}

/** The document an element of `node`'s tree belongs to. */
function docOf(node: Any): FakeDocument | null {
  for (let n = node; n; n = n.parentNode) if (n.ownerDocument) return n.ownerDocument;
  return null;
}

/** Elements that take focus: a link with an href, a form control, or anything with a tabindex. */
function focusable(el: FakeElement): boolean {
  if (el.hasAttribute("tabindex") || el.hasAttribute("tabIndex") || "tabIndex" in el) return true;
  if (el.tagName === "A") return el.hasAttribute("href");
  return ["INPUT", "BUTTON", "SELECT", "TEXTAREA"].includes(el.tagName);
}

/** A stub client rect for `node` (text: 7px per character; elements: their `width` / `height`). */
function rectOf(node: Any): DOMRect {
  const width = node.nodeType === 3
    ? String(node.nodeValue).length * 7
    : Number.parseInt(node.style?.getPropertyValue?.("width") || "0", 10);
  const height = Number.parseInt(node.style?.getPropertyValue?.("height") || "0", 10);
  return { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height } as DOMRect;
}

let installed = false;

/** Add the extra members to the fake's prototypes (once per process). */
export function installFakeDomExtras(): void {
  if (installed) return;
  installed = true;
  const doc = new FakeDocument();
  const textProto = Object.getPrototypeOf(doc.createTextNode(""));
  // Any node takes listeners (a text or comment node too), its maps made on first use.
  const listen = Object.getOwnPropertyDescriptors(FakeElement.prototype);
  Object.defineProperties(FakeNode.prototype, {
    addEventListener: listen.addEventListener,
    removeEventListener: listen.removeEventListener,
  });
  for (const key of ["listeners", "captureListeners"]) {
    Object.defineProperty(FakeNode.prototype, key, {
      get(this: object) {
        const map = new Map();
        Object.defineProperty(this, key, { value: map });
        return map;
      },
      configurable: true,
    });
  }

  Object.defineProperties(FakeNode.prototype, {
    parentElement: {
      get(this: FakeNode) {
        return this.parentNode;
      },
      configurable: true,
    },
  });
  Object.assign(FakeNode.prototype, {
    contains(this: FakeNode, other: FakeNode | null): boolean {
      return other !== null && chain(other).includes(this);
    },
    getRootNode(this: FakeNode): unknown {
      const top = chain(this)[0];
      const d = docOf(this);
      return d && top === d.documentElement ? d : top;
    },
    compareDocumentPosition(this: FakeNode, other: FakeNode): number {
      if (other === this) return 0;
      const a = chain(this);
      const b = chain(other);
      if (a[0] !== b[0]) return DISCONNECTED | IMPLEMENTATION_SPECIFIC | FOLLOWING;
      if (a.includes(other)) return CONTAINS | PRECEDING;
      if (b.includes(this)) return CONTAINED_BY | FOLLOWING;
      let i = 0;
      while (a[i] === b[i]) i++;
      const siblings = a[i - 1].childNodes;
      return siblings.indexOf(b[i]) < siblings.indexOf(a[i]) ? PRECEDING : FOLLOWING;
    },
    /** Dispatch `event` (a plain object) along this node's ancestors: capture, then bubble. */
    dispatchEvent(this: Any, event: Any): boolean {
      const path: Any[] = [this];
      for (let n = this.parentNode; n; n = n.parentNode) path.push(n);
      const d = docOf(this);
      if (d && path.at(-1) === d.documentElement) path.push(d);
      event.target = this;
      let stopped = false;
      event.stopPropagation = () => void (stopped = true);
      event.preventDefault = () => void (event.defaultPrevented = true);
      const run = (node: Any, capture: boolean) => {
        event.currentTarget = node;
        const map = capture ? node.captureListeners : node.listeners;
        for (const fn of [...(map?.get(event.type) ?? [])]) {
          typeof fn === "function" ? fn.call(node, event) : fn.handleEvent(event);
        }
      };
      for (let i = path.length - 1; i > 0 && !stopped; i--) run(path[i], true);
      for (let i = 0; i < (event.bubbles ? path.length : 1) && !stopped; i++) {
        run(path[i], false);
      }
      return event.defaultPrevented !== true;
    },
  });
  Object.defineProperty(textProto, "ownerDocument", {
    get(this: FakeNode) {
      return docOf(this.parentNode);
    },
    configurable: true,
  });

  Object.assign(FakeElement.prototype, {
    focus(this: FakeElement): void {
      const d = this.ownerDocument as Any;
      if (!d || !focusable(this)) return;
      d.activeElement = this;
      for (const fn of [...(d.captureListeners.get("focus") ?? [])]) fn({ type: "focus" });
    },
    blur(this: FakeElement): void {
      const d = this.ownerDocument as Any;
      if (d?.activeElement === this) d.activeElement = d.body;
    },
    getClientRects(this: FakeElement): DOMRect[] {
      return [rectOf(this)];
    },
    scrollIntoView(this: Any, alignToTop?: boolean): void {
      (this.scrolls ??= []).push(alignToTop);
    },
  });

  Object.defineProperty(FakeDocument.prototype, "activeElement", {
    get(this: Any) {
      return this._active ?? this.body;
    },
    set(this: Any, el: unknown) {
      this._active = el;
    },
    configurable: true,
  });
  Object.assign(FakeDocument.prototype, {
    createComment(this: FakeDocument): FakeNode {
      const c = new FakeNode();
      c.nodeType = 8;
      return c;
    },
    createRange(): unknown {
      let node: unknown = null;
      return {
        selectNodeContents(n: unknown) {
          node = n;
        },
        getClientRects: () => [rectOf(node)],
        getBoundingClientRect: () => rectOf(node),
      };
    },
  });
}
