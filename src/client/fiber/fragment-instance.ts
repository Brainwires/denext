// React 19.3's Fragment refs: `<Fragment ref={r}>` puts a `FragmentInstance` in `r.current`. The
// on-demand half of the feature — loaded on the first `<Fragment ref>` a render reaches
// (fragment-ref-support.ts), so an app that never uses one ships none of it.
//
// A port of react-dom's FragmentInstance (ReactFiberConfigDOM.js / ReactFiberTreeReflection.js,
// React 19.3.1, MIT, Copyright (c) Meta Platforms, Inc. and affiliates) onto denext's fibers.
// A fragment's "children" are its nearest host fibers — elements and text — reached without
// descending into an element, skipping content an `<Activity>` / Offscreen hides (portaled
// content counts). React adds a fragment's listeners and observers to each child as the child
// is inserted; denext's commit places a host's whole child list at once, so the commit instead
// re-reads a fragment's children whenever the fragment takes part in a render and diffs them
// against the ones it last applied to.

// It imports types only: the reconciler helpers it calls arrive through `fragmentRefCommit`
// (fragment-ref-support.ts), so the chunk depends on no shared module.

import type { Fiber } from "./fiber.ts";
import type { FragmentRefCommit } from "./fragment-ref-support.ts";
import type { updateRef as UpdateRef } from "../dom-props.ts";
import type { fiberForNode as FiberForNode } from "../dom-fiber-map.ts";
import type { FragmentInstance as FragmentInstanceApi } from "../../runtime/react-extras.ts";

type HostNode = Element | Text;
type ListenerOptions = boolean | AddEventListenerOptions | undefined;
type Observer = IntersectionObserver | ResizeObserver;

/** One listener added through `addEventListener`, as the children carry it. */
interface StoredListener {
  type: string;
  listener: EventListenerOrEventListenerObject;
  options: ListenerOptions;
  /** With `once`: a wrapper that removes the fragment's listener on the first fire. */
  attached: EventListenerOrEventListenerObject;
  /** With `signal`: removes the abort listener. */
  cleanup: (() => void) | null;
}

/** A DOM node that records the fragments it belongs to (React's `reactFragments` handle). */
type WithHandles = HostNode & { reactFragments?: Set<FragmentInstance> };

/** fiber.ts's `HiddenBit` / `HoistedBit` / `OffscreenBit` (tests/fragment-refs.test.ts pins them). */
export const HIDDEN_BIT = 512;
export const HOISTED_BIT = 2048;
export const OFFSCREEN_BIT = 256;

let updateRef: typeof UpdateRef;
let fiberForNode: typeof FiberForNode;

// Node.DOCUMENT_POSITION_* (the constants, so no `Node` global is needed).
const DISCONNECTED = 1;
const PRECEDING = 2;
const FOLLOWING = 4;
const CONTAINS = 8;
const CONTAINED_BY = 16;
const IMPLEMENTATION_SPECIFIC = 32;

function isHostFiber(f: Fiber): boolean {
  return f.tag === "host" || f.tag === "singleton" || f.tag === "text";
}

/** A host fiber's node; the root's container. */
function nodeOf(f: Fiber): HostNode {
  return f.stateNode as HostNode;
}

/** Content an `<Activity>` / Offscreen hides, or a tag hoisted into the head: not a child. */
function skipped(f: Fiber): boolean {
  return (f.bits & (HIDDEN_BIT | HOISTED_BIT)) !== 0 ||
    (f.tag === "activity" && (f.bits & OFFSCREEN_BIT) !== 0);
}

/**
 * Visit the visible host fibers from `child` and its siblings, in order, descending into non-host
 * fibers — and into hosts too when `deep`. Stops (returning true) once `fn` returns true.
 * React's `traverseVisibleInstancesAndTextInstances`.
 */
