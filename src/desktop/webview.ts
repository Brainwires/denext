/**
 * Embedded web views (re-exported from `denext/desktop/window`): a native browser view of another
 * site placed inside the app's window, above the page, at a rectangle the page chooses. It never
 * gets the desktop bridge, the app's storage or the window's navigation guard; it closes with its
 * window.
 *
 * Each call goes to the `window` capability (`webViewCapabilities`, `webViewCreate`, `webViewCall`);
 * the view's events come back as the `window` capability's `webview` event `{ id, event, detail }`,
 * routed here to the handle with that id.
 *
 * Client-safe: web APIs only, nothing runs at import. Off desktop every call rejects `unavailable`
 * without making a request.
 *
 * @module
 */

import { base64ToBytes } from "../mobile/base64.ts";
import { clippingAncestors, type ClipStyle, visiblePart } from "../mobile/native-view-geometry.ts";
import { desktopError, desktopRpc, subscribeDesktopEvent } from "./bridge-client.ts";
import {
  definedOnly,
  fireWebViewListeners,
  webViewHandle,
  type WebViewListeners,
} from "./webview-handle.ts";

/** The capability every call goes to. */
const CAP = "window";

/** A web view's rectangle: CSS pixels, relative to the top-left of the window's page viewport. */
export interface WebViewBounds {
  /** The left edge. */
  x: number;
  /** The top edge. */
  y: number;
  /** The width. */
  width: number;
  /** The height. */
  height: number;
}

/** What {@linkcode createWebView} opens. */
export interface CreateWebViewOptions {
  /** The page to load: `http:` or `https:` only; the app's own origin is refused. */
  url: string;
  /** Where the view sits (CSS pixels, relative to the window's page viewport). */
  bounds: WebViewBounds;
  /**
   * The storage partition (default `"webview:default"`; never the app's own storage): 1 to 64
   * letters, digits, `.`, `_`, `:` or `-`, starting with a letter or digit. Views with the same
   * partition share cookies and storage. `"ephemeral"` or a name starting with `"ephemeral:"` is
   * kept in memory and gone when the app exits; any other name is persistent.
   */
  partition?: string;
  /** Whether the view shows once created (default `true`). */
  visible?: boolean;
  /**
   * What `window.open` / a `target="_blank"` link in the view does: `"same-view"` (default) loads
   * it in this view, `"browser"` opens it in the system browser, `"deny"` opens nothing and fires
   * `new-window`.
   */
  allowPopups?: "deny" | "same-view" | "browser";
  /**
   * What a download does: `"deny"` (default) cancels it, `"ask"` shows the OS save panel,
   * `"browser"` cancels it in the view and opens its URL in the system browser, `"app"` hands each
   * download to the app as a `will-download` event's {@linkcode WebViewDownloadItem} (where
   * `webViewCapabilities().downloadEvents`; elsewhere the create rejects `unsupported`). With
   * `"app"`, a download requested while nothing listens to `will-download` is cancelled.
   */
  downloads?: "deny" | "ask" | "browser" | "app";
  /**
   * The camera / microphone / geolocation / notification prompts: `"deny"` (default) refuses them
   * without a prompt, `"ask"` asks the user, `"app"` asks the view's
   * {@linkcode WebViewHandle.setPermissionRequestHandler} (where
   * `webViewCapabilities().permissionRequests`; elsewhere the create rejects `unsupported`). The
   * object form also sets the clipboard: `prompts` (default `"deny"`) is the string form's choice,
   * `clipboardRead` (default `false`) lets the site read the clipboard, `clipboardWrite` (default
   * `true`) lets it write on a user gesture.
   */
  permissions?: "deny" | "ask" | "app" | WebViewPermissions;
  /**
   * The context menu: `"native"` (default) is the engine's own; `"app"` suppresses it so the page
   * draws its own from the `context-menu` event (which fires in both modes).
   */
  contextMenu?: "native" | "app";
  /**
   * Keys the view hands to the app's page instead of its own page while it has the keyboard:
   * accelerators as `registerShortcut` takes them (`"CmdOrCtrl+1"`, `"Meta+Shift+L"`), at most
   * 64. Each arrives as a `keydown` event with `forwarded: true`, and its release as a `keyup`
   * (where `webViewCapabilities().keyUp`). The app menu's accelerators win over an entry unless
   * it is `{ accelerator, beforeMenu: true }` ({@linkcode WebViewForwardKey}).
   */
  forwardKeys?: WebViewForwardKey[];
  /** Replaces the engine's user agent string for this view. */
  userAgent?: string;
}

/**
 * One `forwardKeys` entry: an accelerator (`"CmdOrCtrl+W"`), or `{ accelerator, beforeMenu }`.
 *
 * `beforeMenu: true` (where `webViewCapabilities().forwardKeysBeforeMenu`; else the create or
 * `setForwardKeys` rejects `unsupported`) forwards the key even when the app menu has the same
 * accelerator: while this view has the keyboard, the key reaches the app's page as a forwarded
 * `keydown` and the menu item does not fire. With the view unfocused, the menu item works as
 * always. Without it (the default) the menu item fires and the key is not forwarded. A string with
 * a leading `!` (`"!CmdOrCtrl+W"`) is the same as `beforeMenu: true`.
 */
export type WebViewForwardKey = string | {
  /** The accelerator, as `registerShortcut` takes it. */
  readonly accelerator: string;
  /** Match it before the app menu's accelerators (default `false`). */
  readonly beforeMenu?: boolean;
};

/** A key event of a web view ({@linkcode WebViewEventMap}'s `keydown` / `keyup`). */
export interface WebViewKeyEvent {
  /** `"keydown"` or `"keyup"`. */
  type: "keydown" | "keyup";
  /** DOM `KeyboardEvent.key`. */
  key: string;
  /** DOM `KeyboardEvent.code` (the physical key). */
  code: string;
  /** Alt / Option held. */
  altKey: boolean;
  /** Control held. */
  ctrlKey: boolean;
  /** Command on macOS, the Windows / Super key elsewhere. */
  metaKey: boolean;
  /** Shift held. */
  shiftKey: boolean;
  /** An auto-repeat of a held key (`keydown` only). */
  repeat: boolean;
  /** One of the view's `forwardKeys` (its page never saw it); always `true` for a `keyup`. */
  forwarded: boolean;
}

