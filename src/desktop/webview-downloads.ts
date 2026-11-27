/**
 * A web view's downloads (`downloads: "app"`) and permission requests (`permissions: "app"`) as
 * both sides hand them to the app: the page's handle (over the bridge, `./webview.ts`) and
 * `desktop.ts`'s (over the runtime view, `./caps/webview.ts`). Each side feeds the runtime's
 * `"download"` / `"permission-request"` event details in and supplies how a decision reaches the
 * runtime; this module keeps each download's item (its live state, its `updated` / `done`
 * listeners) and the pending permission requests (their handler answers and the 5-minute limit).
 *
 * Rules: a download requested while nothing listens to `will-download` is cancelled at once (it
 * would otherwise wait for an answer forever); with no permission handler a request is refused at
 * once; a handler that throws, rejects or has not answered in 5 minutes refuses; an answer to a
 * request the runtime cancelled meanwhile is dropped. The view closing ends every download still
 * running (`done` with `cancelled`) and drops every pending request with its timer.
 *
 * Client-safe: no Deno APIs, nothing runs at import. Internal to denext.
 *
 * @module
 */

import type {
  WebViewDownloadAction,
  WebViewDownloadDone,
  WebViewDownloadEvent,
  WebViewDownloadItem,
  WebViewDownloadState,
  WebViewPermissionHandler,
  WebViewPermissionRequest,
} from "./webview.ts";

/**
 * How long a permission handler may take before its request is refused, and a `will-download`
 * listener before an item it neither saved nor cancelled is cancelled.
 */
const PERMISSION_ANSWER_MS = 5 * 60 * 1000;

/** The download states the runtime reports. */
const STATES: ReadonlySet<string> = new Set([
  "requested",
  "progressing",
  "completed",
  "cancelled",
  "interrupted",
]);

/** The interrupt reasons the runtime names. */
const REASONS: ReadonlySet<string> = new Set(["network", "server", "file", "crash", "failed"]);

/** What a side supplies. */
export interface WebViewMediaOps {
  /** Decide or control download `id` (`target`: `save`'s destination, as the side takes it). */
  control(id: number, action: WebViewDownloadAction, target?: unknown): Promise<void>;
  /** Answer permission request `id`. */
  respond(id: number, allow: boolean): Promise<void>;
  /** Show a saved download in the file manager (`savedTo`: what `save` was given, if anything). */
  reveal(path: string, savedTo: unknown): Promise<void>;
  /** Whether anything listens to `event` on the view. */
  hasListeners(event: string): boolean;
  /** Hand `detail` to the view's `event` listeners. */
  fire(event: string, detail: unknown): void;
  /** The side's error for a call refused before it reaches the runtime. */
  fail(code: string, message: string): Error;
  /** A throwing `updated` / `done` listener (it never stops the others). */
  onListenerError(err: unknown): void;
  /**
   * The permission handler's limit, and how long a requested download may wait for `save`,
   * `saveAs` or `cancel` before it is cancelled (tests shorten it; default 5 minutes).
   */
  readonly answerMs?: number;
}

/** What {@linkcode createWebViewMedia} returns. */
export interface WebViewMedia {
  /** A runtime `"download"` event's detail. */
  download(detail: unknown): void;
  /** A runtime `"permission-request"` event's detail. */
  permissionRequest(detail: unknown): void;
  /** Replace the permission handler (`null`: refuse every request at once). */
  setPermissionRequestHandler(handler: WebViewPermissionHandler | null): void;
  /** The view closed: running downloads end `cancelled`, pending requests and timers go. */
  closed(): void;
}

/** One live download. */
interface LiveDownload {
  readonly data: WebViewDownloadEvent;
  readonly updated: Set<(item: WebViewDownloadItem) => void>;
  readonly done: Set<(done: WebViewDownloadDone) => void>;
  savedTo?: unknown;
  over: boolean;
  /** Its item (made once: `will-download` and `updated` hand the same object). */
  item?: WebViewDownloadItem;
  /** Cancels it once nothing saved or cancelled it in time (cleared by the decision). */
  decideTimer?: ReturnType<typeof setTimeout>;
}

/** The app decided `live` (saved it, or cancelled it): it no longer waits on the deadline. */
function decided(live: LiveDownload): void {
  clearTimeout(live.decideTimer);
  live.decideTimer = undefined;
}

/** A pending permission request. */
interface PendingRequest {
  timer?: ReturnType<typeof setTimeout>;
}

