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
   * `"browser"` cancels it in the view and opens its URL in the system browser.
   */
  downloads?: "deny" | "ask" | "browser";
  /**
   * The camera / microphone / geolocation / notification prompts: `"deny"` (default) refuses them
   * without a prompt, `"ask"` asks the user. The object form also sets the clipboard: `prompts`
   * (default `"deny"`) is the string form's choice, `clipboardRead` (default `false`) lets the
   * site read the clipboard, `clipboardWrite` (default `true`) lets it write on a user gesture.
   */
  permissions?: "deny" | "ask" | WebViewPermissions;
  /**
   * The context menu: `"native"` (default) is the engine's own; `"app"` suppresses it so the page
   * draws its own from the `context-menu` event (which fires in both modes).
   */
  contextMenu?: "native" | "app";
  /** Replaces the engine's user agent string for this view. */
  userAgent?: string;
}

/** The object form of {@linkcode CreateWebViewOptions.permissions}. */
export interface WebViewPermissions {
  /** Camera / microphone / geolocation / notification prompts (default `"deny"`). */
  prompts?: "deny" | "ask";
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
  /** The native view gained or lost keyboard focus. */
  "focus-change": { focused: boolean };
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
  /** The view closed (its `close()`, or its window closed). Nothing follows it. */
  closed: Record<string, never>;
}

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
}

/** A web view (from {@linkcode createWebView}, or `win.createWebView` in `desktop.ts`). */
export interface WebViewHandle {
  /** Its id (the runtime's, as a string). */
  readonly id: string;
  /** Move / resize it (CSS pixels, relative to the window's page viewport). */
  setBounds(bounds: WebViewBounds): Promise<void>;
  /** Show or hide it. */
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
  /** Move keyboard focus into the view. */
  focus(): Promise<void>;
  /** Its URL, title, load state and history. */
  state(): Promise<WebViewState>;
  /**
   * What the view shows now: PNG by default (JPEG `quality` 0..100), at device pixels unless
   * `scale` (output pixels per CSS pixel, up to 4) says.
   */
  capture(opts?: { format?: "png" | "jpeg"; quality?: number; scale?: number }): Promise<Blob>;
  /**
   * Run `script` in the view, isolated from the view's own scripts (it shares the DOM); a promise
   * completion value is awaited. The result is JSON (`undefined` → `null`); a throw rejects
   * `error`, a value JSON can't hold rejects `not_serializable`.
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
  /** Listen to one of its events; returns the unsubscribe. */
  on<K extends keyof WebViewEventMap>(event: K, fn: (e: WebViewEventMap[K]) => void): () => void;
  /** Close it (`closed` fires; the handle's calls reject `closed` after). */
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

/** The view closed: `closed` fires once, then every listener goes. */
function markClosed(v: ViewState): void {
  if (v.closed) return;
  v.closed = true;
  router?.views.delete(v.id);
  fire(v, "closed", {});
  v.listeners.clear();
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
    if (e.event === "closed") markClosed(v);
    else fire(v, e.event, e.detail);
  };
  // Events that came before the handle are delivered once the caller had a chance to subscribe
  // (the create's continuation runs first); later ones queue behind them, in order.
  let backlog: WireEvent[] | null = queued.length > 0 ? queued : null;
  r.views.set(id, (e) => backlog ? void backlog.push(e) : process(e));
  if (backlog) {
    setTimeout(() => {
      const events = backlog ?? [];
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
 * `clipboard`). On a runtime without web views it resolves `supported: false` and every feature
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
  addEventListener?: (type: string, fn: () => void, opts?: unknown) => void;
  removeEventListener?: (type: string, fn: () => void, opts?: unknown) => void;
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
 * @param handle The view ({@linkcode createWebView}).
 * @param element The placeholder element the view should cover.
 * @param options `hideWhenOutOfView`, `clip`.
 * @returns A function that stops following (the view stays as it is, open). It also stops when the
 *   view closes.
 */
export function attachWebView(
  handle: WebViewHandle,
  element: WebViewAnchor,
  options: AttachWebViewOptions = {},
): () => void {
  const g = globalThis as unknown as LayoutGlobals;
  const a: Attachment = {
    g,
    handle,
    element,
    hideOutOfView: options.hideWhenOutOfView !== false,
    clip: options.clip !== false,
    stopped: false,
    inFlight: false,
    dirty: false,
    intersecting: true,
    detach: () => {},
  };
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
    stopOnClose();
  };
  a.detach = detach;
  const stopOnClose = handle.on("closed", detach);
  return detach;
}
