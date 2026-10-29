// Adopting a Lustre server component's first paint. `defineLustreView` renders the view's HTML on
// the server (Lustre's `element.to_string`), so the page shows it before any script runs. When the
// server's first `mount` message arrives, Lustre's own server-component client empties the root
// and renders the whole view again (`lustre/runtime/client/server_component.ffi.mjs`): every node
// is new, so an input loses its focus, caret and what was typed into it. Lustre's SPA runtime
// instead "virtualises" the DOM it starts on (`lustre/vdom/virtualise.ffi.mjs`); the server
// component has no such path, so this module is one, for the server's JSON view.
//
// It walks the server's view (`vdom`, Lustre's `vnode.to_json`) against the nodes already in the
// root and gives each node the reconciler metadata Lustre's reconciler would have given the node
// it created (`insertMetadataChild`, exported by `lustre/vdom/reconciler.ffi.mjs`), so later
// patches find them by the same paths. What HTML cannot carry (event handlers, properties) comes
// back as one patch of `update` changes for `Reconciler.push`, Lustre's own code attaching them.
// The markers `to_string` writes (`<!-- lustre:fragment -->` … `<!-- /lustre:fragment -->`,
// `<!-- lustre:map -->`, `<!-- lustre:memo -->`, `data-lustre-key`) are read as Lustre's
// `virtualise` reads them. Text the parser merged (two adjacent text nodes) is split again, an
// empty text node (which HTML cannot carry) is inserted, and a text or attribute that differs from
// the view is set in place; an element where the view has another tag is a mismatch, and the
// caller renders the whole view instead (the old replace).
//
// What the visitor did to a form field before the view mounted is kept: a `value` / `checked` /
// `selected` property is not applied over a field whose state differs from its default, and the
// caller re-sends that field's `input` and `change` (as Lustre's `virtualise` does), so the server's
// model learns what was typed.

/** Lustre's reconciler metadata for one node (`MetadataNode`), as far as adoption touches it. */
export interface LustreMetadata {
  /** The child nodes' metadata. */
  children: LustreMetadata[];
  /** A fragment's closing marker, when the DOM has one. */
  endNode: Node | null;
}

/**
 * `insertMetadataChild(kind, parent, node, index, key)` from Lustre's
 * `lustre/vdom/reconciler.ffi.mjs`: attach metadata to `node` as child `index` of `parent`.
 */
export type LustreInsertMetadata = (
  kind: number,
  parent: LustreMetadata | null,
  node: Node,
  index: number,
  key: string | null,
) => LustreMetadata;

/** A node of the server's view (Lustre's `vnode.to_json`; empty fields are left out). */
interface VNode {
  kind: number;
  key?: string;
  tag?: string;
  namespace?: string;
  attributes?: VAttr[];
  children?: VNode[];
  content?: string;
  child?: VNode;
}

/** An attribute, property or event handler of the server's view (`vattr.to_json`). */
interface VAttr {
  kind: number;
  name: string;
  value?: unknown;
}

/** A patch for `Reconciler.push` (Lustre's `patch.to_json` shape). */
export interface LustreAdoptPatch {
  /** The child's index in its parent's metadata. */
  index: number;
  /** Children removed from the end (always 0 here). */
  removed: 0;
  /** This node's changes. */
  changes: { kind: number; added: VAttr[]; removed: [] }[];
  /** Patches for children. */
  children: LustreAdoptPatch[];
}

/** What adopting the first paint produced. */
export interface LustreAdoption {
  /** The handlers and properties to attach, for `Reconciler.push`. */
  patch: LustreAdoptPatch;
  /** Form fields whose state the visitor changed before the view mounted. */
  edited: Element[];
}

/** The server's view does not fit the nodes in the root. */
export class LustreAdoptMismatch extends Error {
  override name = "LustreAdoptMismatch";
}

// Lustre's kinds (`lustre/vdom/vnode`, `vattr`, `patch`).
const FRAGMENT = 0;
const ELEMENT = 1;
const TEXT = 2;
const UNSAFE_INNER_HTML = 3;
const MAP = 4;
const ATTRIBUTE = 0;
const PROPERTY = 1;
const EVENT = 2;
const UPDATE = 2;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const HTML_NS = "http://www.w3.org/1999/xhtml";

/** The form state a visitor can change, by property. */
const USER_STATE: Record<string, (el: FormField) => boolean> = {
  value: (el) => el.value !== el.defaultValue,
  checked: (el) => el.checked !== el.defaultChecked,
  selected: (el) => el.selected !== el.defaultSelected,
};

interface FormField extends Element {
  value?: string;
  defaultValue?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  selected?: boolean;
  defaultSelected?: boolean;
  options?: ArrayLike<FormField>;
  type?: string;
}