/** `raw` as a download event, or `null` when it is not one. */
export function downloadEventOf(raw: unknown): WebViewDownloadEvent | null {
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof d.id !== "number" || !Number.isFinite(d.id) || !STATES.has(d.state as string)) {
    return null;
  }
  const out: WebViewDownloadEvent = {
    id: d.id,
    state: d.state as WebViewDownloadState,
    url: typeof d.url === "string" ? d.url : "",
    filename: typeof d.filename === "string" ? d.filename : "",
    receivedBytes: typeof d.receivedBytes === "number" ? d.receivedBytes : 0,
  };
  if (typeof d.mimeType === "string") out.mimeType = d.mimeType;
  if (typeof d.totalBytes === "number") out.totalBytes = d.totalBytes;
  if (typeof d.path === "string") out.path = d.path;
  if (d.paused === true) out.paused = true;
  if (typeof d.canResume === "boolean") out.canResume = d.canResume;
  if (REASONS.has(d.reason as string)) out.reason = d.reason as WebViewDownloadEvent["reason"];
  return out;
}

/** Whether `e` is a download's last event. */
function isFinal(e: WebViewDownloadEvent): boolean {
  return e.state === "completed" || e.state === "cancelled" ||
    (e.state === "interrupted" && e.canResume !== true);
}

/** Call each of `fns` with `arg`; a throw goes to `onError`. */
function callAll<T>(fns: Iterable<(arg: T) => void>, arg: T, onError: (err: unknown) => void) {
  for (const fn of [...fns]) {
    try {
      fn(arg);
    } catch (err) {
      onError(err);
    }
  }
}

/** The media state of one view. */
interface MediaState {
  readonly ops: WebViewMediaOps;
  readonly downloads: Map<number, LiveDownload>;
  readonly requests: Map<number, PendingRequest>;
  handler: WebViewPermissionHandler | null;
}

/** The item over `live` (its fields read live). */
function itemOf(m: MediaState, live: LiveDownload): WebViewDownloadItem {
  if (live.item) return live.item;
  const d = live.data;
  const control = (action: WebViewDownloadAction, target?: unknown) =>
    m.ops.control(d.id, action, target);
  const item: WebViewDownloadItem = {
    id: d.id,
    url: d.url,
    filename: d.filename,
    ...(d.mimeType !== undefined ? { mimeType: d.mimeType } : {}),
    ...(d.totalBytes !== undefined ? { totalBytes: d.totalBytes } : {}),
    get receivedBytes() {
      return live.data.receivedBytes;
    },
    get state() {
      return live.data.state;
    },
    get path() {
      return live.data.path;
    },
    get paused() {
      return live.data.paused === true;
    },
    get canResume() {
      return live.data.canResume === true;
    },
    save: async (target) => {
      await control("save", target);
      live.savedTo = target;
      decided(live);
    },
    saveAs: async () => {
      await control("saveAs");
      decided(live);
    },
    cancel: async () => {
      await control("cancel");
      decided(live);
    },
    pause: () => control("pause"),
    resume: () => control("resume"),
    reveal: () => {
      const path = live.data.path;
      if (path === undefined || path === "") {
        return Promise.reject(m.ops.fail("not_found", "the download has no path yet"));
      }
      return m.ops.reveal(path, live.savedTo);
    },
    on: listenOn(live) as WebViewDownloadItem["on"],
  };
  live.item = item;
  return item;
}

/** `item.on(event, fn)` of `live`: a no-op once it ended. */
function listenOn(live: LiveDownload) {
  return (event: "updated" | "done", fn: (arg: never) => void): () => void => {
    if (live.over) return () => {};
    const set = (event === "done" ? live.done : live.updated) as Set<(arg: never) => void>;
    set.add(fn);
    return () => void set.delete(fn);
  };
}

/** End `live` with its final state: `done` once, then its listeners go. */
function finish(m: MediaState, live: LiveDownload): void {
  if (live.over) return;
  live.over = true;
  decided(live);
  m.downloads.delete(live.data.id);
  const d = live.data;
  const done: WebViewDownloadDone = {
    state: d.state === "completed" || d.state === "interrupted" ? d.state : "cancelled",
    ...(d.reason !== undefined ? { reason: d.reason } : {}),
    ...(d.path !== undefined ? { path: d.path } : {}),
  };
  callAll(live.done, done, m.ops.onListenerError);
  live.updated.clear();
  live.done.clear();
}

/** A download was requested: hand its item to `will-download`, or cancel it with no listener. */
function requested(m: MediaState, e: WebViewDownloadEvent): void {
  if (m.downloads.has(e.id)) return;
  if (!m.ops.hasListeners("will-download")) {
    m.ops.control(e.id, "cancel").catch(() => {});
    return;
  }
  const live: LiveDownload = { data: { ...e }, updated: new Set(), done: new Set(), over: false };
  m.downloads.set(e.id, live);
  // A listener that never saves or cancels it would leave it pending in the runtime until the view
  // closes: past the limit it is cancelled, as an unanswered permission request is refused.
  live.decideTimer = setTimeout(() => {
    live.decideTimer = undefined;
    if (!live.over && live.data.state === "requested") {
      m.ops.control(e.id, "cancel").catch(() => {});
    }
  }, m.ops.answerMs ?? PERMISSION_ANSWER_MS);
  m.ops.fire("will-download", itemOf(m, live));
}

