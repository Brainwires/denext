/**
 * The real stacking order of the app's windows, the pointer on the screen, and a drag session
 * that crosses windows: the backend side of `getWindowOrder` / `getPointer` /
 * `startDragSession` / `onDragSession` in `denext/desktop/window`.
 *
 * A page hears pointer events inside its own window only, and with pointer capture it learns
 * positions relative to that window, never which other window of the app the pointer is over.
 * The runtime can ask the OS (`Deno.desktop.windowOrder()` / `Deno.desktop.pointer()`, where it has
 * them): the windows as they are stacked right now, and the pointer's place on the screen with
 * the app window a click there would reach, wherever the gesture started.
 *
 * A drag session is that question asked once per frame while a mouse button is held:
 *
 * - the window that starts it (`dragStart`, from its `pointerdown` / `dragstart`) is its origin
 *   and gets `move` events (the pointer on the screen and the window under it) and one `end`;
 * - the window under the pointer gets `enter`, `over` (the pointer in ITS page's coordinates),
 *   `leave`, and `drop` when the button is released over it, with the session's `data` (JSON the
 *   origin attached) on `enter` and `drop`;
 * - it ends when the primary button is released (a drop), when the origin cancels it, when the
 *   origin's window closes, or after {@linkcode MAX_SESSION_MS}.
 *
 * SECURITY: the session's data goes only to the app's own windows (the windows of this registry),
 * never to another application: this is not an OS drag and nothing is put on a pasteboard. Only
 * the origin window can cancel its session. One session runs at a time (there is one pointer).
 * The pointer's position on the screen is reported to the app's own pages, as the page's
 * `MouseEvent.screenX` / `screenY` already are while the pointer is over them.
 *
 * Runtime-only (imported by the window registry, never a client bundle).
 *
 * @module
 */

import { DesktopCapError } from "./extension.ts";

/** `Deno.desktop.pointer()`'s answer. */
export interface RuntimePointer {
  /** The pointer on the screen, in `BrowserWindow.getPosition()`'s space. */
  readonly x: number;
  /** Its vertical place (see `x`). */
  readonly y: number;
  /** The buttons held, as a DOM `MouseEvent.buttons`. */
  readonly buttons: number;
  /** The runtime id of the app window under the pointer, or `null`. */
  readonly windowId: number | null;
}

/** The part of `Deno.desktop` the stacking calls read. */
export interface StackingApi {
  /** The runtime ids of the app's on-screen windows, front to back; `null` where the OS won't say. */
  windowOrder?(): readonly number[] | null;
  /** The pointer, asked of the OS; `null` where the OS won't say. */
  pointer?(): RuntimePointer | null;
}

/** One of the app's windows, as the stacking calls see it. */
export interface StackingWindow {
  /** Its registry id (`"main"`, `"window-1"`, …). */
  readonly id: string;
  /** The runtime's id for it (`BrowserWindow.windowId`), where the runtime gives one. */
  readonly windowId?: number;
  /** Whether it is showing (default yes). */
  readonly visible?: boolean;
  /** The top-left corner of its page on the screen (`BrowserWindow.getInnerPosition()`). */
  innerPosition?(): readonly [number, number] | null;
}

/** What {@linkcode createWindowStacking} needs from the registry. */
export interface WindowStackingHost {
  /** `Deno.desktop` (absent in tests and off the desktop runtime). */
  readonly api?: StackingApi;
  /** The open windows. */
  windows(): readonly StackingWindow[];
  /** The ids of the windows that had the focus, most recent first. */
  focusOrder(): readonly string[];
  /** Push a `drag` event to one window's pages. */
  emit(data: DragEvent, target: string): void;
  /** Timers (tests pass fakes). */
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** The clock, in ms (tests pass a fake). */
  readonly now?: () => number;
  /** A session id (tests pass a counter; default a random UUID). */
  readonly newId?: () => string;
}

/** The app's windows front to back, and where the order came from. */
export interface WindowOrder {
  /** The ids of the windows that are on screen, the front-most first. */
  readonly ids: string[];
  /**
   * `"os"`: the OS's own stacking order. `"focus"`: the OS does not tell (a Wayland session, a
   * runtime without the call), so this is the order the windows last had the focus in, which a
   * window raised without focus or an always-on-top window can differ from.
   */
  readonly source: "os" | "focus";
}

