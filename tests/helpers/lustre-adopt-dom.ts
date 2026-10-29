// A small DOM for the Lustre first-paint adoption tests (view-adopt.ts, view-client.ts): sibling
// links, text and comment nodes with `data` / `splitText`, element attributes, form state and a
// document `activeElement` that, as in a browser, is lost when the focused node leaves the tree.
// Events are Deno's own `EventTarget` (dispatched on the node itself, no bubbling).
//
// Beside it, a stand-in for Lustre's reconciler (`lustre/vdom/reconciler.ffi.mjs`):
// `insertMetadataChild` as Lustre writes it (metadata on a symbol, spliced into the parent's
// children), and a `Reconciler` whose `mount` creates every node anew (as Lustre's does) and whose
// `push` walks a patch over the metadata and attaches `update` changes' event handlers and
// properties. The real reconciler runs in the example's browser e2e.

export class MiniNode extends EventTarget {
  nodeType = 0;
  nodeName = "";
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];
  constructor(readonly ownerDocument: MiniDocument) {
    super();
  }
  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): MiniNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings?.[siblings.indexOf(this) + 1] ?? null;
  }
  insertBefore(node: MiniNode, ref: MiniNode | null): MiniNode {
    node.parentNode?.detach(node);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node: MiniNode): MiniNode {
    return this.insertBefore(node, null);
  }
  removeChild(node: MiniNode): MiniNode {
    this.detach(node);
    const doc = this.ownerDocument;
    if (doc.activeElement && node.contains(doc.activeElement)) doc.activeElement = null;
    return node;
  }
  /** Deno's `EventTarget.dispatchEvent` asks a node for its root. */
  getRootNode(): MiniNode {
    return this.parentNode ? this.parentNode.getRootNode() : this;
  }
  contains(node: MiniNode): boolean {
    for (let n: MiniNode | null = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  set textContent(value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value) this.appendChild(this.ownerDocument.createTextNode(value));
  }
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  private detach(node: MiniNode): void {
    const i = this.childNodes.indexOf(node);
    if (i !== -1) this.childNodes.splice(i, 1);
    node.parentNode = null;
  }
}

export class MiniText extends MiniNode {
  override nodeType = 3;
  override nodeName = "#text";
  constructor(doc: MiniDocument, public data: string) {
    super(doc);
  }
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  splitText(offset: number): MiniText {
    const rest = new MiniText(this.ownerDocument, this.data.slice(offset));
    this.data = this.data.slice(0, offset);
    this.parentNode?.insertBefore(rest, this.nextSibling);
    return rest;
  }
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  override get textContent(): string {
    return this.data;
  }
}

export class MiniComment extends MiniNode {
  override nodeType = 8;
  override nodeName = "#comment";
  constructor(doc: MiniDocument, public data: string) {
    super(doc);
  }
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  override get textContent(): string {
    return "";
  }
}

