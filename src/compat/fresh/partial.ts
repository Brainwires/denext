/**
 * `denext/fresh/partial` — Fresh's `<Partial>` and its client navigation on denext. A migrated
 * app imports `Partial` through `fresh/runtime`; `denext migrate` points that at an app module
 * that re-exports it from a `"use client"` file, so each `<Partial>` is a client component the
 * page's Flight payload carries with its server-rendered children.
 *
 * In the browser, inside an element with `f-client-nav` (and not under `f-client-nav="false"`):
 *
 * - a same-origin link fetches its `f-partial` URL (else its `href`) with `?fresh-partial=true`
 *   and swaps only the `<Partial>` regions the answer holds, then pushes `href`;
 * - a `<button f-partial="…">` that submits no form fetches that URL and swaps its partials,
 *   with no history entry;
 * - a `<form>` with an explicit `f-partial`, `action` or submitter `formaction` submits (GET or
 *   POST) to it and swaps the partials of the answer.
 *
 * Each region applies the answer's `mode`: `replace` (default) swaps the children, `append` and
 * `prepend` add them after or before what the region holds. An answer with no partials falls
 * back to a whole-page navigation. The request carries `x-denext-nav`, so denext answers with the
 * page's Flight payload, parsed through the app's client registry (the islands in a swapped
 * region hydrate as on any navigation).
 *
 * As in Fresh, the answer's head is merged into the page's before the regions swap: its
 * `<title>`, each `<meta>` (by `name`, `property`, `http-equiv` or `itemprop`; `charset` is left
 * alone) updated or added, and each stylesheet `<link>` the page lacks added and loaded first.
 * Under an element with `f-view-transition`, the swap runs inside `document.startViewTransition`
 * where the browser has it. Browser back / forward between the entries partial navigation made
 * restores each region as that entry left it (an `append` / `prepend` history included); an
 * entry this page load holds no record of (after a reload) is fetched as a partial request and
 * its regions replaced.
 *
 * @module
 */

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { useEffect, useRef, useState } from "../../runtime/hooks.ts";
import { emit, navigate, setSoftNavBlocker, subscribeLocation } from "../../client/navigation.ts";
import { flightParser } from "../../client/flight-nav.ts";
import { flushSync } from "../../client/reconciler.ts";
import {
  CLIENT_NAV_ATTR,
  PARTIAL_ATTR,
  PARTIAL_SEARCH_PARAM,
  VIEW_TRANSITION_ATTR,
} from "./constants.ts";

/** How a partial update merges into a region. */
export type PartialMode = "replace" | "prepend" | "append";

/** Props of {@link Partial}. */
export interface PartialProps {
  /** The region's name: an answer's `<Partial name>` replaces the region of that name. */
  name: string;
  /** How an update merges: replace the children (default), or add after / before them. */
  mode?: PartialMode;
  /** The region's content. */
  children?: VNodeChildren;
}

/** One block of a region's content: the server-rendered children, or one update. */
interface Chunk {
  key: string;
  children: VNodeChildren;
}

/** A region's updates, over the children (`base`) they were applied to. */
interface RegionState {
  base: VNodeChildren;
  chunks: Chunk[];
}

/** A mounted region, by name. */
interface ActiveRegion {
  apply(mode: PartialMode, children: VNodeChildren, key: string | null): void;
  /** The updates the region shows (null: its server-rendered children). */
  snapshot(): RegionState | null;
  /** Whether {@link restore} can show `state` (its updates were made over these children). */
  canRestore(state: RegionState | null): boolean;
  /** Show a {@link snapshot} again. */
  restore(state: RegionState | null): void;
}

const ACTIVE = new Map<string, ActiveRegion>();
let updates = 0;

/** A region's content with one update merged in, the way `mode` says. */
function merged(
  prev: RegionState | null,
  base: VNodeChildren,
  mode: PartialMode,
  children: VNodeChildren,
  key: string | null,
): RegionState {
  const current = prev && prev.base === base ? prev.chunks : [{ key: "", children: base }];
  if (mode === "replace") return { base, chunks: [{ key: key ?? "", children }] };
  const chunk = { key: key ?? `u${++updates}`, children };
  return { base, chunks: mode === "append" ? [...current, chunk] : [chunk, ...current] };
}

