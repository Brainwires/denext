// The soft-navigation commit: the view-transition wrapper, history, scroll and data-island writes
// every navigation shares, and the document paths — an isomorphic route's compact JSON payload
// and a full-HTML page, both of which re-run the incoming route's client entry (it reconciles the
// retained root in place).
//
// Kept OFF the shared runtime chunk: navigation.ts imports this module dynamically, once a
// navigation (or a prefetch) gets a response that is not a Flight payload, and the Flight
// soft-nav runtime (flight-nav.ts, which only the Flight entry reaches) imports it statically —
// so an app's first page carries none of it until it navigates.

import type { HydrationData, IsoNavPayload } from "../server/document.ts";
// ROOT_ID comes from its own leaf module — importing it from document.ts would drag
// document.ts's server-only deps (which import node:async_hooks) into the client bundle
// and break it under the strict CSP.
import { ROOT_ID } from "../server/root-id.ts";
import { getViewTransitionSupport, takeTransitionTypes } from "./fiber/view-transition-support.ts";
import {
  globalWin,
  type NavigateOptions,
  nextNavStamp,
  resumabilityReboot,
  retainedRoot,
  retainRoot,
  rootlessPrepare,
} from "./nav-state.ts";

/**
 * Apply a full-HTML soft nav: swap the hydration data + Flight island, sync the title,
 * update history, and re-run the route's client bundle to hydrate the swapped markup. `emit`
 * publishes the new location to the route hooks (navigation.ts's location store).
 * Reconcile-in-place: when a retained root exists the re-run route bundle calls
 * startClient → root.render(newTree), which diffs the old tree into the new one and
 * patches the DOM — preserving state in unaffected subtrees. Only when there is no retained
 * root (defensive) is the markup blown away and re-mounted.
 */
export function applyHtmlNav(
  body: string,
  url: URL,
  href: string,
  options: NavigateOptions,
  emit: () => void,
): void {
  const parsed = new DOMParser().parseFromString(body, "text/html");
  const newRoot = parsed.getElementById(ROOT_ID);
  const container = document.getElementById(ROOT_ID);
  if (!newRoot || !container) {
    location.href = href;
    return;
  }
  updateHistory(url, options); // so the bundle sees the correct URL (non-visual — outside the transition)
  const entrySrc = parsedEntrySrc(parsed);
  // Everything that changes the visible DOM runs inside the view transition, and we await the
  // re-injected entry so the reconcile lands before the browser's new-state capture.
  withViewTransition(async () => {
    syncTitle(parsed);
    syncScript(parsed, "__denext_data");
    // Flight island: sync it too so a soft-nav to a Flight route hydrates from the new
    // payload (and a nav to an isomorphic route clears a stale one).
    // The re-run entry also reads the incoming page's lazy islands + signal state, not ours.
    for (const id of ["__denext_flight", "__denext_islands", "__denext_state"]) {
      syncScript(parsed, id);
    }
    // A retained root only reconciles in place when the incoming page re-runs a client
    // entry (→ `startClient` → `root.render`). A STATIC target ships no entry, and a
    // root-less islands target (its Flight island is `null`) hydrates only its islands, so
    // nothing would ever render it: drop the root (its tree unmounts) and swap the markup in,
    // or the URL would change while the old page stayed on screen.
    const rootless = parsed.getElementById("__denext_flight")?.textContent === "null";
    if (retainedRoot && (!entrySrc || rootless)) discardRetainedRoot();
    swapRootHtml(container, newRoot);
    emit();
    scrollAfterNav(url, options);
    if (entrySrc) await injectRouteEntry(entrySrc, url);
    // Unmount the islands whose wrapper the swap or the re-run entry's reconcile removed.
    resumabilityReboot?.([]);
  });
}

/** Unmount and forget the retained root (the next `startClient` hydrates fresh). */
export function discardRetainedRoot(): void {
  const root = retainedRoot ?? globalWin.__dnxRoot;
  retainRoot(null);
  try {
    root?.unmount();
  } catch { /* a torn-down tree is the goal either way */ }
}

/** The incoming document's route entry module (its hydration bundle), if it has one. */
function parsedEntrySrc(parsed: Document): string | null {
  return parsed.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute(
    "src",
  ) ??
    null;
}

/** Adopt the new document's `<title>` (when it has one). */
function syncTitle(parsed: Document): void {
  const newTitle = parsed.querySelector("title");
  if (newTitle) document.title = newTitle.textContent ?? "";
}

/** Replace the root's markup — unless a retained root reconciles it in place. */
function swapRootHtml(container: Element, newRoot: Element): void {
  if (!retainedRoot) container.innerHTML = newRoot.innerHTML;
}