function traverse(child: Fiber | null, deep: boolean, fn: (f: Fiber) => boolean): boolean {
  for (let c = child; c !== null; c = c.sibling) {
    if (skipped(c)) continue;
    const host = isHostFiber(c);
    if (host && fn(c)) return true;
    if ((deep || !host) && traverse(c.child, deep, fn)) return true;
  }
  return false;
}

/** The fragment's host-children fibers (React's `traverseFragmentInstancesAndTextInstances`). */
function childFibers(fragment: Fiber, deep = false): Fiber[] {
  const out: Fiber[] = [];
  traverse(fragment.child, deep, (c) => (out.push(c), false));
  return out;
}

/** The nearest host / root ancestor (portals are passed through). */
function parentHostFiber(f: Fiber): Fiber | null {
  for (let n = f.return; n !== null; n = n.return) {
    if (n.tag === "host" || n.tag === "singleton" || n.tag === "root") return n;
  }
  return null;
}

/** The portal target between `f` and its parent host, if any. */
function portalContainer(f: Fiber): Element | null {
  for (let n = f.return; n !== null; n = n.return) {
    if (n.tag === "portal") return n.stateNode as Element;
    if (n.tag === "host" || n.tag === "singleton" || n.tag === "root") break;
  }
  return null;
}

/** The nearest host siblings around `f` under its parent host: `[before, after]`. */
function hostSiblings(f: Fiber): [Fiber | null, Fiber | null] {
  const result: [Fiber | null, Fiber | null] = [null, null];
  const parent = parentHostFiber(f);
  if (parent === null) return result;
  let foundSelf = false;
  const find = (child: Fiber | null): boolean => {
    for (let c = child; c !== null; c = c.sibling) {
      if (c === f || c === f.alternate) foundSelf = true;
      else if (isHostFiber(c)) {
        if (foundSelf) return (result[1] = c), true;
        result[0] = c;
      } else if (!skipped(c) && find(c.child)) return true;
    }
    return false;
  };
  find(parent.child);
  return result;
}

const sameFiber = (a: Fiber | null, b: Fiber | null): boolean =>
  a !== null && b !== null && (a === b || a.alternate === b);

function ownerDocumentOf(node: Node): Document {
  return node.nodeType === 9 ? node as Document : node.ownerDocument!;
}

/**
 * Focus `node` if it can take focus: true when it is (or became) the active element. React's
 * `setFocusIfFocusable` — a `focus` event, not `activeElement`, decides, so a node that is not
 * focusable is passed over.
 */
function focusIfFocusable(node: HTMLElement, focusOptions?: FocusOptions): boolean {
  const doc = node.ownerDocument;
  if (doc.activeElement === node) return true;
  let didFocus = false;
  const onFocus = () => (didFocus = true);
  try {
    doc.addEventListener("focus", onFocus, true);
    (node.focus ?? HTMLElement.prototype.focus).call(node, focusOptions);
  } finally {
    doc.removeEventListener("focus", onFocus, true);
  }
  return didFocus;
}

function focusFiber(f: Fiber, focusOptions?: FocusOptions): boolean {
  return f.tag !== "text" && focusIfFocusable(nodeOf(f) as HTMLElement, focusOptions);
}

/** Strip `once` / `signal` when attaching to a child: the fragment owns those semantics. */
function attachOptions(opts: ListenerOptions): ListenerOptions {
  if (opts == null || typeof opts === "boolean" || (opts.once !== true && !opts.signal)) {
    return opts;
  }
  return { capture: opts.capture, passive: opts.passive };
}

/** Listeners match by type, listener and capture flag, as the DOM's do. */
function captureOf(opts: ListenerOptions | EventListenerOptions): boolean {
  return opts == null ? false : typeof opts === "boolean" ? opts : opts.capture === true;
}

function indexOfListener(
  listeners: StoredListener[],
  type: string,
  listener: EventListenerOrEventListenerObject,
  opts: ListenerOptions | EventListenerOptions,
): number {
  const capture = captureOf(opts);
  return listeners.findIndex((l) =>
    l.type === type && l.listener === listener && captureOf(l.options) === capture
  );
}

