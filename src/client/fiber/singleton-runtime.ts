// Host singletons — the import-gated half (see singleton-support.ts). A client root layout's
// `<html>`/`<head>`/`<body>` adopt the page's own elements (React's host singletons): the
// adopted fiber creates no element, its children flow into the page container where the server's
// parsed markup already put them, and its props become that element's attributes.
//
// The element is shared with code outside the tree: an inline script that ran before hydration
// (next-themes adds the theme class to `<html>`), a theme toggle later. So, as React does, the
// runtime writes only what it must and takes back only what it wrote:
// - hydration skips every prop the page already reflects, and with `suppressHydrationWarning`
//   leaves a mismatched attribute to the page (without it, the client value wins);
// - `className` is applied token by token: a layout adds and removes its own classes, never a
//   class something else put there;
// - an unmount (or a switch to another root layout) removes only the attributes and listeners
//   this layout set.

import { applyProps, domAttrName } from "../dom-props.ts";
import { stampFiber } from "../dom-fiber-map.ts";
import { onErrorFor } from "./boundaries.ts";
import { completeHostUpdate } from "./complete-work.ts";
import { isHydrating } from "./hydration.ts";
import { documentForFiber, fiberToRoot } from "./state.ts";
import { type Fiber, HoistedBit, Update } from "./fiber.ts";
import { setSingletonSupport } from "./singleton-support.ts";

type Props = Record<string, unknown>;

/**
 * Attribute props a hydrated singleton left to the page (a mismatch under
 * `suppressHydrationWarning`): not written, and never removed, until the layout changes them.
 */
const foreign = new WeakMap<Element, Set<string>>();

/** What hydration found for a mounting singleton: the props the page reflects, and those left to it. */
const hydrated = new WeakMap<Fiber, { base: Props; skip: Set<string> }>();

/** A root rendering into a page element — not the document (global-error's hydrateDocument). */
function isContainerRoot(host: Fiber): boolean {
  return host.tag === "root" && host.stateNode!.nodeType !== 9 &&
    fiberToRoot.get(host)?.documentRoot !== true;
}

function adopt(wip: Fiber): boolean {
  const type = wip.vnode.type as string;
  if (wip.alternate !== null || !isContainerRoot(wip.host!) || !/^(html|head|body)$/.test(type)) {
    return false;
  }
  const page = documentForFiber(wip);
  const el = (type === "html" ? page.documentElement : page[type as "head" | "body"]) ?? null;
  if (el === null) return false;
  wip.tag = "singleton";
  wip.stateNode = el;
  return true;
}

// ---- The head's hoisted tags -----------------------------------------------------------------
//
// The server hoists every `<title>` / `<meta>` / `<link>` into the document's head (React 19's
// document metadata), and the parser keeps the rest of the layout's `<head>` content (a
// `<style>`, a `<script>`) where it was, in the page container. So, as React hoists them, those
// three tags of an adopted `<head>` live in the page's head: hydration adopts the server's by
// match (they sit among the document's own tags, in no set order), a fresh one is added there,
// and an unmount takes it out. The rest of the head's content keeps flowing into the container.

const HOISTED = /^(title|meta|link)$/;

/** The adopted `<head>` a host fiber is a direct (host-level) child of, else null. */
function headOf(f: Fiber): Fiber | null {
  for (let p = f.return; p !== null; p = p.return) {
    if (p.tag === "singleton") return p.vnode.type === "head" ? p : null;
    if (p.tag === "host" || p.tag === "root" || p.tag === "portal") return null;
  }
  return null;
}

/** Whether `f` is a head tag the page's head holds: hoisted, and not microdata (React's rule). */
function hoists(f: Fiber): boolean {
  return f.tag === "host" && HOISTED.test(f.vnode.type as string) &&
    f.vnode.props?.itemProp == null && headOf(f) !== null;
}

/** The hoisted head tags of an adopted `<head>` (host-level descendants), in order. */
function hoistedOf(f: Fiber | null, out: Fiber[]): Fiber[] {
  for (; f !== null; f = f.sibling) {
    if (f.tag === "host") {
      if (hoists(f)) out.push(f);
    } else if (f.tag !== "portal") hoistedOf(f.child, out);
  }
  return out;
}

/** The attributes that identify a head tag (React's hoistable keys), compared when claiming. */
const HEAD_KEYS = [
  "name",
  "property",
  "httpEquiv",
  "charSet",
  "rel",
  "href",
  "media",
  "hrefLang",
  "id",
];

/** Elements of the page's head already claimed by this hydration. */
const claimed = new WeakSet<Element>();

function claimHoisted(wip: Fiber): Element | null | undefined {
  if (!hoists(wip)) return undefined;
  const head = documentForFiber(wip).head;
  const nodes = Array.from(head?.childNodes ?? []) as Element[];
  const el = nodes.find((n) => !claimed.has(n) && sameHeadTag(n, wip)) ?? null;
  if (el) claimed.add(el);
  return el;
}

/** Whether the page's `el` is the head tag `f` renders: its tag and identifying attributes. */
function sameHeadTag(el: Element, f: Fiber): boolean {
  const props: Props = f.vnode.props ?? {};
  return el.nodeType === 1 && el.tagName.toLowerCase() === f.vnode.type &&
    HEAD_KEYS.every((k) => props[k] == null || reflects(el, k, props[k]));
}