/** The pointer, as `pointer` answers the page. */
export interface PointerInfo {
  /** The pointer on the screen. */
  readonly x: number;
  /** Its vertical place (see `x`). */
  readonly y: number;
  /** The buttons held, as a DOM `MouseEvent.buttons`. */
  readonly buttons: number;
  /** The id of the app window under the pointer, or `null`. */
  readonly window: string | null;
  /** The pointer in that window's page (CSS pixels at zoom 1), when the window is known. */
  readonly clientX?: number;
  /** Its vertical place in the page (see `clientX`). */
  readonly clientY?: number;
}

/** A `drag` event, as a window's pages receive it. */
export interface DragEvent {
  /** The session. */
  readonly session: string;
  /**
   * For the origin: `"move"` and `"end"`. For the window under the pointer: `"enter"`, `"over"`,
   * `"leave"` and `"drop"`.
   */
  readonly type: "move" | "end" | "enter" | "over" | "leave" | "drop";
  /** The window that started the session. */
  readonly origin: string;
  /** The pointer on the screen. */
  readonly x: number;
  /** Its vertical place (see `x`). */
  readonly y: number;
  /** The buttons held. */
  readonly buttons: number;
  /** `move` / `end`: the window under the pointer (`end`: the one dropped on), or `null`. */
  readonly window?: string | null;
  /** `enter` / `over` / `drop`: the pointer in the receiving window's page. */
  readonly clientX?: number;
  /** Its vertical place in the page (see `clientX`). */
  readonly clientY?: number;
  /** `enter` / `drop`: the data the origin attached. */
  readonly data?: unknown;
  /** `end` / `leave`: the session was cancelled (no drop). */
  readonly cancelled?: boolean;
  /** `end` with `cancelled`: why (`"cancelled"`, `"closed"`, `"timeout"`, `"unavailable"`). */
  readonly reason?: string;
}

/** The longest a drag session runs, in ms. */
export const MAX_SESSION_MS = 10 * 60 * 1000;
/** How often the pointer is sampled, in ms: the default, and the range a page may ask for. */
const DEFAULT_INTERVAL_MS = 16;
const MIN_INTERVAL_MS = 8;
const MAX_INTERVAL_MS = 100;
/** The most JSON a session carries, in characters. */
export const MAX_DATA_CHARS = 64 * 1024;
/** The primary button's bit in `buttons`. */
const PRIMARY = 1;

/** What {@linkcode createWindowStacking} returns. */
export interface WindowStacking {
  /** The `windows` capability's `order`. */
  order(): WindowOrder;
  /** The `windows` capability's `pointer` (rejects `unsupported` where the OS won't say). */
  pointer(): PointerInfo;
  /** The `windows` capability's `dragStart`, from the window `origin`. */
  dragStart(args: unknown, origin: string): { session: string };
  /** The `windows` capability's `dragCancel`, from the window `caller`. */
  dragCancel(args: unknown, caller: string): { cancelled: boolean };
  /** A window closed: a session it started ends, one over it leaves it. */
  windowClosed(id: string): void;
  /** End whatever runs (the app is quitting). */
  stop(): void;
}

interface Session {
  readonly id: string;
  readonly origin: string;
  readonly data: unknown;
  readonly started: number;
  timer: unknown;
  over: string | null;
  last: { x: number; y: number; window: string | null; buttons: number } | null;
}

const unsupported = (what: string) =>
  new DesktopCapError(
    "unsupported",
    `window: ${what} is not available here (the OS does not tell: a Wayland session, or a ` +
      "runtime without the call)",
    { status: 501 },
  );

/**
 * The stacking order, the pointer and drag sessions over a registry's windows.
 *
 * @param host The registry's windows, `Deno.desktop`, and how to reach a window's pages.
 * @returns The calls the `windows` capability exposes.
 */