/**
 * Fresh's `<Partial>`: a named region of the page that partial navigation updates in place. It
 * renders its children; a navigation that re-renders the page (a full-page soft navigation)
 * resets it to the new children.
 *
 * @param props The region's name, merge mode and content.
 * @returns The region's content.
 */
export function Partial(props: PartialProps): VNode {
  const [state, setState] = useState<RegionState | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const shown = state && state.base === props.children ? state : null;
  const committed = useRef(shown);
  committed.current = shown;
  useEffect(() => {
    installPartialNavigation();
    const canRestore = (s: RegionState | null) => s === null || s.base === latest.current.children;
    const region: ActiveRegion = {
      apply: (mode, children, key) =>
        setState((prev) => merged(prev, latest.current.children, mode, children, key)),
      snapshot: () => committed.current,
      canRestore,
      restore: (s) => setState(s),
    };
    ACTIVE.set(props.name, region);
    return () => {
      if (ACTIVE.get(props.name) === region) ACTIVE.delete(props.name);
    };
  }, [props.name]);
  const chunks = shown ? shown.chunks : [{ key: "", children: props.children }];
  return h(Fragment, null, chunks.map((c) => h(Fragment, { key: c.key }, c.children)));
}

// ── The browser side ─────────────────────────────────────────────────────────

/** Whether client navigation is on for `el`: under `f-client-nav`, not `f-client-nav="false"`. */
function clientNavEnabled(el: Element): boolean {
  const setting = el.closest(`[${CLIENT_NAV_ATTR}]`);
  return setting !== null && setting.getAttribute(CLIENT_NAV_ATTR) !== "false";
}

/** A `<Partial>` in a parsed payload, with what it carries. */
interface FoundPartial {
  name: string;
  mode: PartialMode;
  key: string | null;
  children: VNodeChildren;
}

/** The head elements an answer merges into the page's head (`<title>` travels as its title). */
const HEAD_TAGS = new Set(["meta", "link"]);

/**
 * The outermost `<Partial>` elements of a parsed tree, in document order, and (into `head`) the
 * `<meta>` / `<link>` elements outside them (an `<svg>`'s content is not searched).
 */
function collectPartials(node: unknown, out: FoundPartial[], head?: VNode[]): FoundPartial[] {
  if (Array.isArray(node)) {
    for (const child of node) collectPartials(child, out, head);
  } else if (node !== null && typeof node === "object" && "props" in node) {
    const v = node as VNode;
    const props = v.props as { name?: unknown; mode?: PartialMode; children?: VNodeChildren };
    if (v.type === Partial && typeof props.name === "string") {
      out.push({
        name: props.name,
        mode: props.mode ?? "replace",
        key: v.key == null ? null : String(v.key),
        children: props.children,
      });
    } else if (typeof v.type === "string" && HEAD_TAGS.has(v.type)) {
      head?.push(v);
    } else if (v.type !== "svg") {
      collectPartials(props.children, out, head);
    }
  }
  return out;
}

// ── The answer's head ────────────────────────────────────────────────────────

/** JSX prop names whose attribute is spelled otherwise. */
const ATTR_NAMES: Record<string, string> = {
  charSet: "charset",
  className: "class",
  crossOrigin: "crossorigin",
  fetchPriority: "fetchpriority",
  hrefLang: "hreflang",
  httpEquiv: "http-equiv",
  itemProp: "itemprop",
  referrerPolicy: "referrerpolicy",
};

/** Props that are never attributes. */
const SKIPPED_PROPS = new Set(["children", "key", "ref"]);

/** A prop's attribute value: null for children, handlers and values that set none. */
function attrValue(name: string, value: unknown): string | null {
  if (SKIPPED_PROPS.has(name) || name.startsWith("on")) return null;
  if (value === true) return "";
  return typeof value === "string" || typeof value === "number" ? `${value}` : null;
}

/** A head element's attributes, from its props. */
function attributesOf(props: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(props)) {
    const value = attrValue(k, v);
    if (value !== null) out.push([ATTR_NAMES[k] ?? k, value]);
  }
  return out;
}

/** A new head element with `attrs`. */
function headElement(tag: string, attrs: [string, string][]): Element {
  const el = document.createElement(tag);
  for (const [k, v] of attrs) el.setAttribute(k, v);
  return el;
}

/** The attributes a `<meta>` is matched by, in order (Fresh's `name`, then `property`). */
const META_KEYS = ["name", "property", "http-equiv", "itemprop"];