/**
 * Place an adopted `<head>`'s hoisted tags in the page's head: one not there yet goes before the
 * next of them that is (or at the end); one already there — a hydrated tag among the document's
 * own — is never moved.
 */
function place(f: Fiber): void {
  if (f.vnode.type !== "head") return;
  const head = f.stateNode as Element;
  const nodes = hoistedOf(f.child, []).map((h) => h.stateNode as Element);
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].parentNode === head) continue;
    const next = nodes[i + 1];
    head.insertBefore(nodes[i], next?.parentNode === head ? next : null);
  }
}

const isClass = (k: string) => k === "className" || k === "class";
const classOf = (p: Props) => p.className ?? p.class;
const words = (v: unknown) => typeof v === "string" ? v.split(/\s+/).filter(Boolean) : [];

/** A plain attribute prop (not a listener, ref, child or framework marker). */
function isAttrProp(k: string, v: unknown): boolean {
  return k !== "children" && k !== "key" && k !== "ref" && k !== "suppressHydrationWarning" &&
    !k.startsWith("__dnx") && !/^on[A-Z]/.test(k) && typeof v !== "function";
}

/** Whether the page's attribute already reads as `v` (a value that can't be compared does not). */
function reflects(el: Element, k: string, v: unknown): boolean {
  const a = el.getAttribute(domAttrName(el, k));
  if (v == null || v === false) return a === null;
  return a === (v === true ? "" : typeof v === "object" ? undefined : String(v));
}

/** `props` without the class keys (applied by token, see {@link patchClass}) or `drop`. */
function attrsOnly(props: Props, drop?: Set<string>): Props {
  const out: Props = {};
  for (const k in props) if (!isClass(k) && !drop?.has(k)) out[k] = props[k];
  return out;
}

/** Remove `old`'s class tokens and add `next`'s, keeping every token something else added. */
function patchClass(el: Element, old: unknown, next: unknown): void {
  const drop = words(old);
  const add = words(next);
  const cur = el.getAttribute("class");
  const kept = words(cur).filter((t) => !drop.includes(t) || add.includes(t));
  for (const t of add) if (!kept.includes(t)) kept.push(t);
  const value = kept.join(" ");
  if (value === (cur ?? "")) return;
  if (value) el.setAttribute("class", value);
  else el.removeAttribute("class");
}

/**
 * What hydration finds on the page's element: the attribute props it already reflects (`base`,
 * the commit's "previous" props, so only the others are written) and, under
 * `suppressHydrationWarning`, the mismatched ones it leaves to the page (`skip`).
 */
function scanHydration(el: Element, props: Props): { base: Props; skip: Set<string> } {
  const base: Props = {};
  const skip = new Set<string>();
  const keepMismatch = props.suppressHydrationWarning === true;
  for (const k in props) {
    const v = props[k];
    if (!isAttrProp(k, v) || isClass(k)) continue;
    const matches = reflects(el, k, v);
    if (matches || keepMismatch) base[k] = v;
    if (!matches && keepMismatch) skip.add(k);
  }
  return { base, skip };
}

function complete(wip: Fiber): void {
  // Mark the head's hoisted tags, so the container's placement leaves them to `place`.
  if (wip.vnode.type === "head") { for (const f of hoistedOf(wip.child, [])) f.bits |= HoistedBit; }
  if (completeHostUpdate(wip)) return;
  wip.flags |= Update; // a mount writes its props in the commit, after a released layout's
  if (isHydrating) {
    hydrated.set(wip, scanHydration(wip.stateNode as Element, wip.vnode.props ?? {}));
  }
}

/** The props a singleton's commit diffs against: its last ones, or on mount what the page has. */
function previousProps(f: Fiber, el: Element): Props {
  if (f.alternate !== null) return f.alternate.vnode.props ?? {};
  const h = hydrated.get(f);
  hydrated.delete(f);
  foreign.set(el, h?.skip ?? new Set());
  return h?.base ?? {};
}

/** Drop from `skip` the attributes the layout now sets itself (their value changed). */
function takeBack(skip: Set<string> | undefined, prev: Props, next: Props): void {
  for (const k of skip ?? []) if (prev[k] !== next[k]) skip!.delete(k);
}

function commit(f: Fiber): void {
  const el = f.stateNode as Element;
  const next: Props = f.vnode.props ?? {};
  const prev = previousProps(f, el);
  takeBack(foreign.get(el), prev, next);
  stampFiber(el, f); // event dispatch reads the adopted element's committed props from here
  applyProps(el, f, attrsOnly(prev), attrsOnly(next), onErrorFor(f));
  patchClass(el, classOf(prev), classOf(next));
}

function release(f: Fiber): void {
  const el = f.stateNode as Element;
  const props: Props = f.vnode.props ?? {};
  applyProps(el, f, attrsOnly(props, foreign.get(el)), {}, onErrorFor(f), false);
  patchClass(el, classOf(props), undefined);
  foreign.delete(el);
}

/** Wire host-singleton adoption into the reconciler (the generated entry calls this). */
export function installSingletonSupport(): void {
  setSingletonSupport({ adopt, complete, commit, release, place, claimHoisted });
}