// A child removed from a fragment stays observed by its IntersectionObservers until after the
// next paint, so the observer still delivers the record of it leaving; then it is released.
interface PendingUnobserve {
  inst: FragmentInstance;
  observer: Observer;
  node: Element;
}
let pendingUnobserves: PendingUnobserve[] = [];
let unobserveScheduled = false;

/** IntersectionObserver has `rootMargin`, ResizeObserver none (no `instanceof`: mocks, realms). */
function isIntersectionObserver(observer: Observer): boolean {
  return typeof (observer as IntersectionObserver).rootMargin === "string";
}

/** Drop the pending entries `keep` rejects, running `drop` on each. */
function filterPending(
  keep: (p: PendingUnobserve) => boolean,
  drop?: (p: PendingUnobserve) => void,
): void {
  pendingUnobserves = pendingUnobserves.filter((p) => keep(p) || (drop?.(p), false));
}

function afterPaint(fn: () => void): void {
  const raf = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb: () => void) => setTimeout(cb, 16);
  raf(() => raf(fn));
}

function scheduleUnobserve(inst: FragmentInstance, observer: Observer, node: Element): void {
  pendingUnobserves.push({ inst, observer, node });
  if (unobserveScheduled) return;
  unobserveScheduled = true;
  afterPaint(() => {
    unobserveScheduled = false;
    const pending = pendingUnobserves;
    pendingUnobserves = [];
    for (const p of pending) p.observer.unobserve(p.node);
  });
}

/** The fiber rendering `node` or, failing that, its nearest rendered ancestor's. */
function closestFiber(node: Node): Fiber | null {
  if (node.nodeType === 3 && node.parentNode !== null) {
    // Text nodes are not indexed: find the text fiber among its parent's.
    const parent = fiberForNode(node.parentNode);
    let found: Fiber | null = null;
    if (parent) traverse(parent.child, false, (c) => c.stateNode === node && (found = c) !== null);
    if (found) return found;
  }
  for (let n: Node | null = node; n !== null; n = n.parentNode) {
    const f = fiberForNode(n);
    if (f) return f;
  }
  return null;
}

/** The nearest host / root ancestor of a host fiber (React's `getParentForFragmentAncestors`). */
function hostParentOf(f: Fiber | null): Fiber | null {
  if (f === null) return null;
  let n: Fiber | null = f;
  do n = n.return; while (
    n !== null && n.tag !== "host" && n.tag !== "singleton" && n.tag !== "root"
  );
  return n;
}

function lowestCommonAncestor(a: Fiber, b: Fiber): Fiber | null {
  let depthA = 0;
  for (let t: Fiber | null = a; t; t = hostParentOf(t)) depthA++;
  let depthB = 0;
  for (let t: Fiber | null = b; t; t = hostParentOf(t)) depthB++;
  let x: Fiber | null = a;
  let y: Fiber | null = b;
  for (; depthA > depthB; depthA--) x = hostParentOf(x);
  for (; depthB > depthA; depthB--) y = hostParentOf(y);
  for (; depthA-- > 0; x = hostParentOf(x), y = hostParentOf(y)) {
    if (x === y || sameFiber(y, x)) return x;
  }
  return null;
}

/** Whether `other` comes before (`following` false) or after the `boundary` fiber in tree order. */
function isFiberOrdered(boundary: Fiber, other: Fiber, following: boolean): boolean {
  const lca = lowestCommonAncestor(boundary, other);
  if (lca === null) return false;
  let seenBoundary = false;
  let found = false;
  traverse(lca, true, (c) => {
    if (sameFiber(c, boundary)) {
      seenBoundary = true;
      return !following;
    }
    if (sameFiber(c, other)) {
      found = !following || seenBoundary;
      return true;
    }
    return false;
  });
  return found;
}