/** The object form of {@linkcode CreateWebViewOptions.permissions}. */
export interface WebViewPermissions {
  /** Camera / microphone / geolocation / notification prompts (default `"deny"`). */
  prompts?: "deny" | "ask" | "app";
  /** Whether the site may read the clipboard (default `false`). */
  clipboardRead?: boolean;
  /** Whether the site may write the clipboard on a user gesture (default `true`). */
  clipboardWrite?: boolean;
}

/** A web view's last load state. */
export type WebViewLoadState = "loading" | "interactive" | "complete" | "failed";

/** The events a web view fires ({@linkcode WebViewHandle.on}) and their payloads. */
export interface WebViewEventMap {
  /** The document's title changed. */
  title: { title: string };
  /** The main frame's URL changed (a same-document change too). */
  url: { url: string; canGoBack: boolean; canGoForward: boolean };
  /** A main-frame load started, committed, finished or failed (`error` with `"failed"`). */
  load: { state: WebViewLoadState; url: string; error?: { code: string; message: string } };
  /** The page in the view logged to its console. */
  console: {
    level: "log" | "info" | "warn" | "error" | "debug";
    message: string;
    source?: string;
    line?: number;
  };
  /**
   * The native view gained or lost keyboard focus. `reason` says when denext moved it:
   * `"hidden"` (`setVisible(false)` on a focused view gave the keyboard back to the app's page)
   * or `"blur"` ({@linkcode WebViewHandle.blur}); any other change (a click elsewhere, the window
   * deactivated) has none.
   */
  "focus-change": { focused: boolean; reason?: "hidden" | "blur" };
  /** A popup was refused (only with `allowPopups: "deny"`). */
  "new-window": { url: string; disposition: "popup" | "tab" };
  /** A {@linkcode WebViewHandle.find} search's matches (`activeMatch` 1-based, `0` = none). */
  "find-result": { matches: number; activeMatch: number };
  /**
   * A context menu was asked for (right click, the menu key), in both `contextMenu` modes: where
   * (CSS pixels from the view's top-left) and what is under the pointer.
   */
  "context-menu": {
    x: number;
    y: number;
    linkUrl?: string;
    imageUrl?: string;
    selectionText?: string;
    isEditable: boolean;
    mediaType?: "image" | "video" | "audio" | "canvas" | "plugin";
  };
  /**
   * A keydown while the view had the keyboard: `forwarded: true` for one of its `forwardKeys` (its
   * page never saw it; a held key repeats with `repeat: true`), `false` for a keydown its page
   * left unhandled (where the engine can tell: `unhandledKeys`). DOM `KeyboardEvent` names and
   * values.
   */
  keydown: WebViewKeyEvent & { type: "keydown" };
  /**
   * The release of a forwarded `keydown` (where `keyUp`), matched by its `code` whatever
   * modifiers are down by then; its page never sees it. A forwarded key still held when the view
   * loses the keyboard (a click elsewhere, {@linkcode WebViewHandle.blur}, hiding it, the app
   * deactivated) gets its `keyup` then, so a hold always ends. Keyups of keys that were not
   * forwarded stay the page's.
   */
  keyup: WebViewKeyEvent & { type: "keyup"; forwarded: true };
  /**
   * A download was requested (`downloads: "app"`), once per download: decide it with the item's
   * `save` / `saveAs` / `cancel`, and follow it with its `on("updated" | "done")`. A download
   * requested while nothing listens to this event is cancelled.
   */
  "will-download": WebViewDownloadItem;
  /** Each of the runtime's download events, as it reports it (`downloads: "app"`). */
  download: WebViewDownloadEvent;
  /**
   * Each permission request (`permissions: "app"`) as the runtime reports it, and its
   * cancellation (the page navigated, the engine withdrew it). The handler set with
   * {@linkcode WebViewHandle.setPermissionRequestHandler} answers it.
   */
  "permission-request": WebViewPermissionRequestEvent;
  /** The view closed (its `close()`, or its window closed). Nothing follows it. */
  closed: Record<string, never>;
}

/** Where a download is in its life. */
export type WebViewDownloadState =
  | "requested"
  | "progressing"
  | "completed"
  | "cancelled"
  | "interrupted";

/** Why a download was interrupted. */
export type WebViewDownloadInterruptReason = "network" | "server" | "file" | "crash" | "failed";

/** What a download item's control calls send the runtime. */
export type WebViewDownloadAction = "save" | "saveAs" | "cancel" | "pause" | "resume";

/**
 * One of the runtime's download events ({@linkcode WebViewEventMap}'s `download`): every event of
 * one download carries the same `id`, `url` and `filename`.
 */
export interface WebViewDownloadEvent {
  /** The download's id (the runtime's). */
  id: number;
  /**
   * `"requested"` first (nothing is written until it is answered), then `"progressing"` (at most
   * 5 a second, and once on each pause / resume); `"completed"` and `"cancelled"` are the last
   * event, and so is `"interrupted"` unless `canResume` is `true`.
   */
  state: WebViewDownloadState;
  /** What is being downloaded. */
  url: string;
  /** The suggested file name, reduced to a bare name (never a path). */
  filename: string;
  /** Its MIME type, when the server says. */
  mimeType?: string;
  /** Its size in bytes, left out while unknown. */
  totalBytes?: number;
  /** The bytes received so far. */
  receivedBytes: number;
  /** Where it is being saved, once decided. */
  path?: string;
  /** Set while it is paused. */
  paused?: true;
  /** Whether `resume()` can restart it after an interruption. */
  canResume?: boolean;
  /** Why it was interrupted. */
  reason?: WebViewDownloadInterruptReason;
}

/**
 * Where {@linkcode WebViewDownloadItem.save} writes a download from the page: a file in one of the
 * app's folders (`directory` `"data"`, `"cache"` or `"documents"`, `path` relative to it, missing
 * folders created), or a writable picked item (`{ picked: handle }` from `saveFile` — the file
 * itself, `path` `""` — or from `pickFolder`, `path` relative to the folder). The same rules as
 * the `fs` capability's and `startFileDrag`'s: no absolute path, no `..` or symlink out of the
 * folder, never the runtime's own folders, and a read-only handle refused.
 */
export interface WebViewDownloadDestination {
  /** An app folder, or a picked file or folder. */
  readonly directory: "data" | "cache" | "documents" | { readonly picked: string };
  /** The file, relative to the folder (`""` for a picked file itself). */
  readonly path: string;
}