/** Update the page's `<meta>` of the same key, or add one. A `charset` is left alone. */
function mergeMeta(head: HTMLHeadElement, attrs: [string, string][]): void {
  const get = (name: string) => attrs.find(([k]) => k === name)?.[1] ?? null;
  const keyName = META_KEYS.find((k) => get(k) !== null);
  if (get("charset") !== null || keyName === undefined) return;
  const value = get(keyName);
  const existing = [...head.querySelectorAll("meta")].find((m) =>
    m.getAttribute(keyName) === value
  );
  const content = get("content");
  if (!existing) head.appendChild(headElement("meta", attrs));
  else if (content !== null && existing.getAttribute("content") !== content) {
    existing.setAttribute("content", content);
  }
}

/** The longest a navigation waits for a new stylesheet before swapping its regions anyway. */
const STYLESHEET_WAIT_MS = 3000;

/** Add a stylesheet `<link>` the page lacks; resolves once it loads (or fails, or times out). */
function mergeStylesheet(head: HTMLHeadElement, attrs: [string, string][]): Promise<void> | null {
  const get = (name: string) => attrs.find(([k]) => k === name)?.[1] ?? null;
  const href = get("href");
  const rels = (get("rel") ?? "").toLowerCase().split(/\s+/);
  if (href === null || !rels.includes("stylesheet")) return null;
  const abs = (raw: string | null) => raw === null ? null : new URL(raw, location.href).href;
  const wanted = abs(href);
  if ([...head.querySelectorAll("link")].some((l) => abs(l.getAttribute("href")) === wanted)) {
    return null;
  }
  const link = headElement("link", attrs);
  const loaded = new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, STYLESHEET_WAIT_MS);
    link.addEventListener("load", done);
    link.addEventListener("error", done);
  });
  head.appendChild(link);
  return loaded;
}

/**
 * Merge an answer's head elements into the page's, as Fresh does: `<meta>` updated or added,
 * new stylesheets added. Nothing the page has is removed.
 *
 * @returns The new stylesheets' loads (the regions swap once they settle).
 */
function mergeHead(nodes: VNode[]): Promise<void>[] {
  const head = document.head;
  const waits: Promise<void>[] = [];
  if (!head) return waits;
  for (const node of nodes) {
    const attrs = attributesOf(node.props as Record<string, unknown>);
    if (node.type === "meta") mergeMeta(head, attrs);
    else {
      const wait = mergeStylesheet(head, attrs);
      if (wait) waits.push(wait);
    }
  }
  return waits;
}

/** A partial request's parsed answer. */
interface PartialAnswer {
  found: FoundPartial[];
  head: VNode[];
  title: string | null;
}

/**
 * Parse a partial request's answer: its partials, head elements and title.
 *
 * @param res The answer (denext's Flight navigation payload).
 * @returns The answer, or null when it is not a payload this can apply.
 */
async function readAnswer(res: Response): Promise<PartialAnswer | null> {
  const parse = flightParser;
  if (!parse || res.headers.get("x-denext-flight") !== "1") return null;
  const payload = JSON.parse(await res.text()) as { flight: unknown; title?: string | null };
  const head: VNode[] = [];
  const found = collectPartials(await parse(payload.flight), [], head);
  return { found, head, title: payload.title ?? null };
}

/** Apply found partials to the regions of the same names, each in its mode (or `mode`). */
function applyFound(found: FoundPartial[], mode?: PartialMode): void {
  for (const p of found) {
    const region = ACTIVE.get(p.name);
    if (region) region.apply(mode ?? p.mode, p.children, p.key);
    else console.warn(`denext/fresh: partial "${p.name}" is not on this page; skipped`);
  }
}

/** A document that may have the View Transitions API. */
type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { updateCallbackDone: Promise<void> };
};

/**
 * Run a region swap: inside `document.startViewTransition` (flushed, so the browser captures
 * the new state) when `transition` asks and the browser has it, else at once.
 */
async function swap(update: () => void, transition: boolean): Promise<void> {
  const doc = document as TransitionDocument;
  if (!transition || typeof doc.startViewTransition !== "function") return update();
  const vt = doc.startViewTransition(() => void flushSync(update));
  await vt.updateCallbackDone.catch(() => {});
}