export function createWindowStacking(host: WindowStackingHost): WindowStacking {
  const every = host.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear = host.clearInterval ?? ((h) => clearInterval(h as number));
  const now = host.now ?? (() => Date.now());
  const newId = host.newId ?? (() => crypto.randomUUID());
  let session: Session | null = null;

  const byRuntimeId = (windowId: number | null): StackingWindow | undefined =>
    windowId === null ? undefined : host.windows().find((w) => w.windowId === windowId);

  /** The pointer from the runtime, or `null` (no call, a throw, a malformed answer). */
  const sample = (): RuntimePointer | null => {
    if (typeof host.api?.pointer !== "function") return null;
    let p: RuntimePointer | null;
    try {
      p = host.api.pointer();
    } catch {
      return null;
    }
    if (p === null || typeof p !== "object") return null;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isInteger(p.buttons)) return null;
    return p;
  };

  /** The pointer in `w`'s page, where the runtime tells the page's place on the screen. */
  const client = (
    w: StackingWindow | undefined,
    p: { x: number; y: number },
  ): { clientX: number; clientY: number } | Record<string, never> => {
    let inner: readonly [number, number] | null | undefined;
    try {
      inner = w?.innerPosition?.();
    } catch {
      inner = null;
    }
    if (!inner || !Number.isFinite(inner[0]) || !Number.isFinite(inner[1])) return {};
    return { clientX: p.x - inner[0], clientY: p.y - inner[1] };
  };

  const order = (): WindowOrder => {
    const windows = host.windows();
    let os: readonly number[] | null = null;
    if (typeof host.api?.windowOrder === "function") {
      try {
        os = host.api.windowOrder();
      } catch {
        os = null;
      }
    }
    if (Array.isArray(os)) {
      const ids: string[] = [];
      for (const windowId of os) {
        const w = windows.find((x) => x.windowId === windowId);
        if (w && !ids.includes(w.id)) ids.push(w.id);
      }
      return { ids, source: "os" };
    }
    // The order the windows had the focus in, then the ones never focused, visible ones only.
    const visible = windows.filter((w) => w.visible !== false).map((w) => w.id);
    const focused = host.focusOrder().filter((id) => visible.includes(id));
    const ids = [...new Set([...focused, ...visible])];
    return { ids, source: "focus" };
  };

  const pointer = (): PointerInfo => {
    const p = sample();
    if (p === null) throw unsupported("the pointer's position");
    const w = byRuntimeId(p.windowId);
    return { x: p.x, y: p.y, buttons: p.buttons, window: w?.id ?? null, ...client(w, p) };
  };

  /** End the session: `leave` for the window under the pointer, `end` for the origin. */
  const finish = (
    s: Session,
    p: { x: number; y: number; buttons: number },
    outcome: { dropped: string | null } | { cancelled: string },
  ): void => {
    if (session !== s) return;
    session = null;
    clear(s.timer);
    const base = { session: s.id, origin: s.origin, x: p.x, y: p.y, buttons: p.buttons };
    if ("cancelled" in outcome) {
      if (s.over !== null) host.emit({ ...base, type: "leave", cancelled: true }, s.over);
      // The origin's window may be the reason (closed): its pages are gone then.
      if (outcome.cancelled !== "closed") {
        host.emit(
          { ...base, type: "end", window: null, cancelled: true, reason: outcome.cancelled },
          s.origin,
        );
      }
      return;
    }
    host.emit({ ...base, type: "end", window: outcome.dropped }, s.origin);
  };

  /** Tell the windows what one sample changed: who the pointer left, entered, moved over. */
  const announce = (s: Session, p: RuntimePointer, target: StackingWindow | undefined): void => {
    const over = target?.id ?? null;
    const base = { session: s.id, origin: s.origin, x: p.x, y: p.y, buttons: p.buttons };
    const moved = s.last === null || s.last.x !== p.x || s.last.y !== p.y;
    const changed = over !== s.over;
    if (changed && s.over !== null) host.emit({ ...base, type: "leave" }, s.over);
    if (changed && over !== null) {
      host.emit({ ...base, type: "enter", ...client(target, p), data: s.data }, over);
    }
    if (!changed && over !== null && moved) {
      host.emit({ ...base, type: "over", ...client(target, p) }, over);
    }
    if (moved || changed || s.last?.buttons !== p.buttons) {
      host.emit({ ...base, type: "move", window: over }, s.origin);
    }
    s.over = over;
    s.last = { x: p.x, y: p.y, window: over, buttons: p.buttons };
  };

  /** The button was released: a drop on the window under the pointer, if any, and the end. */
  const release = (s: Session, p: RuntimePointer, target: StackingWindow | undefined): void => {
    const over = target?.id ?? null;
    if (over !== null) {
      const base = { session: s.id, origin: s.origin, x: p.x, y: p.y, buttons: p.buttons };
      host.emit({ ...base, type: "drop", ...client(target, p), data: s.data }, over);
    }
    // `drop` took the place of `leave`.
    s.over = null;
    finish(s, p, { dropped: over });
  };

  const tick = (s: Session): void => {
    if (session !== s) return;
    const last = s.last ?? { x: 0, y: 0, buttons: 0, window: null };
    if (now() - s.started > MAX_SESSION_MS) {
      finish(s, last, { cancelled: "timeout" });
      return;
    }
    const p = sample();
    if (p === null) {
      finish(s, last, { cancelled: "unavailable" });
      return;
    }
    const target = byRuntimeId(p.windowId);
    announce(s, p, target);
    if ((p.buttons & PRIMARY) === 0) release(s, p, target);
  };

  /** `dragStart`'s `intervalMs`, checked (the default when absent). */
  const intervalArg = (value: unknown): number => {
    if (value === undefined) return DEFAULT_INTERVAL_MS;
    if (
      typeof value !== "number" || !Number.isFinite(value) ||
      value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS
    ) {
      throw new DesktopCapError(
        "validation",
        `window: intervalMs must be a number from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`,
      );
    }
    return value;
  };

  /** `dragStart`'s `data`, as a JSON copy (`null` when absent). */
  const dataArg = (value: unknown): unknown => {
    if (value === undefined) return null;
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      json = undefined;
    }
    if (json === undefined || json.length > MAX_DATA_CHARS) {
      throw new DesktopCapError(
        "validation",
        `window: a drag session's data must be JSON of at most ${MAX_DATA_CHARS} characters`,
      );
    }
    // A copy: what the page mutates later is not what a drop delivers.
    return JSON.parse(json);
  };

  /** The first sample of a session about to start: a button must be held. */
  const firstSample = (): RuntimePointer => {
    const first = sample();
    if (first === null) throw unsupported("a drag session");
    if ((first.buttons & PRIMARY) === 0) {
      throw new DesktopCapError(
        "not_dragging",
        "window: no mouse button is held; start the session from pointerdown or dragstart",
        { status: 409 },
      );
    }
    return first;
  };

  const dragStart = (args: unknown, origin: string): { session: string } => {
    const a = (args !== null && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const interval = intervalArg(a.intervalMs);
    const data = dataArg(a.data);
    if (!host.windows().some((w) => w.id === origin)) {
      throw new DesktopCapError("not_found", "window: no such window", { status: 404 });
    }
    if (session !== null) {
      throw new DesktopCapError(
        "conflict",
        "window: another drag session is running (there is one pointer)",
        { status: 409 },
      );
    }
    firstSample();
    const s: Session = {
      id: newId(),
      origin,
      data,
      started: now(),
      timer: undefined,
      over: null,
      last: null,
    };
    session = s;
    s.timer = every(() => tick(s), interval);
    // The first sample, so the window under the pointer hears `enter` before the first interval.
    tick(s);
    return { session: s.id };
  };

  const dragCancel = (args: unknown, caller: string): { cancelled: boolean } => {
    const a = (args !== null && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const s = session;
    // Another window's session, an ended one and an unknown id all answer the same.
    if (s === null || s.id !== a.session || s.origin !== caller) return { cancelled: false };
    finish(s, s.last ?? { x: 0, y: 0, buttons: 0 }, { cancelled: "cancelled" });
    return { cancelled: true };
  };

  const windowClosed = (id: string): void => {
    const s = session;
    if (s === null) return;
    if (s.origin === id) {
      finish(s, s.last ?? { x: 0, y: 0, buttons: 0 }, { cancelled: "closed" });
    } else if (s.over === id) {
      // Its pages are gone: no `leave` to send.
      s.over = null;
    }
  };

  const stop = (): void => {
    const s = session;
    if (s === null) return;
    session = null;
    clear(s.timer);
  };

  return { order, pointer, dragStart, dragCancel, windowClosed, stop };
}