/** What a download item's `done` listeners get: how it ended. */
export interface WebViewDownloadDone {
  /** `"completed"`, `"cancelled"` (also when its view closed) or `"interrupted"`. */
  readonly state: "completed" | "cancelled" | "interrupted";
  /** Why it was interrupted. */
  readonly reason?: WebViewDownloadInterruptReason;
  /** Where it was saved, when it got that far. */
  readonly path?: string;
}

/**
 * A download of a view created with `downloads: "app"` (the `will-download` event): its identity,
 * its live state, and the calls that decide and control it. Each call resolves once the runtime
 * took it and rejects with the desktop error shape: `validation` (a download that is over, an
 * action its state does not take, a bad destination), `unsupported` (`pause` / `resume` where
 * `webViewCapabilities().downloadPause` is `false`), `forbidden` (a destination outside the rules),
 * `closed` (its view closed), `failed`.
 */
export interface WebViewDownloadItem {
  /** The download's id (the runtime's; the raw `download` events carry it). */
  readonly id: number;
  /** What is being downloaded. */
  readonly url: string;
  /** The suggested file name (a bare name, never a path). */
  readonly filename: string;
  /** Its MIME type, when the server says. */
  readonly mimeType?: string;
  /** Its size in bytes, when known at the request. */
  readonly totalBytes?: number;
  /** The bytes received so far. */
  readonly receivedBytes: number;
  /** Where it is in its life. */
  readonly state: WebViewDownloadState;
  /** Where it is being saved, once decided. */
  readonly path?: string;
  /** Whether it is paused. */
  readonly paused: boolean;
  /** Whether `resume()` can restart it after an interruption. */
  readonly canResume: boolean;
  /**
   * Answer the request by writing the download to `target`: from the page a
   * {@linkcode WebViewDownloadDestination}; in `desktop.ts` an absolute path (its folder must
   * exist, a file there is replaced; the app needs write permission for it).
   */
  save(target: WebViewDownloadDestination | string): Promise<void>;
  /** Answer the request with the OS save panel (dismissing it cancels the download). */
  saveAs(): Promise<void>;
  /** Cancel it, at any time before its last event. */
  cancel(): Promise<void>;
  /** Pause it (where `webViewCapabilities().downloadPause`). */
  pause(): Promise<void>;
  /** Resume it after a pause, or restart an interrupted one whose `canResume` is `true`. */
  resume(): Promise<void>;
  /**
   * Show the saved file in Finder / Explorer / the file manager. Rejects `not_found` before it
   * has a path. From the page this is `revealInFileManager`, with its rules: the `shell` capability
   * with `reveal` on, and a file in the app's folders or the picked file it was saved to (a file
   * saved through `saveAs()` or into a picked folder is outside them: `forbidden`).
   */
  reveal(): Promise<void>;
  /**
   * Listen for `"updated"` (each progress event, pause and resume, with the item) or `"done"`
   * (once, with how it ended). Returns the unsubscribe.
   */
  on(event: "updated", fn: (item: WebViewDownloadItem) => void): () => void;
  /** See the `"updated"` overload: `"done"` fires once, with how the download ended. */
  on(event: "done", fn: (done: WebViewDownloadDone) => void): () => void;
}

/**
 * A permission a page in a web view asks for (`"camera"`, `"microphone"`, `"screen"`,
 * `"geolocation"`, `"notifications"`, `"midi"`, `"pointer-lock"`, `"storage-access"`, `"sensors"`,
 * `"clipboard-read"`, `"window-management"`, `"local-fonts"`, `"file-system"`,
 * `"multiple-downloads"`, `"autoplay"`; the engine decides which it raises).
 */
export type WebViewPermission = string;

/** A permission request as the handler gets it ({@linkcode WebViewPermissionHandler}). */
export interface WebViewPermissionRequest {
  /** The request's id (the runtime's; the raw `permission-request` events carry it). */
  readonly id: number;
  /** The origin that asked (`"https://example.com"`). */
  readonly origin: string;
  /** What it asked for; one request may name several. */
  readonly permissions: readonly WebViewPermission[];
  /** The frame that asked, where the engine says. */
  readonly frame?: { readonly isMain: boolean; readonly origin?: string };
}

/** The raw `permission-request` event: a request, or its cancellation. */
export type WebViewPermissionRequestEvent =
  | {
    /** The request's id. */
    id: number;
    /** A new request. */
    state: "requested";
    /** The origin that asked. */
    origin: string;
    /** What it asked for. */
    permissions: WebViewPermission[];
    /** The frame that asked, where the engine says. */
    frame?: { isMain: boolean; origin?: string };
  }
  | {
    /** The request's id. */
    id: number;
    /** It went away unanswered (and was refused). */
    state: "cancelled";
  };

/**
 * Answers a web view's permission requests: `true` allows, anything else refuses. A throw, a
 * rejection or no answer within 5 minutes refuses.
 */
export type WebViewPermissionHandler = (
  request: WebViewPermissionRequest,
) => boolean | Promise<boolean>;

/** What {@linkcode WebViewHandle.state} answers. */
export interface WebViewState {
  /** The main frame's URL. */
  url: string;
  /** The document's title. */
  title: string;
  /** The last load state (`"complete"` before the first navigation). */
  load: WebViewLoadState;
  /** Whether `back()` has somewhere to go. */
  canGoBack: boolean;
  /** Whether `forward()` has somewhere to go. */
  canGoForward: boolean;
  /** Its stacking order among the window's views (higher is above; equal: newer above). */
  zOrder: number;
}

/** An engine that hosts web views. */
export type WebViewEngine = "cef" | "wkwebview" | "webview2" | "webkitgtk";