/** Whether `el` is under an element with `f-view-transition` (Fresh's opt-in). */
function viewTransitionFor(el: Element | null): boolean {
  return el?.closest?.(`[${VIEW_TRANSITION_ATTR}]`) != null;
}

/**
 * Apply the `<Partial>` regions of a rendered tree (a partial request's parsed answer) to the
 * regions of the same names on the page, each in its `mode`. A nested `<Partial>` travels with
 * the outer one.
 *
 * @param tree The tree.
 * @returns How many partials the tree held.
 */
export function applyPartialTree(tree: unknown): number {
  const found = collectPartials(tree, []);
  applyFound(found);
  return found.length;
}

/** A partial request. */
interface PartialRequest {
  /** The URL the page shows afterwards (a navigation pushes it). */
  url: URL;
  /** The URL the partials are fetched from. */
  partial: URL;
  /** Show `url` afterwards (a link or a form; not a button). */
  navigate: boolean;
  /** Replace the history entry instead of pushing one (a form, as Fresh does). */
  replace?: boolean;
  /** The method and body (a POST form). */
  init?: RequestInit;
  /** Swap inside a view transition (the element is under `f-view-transition`). */
  transition?: boolean;
  /** Apply every partial in this mode (a back / forward re-fetch replaces). */
  mode?: PartialMode;
}

/**
 * Fetch a partial request and apply its partials. An answer with no partials follows the redirect
 * it took, else navigates the whole page instead (a link or a GET form), as a full load would.
 */
async function fetchPartials(req: PartialRequest): Promise<void> {
  const partial = new URL(req.partial);
  partial.searchParams.set(PARTIAL_SEARCH_PARAM, "true");
  const res = await fetch(partial, { ...req.init, headers: { "x-denext-nav": "1" } });
  if (loadedElsewhere(res)) return;
  const url = landedUrl(req.url, res);
  const answer = await readAnswer(res);
  if (answer && answer.found.length > 0) return commitAnswer(req, url, answer);
  if (res.redirected) location.href = url.href;
  else if (req.navigate && req.init?.method !== "post") await navigate(url.href);
  else throw new Error(`denext/fresh: no <Partial> in the answer from ${partial.pathname}`);
}

/**
 * A redirect that landed on another origin is not a page of this app: its answer is never
 * applied (its partials and head tags would run as this origin). The browser loads that URL
 * instead, as a full navigation would. Returns whether it did.
 */
function loadedElsewhere(res: Response): boolean {
  if (!res.redirected || !res.url) return false;
  const landed = new URL(res.url);
  if (landed.origin === location.origin) return false;
  void res.body?.cancel();
  landed.searchParams.delete(PARTIAL_SEARCH_PARAM);
  location.href = landed.href;
  return true;
}

/** The URL the page shows after `res`: the same-origin URL a redirect landed on, else `url`. */
function landedUrl(url: URL, res: Response): URL {
  const landed = res.redirected ? new URL(res.url) : null;
  const shown = landed && landed.origin === location.origin ? landed : url;
  shown.searchParams.delete(PARTIAL_SEARCH_PARAM);
  return shown;
}

/**
 * Whether a partial URL is this page's origin. An `f-partial` naming another origin is never
 * fetched: its answer would be swapped into the page, and a form's fields (a CSRF token among
 * them) sent there. The element then does what it would with no `f-partial`.
 */
function sameOrigin(url: URL): boolean {
  return url.origin === location.origin;
}

/**
 * Commit an answer: merge its head (waiting for new stylesheets), record the regions of the entry
 * a push leaves, swap the regions (in a view transition when asked), then the history entry.
 */
async function commitAnswer(req: PartialRequest, url: URL, answer: PartialAnswer): Promise<void> {
  await Promise.all(mergeHead(answer.head));
  const entry = markEntry();
  if (req.navigate && !req.replace && url.href !== location.href) remember(entry);
  await swap(() => {
    applyFound(answer.found, req.mode);
    if (answer.title) document.title = answer.title;
  }, req.transition === true);
  pushNavigation(req, url);
}

/** A navigation's history entry (a new URL only) and the location hooks' update. */
function pushNavigation(req: PartialRequest, url: URL): void {
  if (!req.navigate) return;
  if (url.href === location.href) return emit();
  if (req.replace) history.replaceState(entryState(currentEntry!), "", url.href);
  else history.pushState(entryState(currentEntry = newEntryId()), "", url.href);
  emit();
}

