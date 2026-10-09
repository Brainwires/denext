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
import { onErrorFor } from "./boundaries.ts";
import { hostPropsChanged } from "./complete-work.ts";
import { isHydrating } from "./hydration.ts";
import { documentForFiber, fiberToRoot } from "./state.ts";
import { type Fiber, Update } from "./fiber.ts";
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
  if (!wip.listeners) wip.listeners = wip.alternate?.listeners;
  if (wip.alternate !== null) {
    if (hostPropsChanged(wip.alternate.vnode.props, wip.vnode.props)) wip.flags |= Update;
    return;
  }
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
  setSingletonSupport({ adopt, complete, commit, release });
}