/** What {@linkcode webViewCapabilities} answers. */
export interface WebViewCapabilities {
  /** Whether this window's engine and runtime host web views ({@linkcode createWebView} works). */
  supported: boolean;
  /** The engine that hosts them (empty where unsupported). */
  engines: Array<WebViewEngine>;
  /** Whether {@linkcode WebViewHandle.capture} works. */
  capture: boolean;
  /** Whether {@linkcode WebViewHandle.evaluate} works. */
  evaluate: boolean;
  /** Whether `raise` / `lower` / `setZOrder` work. */
  zOrder: boolean;
  /** Whether `setZoom` / `getZoom` work. */
  zoom: boolean;
  /** Whether `find` / `stopFind` work. */
  find: boolean;
  /** Whether `openDevTools` works (it is still refused unless the app's DevTools are on). */
  devTools: boolean;
  /** Whether `contextMenu: "app"` and the `context-menu` event work. */
  contextMenu: boolean;
  /** Whether `print` works. */
  print: boolean;
  /** Whether the `clipboardRead` / `clipboardWrite` permissions apply. */
  clipboard: boolean;
  /** Whether the app menu's accelerators fire while a view has the keyboard. */
  menuAccelerators: boolean;
  /** Whether keydowns the view's page left unhandled arrive as `keydown` (`forwarded: false`). */
  unhandledKeys: boolean;
  /** Whether `forwardKeys` / `setForwardKeys` work. */
  forwardKeys: boolean;
  /** Whether {@linkcode WebViewHandle.blur} works. */
  blur: boolean;
  /** Whether a forwarded key's release arrives as `keyup`. */
  keyUp: boolean;
  /** Whether `forwardKeys` entries take `beforeMenu: true`. */
  forwardKeysBeforeMenu: boolean;
  /** Whether `downloads: "app"` works (the `will-download` and `download` events). */
  downloadEvents: boolean;
  /** Whether a download item's `pause()` / `resume()` work. */
  downloadPause: boolean;
  /** Whether `permissions: "app"` works ({@linkcode WebViewHandle.setPermissionRequestHandler}). */
  permissionRequests: boolean;
}

/** A web view (from {@linkcode createWebView}, or `win.createWebView` in `desktop.ts`). */
export interface WebViewHandle {
  /** Its id (the runtime's, as a string). */
  readonly id: string;
  /** Move / resize it (CSS pixels, relative to the window's page viewport). */
  setBounds(bounds: WebViewBounds): Promise<void>;
  /**
   * Show or hide it. Hiding a view that has the keyboard hands the keyboard back to the app's
   * page (never activating the app): `focus-change` fires with `{ focused: false, reason:
   * "hidden" }`.
   */
  setVisible(visible: boolean): Promise<void>;
  /** Load another `http:` / `https:` page (rejects `not_allowed_url` otherwise). */
  navigate(url: string): Promise<void>;
  /** Go back in its history. */
  back(): Promise<void>;
  /** Go forward in its history. */
  forward(): Promise<void>;
  /** Reload (`ignoreCache`: bypass the cache). */
  reload(opts?: { ignoreCache?: boolean }): Promise<void>;
  /** Stop loading. */
  stop(): Promise<void>;
  /** Move keyboard focus into the view (this brings its window forward and activates the app). */
  focus(): Promise<void>;
  /**
   * Hand the keyboard back to the app's page if the view has it, without activating the app or
   * raising or reordering a window (`focusWindow()` does both). `focus-change` fires with
   * `{ focused: false, reason: "blur" }`; a view without the keyboard is left as it is. Rejects
   * `unsupported` where `webViewCapabilities().blur` is `false`.
   */
  blur(): Promise<void>;
  /** Its URL, title, load state and history. */
  state(): Promise<WebViewState>;
  /**
   * What the view shows now: PNG by default (JPEG `quality` 0..100), at device pixels unless
   * `scale` (output pixels per CSS pixel, up to 4) says.
   */
  capture(opts?: { format?: "png" | "jpeg"; quality?: number; scale?: number }): Promise<Blob>;
  /**
   * Run `script` (a classic script; its completion value is the result) in the view's main frame,
   * in an isolated world (`laufey-webview`): it shares the DOM but none of the page's globals (a
   * page variable, function or patched prototype is not seen), and no Content-Security-Policy of
   * the page refuses it. A promise completion value is awaited, except on WKWebView and WebKitGTK
   * under a page CSP that refuses `eval`, where the engine's own evaluate returns the completion
   * value as it is (a promise there rejects `not_serializable`: end the script with a plain
   * value). The result is JSON (`undefined` → `null`); a throw rejects `error`, a value JSON can't
   * hold rejects `not_serializable`.
   */
  evaluate<T = unknown>(script: string): Promise<T>;
  /** Put it above the window's other views. */
  raise(): Promise<void>;
  /** Put it below the window's other views (still above the page). */
  lower(): Promise<void>;
  /** Set its stacking order (an integer; higher is above, equal keeps creation order). */
  setZOrder(n: number): Promise<void>;
  /** Zoom its page (0.25 to 5; 1 is 100%). */
  setZoom(factor: number): Promise<void>;
  /** Its page's zoom factor. */
  getZoom(): Promise<number>;
  /**
   * Find `text` in its page (repeating the same text moves to the next match); results come as
   * `find-result`.
   */
  find(text: string, opts?: { forward?: boolean; matchCase?: boolean }): Promise<void>;
  /** End the find (its highlights go). */
  stopFind(): Promise<void>;
  /**
   * Open the engine's DevTools for the view: rejects `not_allowed` unless the app's DevTools are
   * on (`denext desktop dev`, or `desktop.inspectable: true`).
   */
  openDevTools(): Promise<void>;
  /** Show the OS print dialog for its page. */
  print(): Promise<void>;
  /** Replace its `forwardKeys` (an empty list forwards none). */
  setForwardKeys(keys: WebViewForwardKey[]): Promise<void>;
  /** Listen to one of its events; returns the unsubscribe. */
  on<K extends keyof WebViewEventMap>(event: K, fn: (e: WebViewEventMap[K]) => void): () => void;
  /**
   * Answer the view's permission requests (`permissions: "app"`) with `handler`, or `null` to
   * refuse every request at once (the default). The handler allows with `true`; anything else, a
   * throw, a rejection or no answer within 5 minutes refuses. A request cancelled before the
   * answer drops the answer. The raw `permission-request` event fires either way.
   */
  setPermissionRequestHandler(handler: WebViewPermissionHandler | null): void;
  /**
   * Close it (`closed` fires; the handle's calls reject `closed` after). A view that had the
   * keyboard hands it back to the app's page.
   */
  close(): Promise<void>;
}

/** The event names a web view fires. */
const EVENT_NAMES: ReadonlySet<string> = new Set([
  "title",
  "url",
  "load",
  "console",
  "focus-change",
  "new-window",
  "find-result",
  "context-menu",
  "keydown",
  "keyup",
  "download",
  "permission-request",
  "closed",
]);