/**
 * Copy the incoming page's JSON island (`#<id>`) into the live document. When the
 * incoming page has no such island, remove any stale live copy so it does not
 * leak into the next hydration.
 */
function syncScript(parsed: Document, id: string): void {
  const incoming = parsed.getElementById(id);
  if (!incoming) {
    document.getElementById(id)?.remove();
    return;
  }
  jsonIsland(id).textContent = incoming.textContent;
}

/**
 * Re-inject a route's client entry module (cache-busted per nav so it re-evaluates),
 * which re-runs the route → `startClient` → `retainedRoot.render` reconciles in place.
 * The injected `<script>` removes itself after running so they don't pile up. Resolves when
 * the module has evaluated (its synchronous `main()` has rendered) — so a caller can run the
 * DOM swap inside a view transition and await the reconcile before the new-state capture.
 */
function injectRouteEntry(entrySrc: string, url: URL): Promise<void> {
  return new Promise<void>((resolve) => {
    const src = new URL(entrySrc, url.href);
    src.searchParams.set("nav", nextNavStamp());
    const script = document.createElement("script");
    script.type = "module";
    script.src = src.href;
    let settled = false;
    // Resolve on load/error, but also on a timeout: this promise is awaited INSIDE a view
    // transition's update callback, so a stalled entry chunk (or a nested dynamic import whose
    // failure never surfaces as the script's `error`) would otherwise hang the reconcile until
    // the browser's own ~4 s transition timeout. Cap it so the commit lands promptly.
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.remove();
      resolve();
    };
    const timer = setTimeout(cleanup, 4000);
    script.addEventListener("load", cleanup, { once: true });
    script.addEventListener("error", cleanup, { once: true });
    document.body.appendChild(script);
  });
}

/**
 * Apply an isomorphic soft-navigation payload (title/data/entry/styles): a route with
 * a client entry but no Flight boundary re-renders from its re-run bundle, so the SSR
 * body is not needed — this updates history, title, the `#__denext_data` island, and
 * the route's stylesheets, then re-injects the entry (which reconciles the DOM in
 * place). No HTML parse, and the discarded body is never sent over the wire. `emit` publishes
 * the new location to the route hooks.
 */
export function applyIsoNav(
  body: string,
  url: URL,
  href: string,
  options: NavigateOptions,
  emit: () => void,
): void {
  let payload: IsoNavPayload;
  try {
    payload = JSON.parse(body) as IsoNavPayload;
  } catch {
    location.href = href; // malformed payload: hard navigate rather than get stuck
    return;
  }
  updateHistory(url, options); // non-visual — outside the transition
  withViewTransition(async () => {
    if (payload.title != null) document.title = payload.title;
    writeDataIsland(payload.data);
    // The re-run entry adopts the new route's signal state (and none of the old route's).
    jsonIsland("__denext_state").textContent = JSON.stringify(payload.signalState ?? null);
    swapRouteStyles(payload.styles);
    emit();
    scrollAfterNav(url, options);
    // A root-less islands page has no root for the entry to render into: give it a fresh one
    // (its islands are unmounted first).
    rootlessPrepare?.();
    await injectRouteEntry(payload.entry, url); // resolves once the re-run entry has reconciled
    // The new route has no islands: unmount the ones whose wrapper the reconcile removed.
    resumabilityReboot?.([]);
  });
}

/**
 * Swap the per-route stylesheets (`link[data-dnx-css]`) to the new route's set:
 * drop the ones it no longer wants, keep the ones it still does, and add the new
 * ones. Global stylesheets (unmarked) are left untouched.
 */
function swapRouteStyles(hrefs: string[] | undefined): void {
  const want = new Map<string, boolean>(); // absolute href → already present
  for (const h of hrefs ?? []) want.set(new URL(h, location.href).href, false);
  document.querySelectorAll("link[data-dnx-css]").forEach((el) => {
    const link = el as HTMLLinkElement;
    if (want.has(link.href)) want.set(link.href, true);
    else link.remove();
  });
  for (const [href, present] of want) {
    if (present) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-dnx-css", "");
    document.head.appendChild(link);
  }
}

/** Surface a soft navigation's failed DOM swap (one copy of the message for both paths below). */
function reportNavFailure(err: unknown): void {
  console.error("denext: soft navigation failed", err);
}