/**
 * Whether the DOM's answer for `otherNode` agrees with the React tree (a node portaled or injected
 * into the fragment's DOM range is not the fragment's). React's `validateDocumentPositionWithFiberTree`.
 */
function agreesWithTree(position: number, fragment: Fiber, children: Fiber[], otherNode: Node) {
  const other = closestFiber(otherNode);
  if (position & CONTAINED_BY) return other !== null && insideFragment(other, fragment);
  if (position & CONTAINS) {
    return other === null ? isDocumentLevel(otherNode) : parentHostFiber(fragment) !== null;
  }
  if (other === null) return false;
  if (position & PRECEDING) return orderedFrom(children[0], other, false);
  if (position & FOLLOWING) return orderedFrom(children[children.length - 1], other, true);
  return false;
}

/** Whether `fiber` is rendered inside `fragment` (either of its buffers). */
function insideFragment(fiber: Fiber, fragment: Fiber): boolean {
  for (let n: Fiber | null = fiber; n !== null; n = n.return) {
    if (n.tag === "fragment" && sameFiber(n, fragment)) return true;
  }
  return false;
}

/** The document, its element or its body: nodes no fiber renders that contain every fragment. */
function isDocumentLevel(node: Node): boolean {
  const doc = node.ownerDocument;
  return node === doc || node === doc?.documentElement || node === doc?.body;
}

/** `other` is `boundary`, or comes before (after, when `following`) it in tree order. */
function orderedFrom(boundary: Fiber, other: Fiber, following: boolean): boolean {
  return sameFiber(other, boundary) || isFiberOrdered(boundary, other, following);
}

function scrollTextIntoView(text: Text, alignToTop: boolean): void {
  const range = text.ownerDocument.createRange();
  range.selectNodeContents(text);
  const rect = range.getBoundingClientRect();
  const y = alignToTop ? scrollY + rect.top : scrollY + rect.bottom - innerHeight;
  scrollTo(scrollX + rect.left, y);
}

/** An empty fragment's position: its host container's, placed between the host siblings. */
function emptyPosition(fragment: Fiber, host: Node, otherNode: Node): number {
  const position = host.compareDocumentPosition(otherNode);
  let result = position;
  if (host === otherNode) result = CONTAINS;
  else if (position & CONTAINED_BY) {
    const next = hostSiblings(fragment)[1];
    const r = next === null ? PRECEDING : (nodeOf(next) as Node).compareDocumentPosition(otherNode);
    result = next !== null && (r === 0 || r & FOLLOWING) ? FOLLOWING : PRECEDING;
  }
  return result | IMPLEMENTATION_SPECIFIC;
}

/**
 * `otherNode`'s position against the DOM range from `first` to `last` under `domParent`: inside it
 * (the bounds, within one, or between them), `IMPLEMENTATION_SPECIFIC` for a bound that left
 * `domParent` (portaled away), else its position against `first`.
 */
function rangePosition(domParent: Node, first: Node, last: Node, otherNode: Node): number {
  const firstIn = (domParent.compareDocumentPosition(first) & CONTAINED_BY) !== 0;
  const lastIn = (domParent.compareDocumentPosition(last) & CONTAINED_BY) !== 0;
  const firstResult = first.compareDocumentPosition(otherNode);
  const lastResult = last.compareDocumentPosition(otherNode);
  const isBound = (inside: boolean) =>
    (inside === firstIn && first === otherNode) || (inside === lastIn && last === otherNode);
  const within = ((firstResult | lastResult) & CONTAINED_BY) !== 0;
  const between = firstIn && lastIn && (firstResult & FOLLOWING) !== 0 &&
    (lastResult & PRECEDING) !== 0;
  if (isBound(true) || within || between) return CONTAINED_BY;
  return isBound(false) ? IMPLEMENTATION_SPECIFIC : firstResult;
}