/** A view's event as the `window` capability pushes it. */
interface WireEvent {
  readonly event: string;
  readonly detail: unknown;
}

/** The most events kept for a view id the page has no handle for yet (the create in flight). */
const MAX_PENDING_EVENTS = 64;
/** The most view ids kept that way. */
const MAX_PENDING_IDS = 16;

/** The page's views by id, the events of ids not adopted yet, and the one subscription. */
interface Router {
  readonly views: Map<string, (e: WireEvent) => void>;
  readonly pending: Map<string, WireEvent[]>;
}

let router: Router | undefined;

/** A `webview` event's id and event, or `null` for a malformed one. */
function wireEventOf(data: unknown): { id: string; e: WireEvent } | null {
  const d = data as { id?: unknown; event?: unknown; detail?: unknown } | null;
  if (typeof d?.id !== "string" || typeof d.event !== "string") return null;
  if (!EVENT_NAMES.has(d.event)) return null;
  return { id: d.id, e: { event: d.event, detail: d.detail ?? {} } };
}

/** Keep `e` for view `id`, whose create is still answering (bounded, oldest ids dropped). */
function keepPending(r: Router, id: string, e: WireEvent): void {
  const queue = r.pending.get(id) ?? [];
  if (queue.length < MAX_PENDING_EVENTS) queue.push(e);
  r.pending.delete(id);
  r.pending.set(id, queue);
  if (r.pending.size > MAX_PENDING_IDS) r.pending.delete(r.pending.keys().next().value!);
}

/** The router, subscribing to the `webview` event on first use. */
function routerOf(): Router {
  if (router) return router;
  const r: Router = { views: new Map(), pending: new Map() };
  router = r;
  subscribeDesktopEvent(CAP, "webview", (data) => {
    const wire = wireEventOf(data);
    if (!wire) return;
    const deliver = r.views.get(wire.id);
    if (deliver) deliver(wire.e);
    else keepPending(r, wire.id, wire.e);
  });
  return r;
}

/** Forget the page's views (tests: a fresh module state per case). */
export function resetWebViewsForTesting(): void {
  router = undefined;
}

/** What the page knows of one of its views. */
interface ViewState extends WebViewListeners {
  readonly id: string;
}

/** Hand `detail` to every listener of `event` (a throwing listener doesn't stop the others). */
function fire(v: ViewState, event: string, detail: unknown): void {
  fireWebViewListeners(v, event, detail, (err) =>
    queueMicrotask(() => {
      throw err;
    }));
}

/** The view closed: its downloads end, `closed` fires once, then every listener goes. */
function markClosed(v: ViewState): void {
  if (v.closed) return;
  v.closed = true;
  router?.views.delete(v.id);
  v.media?.closed();
  fire(v, "closed", {});
  v.listeners.clear();
}

/** Show a saved download in the file manager through the `shell` capability's `reveal`. */
async function revealSaved(path: string, savedTo: unknown): Promise<void> {
  const to = savedTo as { directory?: { picked?: unknown }; path?: unknown } | undefined;
  const handle = to?.directory?.picked;
  // Saved to a picked file: reveal it by its handle; anything else by its path.
  const args = typeof handle === "string" && to?.path === "" ? { handle } : { path };
  await desktopRpc("shell", "reveal", args);
}

/** One call on view `v` (rejects `closed` once it closed, without a request). */
async function viewCall<O = unknown>(
  v: ViewState,
  method: string,
  args: Record<string, unknown> = {},
): Promise<O> {
  if (v.closed) throw desktopError(CAP, "webViewCall", "closed", "the web view is closed");
  try {
    return await desktopRpc<O>(CAP, "webViewCall", { id: v.id, method, args });
  } catch (err) {
    if ((err as { code?: unknown })?.code === "closed") markClosed(v);
    throw err;
  }
}

/** The handle over view `v`: each call a `webViewCall` over the bridge. */
function handleOf(v: ViewState): WebViewHandle {
  return webViewHandle(v.id, v, {
    call: (method, args) => viewCall(v, method, args),
    capture: async (opts) => {
      const out = await viewCall<{ base64?: unknown; type?: unknown }>(
        v,
        "capture",
        definedOnly(opts),
      );
      const bytes = base64ToBytes(typeof out?.base64 === "string" ? out.base64 : "");
      return new Blob([bytes], { type: typeof out?.type === "string" ? out.type : "image/png" });
    },
    evaluate: async (script) => {
      const out = await viewCall<{ value?: unknown }>(v, "evaluate", { script });
      return out?.value ?? null;
    },
    close: async () => {
      if (v.closed) return;
      await viewCall(v, "close");
      markClosed(v);
    },
    control: async (download, action, target) => {
      await viewCall(v, "controlDownload", {
        download,
        action,
        ...(target !== undefined ? { target } : {}),
      });
    },
    respond: async (request, allow) => {
      await viewCall(v, "respondToPermissionRequest", { request, allow });
    },
    reveal: revealSaved,
    fail: (code, message) => desktopError(CAP, "webViewCall", code, message),
    onListenerError: (err) =>
      queueMicrotask(() => {
        throw err;
      }),
  });
}

/** Make the handle of view `id` and hand it the events that arrived before it. */
function adopt(id: string): WebViewHandle {
  const r = routerOf();
  const v: ViewState = { id, listeners: new Map(), closed: false };
  const queued = r.pending.get(id) ?? [];
  r.pending.delete(id);
  const process = (e: WireEvent) => {
    if (v.closed) return;
    if (e.event === "closed") return markClosed(v);
    fire(v, e.event, e.detail);
    if (e.event === "download") v.media?.download(e.detail);
    else if (e.event === "permission-request") v.media?.permissionRequest(e.detail);
  };
  // Events that came before the handle are delivered once the caller had a chance to subscribe
  // (the create's continuation runs first); later ones queue behind them, in order.
  let backlog: WireEvent[] | null = queued.length > 0 ? queued : null;
  r.views.set(id, (e) => backlog ? void backlog.push(e) : process(e));
  if (backlog) {
    const events = backlog; // later events push onto this same list until it is taken
    setTimeout(() => {
      backlog = null;
      events.forEach(process);
    }, 0);
  }
  return handleOf(v);
}

