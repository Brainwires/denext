/**
 * Dev-only scroll restoration for a list WITHOUT `restoreKey`: what keeps a `VirtualList`
 * on the row you were looking at when a dev edit remounts it or reloads the page.
 *
 * Fast Refresh reconciles an edited component onto its live fiber, so an ordinary edit never
 * remounts the list. Some edits still do: a hook-signature change (the refresh runtime falls
 * back to a full reload), a structural edit the dev server answers with a reload, and a
 * whole-entry refresh on the bundled dev paths, where a component the refresh cannot match
 * remounts its subtree. The list then saves its view (anchor row, gap, sizes around it; the
 * same snapshot as `restoreKey`) on unmount / `pagehide` under its position in the document,
 * and restores it when it mounts again — but only when that remount is one of those:
 *
 * - **A hot update:** the snapshot was saved by this document within
 *   {@linkcode HMR_WINDOW_MS} after the HMR client applied an update (`__denextHmrAt`, set by
 *   the dev reload scripts).
 * - **A reload:** the page was reloaded and the snapshot was saved by the previous document.
 *
 * Any other remount (a key change, a navigation, back / forward) starts where production
 * would. Nothing here runs outside dev (`__denextDev`).
 *
 * @module
 */

import type { RestoreSnapshot } from "./restore.ts";

/** How long after the HMR client applies an update a remount counts as caused by it (ms). */
const HMR_WINDOW_MS = 10_000;

/** The slot prefix of an automatic (dev) snapshot, apart from a `restoreKey`'s. */
const DEV_PREFIX = "dev:";

/** The dev globals read here. */
interface DevGlobals {
  __denextDev?: boolean;
  /** When the HMR client last applied an update (epoch ms). */
  __denextHmrAt?: number;
  /** This document's id (a reload is a new document, so a new id). */
  __denextVLDoc?: string;
}

/** Whether automatic restoration applies: a dev page (the dev server sets `__denextDev`). */
export function devRestoreEnabled(): boolean {
  return (globalThis as DevGlobals).__denextDev === true;
}

/** This document's id, created on first use. */
function documentId(): string {
  const g = globalThis as DevGlobals;
  return g.__denextVLDoc ??= `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A node's parent, when it is an element (not the document, not detached). */
function parentOf(el: Element): Element | undefined {
  const parent = el.parentNode as (Element & { nodeType?: number }) | null;
  return parent && parent.nodeType !== 9 && parent.children ? parent : undefined;
}

/**
 * The list's position in the document — each ancestor's tag and index among its parent's
 * elements, up to `<body>` (or the top of a detached tree) — as its automatic snapshot slot.
 * Stable across a remount and a reload that leave the markup above the list alone.
 */
export function devRestoreKey(el: Element | null | undefined): string | undefined {
  if (!el) return undefined;
  const body = (globalThis as { document?: Document }).document?.body;
  const parts: string[] = [];
  let node: Element = el;
  for (let parent = parentOf(node); parent; parent = parentOf(node)) {
    const index = Array.prototype.indexOf.call(parent.children, node);
    parts.push(`${node.tagName.toLowerCase()}${index}`);
    if (parent === body) break;
    node = parent;
  }
  return DEV_PREFIX + parts.reverse().join("/");
}

/** How the current document was loaded (`"reload"`, `"navigate"`, …), when known. */
function navigationType(): string | undefined {
  try {
    const perf = (globalThis as { performance?: Performance }).performance;
    const entry = perf?.getEntriesByType?.("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type;
  } catch {
    return undefined;
  }
}

/** The stamp saved with an automatic snapshot. */
export function devStamp(): NonNullable<RestoreSnapshot["dev"]> {
  return { at: Date.now(), doc: documentId() };
}

/** Whether an automatic snapshot applies to this mount (a hot update's remount, or a reload). */
export function devSnapshotApplies(snap: RestoreSnapshot, now = Date.now()): boolean {
  const stamp = snap.dev;
  if (!stamp) return false;
  if (stamp.doc !== documentId()) return navigationType() === "reload";
  const hmrAt = (globalThis as DevGlobals).__denextHmrAt;
  return typeof hmrAt === "number" && stamp.at >= hmrAt && stamp.at - hmrAt <= HMR_WINDOW_MS &&
    now - stamp.at <= HMR_WINDOW_MS;
}