/** Scroll one host fiber into view (a text node through its Range). */
function scrollFiber(f: Fiber, top: boolean, alignToTop?: boolean): void {
  if (f.tag === "text") scrollTextIntoView(nodeOf(f) as Text, top);
  else (nodeOf(f) as Element).scrollIntoView(alignToTop);
}

/** An empty fragment scrolls its next (`top`) or previous host sibling, else its parent. */
function scrollEmpty(fragment: Fiber, top: boolean, alignToTop?: boolean): void {
  const [before, after] = hostSiblings(fragment);
  const target = top ? after ?? before ?? parentHostFiber(fragment) : before ?? after;
  if (target === null) return;
  const node = nodeOf(target) as Node;
  if (target.tag === "text" || node.nodeType === 1) return scrollFiber(target, top, alignToTop);
  if (node.nodeType !== 11) return; // a Document is always in view
  // A ShadowRoot's host marks where its content appears; a bare DocumentFragment has none.
  const host = "host" in node ? (node as ShadowRoot).host : null;
  if (host !== null) host.scrollIntoView(alignToTop);
  else {
    console.warn(
      "You are attempting to scroll a FragmentInstance that is only mounted inside a " +
        "detached DocumentFragment. No scroll was performed.",
    );
  }
}

/** The value a `<Fragment ref>` receives. */
class FragmentInstance implements FragmentInstanceApi {
  /** The fragment's committed fiber (re-pointed at each commit it takes part in). */
  _fragmentFiber: Fiber;
  _eventListeners: StoredListener[] | null = null;
  _observers: Set<Observer> | null = null;
  /** The host children the listeners, observers and handles were last applied to. */
  _children: HostNode[] = [];