/** Did the visitor change this field from what the HTML set? */
function edited(el: FormField): boolean {
  const tag = el.localName;
  if (tag === "select") return Array.from(el.options ?? []).some(USER_STATE.selected);
  if (tag === "textarea") return USER_STATE.value(el);
  if (tag !== "input") return false;
  return el.type === "checkbox" || el.type === "radio"
    ? USER_STATE.checked(el)
    : USER_STATE.value(el);
}

function commentData(node: Node | null): string | null {
  return node?.nodeType === COMMENT_NODE ? (node as Comment).data.trim() : null;
}

function newPatch(index: number): LustreAdoptPatch {
  return { index, removed: 0, changes: [], children: [] };
}

/** Add `child` to `parent` when it (or a descendant) has something to apply. */
function addPatch(parent: LustreAdoptPatch, child: LustreAdoptPatch): void {
  if (child.changes.length || child.children.length) parent.children.push(child);
}

/** `cursor` as the element `vnode` names, or a mismatch. */
function matchingElement(cursor: Node | null, vnode: VNode): Element {
  const el = cursor as Element | null;
  const fits = el?.nodeType === ELEMENT_NODE && el.localName === vnode.tag &&
    (el.namespaceURI || HTML_NS) === (vnode.namespace || HTML_NS);
  if (!fits) {
    throw new LustreAdoptMismatch(`<${vnode.tag}> where the page has ${el?.nodeName ?? "nothing"}`);
  }
  return el!;
}

/**
 * Adopt one attribute of the view on `el`. An attribute is in the HTML already (set when it
 * differs; `virtual:default*` are HTML's own defaults, parsed as such).
 *
 * @returns Whether the reconciler must still apply it: an event handler, or a property that does
 *   not overwrite what the visitor did to a form field.
 */
function adoptAttribute(el: Element, attr: VAttr): boolean {
  if (attr.kind === EVENT) return true;
  if (attr.kind === PROPERTY) return !keepsUserState(el, attr.name);
  if (attr.kind === ATTRIBUTE && !/^(virtual:|$)/.test(attr.name)) {
    const value = String(attr.value ?? "");
    if (el.getAttribute(attr.name) !== value) el.setAttribute(attr.name, value);
  }
  return false;
}

/** Would setting property `name` overwrite what the visitor did to this form field? */
function keepsUserState(el: Element, name: string): boolean {
  return Object.hasOwn(USER_STATE, name) && USER_STATE[name](el as FormField);
}

/** Remove `node` and every sibling after it from `parent`. */
function removeFrom(parent: Node, node: Node | null): void {
  while (node) {
    const next: Node | null = node.nextSibling;
    parent.removeChild(node);
    node = next;
  }
}

class Adopter {
  readonly edited: Element[] = [];
  constructor(readonly insert: LustreInsertMetadata, readonly doc: Document) {}

  /** Skip comments that are not Lustre's markers; drop memo markers (Lustre's `virtualise` does). */
  skip(domParent: Node, cursor: Node | null): Node | null {
    for (let data = commentData(cursor); data !== null; data = commentData(cursor)) {
      if (/^(lustre:fragment|\/lustre:fragment|lustre:map)/.test(data)) return cursor;
      const next: Node | null = cursor!.nextSibling;
      if (data.startsWith("lustre:memo")) domParent.removeChild(cursor!);
      cursor = next;
    }
    return cursor;
  }

  children(
    domParent: Node,
    meta: LustreMetadata,
    patch: LustreAdoptPatch,
    vnodes: VNode[] | undefined,
    cursor: Node | null,
  ): Node | null {
    (vnodes ?? []).forEach((vnode, index) => {
      cursor = this.child(domParent, meta, patch, vnode, index, cursor);
    });
    return cursor;
  }

  /** Adopt `vnode` at `cursor`; the node after it. */
  child(
    domParent: Node,
    meta: LustreMetadata,
    patch: LustreAdoptPatch,
    vnode: VNode,
    index: number,
    cursor: Node | null,
  ): Node | null {
    cursor = this.skip(domParent, cursor);
    switch (vnode.kind) {
      case TEXT:
        return this.text(domParent, meta, vnode, index, cursor);
      case ELEMENT:
      case UNSAFE_INNER_HTML:
        return this.element(meta, patch, vnode, index, cursor);
      case FRAGMENT:
      case MAP:
        return this.virtual(domParent, meta, patch, vnode, index, cursor);
      default:
        throw new LustreAdoptMismatch(`a node of kind ${vnode.kind}`);
    }
  }

