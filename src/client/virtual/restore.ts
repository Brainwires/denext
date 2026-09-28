/**
 * Scroll restoration for `VirtualList` (`restoreKey`): the view is saved as the anchor row's
 * key, its distance from the viewport and the sizes of the rows around it — not a pixel
 * offset, which is meaningless once rows above were re-estimated — and restored when the list
 * mounts again for the same history entry: back / forward navigation (soft, through denext's
 * router, or a hard reload / bfcache-less back), and a remount inside the same page.
 *
 * - The history entry is identified by an id stored in `history.state` (merged into whatever
 *   the router keeps there). A new navigation pushes a fresh entry with no id, so a list opened
 *   by a link starts at its top (or its `initialScrollIndex`), as a browser does.
 * - Snapshots live in `sessionStorage` under `denext:vl:<entry>:<restoreKey>`; every access is
 *   guarded (private mode, blocked storage, the server).
 *
 * @module
 */

/** A saved view. */
export interface RestoreSnapshot {
  /** The anchor row's key (stringified; numeric keys compare as strings). */
  readonly key: string;
  /** Its index when saved (a search hint). */
  readonly index: number;
  /** Px from the viewport's leading edge to the anchor row's leading edge. */
  readonly gap: number;
  /** Measured sizes of rows around the anchor: `[key, px]`. */
  readonly sizes: readonly (readonly [string, number])[];
  /** Whether the view was at the end (a chat list re-pins). */
  readonly atEnd: boolean;
  /**
   * An automatic (dev) snapshot's stamp: when it was saved (epoch ms) and by which document.
   * Absent for a `restoreKey` snapshot. See `dev-restore.ts`.
   */
  readonly dev?: { readonly at: number; readonly doc: string };
}

/** The field of `history.state` holding the entry id. */
const STATE_FIELD = "__denextVL";

/** The storage key prefix. */
const PREFIX = "denext:vl:";

/** The most snapshots kept per session (oldest dropped). */
const MAX_SNAPSHOTS = 50;

/** `sessionStorage`, or `undefined` where it is missing or throws. */
function storage(): Storage | undefined {
  try {
    const s = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return s && typeof s.getItem === "function" ? s : undefined;
  } catch {
    return undefined;
  }
}

/** The history object, or `undefined` off the browser. */
function hist(): History | undefined {
  const h = (globalThis as { history?: History }).history;
  return h && typeof h.replaceState === "function" ? h : undefined;
}

/**
 * The current history entry's id, created (and stored in `history.state`) on first use.
 * `undefined` without history.
 */
export function historyEntryId(): string | undefined {
  const h = hist();
  if (!h) return undefined;
  try {
    const state = h.state as Record<string, unknown> | null;
    const have = state && typeof state === "object" ? state[STATE_FIELD] : undefined;
    if (typeof have === "string") return have;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const next = state && typeof state === "object" ? { ...state, [STATE_FIELD]: id } : {
      [STATE_FIELD]: id,
    };
    h.replaceState(next, "");
    return id;
  } catch {
    return undefined;
  }
}

/** The storage key of a list's snapshot in an entry. */
function slot(entry: string, restoreKey: string): string {
  return `${PREFIX}${entry}:${restoreKey}`;
}

/** Save a snapshot (best effort). */
export function saveSnapshot(entry: string, restoreKey: string, snap: RestoreSnapshot): void {
  const s = storage();
  if (!s) return;
  try {
    const key = slot(entry, restoreKey);
    s.setItem(key, JSON.stringify(snap));
    const index = JSON.parse(s.getItem(`${PREFIX}index`) ?? "[]") as string[];
    const next = [...index.filter((k) => k !== key), key];
    while (next.length > MAX_SNAPSHOTS) s.removeItem(next.shift()!);
    s.setItem(`${PREFIX}index`, JSON.stringify(next));
  } catch { /* storage full or blocked */ }
}

/** Load a snapshot, or `undefined`. */
export function loadSnapshot(entry: string, restoreKey: string): RestoreSnapshot | undefined {
  const s = storage();
  if (!s) return undefined;
  try {
    const raw = s.getItem(slot(entry, restoreKey));
    if (!raw) return undefined;
    const snap = JSON.parse(raw) as RestoreSnapshot;
    return typeof snap?.key === "string" && typeof snap.gap === "number" ? snap : undefined;
  } catch {
    return undefined;
  }
}