/**
 * Open a web view of another site inside this window, above the page, at `bounds`. It belongs to
 * this window and closes with it; a reload or navigation of the page does not close it.
 *
 * The view is isolated: it never gets the desktop bridge, its storage is its partition's (never
 * the app's), and its navigations never reach the window's navigation guard. It draws above all of
 * the page's HTML: hide it (or show a {@linkcode WebViewHandle.capture} snapshot in its place)
 * while a menu or dialog overlaps it. {@linkcode attachWebView} keeps it on an element.
 *
 * @example
 * ```ts
 * import { attachWebView, createWebView, webViewCapabilities } from "denext/desktop/window";
 *
 * if ((await webViewCapabilities()).supported) {
 *   const tile = document.querySelector("#docs")!;
 *   const view = await createWebView({ url: "https://docs.example", bounds: { x: 0, y: 0, width: 0, height: 0 } });
 *   const detach = attachWebView(view, tile);
 *   view.on("title", ({ title }) => (tile.ariaLabel = title));
 * }
 * ```
 *
 * @param opts The URL, where it sits, and its partition, popup, download and permission policies.
 * @returns Its handle. Rejects `unsupported` where this engine / runtime has no web views,
 *   `not_allowed_url` for a URL that is not `http:` / `https:`, the app's own origin, or outside
 *   `desktop.webViews.allowedOrigins`, `limit` past `desktop.webViews.limit` views in this window,
 *   `validation` for a bad option; off desktop `unavailable`.
 */
export async function createWebView(opts: CreateWebViewOptions): Promise<WebViewHandle> {
  routerOf();
  const out = await desktopRpc<{ id?: unknown }>(CAP, "webViewCreate", { options: { ...opts } });
  if (typeof out?.id !== "string" || out.id === "") {
    throw desktopError(CAP, "webViewCreate", "bridge_error", "the runtime answered no web view id");
  }
  return adopt(out.id);
}

/**
 * Whether this window can host web views, on which engine, and which of their features work
 * (`capture`, `evaluate`, `zOrder`, `zoom`, `find`, `devTools`, `contextMenu`, `print`,
 * `clipboard`, `menuAccelerators`, `unhandledKeys`, `forwardKeys`, `blur`, `keyUp`,
 * `forwardKeysBeforeMenu`, `downloadEvents`, `downloadPause`, `permissionRequests`). On a runtime without web views it resolves `supported: false` and every feature
 * `false`; a feature the engine or runtime lacks is `false`, and its call rejects `unsupported`.
 *
 * @returns The capabilities. Off desktop it rejects `unavailable`.
 */
export async function webViewCapabilities(): Promise<WebViewCapabilities> {
  const raw = await desktopRpc<Record<string, unknown>>(CAP, "webViewCapabilities", {});
  const supported = raw?.supported === true;
  const engines = Array.isArray(raw?.engines)
    ? (raw.engines as unknown[]).filter((e): e is WebViewEngine =>
      e === "cef" || e === "wkwebview" || e === "webview2" || e === "webkitgtk"
    )
    : [];
  const flag = (key: string) => supported && raw?.[key] === true;
  return {
    supported,
    engines: supported ? engines : [],
    capture: flag("capture"),
    evaluate: flag("evaluate"),
    zOrder: flag("zOrder"),
    zoom: flag("zoom"),
    find: flag("find"),
    devTools: flag("devTools"),
    contextMenu: flag("contextMenu"),
    print: flag("print"),
    clipboard: flag("clipboard"),
    menuAccelerators: flag("menuAccelerators"),
    unhandledKeys: flag("unhandledKeys"),
    forwardKeys: flag("forwardKeys"),
    blur: flag("blur"),
    keyUp: flag("keyUp"),
    forwardKeysBeforeMenu: flag("forwardKeysBeforeMenu"),
    downloadEvents: flag("downloadEvents"),
    downloadPause: flag("downloadPause"),
    permissionRequests: flag("permissionRequests"),
  };
}

// --- attachWebView ---------------------------------------------------------------------------

/** The slice of a DOM element {@linkcode attachWebView} measures. */
export interface WebViewAnchor {
  /** Its border box, in CSS pixels relative to the viewport. */
  getBoundingClientRect(): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  /** `false` once it is out of the document. */
  readonly isConnected?: boolean;
  /** Its parent element (walked for the scroll containers that clip it). */
  readonly parentElement?: WebViewAnchor | null;
  /** Its running animations and transitions (`follow: "frame"` keeps measuring while any runs). */
  getAnimations?(): ReadonlyArray<{ readonly playState?: string }>;
}

/** Options for {@linkcode attachWebView}. */
export interface AttachWebViewOptions {
  /**
   * Hide the view while the element is entirely outside the viewport or clipped away by a
   * scrolling ancestor (default `true`). It is always hidden while the element is out of the
   * document, `display: none` or zero-sized.
   */
  readonly hideWhenOutOfView?: boolean;
  /**
   * Fit the view to the part of the element that is visible: inside the viewport and inside every
   * ancestor that clips its overflow (a scroll container) (default `true`). A native view can't
   * be cropped, so a partly scrolled-away element gets a smaller view whose page lays out at that
   * size (it is resized, not cut). `false` keeps the whole element box, and the view then draws
   * over whatever is outside the scroll container (a toolbar, the window's other content).
   */
  readonly clip?: boolean;
  /**
   * How the view follows moves the element's own box doesn't report. `"events"` (default):
   * resizes, scrolls, the window's resize and display scale changes. `"frame"` adds a measure on
   * every animation frame while a CSS transition or animation runs on the element or one of its
   * ancestors (a `transform` slide, a sheet moving in), from its `transitionrun` /
   * `animationstart` until none runs there, and nothing between them: no polling while idle. A
   * move no event reports (a transform set from script, a Web Animations `element.animate()`)
   * needs {@linkcode WebViewAttachment.relayout}.
   */
  readonly follow?: "events" | "frame";
}

/**
 * What {@linkcode attachWebView} returns: call it (or its `detach`) to stop following;
 * `relayout()` measures the element again at the next animation frame, for a move no event
 * reports.
 */
export interface WebViewAttachment {
  /** Stop following (the view stays as it is, open). */
  (): void;
  /** The same as calling the attachment. */
  detach(): void;
  /**
   * Measure the element again at the next animation frame and move or show / hide the view to
   * match (at most one `setBounds` per frame, only on a change). A no-op once detached.
   */
  relayout(): void;
}