/**
 * Run a soft-nav DOM commit inside a View Transition when the browser supports it
 * (Chromium today), so the route swap cross-fades; where unsupported it runs exactly as
 * before. Feature-detected — no effect and no cost where the API is absent, and the browser
 * honors `prefers-reduced-motion` itself.
 *
 * When the app uses `<ViewTransition>`, the marking runtime (import-gated, via the seam)
 * stamps `view-transition-name` on the wrapper's host child on BOTH sides of the swap — the
 * OUTGOING tree before `startViewTransition` (so the browser's old-state capture sees it) and
 * the INCOMING tree inside the callback after the commit — so a shared `name` morphs between
 * routes, then clears when the transition finishes. Buffered `addTransitionType` types drive
 * `startViewTransition({ types })`. The `commit` may be async (the isomorphic/HTML paths await
 * a re-injected entry before the DOM settles); all its DOM work happens inside the callback,
 * so the transition captures the real before/after. Exported for testing.
 */
export function withViewTransition(commit: () => void): void {
  const doc = document as Document & {
    startViewTransition?: (
      cb: (() => void | Promise<void>) | { update: () => void | Promise<void>; types?: string[] },
    ) =>
      | { ready?: Promise<void>; finished?: Promise<void>; updateCallbackDone?: Promise<void> }
      | undefined;
  };
  if (typeof doc.startViewTransition !== "function") {
    // `commit` is often an async callback (typed `() => void` via void-bivalence); without a
    // transition to carry its rejection, surface a DOM-swap failure instead of letting it become
    // an unhandled promise rejection (a nav that "hangs").
    Promise.resolve((commit as () => unknown)()).catch(reportNavFailure);
    return;
  }
  const vt = getViewTransitionSupport();
  const types = takeTransitionTypes();
  // Stamp the outgoing hosts BEFORE startViewTransition so the old-state capture includes their
  // names (the capture happens after this synchronous task, before the callback runs). `begin`
  // scopes this transition's stamped elements + types, so overlapping navigations don't clash.
  const tx = vt ? vt.begin(types) : null;
  const update = async () => {
    await commit();
    tx?.markIncoming(); // new hosts, before the browser's new-state capture
  };
  // A skipped/aborted transition (another started, tab hidden) is not an error: `ready`
  // rejects with InvalidStateError and `finished` may too. The `{ update, types }` object
  // form is only understood where transition types exist; fall back to the callback form.
  let transition:
    | { ready?: Promise<void>; finished?: Promise<void>; updateCallbackDone?: Promise<void> }
    | undefined;
  try {
    transition = types.length > 0
      ? doc.startViewTransition({ update, types })
      : doc.startViewTransition(update);
  } catch {
    transition = doc.startViewTransition(update);
  }
  // A skipped/aborted transition is not an error; the `<ViewTransition>` callbacks run either way.
  const ready = () => tx?.ready();
  transition?.ready?.then(ready, ready);
  // `updateCallbackDone` rejects ONLY when `commit` itself threw (distinct from an abort, which
  // rejects `ready`/`finished`) — surface that real DOM-swap failure instead of swallowing it.
  transition?.updateCallbackDone?.catch(reportNavFailure);
  const done = () => tx?.clear();
  (transition?.finished ?? Promise.resolve()).then(done, done);
}

/**
 * Scroll for the new page unless the navigation opted out: to the element the URL's
 * `#fragment` names (what a hard load does), else to the top.
 */
export function scrollAfterNav(url: URL, options: NavigateOptions): void {
  if (options.scroll === false) return;
  const hash = url.hash.slice(1);
  if (hash) {
    let id = hash;
    try {
      id = decodeURIComponent(hash);
    } catch { /* keep the raw fragment */ }
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView?.();
      return;
    }
  }
  globalThis.scrollTo?.(0, 0);
}

/**
 * Update history for a soft nav: push (default), replace (`options.replace`), or
 * leave untouched (`options.history === false`, i.e. popstate — the browser already
 * changed the URL). Shared by the HTML, Flight, and isomorphic nav paths.
 */
export function updateHistory(url: URL, options: NavigateOptions): void {
  if (options.history === false) return;
  if (options.replace) history.replaceState({}, "", url.href);
  else history.pushState({}, "", url.href);
}

/** Write the `#__denext_data` island from a hydration-data object (Flight nav). */
export function writeDataIsland(data: HydrationData): void {
  jsonIsland("__denext_data").textContent = JSON.stringify(data);
}

/** The live document's JSON island `#<id>`, created (empty, at the end of `<body>`) if absent. */
function jsonIsland(id: string): HTMLElement {
  let live = document.getElementById(id);
  if (!live) {
    live = document.createElement("script");
    live.id = id;
    (live as HTMLScriptElement).type = "application/json";
    document.body.appendChild(live);
  }
  return live;
}