// ── Back / forward ───────────────────────────────────────────────────────────

/** The `history.state` key naming an entry partial navigation made or marked. */
const ENTRY_KEY = "denextFreshEntry";

/** Each region's updates, by name: what an entry showed when the page left it. */
type RegionsSnapshot = Map<string, RegionState | null>;

/** The entries this page load left, newest last (bounded). */
const SNAPSHOTS = new Map<string, RegionsSnapshot>();
const MAX_SNAPSHOTS = 50;

/** The entry the page shows, when partial navigation marked it. */
let currentEntry: string | null = null;
let entries = 0;

/** A new entry id, unique to this page load. */
function newEntryId(): string {
  return `${Date.now().toString(36)}.${++entries}`;
}

/** An entry's partial-navigation id, from its `history.state`. */
function entryOf(state: unknown): string | null {
  const id = state !== null && typeof state === "object"
    ? (state as Record<string, unknown>)[ENTRY_KEY]
    : null;
  return typeof id === "string" ? id : null;
}

/** A `history.state` naming `id`, keeping what the current state holds otherwise. */
function entryState(id: string): Record<string, unknown> {
  const state = history.state;
  const base = state !== null && typeof state === "object" ? state as Record<string, unknown> : {};
  return { ...base, [ENTRY_KEY]: id };
}

/** Mark the entry the page shows (once), so a back / forward to it can restore its regions. */
function markEntry(): string {
  const id = entryOf(history.state);
  if (id !== null) return (currentEntry = id);
  currentEntry = newEntryId();
  history.replaceState(entryState(currentEntry), "", location.href);
  return currentEntry;
}

/** Record what the mounted regions show, as the entry `id`'s. */
function remember(id: string): void {
  const snap: RegionsSnapshot = new Map();
  for (const [name, region] of ACTIVE) snap.set(name, region.snapshot());
  SNAPSHOTS.delete(id);
  SNAPSHOTS.set(id, snap);
  if (SNAPSHOTS.size > MAX_SNAPSHOTS) SNAPSHOTS.delete(SNAPSHOTS.keys().next().value!);
}

/** Show a recorded entry's regions again; false when this page no longer holds them. */
function restoreRegions(snap: RegionsSnapshot): boolean {
  for (const [name, state] of snap) {
    if (!ACTIVE.get(name)?.canRestore(state)) return false;
  }
  for (const [name, state] of snap) ACTIVE.get(name)!.restore(state);
  return true;
}

/**
 * The router's back / forward claim: an entry partial navigation made is shown by its regions,
 * restored as the page left it, or (no record of it in this page load) fetched as a partial
 * request that replaces them. Any other entry, or one whose page was re-rendered since, is left
 * to the router (a whole-page navigation).
 *
 * @returns Whether the pop was claimed.
 */
function claimPop(href: string, event: Event): boolean {
  const id = entryOf((event as PopStateEvent).state);
  if (id === null) return false;
  if (currentEntry !== null && entryOf(history.state) !== currentEntry) remember(currentEntry);
  const snap = SNAPSHOTS.get(id);
  if (snap) {
    if (!restoreRegions(snap)) return false;
    currentEntry = id;
    return true;
  }
  currentEntry = id;
  const url = new URL(href);
  void fetchPartials({ url, partial: url, navigate: false, mode: "replace" }).catch(() =>
    navigate(href, { history: false, scroll: false })
  );
  return true;
}

/**
 * Take the router's `__dnxPop` hook, asking whatever claims it after (a stack layout) when this
 * declines.
 */
function installPopClaim(): void {
  const g = globalThis as { __dnxPop?: (href: string, event: Event) => unknown };
  let next = g.__dnxPop;
  const claim = (href: string, event: Event) => claimPop(href, event) || next?.(href, event);
  Object.defineProperty(g, "__dnxPop", {
    configurable: true,
    get: () => claim,
    set: (fn) => (next = fn),
  });
}

/** The link a click inside a client-nav subtree claimed, until denext's navigation asks. */
let claimed: { href: string; partial: string | null; transition: boolean } | null = null;

/**
 * A click on a same-origin link in a client-nav subtree: claim it. denext's own link handling
 * runs next (after the page's handlers, which may still cancel it) and asks the soft-nav blocker
 * before it navigates; the blocker answers the claimed link with a partial navigation instead.
 */