  text(
    domParent: Node,
    meta: LustreMetadata,
    vnode: VNode,
    index: number,
    cursor: Node | null,
  ): Node | null {
    const content = vnode.content ?? "";
    if (content === "" || cursor?.nodeType !== TEXT_NODE) {
      // HTML has no empty text node, and a text node may sit where the parser found none.
      const node = this.doc.createTextNode(content);
      domParent.insertBefore(node, cursor);
      this.insert(TEXT, meta, node, index, vnode.key ?? "");
      return cursor;
    }
    const node = cursor as Text;
    if (node.data !== content) {
      // The parser merges adjacent text nodes: split this one where the view's ends.
      if (node.data.startsWith(content)) node.splitText(content.length);
      else node.data = content;
    }
    this.insert(TEXT, meta, node, index, vnode.key ?? "");
    return node.nextSibling;
  }

  element(
    meta: LustreMetadata,
    patch: LustreAdoptPatch,
    vnode: VNode,
    index: number,
    cursor: Node | null,
  ): Node | null {
    const el = matchingElement(cursor, vnode);
    const key = vnode.key ?? "";
    if (key) el.removeAttribute("data-lustre-key");
    const own = this.insert(vnode.kind, meta, el, index, key);
    const elPatch = newPatch(index);
    if (edited(el)) this.edited.push(el);
    this.attributes(el, vnode.attributes, elPatch);
    if (vnode.kind === ELEMENT) {
      // Nodes past the view's children are not the view's: they go, as a patch would remove them.
      removeFrom(el, this.children(el, own, elPatch, vnode.children, el.firstChild));
    }
    addPatch(patch, elPatch);
    return el.nextSibling;
  }

  /** A fragment or a map: Lustre's marker comment as its head (or an empty text node, as the
   * reconciler writes outside debug mode), then its children. */
  virtual(
    domParent: Node,
    meta: LustreMetadata,
    patch: LustreAdoptPatch,
    vnode: VNode,
    index: number,
    cursor: Node | null,
  ): Node | null {
    const marker = vnode.kind === FRAGMENT ? "lustre:fragment" : "lustre:map";
    let head: Node;
    if (commentData(cursor)?.startsWith(marker)) {
      head = cursor!;
      cursor = cursor!.nextSibling;
    } else {
      head = this.doc.createTextNode("");
      domParent.insertBefore(head, cursor);
    }
    const own = this.insert(vnode.kind, meta, head, index, vnode.key ?? "");
    const ownPatch = newPatch(index);
    if (vnode.kind === MAP) {
      if (!vnode.child) throw new LustreAdoptMismatch("a map without its child");
      cursor = this.child(domParent, own, ownPatch, vnode.child, 0, cursor);
    } else {
      cursor = this.skip(
        domParent,
        this.children(domParent, own, ownPatch, vnode.children, cursor),
      );
      if (head.nodeType === COMMENT_NODE) {
        if (commentData(cursor) !== "/lustre:fragment") {
          throw new LustreAdoptMismatch("a fragment's children");
        }
        own.endNode = cursor;
        cursor = cursor!.nextSibling;
      }
    }
    addPatch(patch, ownPatch);
    return cursor;
  }

  /** Attributes are in the HTML already (set any that differ); properties and event handlers
   * become `update` changes. */
  attributes(el: Element, attrs: VAttr[] | undefined, patch: LustreAdoptPatch): void {
    const added = (attrs ?? []).filter((attr) => adoptAttribute(el, attr));
    if (added.length) patch.changes.push({ kind: UPDATE, added, removed: [] });
  }
}

/**
 * Adopt the server-rendered first paint in `root` as the Lustre view `vdom`: the nodes stay, and
 * Lustre's reconciler metadata is attached to them.
 *
 * @param root The view's root (the server rendered `vdom` into it).
 * @param vdom The server's whole view, from its `mount` message.
 * @param insertMetadata Lustre's `insertMetadataChild`.
 * @returns The patch that attaches handlers and properties (`Reconciler.push`) and the form fields
 *   the visitor edited before the mount.
 * @throws {LustreAdoptMismatch} When the nodes do not have the view's shape.
 */
export function adoptLustreView(
  root: Element,
  vdom: unknown,
  insertMetadata: LustreInsertMetadata,
): LustreAdoption {
  if (vdom === null || typeof vdom !== "object") throw new LustreAdoptMismatch("no view");
  const adopter = new Adopter(insertMetadata, root.ownerDocument);
  const rootMeta = insertMetadata(ELEMENT, null, root, 0, null);
  const patch = newPatch(0);
  removeFrom(root, adopter.child(root, rootMeta, patch, vdom as VNode, 0, root.firstChild));
  return { patch, edited: adopter.edited };
}