/** A transition / animation event as {@linkcode attachWebView}'s frame follower reads it. */
interface MotionEvent {
  readonly target?: unknown;
}

/** The browser globals {@linkcode attachWebView} uses, each feature-detected. */
interface LayoutGlobals {
  ResizeObserver?: new (cb: () => void) => { observe(el: unknown): void; disconnect(): void };
  IntersectionObserver?: new (
    cb: (entries: Array<{ isIntersecting: boolean }>) => void,
  ) => { observe(el: unknown): void; disconnect(): void };
  requestAnimationFrame?: (cb: () => void) => number;
  cancelAnimationFrame?: (id: number) => void;
  matchMedia?: (query: string) => {
    addEventListener?(type: string, fn: () => void, opts?: unknown): void;
    removeEventListener?(type: string, fn: () => void): void;
  };
  addEventListener?: (type: string, fn: (e?: MotionEvent) => void, opts?: unknown) => void;
  removeEventListener?: (type: string, fn: (e?: MotionEvent) => void, opts?: unknown) => void;
  devicePixelRatio?: number;
  innerWidth?: number;
  innerHeight?: number;
  getComputedStyle?: (el: unknown) => ClipStyle;
}

/** The element's rectangle as bounds, or `null` while it shows nothing (detached, hidden, empty). */
function anchorBounds(element: WebViewAnchor): WebViewBounds | null {
  if (element.isConnected === false) return null;
  const r = element.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** `b` cut to the viewport and to every ancestor of `element` that clips; `null`: nothing left. */
function clippedBounds(
  g: LayoutGlobals,
  element: WebViewAnchor,
  b: WebViewBounds,
): WebViewBounds | null {
  const viewport = typeof g.innerWidth === "number" && typeof g.innerHeight === "number"
    ? { x: 0, y: 0, width: g.innerWidth, height: g.innerHeight }
    : b;
  const styleOf = g.getComputedStyle;
  const clippers = styleOf ? clippingAncestors(element, (el) => styleOf(el)) : [];
  const out = visiblePart(b, clippers, viewport);
  return out ? { x: out.x, y: out.y, width: out.width, height: out.height } : null;
}

/** Whether `b` lies entirely outside the viewport (unknown viewport size: never). */
function outsideViewport(g: LayoutGlobals, b: WebViewBounds): boolean {
  const w = g.innerWidth;
  const h = g.innerHeight;
  if (typeof w !== "number" || typeof h !== "number") return false;
  return b.x + b.width <= 0 || b.y + b.height <= 0 || b.x >= w || b.y >= h;
}

/** {@linkcode attachWebView}'s state. */
interface Attachment {
  readonly g: LayoutGlobals;
  readonly handle: WebViewHandle;
  readonly element: WebViewAnchor;
  readonly hideOutOfView: boolean;
  readonly clip: boolean;
  stopped: boolean;
  frame?: number;
  inFlight: boolean;
  dirty: boolean;
  intersecting: boolean;
  lastKey?: string;
  lastVisible?: boolean;
  /** Stop following (observers and listeners off). */
  detach: () => void;
}

/** The transition / animation events that start (and end) a frame follower's measuring. */
const MOTION_START = ["transitionrun", "animationstart"] as const;
const MOTION_END = [
  "transitionend",
  "transitioncancel",
  "animationend",
  "animationcancel",
] as const;
/** Frames measured after the last motion with no running-animation API to ask. */
const MOTION_TAIL_FRAMES = 2;

/** `follow: "frame"`: an animation-frame loop while motion runs on the element's chain. */
interface FrameFollower {
  /** Motions started minus ended (the fallback where `getAnimations` is missing). */
  running: number;
  /** The loop's pending frame. */
  frame?: number;
  /** Frames still to measure once nothing runs. */
  tail: number;
}

/** Whether `target` is the element or one of its ancestors. */
function onChain(element: WebViewAnchor, target: unknown): boolean {
  for (let el: WebViewAnchor | null | undefined = element; el; el = el.parentElement) {
    if (el === target) return true;
  }
  return false;
}

/**
 * Whether an animation or transition runs on the element's chain: asked of each element's
 * `getAnimations()` where it exists, else the started-minus-ended count.
 */
function motionRuns(element: WebViewAnchor, f: FrameFollower): boolean {
  if (typeof element.getAnimations !== "function") return f.running > 0;
  for (let el: WebViewAnchor | null | undefined = element; el; el = el.parentElement) {
    const list = typeof el.getAnimations === "function" ? el.getAnimations() : [];
    if (list.some((x) => x.playState === "running" || x.playState === "pending")) return true;
  }
  return false;
}

/** Ask for one flush at the next animation frame (at most one pending). */
function schedule(a: Attachment): void {
  if (a.stopped) return;
  a.dirty = true;
  if (a.frame !== undefined || a.inFlight) return;
  const run = () => {
    a.frame = undefined;
    void flush(a);
  };
  a.frame = a.g.requestAnimationFrame
    ? a.g.requestAnimationFrame(run)
    : setTimeout(run, 16) as unknown as number;
}

/** The element's bounds when the view should show there, else `null` (hidden). */
function shownBounds(a: Attachment): WebViewBounds | null {
  const b = anchorBounds(a.element);
  if (b === null) return null;
  if (a.hideOutOfView && (!a.intersecting || outsideViewport(a.g, b))) return null;
  return a.clip ? clippedBounds(a.g, a.element, b) : b;
}

/** Send what changed: the bounds (when shown and moved), then the visibility (when it flips). */
async function sync(a: Attachment, b: WebViewBounds | null): Promise<void> {
  if (b !== null) {
    const key = `${b.x},${b.y},${b.width},${b.height}`;
    if (key !== a.lastKey) {
      a.lastKey = key;
      await a.handle.setBounds(b);
    }
  }
  const show = b !== null;
  if (!a.stopped && show !== a.lastVisible) {
    a.lastVisible = show;
    await a.handle.setVisible(show);
  }
}

/** Bring the view in line with the element (one pass; another is scheduled if more changed). */
async function flush(a: Attachment): Promise<void> {
  if (a.stopped || !a.dirty) return;
  a.dirty = false;
  a.inFlight = true;
  try {
    await sync(a, shownBounds(a));
  } catch (err) {
    // A closed view stops the attachment; anything else is retried on the next change.
    if ((err as { code?: unknown })?.code === "closed") a.detach();
    a.lastKey = undefined;
    a.lastVisible = undefined;
  } finally {
    a.inFlight = false;
  }
  if (a.dirty) schedule(a);
}

/**
 * Keep `handle` glued to `element`'s border box: the view follows the element through resizes,
 * scrolling (any scroller), window resizes and display scale changes, at most one `setBounds` per
 * animation frame and only when the rectangle changed. It is hidden (`setVisible(false)`) while the
 * element is out of the document, `display: none`, zero-sized or out of view, and shown again when
 * it is back — so the attachment owns the view's visibility while attached. The view only ever
 * covers the element's visible part: its box cut to the viewport and to the scroll containers
 * around it (`clip: false` keeps the whole box).
 *
 * A move made only by a CSS `transform` (on the element or an ancestor) changes none of those:
 * `follow: "frame"` measures on every frame while a CSS transition or animation runs there, and
 * `relayout()` measures once, for any other move.
 *
 * @example
 * ```ts
 * const attachment = attachWebView(view, tile, { follow: "frame" });
 * panel.style.transform = "translateX(0)"; // a CSS transition: followed frame by frame
 * tile.animate([{ translate: "0 40px" }], 200).finished.then(() => attachment.relayout());
 * attachment(); // stop
 * ```
 *
 * @param handle The view ({@linkcode createWebView}).
 * @param element The placeholder element the view should cover.
 * @param options `hideWhenOutOfView`, `clip`, `follow`.
 * @returns The attachment: call it (or `detach()`) to stop following (the view stays as it is,
 *   open); `relayout()` measures again. It also stops when the view closes.
 */
export function attachWebView(
  handle: WebViewHandle,
  element: WebViewAnchor,
  options: AttachWebViewOptions = {},
): WebViewAttachment {
  const g = globalThis as unknown as LayoutGlobals;
  const a = {
    g,
    handle,
    element,
    hideOutOfView: options.hideWhenOutOfView !== false,
    clip: options.clip !== false,
    stopped: false,
    inFlight: false,
    dirty: false,
    intersecting: true,
  } as Attachment; // `detach` is set below, before anything can call it
  const onChange = () => schedule(a);
  const resize = g.ResizeObserver ? new g.ResizeObserver(onChange) : undefined;
  resize?.observe(element);
  const intersection = g.IntersectionObserver
    ? new g.IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) a.intersecting = last.isIntersecting;
      schedule(a);
    })
    : undefined;
  intersection?.observe(element);
  // Scroll events don't bubble; a capture listener on the window hears every scroller's.
  g.addEventListener?.("scroll", onChange, { capture: true, passive: true });
  g.addEventListener?.("resize", onChange);
  // devicePixelRatio: a resolution query for the current ratio, re-armed for each new one.
  let media: ReturnType<NonNullable<LayoutGlobals["matchMedia"]>> | undefined;
  const onRatio = () => {
    media?.removeEventListener?.("change", onRatio);
    media = g.matchMedia?.(`(resolution: ${g.devicePixelRatio ?? 1}dppx)`);
    media?.addEventListener?.("change", onRatio);
    schedule(a);
  };
  onRatio();
  const motion = options.follow === "frame" ? followFrames(a) : undefined;
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    a.stopped = true;
    if (a.frame !== undefined) {
      if (g.cancelAnimationFrame) g.cancelAnimationFrame(a.frame);
      else clearTimeout(a.frame);
      a.frame = undefined;
    }
    resize?.disconnect();
    intersection?.disconnect();
    g.removeEventListener?.("scroll", onChange, { capture: true });
    g.removeEventListener?.("resize", onChange);
    media?.removeEventListener?.("change", onRatio);
    motion?.();
    stopOnClose();
  };
  a.detach = detach;
  const stopOnClose = handle.on("closed", detach);
  return Object.assign(() => detach(), {
    detach,
    relayout: () => schedule(a),
  });
}