function onClickCapture(e: MouseEvent): void {
  const a = (e.target as Element | null)?.closest?.("a");
  const raw = a?.getAttribute("href");
  if (!a || raw == null || raw.startsWith("#") || !clientNavEnabled(a)) return;
  claimed = {
    href: a.href,
    partial: a.getAttribute(PARTIAL_ATTR),
    transition: viewTransitionFor(a),
  };
  setTimeout(() => (claimed = null), 0);
}

/** denext's soft-nav blocker: a claimed link navigates by its partials. */
function partialLinkBlocker(href: string): boolean {
  const link = claimed;
  if (link === null || link.href !== href) return false;
  claimed = null;
  const url = new URL(href);
  const partial = new URL(link.partial ?? href, location.href);
  if (!sameOrigin(partial) || !sameOrigin(url)) return false;
  void fetchPartials({ url, partial, navigate: true, transition: link.transition })
    .then(
      () => scrollTo({ left: 0, top: 0, behavior: "instant" }),
      () => (location.href = href), // the fetch failed: load the page in full
    );
  return true;
}

/** A `<button f-partial>` that submits no form: fetch its partials, without navigating. */
function onClick(e: MouseEvent): void {
  if (e.defaultPrevented) return;
  const target = e.target as Element | null;
  if (target?.closest?.("a")) return;
  const button = target?.closest?.("button");
  if (!button || (button.type === "submit" && button.form !== null)) return;
  const partial = button.getAttribute(PARTIAL_ATTR);
  if (partial === null || !clientNavEnabled(button)) return;
  const url = new URL(partial, location.href);
  if (!sameOrigin(url)) return;
  void fetchPartials({ url, partial: url, navigate: false, transition: viewTransitionFor(button) });
}

/** A form submission a partial request takes: its method, partial URL and action URL. */
interface FormTarget {
  method: "get" | "post";
  partial: URL;
  url: URL;
}

/**
 * Where a client-nav form submits as a partial request, as Fresh decides it: only a form (or
 * submitter) naming a target (`f-partial`, `action`, `formaction`), by GET or POST. Null: the
 * browser submits it.
 */
function formTarget(form: HTMLFormElement, submitter: HTMLElement | null): FormTarget | null {
  if (![form, submitter].every((el) => el === null || clientNavEnabled(el))) return null;
  const attr = (name: string) => submitter?.getAttribute(name) ?? null;
  const method = (attr("formmethod") ?? form.method).toLowerCase();
  const raw = [
    attr(PARTIAL_ATTR),
    attr("formaction"),
    form.getAttribute(PARTIAL_ATTR),
    form.getAttribute("action"),
  ].find((v) => v !== null);
  if (!FORM_METHODS.has(method) || !raw) return null;
  const url = new URL(attr("formaction") ?? form.action, location.href);
  const partial = new URL(raw, location.href);
  if (!sameOrigin(partial) || !sameOrigin(url)) return null;
  return { method: method as FormTarget["method"], partial, url };
}

/** The methods a partial form request takes (others submit as the browser does). */
const FORM_METHODS = new Set(["get", "post"]);

/** A form in a client-nav subtree with an explicit target: submit it as a partial request. */
function onSubmit(e: SubmitEvent): void {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || e.defaultPrevented) return;
  const submitter = e.submitter;
  const target = formTarget(form, submitter);
  if (!target) return;
  e.preventDefault();
  const { method, partial, url } = target;
  const data = new FormData(form, submitter);
  const transition = viewTransitionFor(submitter) || viewTransitionFor(form);
  if (method === "post") {
    const init = { method: "post", body: data };
    void fetchPartials({ url, partial, navigate: true, replace: true, init, transition });
    return;
  }
  for (const [k, v] of data) if (typeof v === "string") partial.searchParams.append(k, v);
  void fetchPartials({ url, partial, navigate: true, replace: true, transition });
}

let installed = false;

/** Install the document listeners (once, in the browser, when a region first mounts). */
function installPartialNavigation(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  setSoftNavBlocker(partialLinkBlocker);
  installPopClaim();
  // Any other navigation (the router's own) moves to an entry this did not mark, or re-marks it.
  subscribeLocation(() => {
    if (entryOf(history.state) !== currentEntry) currentEntry = entryOf(history.state);
  });
}
