/**
 * Where the app's keyed windows keep their frames between launches: one JSON file in the app
 * support folder (`windows.json`) with the last bounds of each key and the keyed windows that were
 * open at the last exit (`DesktopWindows.lastSession`, `desktop.app.restoreWindows`).
 *
 * A key is app-chosen (`windows.open({ key })`, or a page's `openWindow({ key })`), so it is
 * checked before it is used ({@linkcode windowKeyProblem}: a short name, no path characters) and
 * every key lives in the one file — never a file per key. The store never throws: a missing or
 * corrupt file is the defaults (a corrupt one with a warning), and a write that fails (no
 * `--allow-write` for the folder) is reported once and the frames stay in memory.
 *
 * What is restored is the frame — bounds and the display they are on, clamped onto a display that
 * is connected now ({@linkcode clampToScreens}). macOS Spaces (which Space a window was on) are not
 * reported by the runtime and are not restored.
 *
 * Runtime-only (imported by the window registry, never a client bundle).
 *
 * @module
 */

import { dirname, join } from "@std/path";
import type { DesktopRect, DesktopScreen } from "./launch-events.ts";
import { isAppPath } from "./tray-config.ts";

/** The store's file name in the app support folder. */
export const WINDOW_STORE_FILE = "windows.json";
/** The most keys the store keeps bounds for (the least recently saved go first). */
const MAX_KEYS = 256;
/** How long after the last move / resize the frames are written. */
const WINDOW_STORE_DEBOUNCE_MS = 500;
/** The least of a window that must be on a display for its frame to count as visible. */
const VISIBLE_PX = 64;
/** A key: a short name of letters, digits, `.`, `_`, `:` and `-`. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** A keyed window that was open at the last exit ({@linkcode WindowStore.lastSession}). */
export interface SessionWindow {
  /** Its key. */
  readonly key: string;
  /** The app path it showed (as opened, or last navigated to through the windows API). */
  readonly url: string;
  /** Its last saved bounds, if any. */
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** What {@linkcode openWindowStore} returns. */
export interface WindowStore {
  /** The last saved bounds of `key`, or `undefined`. */
  bounds(key: string): DesktopRect | undefined;
  /** Remember `key`'s bounds (written after a short delay; `flush` writes now). */
  setBounds(key: string, bounds: DesktopRect): void;
  /** The keyed windows open at the last exit, as the file had them when the app started. */
  lastSession(): readonly SessionWindow[];
  /** Set the keyed windows open now (written after a short delay; `flush` writes now). */
  setSession(session: readonly { readonly key: string; readonly url: string }[]): void;
  /** Write what changed now (a no-op when nothing did). */
  flush(): void;
}

/** Options for {@linkcode openWindowStore}. */
export interface WindowStoreOptions {
  /** Where warnings go. */
  readonly warn: (message: string) => void;
  /** The write delay after a change (default 500 ms). */
  readonly debounceMs?: number;
  /** Read the file (tests; default `Deno.readTextFileSync`). */
  readonly read?: (path: string) => string;
  /** Write the file atomically (tests; default a temp file + rename). */
  readonly write?: (path: string, text: string) => void;
}

/**
 * Why `key` is not a window key, or `null` when it is one: a string of 1 to 64 letters, digits,
 * `.`, `_`, `:` or `-`, starting with a letter or digit — never a path separator, since the key
 * names an entry in the app's support folder's store.
 *
 * @param key The key to check.
 * @returns The problem, or `null`.
 */
export function windowKeyProblem(key: unknown): string | null {
  if (typeof key !== "string") return "key must be a string";
  if (!KEY_PATTERN.test(key)) {
    return "key must be 1 to 64 letters, digits, '.', '_', ':' or '-', starting with a letter or digit";
  }
  return null;
}

/** A finite integer-ish number within [min, max]. */
function numberIn(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return undefined;
  }
  return Math.round(value);
}

/** A stored rectangle, checked (sizes at least 1), or `undefined`. */
function rectOf(value: unknown): DesktopRect | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const x = numberIn(r.x, -1e5, 1e5);
  const y = numberIn(r.y, -1e5, 1e5);
  const width = numberIn(r.width, 1, 10000);
  const height = numberIn(r.height, 1, 10000);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

/** The file's shape once checked. */
interface StoreData {
  readonly bounds: Map<string, DesktopRect>;
  readonly session: SessionWindow[];
}

/** The file's `bounds` object as a map: every entry checked, the bad ones dropped. */
function boundsOf(raw: unknown): Map<string, DesktopRect> {
  const bounds = new Map<string, DesktopRect>();
  if (typeof raw !== "object" || raw === null) return bounds;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rect = rectOf(value);
    if (windowKeyProblem(key) === null && rect) bounds.set(key, rect);
  }
  return bounds;
}

/** The file's `session` list, checked (a key once, an app path), with each key's bounds. */
function sessionOf(raw: unknown, bounds: Map<string, DesktopRect>): SessionWindow[] {
  const session: SessionWindow[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const e = (entry ?? {}) as { key?: unknown; url?: unknown };
    if (windowKeyProblem(e.key) !== null || !isAppPath(e.url) || seen.has(e.key as string)) {
      continue;
    }
    seen.add(e.key as string);
    const saved = bounds.get(e.key as string);
    session.push({ key: e.key as string, url: e.url, ...(saved ? { bounds: saved } : {}) });
  }
  return session;
}

/** Parse the file's text: every entry checked, the bad ones dropped; a throw for no JSON object. */
function parse(text: string): StoreData {
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("not an object");
  }
  const o = raw as { bounds?: unknown; session?: unknown };
  const bounds = boundsOf(o.bounds);
  return { bounds, session: sessionOf(o.session, bounds) };
}