/** Measure in this frame (a frame already asked for, or a call in flight, takes it over). */
function measureNow(a: Attachment): void {
  a.dirty = true;
  if (a.frame === undefined && !a.inFlight) void flush(a);
}

/** One animation frame (or a 16 ms timer without `requestAnimationFrame`). */
function nextFrame(g: LayoutGlobals, fn: () => void): number {
  return g.requestAnimationFrame
    ? g.requestAnimationFrame(fn)
    : setTimeout(fn, 16) as unknown as number;
}

/**
 * `follow: "frame"`: a transition / animation starting on the element's chain runs a measure on
 * every frame until none runs there (and {@linkcode MOTION_TAIL_FRAMES} more, for the last
 * position); nothing runs between motions. Returns the stop.
 */
function followFrames(a: Attachment): () => void {
  const g = a.g;
  const f: FrameFollower = { running: 0, tail: 0 };
  const tick = () => {
    f.frame = undefined;
    if (a.stopped) return;
    measureNow(a);
    // Out of the document: no end event may come for its motions.
    if (a.element.isConnected === false) {
      f.running = 0;
      return;
    }
    if (motionRuns(a.element, f)) f.tail = MOTION_TAIL_FRAMES;
    else if (f.tail-- <= 0) return;
    f.frame = nextFrame(g, tick);
  };
  const start = (e?: MotionEvent) => {
    if (!onChain(a.element, e?.target)) return;
    f.running++;
    f.tail = MOTION_TAIL_FRAMES;
    if (f.frame === undefined) f.frame = nextFrame(g, tick);
  };
  const end = (e?: MotionEvent) => {
    if (!onChain(a.element, e?.target)) return;
    f.running = Math.max(0, f.running - 1);
    schedule(a);
  };
  // They bubble: a capture listener on the window hears the whole document's.
  for (const type of MOTION_START) g.addEventListener?.(type, start, { capture: true });
  for (const type of MOTION_END) g.addEventListener?.(type, end, { capture: true });
  return () => {
    for (const type of MOTION_START) g.removeEventListener?.(type, start, { capture: true });
    for (const type of MOTION_END) g.removeEventListener?.(type, end, { capture: true });
    if (f.frame !== undefined) {
      if (g.cancelAnimationFrame) g.cancelAnimationFrame(f.frame);
      else clearTimeout(f.frame);
      f.frame = undefined;
    }
  };
}