  constructor(fragmentFiber: Fiber) {
    this._fragmentFiber = fragmentFiber;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const signal = options != null && typeof options !== "boolean" ? options.signal ?? null : null;
    if (signal?.aborted) return;
    const listeners = this._eventListeners ??= [];
    if (indexOfListener(listeners, type, listener, options) !== -1) return;
    let attached = listener;
    if (options != null && typeof options !== "boolean" && options.once === true) {
      // `once` is fragment-scoped: the first fire on any child removes it from every child.
      // deno-lint-ignore no-this-alias
      const inst = this;
      attached = function (this: EventTarget, event: Event) {
        inst.removeEventListener(type, listener, options);
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
    }
    let cleanup: (() => void) | null = null;
    if (signal !== null) {
      const onAbort = () => this.removeEventListener(type, listener, options);
      signal.addEventListener("abort", onAbort, { once: true });
      cleanup = () => signal.removeEventListener("abort", onAbort);
    }
    listeners.push({ type, listener, options, attached, cleanup });
    const opts = attachOptions(options);
    for (const n of this._children) n.addEventListener(type, attached, opts);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    const listeners = this._eventListeners;
    const i = listeners === null ? -1 : indexOfListener(listeners, type, listener, options);
    if (i === -1) return;
    const stored = listeners![i];
    const opts = attachOptions(stored.options);
    for (const n of this._children) n.removeEventListener(type, stored.attached, opts);
    listeners!.splice(i, 1);
    stored.cleanup?.();
  }

  dispatchEvent(event: Event): boolean {
    const parent = parentHostFiber(this._fragmentFiber);
    if (parent === null) return true;
    const parentNode = nodeOf(parent) as unknown as Node;
    const listeners = this._eventListeners;
    if ((listeners !== null && listeners.length > 0) || !event.bubbles) {
      // A temporary node stands in for the fragment's position, so its own listeners run before
      // the event propagates to the parent. A Document only takes a comment beside its element.
      const doc = ownerDocumentOf(parentNode);
      const temp = parentNode.nodeType === 9 ? doc.createComment("") : doc.createTextNode("");
      for (const l of listeners ?? []) {
        temp.addEventListener(l.type, l.attached, attachOptions(l.options));
      }
      parentNode.appendChild(temp);
      const result = temp.dispatchEvent(event);
      for (const l of listeners ?? []) {
        temp.removeEventListener(l.type, l.attached, attachOptions(l.options));
      }
      parentNode.removeChild(temp);
      return result;
    }
    return parentNode.dispatchEvent(event);
  }

  focus(focusOptions?: FocusOptions): void {
    traverse(this._fragmentFiber.child, true, (c) => focusFiber(c, focusOptions));
  }

  focusLast(focusOptions?: FocusOptions): void {
    const all = childFibers(this._fragmentFiber, true);
    for (let i = all.length - 1; i >= 0 && !focusFiber(all[i], focusOptions); i--);
  }

  blur(): void {
    const parent = parentHostFiber(this._fragmentFiber);
    if (parent === null) return;
    const active = ownerDocumentOf(nodeOf(parent)).activeElement as HTMLElement | null;
    if (active === null) return;
    traverse(this._fragmentFiber.child, false, (c) => {
      if (c.tag === "text") return false;
      const el = nodeOf(c);
      if (el !== active && !el.contains(active)) return false;
      active.blur();
      return true;
    });
  }

  observeUsing(observer: Observer): void {
    const children = childFibers(this._fragmentFiber);
    if (children.length > 0 && children.every((c) => c.tag === "text")) {
      console.error(
        "observeUsing() was called on a FragmentInstance with only text children. " +
          "Observers do not work on text nodes.",
      );
    }
    (this._observers ??= new Set()).add(observer);
    for (const n of this._children) if (n.nodeType === 1) observer.observe(n as Element);
  }

  unobserveUsing(observer: Observer): void {
    const observers = this._observers;
    if (observers === null || !observers.has(observer)) {
      console.error(
        "You are calling unobserveUsing() with an observer that is not being observed with " +
          "this fragment instance. First attach the observer with observeUsing()",
      );
      return;
    }
    observers.delete(observer);
    for (const n of this._children) if (n.nodeType === 1) observer.unobserve(n as Element);
    // Release the removed children still waiting for their exit record.
    filterPending(
      (p) => p.inst !== this || p.observer !== observer,
      (p) => observer.unobserve(p.node),
    );
  }

  getClientRects(): DOMRect[] {
    const rects: DOMRect[] = [];
    for (const c of childFibers(this._fragmentFiber)) {
      if (c.tag === "text") {
        const range = (nodeOf(c) as Text).ownerDocument.createRange();
        range.selectNodeContents(nodeOf(c));
        rects.push(...range.getClientRects());
      } else rects.push(...(nodeOf(c) as Element).getClientRects());
    }
    return rects;
  }

  getRootNode(options?: GetRootNodeOptions): Document | ShadowRoot | FragmentInstance {
    const parent = parentHostFiber(this._fragmentFiber);
    if (parent === null) return this;
    return (nodeOf(parent) as Node).getRootNode(options) as Document | ShadowRoot;
  }

  compareDocumentPosition(otherNode: Node): number {
    const fragment = this._fragmentFiber;
    const parent = parentHostFiber(fragment);
    if (parent === null) return DISCONNECTED;
    const children = childFibers(fragment);
    const parentNode = nodeOf(parent) as Node;
    const portal = portalContainer(fragment);
    // An empty fragment sits between its host siblings (in a portal: in the portal's target).
    if (children.length === 0) return emptyPosition(fragment, portal ?? parentNode, otherNode);
    const first = nodeOf(children[0]) as Node;
    // Portaled: the best guess at the fragment's DOM parent is its first child's parent.
    const domParent = portal !== null ? first.parentElement : parentNode;
    if (domParent == null) return DISCONNECTED;
    const last = nodeOf(children[children.length - 1]) as Node;
    const result = rangePosition(domParent, first, last, otherNode);
    if (result & (DISCONNECTED | IMPLEMENTATION_SPECIFIC)) return result;
    return agreesWithTree(result, fragment, children, otherNode) ? result : IMPLEMENTATION_SPECIFIC;
  }

  scrollIntoView(alignToTop?: boolean): void {
    if (typeof alignToTop === "object") {
      throw new Error(
        "FragmentInstance.scrollIntoView() does not support scrollIntoViewOptions. " +
          "Use the alignToTop boolean instead.",
      );
    }
    const children = childFibers(this._fragmentFiber);
    const top = alignToTop !== false;
    if (children.length === 0) scrollEmpty(this._fragmentFiber, top, alignToTop);
    // Scroll each child, ending on the first (top) or the last, so that one settles in view.
    if (top) children.reverse();
    for (const c of children) scrollFiber(c, top, alignToTop);
  }
}

/** Apply the fragment's listeners, observers and handle to a child that joined it. */
function adoptChild(inst: FragmentInstance, node: WithHandles): void {
  for (const l of inst._eventListeners ?? []) {
    node.addEventListener(l.type, l.attached, attachOptions(l.options));
  }
  if (node.nodeType !== 1) return;
  inst._observers?.forEach((observer) => {
    filterPending((p) => p.inst !== inst || p.observer !== observer || p.node !== node);
    observer.observe(node as Element);
  });
  (node.reactFragments ??= new Set()).add(inst);
}

/** Take them off a child that left it (an IntersectionObserver lets go after the next paint). */
function releaseChild(inst: FragmentInstance, node: WithHandles): void {
  for (const l of inst._eventListeners ?? []) {
    node.removeEventListener(l.type, l.attached, attachOptions(l.options));
  }
  if (node.nodeType !== 1) return;
  inst._observers?.forEach((observer) => {
    if (isIntersectionObserver(observer)) scheduleUnobserve(inst, observer, node as Element);
    else observer.unobserve(node as Element);
  });
  node.reactFragments?.delete(inst);
}

/** Bring the instance's applied children up to `next`. */
function syncChildren(inst: FragmentInstance, next: HostNode[]): void {
  const prev = inst._children;
  if (prev.length === next.length && prev.every((n, i) => n === next[i])) return;
  const nextSet = new Set(next);
  const prevSet = new Set(prev);
  for (const n of prev) if (!nextSet.has(n)) releaseChild(inst, n);
  for (const n of next) if (!prevSet.has(n)) adoptChild(inst, n);
  inst._children = next;
}

/**
 * The reconciler's commit of a Fragment fiber (the {@link FragmentRefCommit} seam). Visible: point
 * the instance at this committed fiber, sync its children, and attach — or swap — the ref
 * (React 19 ref semantics: a callback ref's returned cleanup runs on detach). Hidden or deleted:
 * detach the ref and release the children. The instance is created on the first attach and kept
 * for the fiber's life, so every attach hands the same one.
 */
function commitFragmentRef(fiber: Fiber, visible: boolean): void {
  const ref = visible ? fiber.vnode.props?.ref : undefined;
  let inst = fiber.stateNode as FragmentInstance | null;
  if (inst === null) {
    if (ref == null) return;
    inst = new FragmentInstance(fiber);
    fiber.stateNode = inst as unknown as Element;
  }
  inst._fragmentFiber = fiber;
  syncChildren(inst, visible ? childFibers(fiber).map(nodeOf) : []);
  updateRef(fiber, fiber.attachedRef, ref, inst as unknown as Element);
}

/**
 * The reconciler's commit for Fragment fibers, bound to the reconciler helpers it uses (which
 * fragment-ref-support.ts passes in, so this chunk imports no shared module).
 */
export function fragmentRefCommit(
  update: typeof UpdateRef,
  lookup: typeof FiberForNode,
): FragmentRefCommit {
  updateRef = update;
  fiberForNode = lookup;
  return commitFragmentRef;
}
