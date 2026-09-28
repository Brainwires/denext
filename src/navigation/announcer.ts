/**
 * The route announcer of `denext/navigation`: when a stack pushes or pops, or a tab bar switches
 * tabs, screen reader users hear the new screen's title, the way VoiceOver and TalkBack announce
 * a native screen change. One visually hidden `aria-live="assertive"` region per page (like
 * Next.js's route announcer), created on the first announcement. The title is the screen's
 * `title` option, else the document's title once the navigation has settled.
 *
 * `StackView` / `StackLayout`, `TabsView` / `TabsLayout`, and React Native mode's React
 * Navigation and Expo Router navigators (drawn by them) all announce; `announceRouteChanges:
 * false` on a view turns it off there.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";

/** The region's id (one per page). */
const REGION_ID = "dnx-route-announcer";
/** How long to wait for the new page's title and a quiet moment for the screen reader. */
const DELAY_MS = 100;

/** A visually hidden region's style. */
const HIDDEN =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;" +
  "clip:rect(0 0 0 0);white-space:nowrap";

/** The page's document, when there is one. */
function doc(): Document | undefined {
  return (globalThis as { document?: Document }).document;
}

/** The region this page made, and its document. */
let made: { doc: Document; el: HTMLElement } | null = null;

/** The live region, created on demand (one per document). */
function region(d: Document): HTMLElement | null {
  if (made?.doc === d) return made.el;
  let el = d.getElementById?.(REGION_ID) ?? null;
  if (el) return (made = { doc: d, el }).el;
  if (!d.body || typeof d.createElement !== "function") return null;
  el = d.createElement("div");
  el.id = REGION_ID;
  el.setAttribute("aria-live", "assertive");
  el.setAttribute("aria-atomic", "true");
  el.setAttribute("data-dnx-route-announcer", "");
  el.setAttribute("style", HIDDEN);
  d.body.appendChild(el);
  made = { doc: d, el };
  return el;
}

/**
 * Announce `message` to screen readers now (the same text twice in a row is announced twice).
 * Nothing happens without a document or with an empty message.
 *
 * @param message What to say (a screen's title).
 */
export function announceRoute(message: string): void {
  const d = doc();
  const text = message.trim();
  if (!d || text === "") return;
  const el = region(d);
  if (!el) return;
  if (el.textContent === text) {
    el.textContent = "";
    setTimeout(() => (el.textContent = text), DELAY_MS);
  } else {
    el.textContent = text;
  }
}

/**
 * Hook: announce the screen whenever `key` changes after the first render (the first screen
 * is the page the screen reader is already reading). `title` wins; without one the document's
 * title is read a moment later, once the navigation has set it.
 *
 * @param key What identifies the shown screen (a stack's top entry, the active tab).
 * @param title The screen's title, when known.
 * @param enabled Whether to announce.
 */
export function useRouteAnnouncer(key: string, title: string | undefined, enabled = true): void {
  const last = useRef<string | null>(null);
  // Read when the timer fires: a title that arrives a render after the key still counts.
  const latest = useRef({ title, enabled });
  latest.current = { title, enabled };
  useEffect(() => {
    const previous = last.current;
    last.current = key;
    if (previous === null || previous === key) return;
    const timer = setTimeout(() => {
      const now = latest.current;
      if (now.enabled) announceRoute(now.title ?? doc()?.title ?? "");
    }, DELAY_MS);
    return () => clearTimeout(timer);
  }, [key]);
}
