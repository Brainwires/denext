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
 * @module
 */

import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { useEffect, useRef, useState } from "../../runtime/hooks.ts";
import { emit, navigate, setSoftNavBlocker } from "../../client/navigation.ts";
import { flightParser } from "../../client/flight-nav.ts";
import { CLIENT_NAV_ATTR, PARTIAL_ATTR, PARTIAL_SEARCH_PARAM } from "./constants.ts";

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
  useEffect(() => {
    installPartialNavigation();
    const region: ActiveRegion = {
      apply: (mode, children, key) =>
        setState((prev) => merged(prev, latest.current.children, mode, children, key)),
    };
    ACTIVE.set(props.name, region);
    return () => {
      if (ACTIVE.get(props.name) === region) ACTIVE.delete(props.name);
    };
  }, [props.name]);
  const chunks = state && state.base === props.children
    ? state.chunks
    : [{ key: "", children: props.children }];
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

/** The outermost `<Partial>` elements of a parsed tree, in document order. */
function collectPartials(node: unknown, out: FoundPartial[]): FoundPartial[] {
  if (Array.isArray(node)) {
    for (const child of node) collectPartials(child, out);
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
    } else {
      collectPartials(props.children, out);
    }
  }
  return out;
}

/**
 * Apply the partials of a partial request's answer to the mounted regions.
 *
 * @param res The answer (denext's Flight navigation payload).
 * @returns How many partials the answer held (0: not a payload this can apply).
 */
async function applyPartials(res: Response): Promise<number> {
  const parse = flightParser;
  if (!parse || res.headers.get("x-denext-flight") !== "1") return 0;
  const payload = JSON.parse(await res.text()) as { flight: unknown; title?: string | null };
  const found = applyPartialTree(await parse(payload.flight));
  if (found > 0 && payload.title) document.title = payload.title;
  return found;
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
  for (const p of found) {
    const region = ACTIVE.get(p.name);
    if (region) region.apply(p.mode, p.children, p.key);
    else console.warn(`denext/fresh: partial "${p.name}" is not on this page; skipped`);
  }
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
}

/**
 * Fetch a partial request and apply its partials. An answer with no partials follows the redirect
 * it took, else navigates the whole page instead (a link or a GET form), as a full load would.
 */
async function fetchPartials(req: PartialRequest): Promise<void> {
  const partial = new URL(req.partial);
  partial.searchParams.set(PARTIAL_SEARCH_PARAM, "true");
  const res = await fetch(partial, { ...req.init, headers: { "x-denext-nav": "1" } });
  const url = landedUrl(req.url, res);
  if (await applyPartials(res) > 0) return pushNavigation(req, url);
  if (res.redirected) location.href = url.href;
  else if (req.navigate && req.init?.method !== "post") await navigate(url.href);
  else throw new Error(`denext/fresh: no <Partial> in the answer from ${partial.pathname}`);
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

/** A navigation's history entry (a new URL only) and the location hooks' update. */
function pushNavigation(req: PartialRequest, url: URL): void {
  if (!req.navigate) return;
  if (url.href === location.href) return emit();
  if (req.replace) history.replaceState({}, "", url.href);
  else history.pushState({}, "", url.href);
  emit();
}

/** The link a click inside a client-nav subtree claimed, until denext's navigation asks. */
let claimed: { href: string; partial: string | null } | null = null;

/**
 * A click on a same-origin link in a client-nav subtree: claim it. denext's own link handling
 * runs next (after the page's handlers, which may still cancel it) and asks the soft-nav blocker
 * before it navigates; the blocker answers the claimed link with a partial navigation instead.
 */
function onClickCapture(e: MouseEvent): void {
  const a = (e.target as Element | null)?.closest?.("a");
  const raw = a?.getAttribute("href");
  if (!a || raw == null || raw.startsWith("#") || !clientNavEnabled(a)) return;
  claimed = { href: a.href, partial: a.getAttribute(PARTIAL_ATTR) };
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
  void fetchPartials({ url, partial, navigate: true })
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
  void fetchPartials({ url, partial: url, navigate: false });
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
  if (method === "post") {
    const init = { method: "post", body: data };
    void fetchPartials({ url, partial, navigate: true, replace: true, init });
    return;
  }
  for (const [k, v] of data) if (typeof v === "string") partial.searchParams.append(k, v);
  void fetchPartials({ url, partial, navigate: true, replace: true });
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
}
