/**
 * The `WebViewHandle` shape both sides build: the page's (over the bridge, `./webview.ts`) and
 * `desktop.ts`'s (over the runtime view, `./caps/webview.ts`). Each supplies the operations; the
 * method names and argument objects are the wire's (`webViewCall`'s `method` / `args`).
 *
 * Client-safe: no Deno APIs, nothing runs at import. Internal to denext.
 *
 * @module
 */

import type { WebViewDownloadAction, WebViewHandle, WebViewState } from "./webview.ts";
import { createWebViewMedia, type WebViewMedia } from "./webview-downloads.ts";

/** What a side supplies to build a handle. */
export interface WebViewOps {
  /** Run `method` with `args` (the wire's names); resolves its result. */
  call(method: string, args: Record<string, unknown>): Promise<unknown>;
  /** `capture` as a Blob. */
  capture(opts: { format?: "png" | "jpeg"; quality?: number; scale?: number }): Promise<Blob>;
  /** `evaluate`'s JSON value. */
  evaluate(script: string): Promise<unknown>;
  /** Close the view. */
  close(): Promise<void>;
  /** Decide or control download `id` (`controlDownload`; `target`: `save`'s destination). */
  control(id: number, action: WebViewDownloadAction, target?: unknown): Promise<void>;
  /** Answer permission request `id` (`respondToPermissionRequest`). */
  respond(id: number, allow: boolean): Promise<void>;
  /** Show download `id`'s file, `path` (the one the runtime reported), in the file manager. */
  reveal(path: string, id: number): Promise<void>;
  /** The side's error for a call refused before it reaches the runtime. */
  fail(code: string, message: string): Error;
  /** A listener threw (it never stops the others). */
  onListenerError(err: unknown): void;
  /** The permission handler's limit (tests shorten it). */
  readonly answerMs?: number;
}

/** A view's listeners by event name, whether it closed, and its downloads and requests. */
export interface WebViewListeners {
  readonly listeners: Map<string, Set<(e: unknown) => void>>;
  closed: boolean;
  /** Its downloads and permission requests (set by {@linkcode webViewHandle}). */
  media?: WebViewMedia;
}

/** Add `fn` for `event` (a no-op on a closed view); returns the unsubscribe. */
function addWebViewListener(
  v: WebViewListeners,
  event: string,
  fn: (e: unknown) => void,
): () => void {
  if (v.closed) return () => {};
  let set = v.listeners.get(event);
  if (!set) v.listeners.set(event, set = new Set());
  set.add(fn);
  return () => void v.listeners.get(event)?.delete(fn);
}

/** Hand `detail` to every listener of `event`; a throwing one goes to `onError`, not the others. */
export function fireWebViewListeners(
  v: WebViewListeners,
  event: string,
  detail: unknown,
  onError: (err: unknown) => void,
): void {
  for (const fn of [...(v.listeners.get(event) ?? [])]) {
    try {
      fn(detail);
    } catch (err) {
      onError(err);
    }
  }
}

/** `o` without its `undefined` values (a wire argument object). */
export function definedOnly(o: object | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
}

/** A state answer as {@linkcode WebViewState} (the five fields; unknown values defaulted). */
export function webViewStateOf(raw: unknown): WebViewState {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const load = s.load;
  return {
    url: typeof s.url === "string" ? s.url : "",
    title: typeof s.title === "string" ? s.title : "",
    load: load === "loading" || load === "interactive" || load === "failed" ? load : "complete",
    canGoBack: s.canGoBack === true,
    canGoForward: s.canGoForward === true,
    zOrder: typeof s.zOrder === "number" && Number.isFinite(s.zOrder) ? s.zOrder : 0,
  };
}

/**
 * The handle of view `id` over `ops`, its listeners in `v`.
 *
 * @param id The view's id.
 * @param v Its listeners.
 * @param ops The side's operations.
 * @returns The handle.
 */
export function webViewHandle(id: string, v: WebViewListeners, ops: WebViewOps): WebViewHandle {
  const act = async (method: string, args: Record<string, unknown> = {}): Promise<void> => {
    await ops.call(method, args);
  };
  const media = createWebViewMedia({
    control: ops.control,
    respond: ops.respond,
    reveal: ops.reveal,
    fail: ops.fail,
    onListenerError: ops.onListenerError,
    hasListeners: (event) => (v.listeners.get(event)?.size ?? 0) > 0,
    fire: (event, detail) => fireWebViewListeners(v, event, detail, ops.onListenerError),
    ...(ops.answerMs !== undefined ? { answerMs: ops.answerMs } : {}),
  });
  v.media = media;
  return {
    id,
    setBounds: (b) => act("setBounds", { x: b.x, y: b.y, width: b.width, height: b.height }),
    setVisible: (visible) => act("setVisible", { visible }),
    navigate: (url) => act("navigate", { url }),
    back: () => act("back"),
    forward: () => act("forward"),
    reload: (opts) =>
      act("reload", opts?.ignoreCache !== undefined ? { ignoreCache: opts.ignoreCache } : {}),
    stop: () => act("stop"),
    focus: () => act("focus"),
    blur: () => act("blur"),
    state: async () => webViewStateOf(await ops.call("state", {})),
    capture: (opts) => ops.capture({ ...opts }),
    evaluate: async <T>(script: string) => await ops.evaluate(script) as T,
    raise: () => act("raise"),
    lower: () => act("lower"),
    setZOrder: (n) => act("setZOrder", { zOrder: n }),
    setZoom: (factor) => act("setZoom", { factor }),
    getZoom: async () => {
      const out = await ops.call("getZoom", {}) as { factor?: unknown } | null;
      return typeof out?.factor === "number" ? out.factor : 1;
    },
    find: (text, opts) => act("find", { text, ...definedOnly(opts) }),
    stopFind: () => act("stopFind"),
    openDevTools: () => act("openDevTools"),
    print: () => act("print"),
    setForwardKeys: (keys) =>
      act("setForwardKeys", {
        keys: keys.map((k) => typeof k === "string" ? k : { ...k }),
      }),
    on: (event, fn) => addWebViewListener(v, event, fn as (e: unknown) => void),
    setPermissionRequestHandler: (handler) => media.setPermissionRequestHandler(handler),
    close: () => ops.close(),
  };
}