/** Read and check the file; the defaults when it is missing, a warning too when it is corrupt. */
function load(path: string, read: (path: string) => string, warn: (m: string) => void): StoreData {
  let text: string;
  try {
    text = read(path);
  } catch {
    return { bounds: new Map(), session: [] }; // missing (or unreadable): the defaults
  }
  try {
    return parse(text);
  } catch (err) {
    warn(
      `the window store is corrupt and was reset: ${err instanceof Error ? err.message : err}`,
    );
    return { bounds: new Map(), session: [] };
  }
}

/** Write `text` to `path` atomically: a temp file beside it, then a rename. */
function writeAtomic(path: string, text: string): void {
  try {
    Deno.mkdirSync(dirname(path), { recursive: true });
  } catch { /* exists, or the write below says why */ }
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  Deno.writeTextFileSync(tmp, text);
  try {
    Deno.renameSync(tmp, path);
  } catch (err) {
    try {
      Deno.removeSync(tmp);
    } catch { /* already gone */ }
    throw err;
  }
}

/**
 * Open the store at `dir/windows.json` (read once, now). With no `dir` (no app support folder: a
 * sidecar's child, a test) the frames live in memory for this launch only.
 *
 * @param dir The app support folder, or `undefined` for a memory-only store.
 * @param options Where warnings go, the write delay, and the file access (tests).
 * @returns The store.
 */
export function openWindowStore(
  dir: string | undefined,
  options: WindowStoreOptions,
): WindowStore {
  const path = dir === undefined ? undefined : join(dir, WINDOW_STORE_FILE);
  const read = options.read ?? ((p: string) => Deno.readTextFileSync(p));
  const write = options.write ?? writeAtomic;
  const loaded = path === undefined
    ? { bounds: new Map<string, DesktopRect>(), session: [] as SessionWindow[] }
    : load(path, read, options.warn);
  const bounds = loaded.bounds;
  let session: { key: string; url: string }[] = loaded.session.map(({ key, url }) => ({
    key,
    url,
  }));
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writeFailed = false;

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty || path === undefined) return;
    dirty = false;
    const text = JSON.stringify(
      { version: 1, bounds: Object.fromEntries(bounds), session },
      null,
      2,
    );
    try {
      write(path, text);
    } catch (err) {
      dirty = true; // the next flush tries again
      if (writeFailed) return;
      writeFailed = true;
      options.warn(
        `the window frames could not be saved (${err instanceof Error ? err.message : err}): ` +
          "the app needs --allow-write for its app-support folder (desktop.app.restoreWindows, " +
          "the fs / sqlite / updates capabilities, or desktop.extraPermissions.write grant it)",
      );
    }
  };
  const schedule = () => {
    dirty = true;
    if (path === undefined || timer !== undefined) return;
    const id = setTimeout(() => {
      timer = undefined;
      flush();
    }, options.debounceMs ?? WINDOW_STORE_DEBOUNCE_MS);
    timer = id;
    Deno.unrefTimer(id);
  };

  return {
    bounds: (key) => bounds.get(key),
    setBounds: (key, rect) => {
      const checked = rectOf(rect);
      if (!checked) return;
      bounds.delete(key); // re-inserted last: the least recently saved go first
      bounds.set(key, checked);
      while (bounds.size > MAX_KEYS) bounds.delete(bounds.keys().next().value as string);
      schedule();
    },
    lastSession: () => loaded.session,
    setSession: (list) => {
      session = list.map(({ key, url }) => ({ key, url }));
      schedule();
    },
    flush,
  };
}

/** How much of `rect` is on `screen`'s work area, in pixels of each axis. */
function overlap(rect: DesktopRect, area: DesktopRect): { w: number; h: number } {
  const w = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const h = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  return { w, h };
}

/**
 * `rect` clamped onto a connected display: where it is when at least {@linkcode VISIBLE_PX} pixels
 * of it on each axis are on some display's work area (no larger than the largest work area), else
 * moved (and shrunk when larger than the area) onto the display it is nearest to, the primary one
 * first. With no displays known (the stock runtime, Wayland) `rect` is returned as it is.
 *
 * @param rect The saved bounds.
 * @param screens The displays connected now (`Deno.desktop.screens()`).
 * @returns The bounds to open with.
 */
export function clampToScreens(rect: DesktopRect, screens: readonly DesktopScreen[]): DesktopRect {
  const areas = screens.map((s) => s.workArea ?? s.bounds).filter((a) => a !== undefined);
  if (areas.length === 0) return rect;
  const largest = {
    width: Math.max(...areas.map((a) => a.width)),
    height: Math.max(...areas.map((a) => a.height)),
  };
  for (const area of areas) {
    const { w, h } = overlap(rect, area);
    if (w >= VISIBLE_PX && h >= VISIBLE_PX) {
      return {
        ...rect,
        width: Math.min(rect.width, largest.width),
        height: Math.min(rect.height, largest.height),
      };
    }
  }
  // The display whose area is nearest the saved centre (the primary wins a tie).
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let best = areas[0];
  let bestDistance = Infinity;
  for (const area of areas) {
    const dx = Math.max(area.x - cx, 0, cx - (area.x + area.width));
    const dy = Math.max(area.y - cy, 0, cy - (area.y + area.height));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = area;
      bestDistance = distance;
    }
  }
  const width = Math.min(rect.width, best.width);
  const height = Math.min(rect.height, best.height);
  const x = Math.min(Math.max(rect.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(rect.y, best.y), best.y + best.height - height);
  return { x, y, width, height };
}