export class MiniElement extends MiniNode {
  override nodeType = 1;
  attrs = new Map<string, string>();
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  value = "";
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  checked = false;
  constructor(doc: MiniDocument, readonly localName: string, readonly namespaceURI: string) {
    super(doc);
    this.nodeName = localName.toUpperCase();
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  get type(): string {
    return this.attrs.get("type") ?? "text";
  }
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  get defaultValue(): string {
    return this.attrs.get("value") ?? "";
  }
  // fallow-ignore-next-line unused-class-member -- DOM API: view-adopt.ts / view-client.ts reach it through the DOM
  get defaultChecked(): boolean {
    return this.attrs.has("checked");
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

export class MiniDocument {
  activeElement: MiniElement | null = null;
  createTextNode(data: string): MiniText {
    return new MiniText(this, data);
  }
  createComment(data: string): MiniComment {
    return new MiniComment(this, data);
  }
  createElementNS(ns: string, tag: string): MiniElement {
    return new MiniElement(this, tag, ns);
  }
}

const HTML = "http://www.w3.org/1999/xhtml";

/** Build a tree as the HTML parser would from a view's `to_string`. */
export function el(
  doc: MiniDocument,
  tag: string,
  attrs: Record<string, string>,
  ...children: (MiniNode | string)[]
): MiniElement {
  const node = doc.createElementNS(HTML, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (tag === "input") {
    node.value = attrs.value ?? "";
    node.checked = "checked" in attrs;
  }
  for (const c of children) node.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
  return node;
}

// The stand-in for Lustre's reconciler.

const meta = Symbol("lustre");

/** Lustre's `MetadataNode`, as far as these tests read it. */
export interface Meta {
  kind: number;
  key: string | null;
  parent: Meta | null;
  node: MiniNode;
  children: Meta[];
  endNode: MiniNode | null;
}

/** The metadata Lustre keeps on `node`. */
export const metaOf = (node: MiniNode): Meta | undefined =>
  (node as unknown as Record<symbol, Meta>)[meta];

/** Lustre's `insertMetadataChild`. */
export function insertMetadataChild(
  kind: number,
  parent: Meta | null,
  node: MiniNode,
  index: number,
  key: string | null,
): Meta {
  const child: Meta = { kind, key, parent, node, children: [], endNode: null };
  (node as unknown as Record<symbol, Meta>)[meta] = child;
  parent?.children.splice(index, 0, child);
  return child;
}

interface Attr {
  kind: number;
  name: string;
  value?: unknown;
}
interface View {
  kind: number;
  tag?: string;
  content?: string;
  attributes?: Attr[];
  children?: View[];
}
interface Patch {
  index?: number;
  changes?: { kind: number; added?: Attr[] }[];
  children?: Patch[];
}

/** What a stand-in reconciler saw. */
export interface ReconcilerLog {
  root: MiniElement;
  mounted: unknown[];
  pushed: unknown[];
}

/** A `Reconciler` class over the mini DOM, logging into `logs`. */
export function miniReconciler(logs: ReconcilerLog[]) {
  return class MiniReconciler {
    log: ReconcilerLog;
    constructor(
      readonly root: MiniElement,
      readonly decode: (event: Event, path: string, name: string) => unknown,
      readonly dispatch: (event: Event, data: unknown) => void,
    ) {
      this.log = { root, mounted: [], pushed: [] };
      logs.push(this.log);
    }
    mount(vdom: View) {
      this.log.mounted.push(vdom);
      const rootMeta = insertMetadataChild(1, null, this.root, 0, null);
      this.create(this.root, rootMeta, 0, vdom);
    }
    create(parent: MiniNode, parentMeta: Meta, index: number, v: View) {
      const doc = this.root.ownerDocument;
      if (v.kind === 2) {
        const t = doc.createTextNode(v.content ?? "");
        insertMetadataChild(2, parentMeta, t, index, null);
        parent.appendChild(t);
        return;
      }
      const node = doc.createElementNS(HTML, v.tag!);
      const own = insertMetadataChild(1, parentMeta, node, index, null);
      for (const a of v.attributes ?? []) {
        if (a.kind === 0) node.setAttribute(a.name, String(a.value ?? ""));
        else this.attach(node, a);
      }
      (v.children ?? []).forEach((c, i) => this.create(node, own, i, c));
      parent.appendChild(node);
    }
    attach(node: MiniNode, a: Attr) {
      if (a.kind === 1) (node as unknown as Record<string, unknown>)[a.name] = a.value;
      else node.addEventListener(a.name, (e) => this.dispatch(e, this.decode(e, "", a.name)));
    }
    push(patch: Patch) {
      this.log.pushed.push(patch);
      const walk = (m: Meta, p: Patch) => {
        for (const change of p.changes ?? []) {
          for (const a of change.added ?? []) this.attach(m.node, a);
        }
        for (const child of p.children ?? []) walk(m.children[child.index ?? 0], child);
      };
      walk(metaOf(this.root)!, patch);
    }
  };
}