/** A later event of a tracked download: its fields follow, then `updated` or `done`. */
function progressed(m: MediaState, e: WebViewDownloadEvent): void {
  const live = m.downloads.get(e.id);
  if (!live) return;
  const d = live.data;
  d.state = e.state;
  d.receivedBytes = e.receivedBytes;
  if (e.totalBytes !== undefined) d.totalBytes = e.totalBytes;
  if (e.path !== undefined) d.path = e.path;
  if (e.paused) d.paused = true;
  else delete d.paused;
  if (e.canResume !== undefined) d.canResume = e.canResume;
  if (e.reason !== undefined) d.reason = e.reason;
  if (d.state !== "requested") decided(live); // under way: it was decided
  if (isFinal(d)) return finish(m, live);
  callAll(live.updated, itemOf(m, live), m.ops.onListenerError);
}

/** A permission request as the handler gets it, or `null` when the detail is not one. */
function requestOf(raw: Record<string, unknown>): WebViewPermissionRequest | null {
  if (typeof raw.id !== "number" || typeof raw.origin !== "string") return null;
  const permissions = Array.isArray(raw.permissions)
    ? raw.permissions.filter((p): p is string => typeof p === "string")
    : [];
  const f = raw.frame as Record<string, unknown> | undefined;
  const frame = typeof f === "object" && f !== null && typeof f.isMain === "boolean"
    ? { isMain: f.isMain, ...(typeof f.origin === "string" ? { origin: f.origin } : {}) }
    : undefined;
  return { id: raw.id, origin: raw.origin, permissions, ...(frame ? { frame } : {}) };
}

/** Ask the handler about `req`; the answer (or a refusal) goes to the runtime unless dropped. */
function ask(m: MediaState, handler: WebViewPermissionHandler, req: WebViewPermissionRequest) {
  const pending: PendingRequest = {};
  m.requests.set(req.id, pending);
  const limit = new Promise<boolean>((resolve) => {
    pending.timer = setTimeout(() => resolve(false), m.ops.answerMs ?? PERMISSION_ANSWER_MS);
  });
  const answer = Promise.resolve()
    .then(() => handler(req))
    .then((allow) => allow === true, () => false);
  void Promise.race([answer, limit]).then((allow) => {
    clearTimeout(pending.timer);
    // Cancelled meanwhile (or the view closed): the late answer is dropped.
    if (m.requests.get(req.id) !== pending) return;
    m.requests.delete(req.id);
    m.ops.respond(req.id, allow).catch(() => {});
  });
}

/** A runtime `"permission-request"` detail: a cancellation drops it, a request is asked. */
function permissionRequested(m: MediaState, detail: unknown): void {
  const d = (typeof detail === "object" && detail !== null ? detail : {}) as Record<
    string,
    unknown
  >;
  if (typeof d.id !== "number") return;
  if (d.state === "cancelled") return dropRequest(m, d.id);
  const req = d.state === "requested" ? requestOf(d) : null;
  if (!req || m.requests.has(req.id)) return;
  if (m.handler) ask(m, m.handler, req);
  else m.ops.respond(req.id, false).catch(() => {});
}

/** Forget pending request `id` (its timer cleared; a late answer is dropped). */
function dropRequest(m: MediaState, id: number): void {
  clearTimeout(m.requests.get(id)?.timer);
  m.requests.delete(id);
}

/**
 * The downloads and permission requests of one view.
 *
 * @param ops How the side decides, answers, reveals and fires.
 * @returns The event inputs, the handler setter and the close hook.
 */
export function createWebViewMedia(ops: WebViewMediaOps): WebViewMedia {
  const m: MediaState = { ops, downloads: new Map(), requests: new Map(), handler: null };
  return {
    download: (detail) => {
      const e = downloadEventOf(detail);
      if (!e) return;
      if (e.state === "requested") requested(m, e);
      else progressed(m, e);
    },
    permissionRequest: (detail) => permissionRequested(m, detail),
    setPermissionRequestHandler: (handler) => {
      m.handler = typeof handler === "function" ? handler : null;
    },
    closed: () => {
      for (const p of m.requests.values()) clearTimeout(p.timer);
      m.requests.clear();
      for (const live of [...m.downloads.values()]) {
        if (!isFinal(live.data)) live.data.state = "cancelled";
        finish(m, live);
      }
    },
  };
}
