/**
 * `react-native-webview` for denext's React Native mode: `WebView` as an `<iframe>`.
 *
 * React Native mode resolves `import { WebView } from "react-native-webview"` here (unless
 * `reactNative: { aliases: { "react-native-webview": false } }`). The real package's web entry
 * renders a "not supported" notice; this one loads the page in an `<iframe>` and keeps the
 * package's messaging contract:
 *
 * - `source={{ uri }}` loads the URL; `source={{ html, baseUrl }}` loads the markup through
 *   `srcdoc` (with a `<base href>` for `baseUrl`), in a sandbox WITHOUT `allow-same-origin`:
 *   inline HTML gets an opaque origin, so it cannot read the app's cookies or storage.
 * - Native shell: unlike React Native's separate WKWebView, this frame lives INSIDE the app's
 *   Capacitor WebView. Native plugin calls are accepted from the main frame only: on Android by
 *   Capacitor 8's bridge (not with `android.useLegacyBridge`, which `denext mobile doctor
 *   --release` flags), and on iOS by the guard in the `DenextBridgeViewController` every
 *   `denext mobile add` of a denext native plugin writes (Capacitor's own iOS handler answers
 *   every frame; `denext mobile doctor` flags a bridge written before the guard). The framed
 *   page still runs in the app's WebView process, so frame only content you trust.
 * - `window.ReactNativeWebView.postMessage(data)` inside the page reaches `onMessage` as
 *   `{ nativeEvent: { data } }`. A plain `window.parent.postMessage(string, "*")` from a page
 *   in the frame does too.
 * - The ref's `postMessage(data)` delivers a `message` event (`event.data === data`) to the
 *   page, as the package does.
 * - `injectJavaScript(code)`, `injectedJavaScript` and `injectedJavaScriptBeforeContentLoaded`
 *   run for inline HTML (inlined as `<script>`s, or sent through the in-page bridge) and for a
 *   same-origin URL (evaluated in the frame at load). A cross-origin URL cannot be scripted by
 *   the embedding page at all: injection is skipped with a one-time warning.
 * - `goBack` / `goForward` / `reload` / `stopLoading` work on a same-origin frame; `reload`
 *   reloads a cross-origin one by resetting its `src`.
 * - `javaScriptEnabled={false}` drops `allow-scripts` from the sandbox.
 *
 * Limits: a web page cannot see inside a cross-origin frame, so there is no per-navigation
 * `onShouldStartLoadWithRequest` / `originWhitelist` enforcement (the first is never called,
 * the second is ignored), `onNavigationStateChange` fires once per frame load, `title` and
 * `canGoBack` are read only from a same-origin page, `source.headers` / `method` / `body`
 * cannot be sent, and sites that forbid framing (`X-Frame-Options`, CSP `frame-ancestors`)
 * refuse to load. Scroll, zoom, cookie, cache, file-access and media props are accepted and
 * ignored. Open such pages with `openExternal` from `denext/mobile` instead.
 *
 * @example
 * ```ts
 * import { WebView } from "react-native-webview"; // React Native mode → this module
 * import { h } from "denext/jsx-runtime";
 *
 * h(WebView, {
 *   source: { html: "<button onclick=\"ReactNativeWebView.postMessage('hi')\">Hi</button>" },
 *   onMessage: (e: { nativeEvent: { data: string } }) => console.log(e.nativeEvent.data),
 *   style: { flex: 1 },
 * });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useImperativeHandle, useMemo, useRef } from "../runtime/hooks.ts";
import { hostView, viewStyle } from "../expo/internal/common.ts";

/** A page source: a URL, or inline HTML. */
export type WebViewSource =
  | {
    /** The URL to load. */
    uri: string;
    /** Request headers (cannot be sent from a frame; ignored). */
    headers?: Record<string, string>;
    /** The HTTP method (ignored: a frame always GETs). */
    method?: string;
    /** The request body (ignored). */
    body?: string;
  }
  | {
    /** The markup to load. */
    html: string;
    /** The base URL relative links in `html` resolve against. */
    baseUrl?: string;
  };

/** What every WebView event carries (`nativeEvent`). */
export interface WebViewNativeEvent {
  /** The frame's URL (`about:srcdoc` for inline HTML; the `src` for a cross-origin page). */
  url: string;
  /** Whether a load is in flight. */
  loading: boolean;
  /** The page title (same-origin pages only; else empty). */
  title: string;
  /** Whether the frame can go back (always `false`: a frame's history is not observable). */
  canGoBack: boolean;
  /** Whether the frame can go forward (always `false`). */
  canGoForward: boolean;
  /** Always `0`. */
  lockIdentifier: number;
}

/** A navigation event's `nativeEvent` (`onNavigationStateChange` gets it directly). */
export interface WebViewNavigation extends WebViewNativeEvent {
  /** Always `"other"` here. */
  navigationType: "click" | "formsubmit" | "backforward" | "reload" | "formresubmit" | "other";
  /** The top document's URL. */
  mainDocumentURL?: string;
}

/** A message event's `nativeEvent`. */
export interface WebViewMessage extends WebViewNativeEvent {
  /** What the page posted (always a string). */
  data: string;
}

/** An error event's `nativeEvent`. */
export interface WebViewError extends WebViewNativeEvent {
  /** Always `-1` here. */
  code: number;
  /** What went wrong. */
  description: string;
  /** The error domain (always `"denext"`). */
  domain?: string;
}

/** The `{ nativeEvent }` wrapper every WebView callback receives. */
export interface WebViewSyntheticEvent<T> {
  /** The event data. */
  nativeEvent: T;
}

/** A message from the page (`onMessage`). */
export type WebViewMessageEvent = WebViewSyntheticEvent<WebViewMessage>;
/** A load event (`onLoad`, `onLoadStart`, `onLoadEnd`). */
export type WebViewNavigationEvent = WebViewSyntheticEvent<WebViewNavigation>;
/** A load failure (`onError`). */
export type WebViewErrorEvent = WebViewSyntheticEvent<WebViewError>;

/** A file download (`onFileDownload`, iOS; never fired here). */
export interface FileDownload {
  /** The URL being downloaded. */
  downloadUrl: string;
}

/** `WebView` props: the commonly used subset; any other prop is accepted and ignored. */
export interface WebViewProps {
  /** What to load. */
  source?: WebViewSource;
  /** The container style. */
  style?: unknown;
  /** The container style (the package's inner-view style; merged with `style`). */
  containerStyle?: unknown;
  /** A page message (`window.ReactNativeWebView.postMessage`). */
  onMessage?: (event: WebViewMessageEvent) => void;
  /** A load started. */
  onLoadStart?: (event: WebViewNavigationEvent) => void;
  /** The page loaded. */
  onLoad?: (event: WebViewNavigationEvent) => void;
  /** A load finished (after `onLoad` / `onError`). */
  onLoadEnd?: (event: WebViewNavigationEvent | WebViewErrorEvent) => void;
  /** The frame failed to load. */
  onError?: (event: WebViewErrorEvent) => void;
  /** Called once per frame load. */
  onNavigationStateChange?: (event: WebViewNavigation) => void;
  /** Never called (a frame's navigations are not observable). */
  onShouldStartLoadWithRequest?: (event: unknown) => boolean;
  /** Ignored (see the module notes). */
  originWhitelist?: readonly string[];
  /** Script run after the page loads (inline HTML and same-origin URLs). */
  injectedJavaScript?: string;
  /** Script run before the page's own (inline HTML only; same-origin URLs run it at load). */
  injectedJavaScriptBeforeContentLoaded?: string;
  /** `false` drops `allow-scripts` from the sandbox (default `true`). */
  javaScriptEnabled?: boolean;
  /** Test id (as `data-testid` on the frame). */
  testID?: string;
  /** The ref handle ({@linkcode WebViewHandle}). */
  ref?: unknown;
  /** Other package props (scroll, zoom, cookies, media): accepted and ignored. */
  [prop: string]: unknown;
}

/** The ref handle of a {@linkcode WebView}. */
export interface WebViewHandle {
  /** Go back in the frame's history (same-origin pages). */
  goBack(): void;
  /** Go forward in the frame's history (same-origin pages). */
  goForward(): void;
  /** Reload the page. */
  reload(): void;
  /** Stop loading (same-origin pages). */
  stopLoading(): void;
  /** Run `script` in the page (inline HTML and same-origin pages). */
  injectJavaScript(script: string): void;
  /** Focus the frame. */
  requestFocus(): void;
  /** Deliver a `message` event with `data` to the page. */
  postMessage(data: string): void;
  /** Does nothing (the browser owns the cache). */
  clearCache(includeDiskFiles: boolean): void;
  /** Does nothing. */
  clearFormData(): void;
  /** Does nothing. */
  clearHistory(): void;
}

/** The marker the in-page bridge tags its messages with. */
const TAG = "__denextWebView";

/** The in-page bridge: `window.ReactNativeWebView` and the injection channel from the app. */
function bridgeScript(): string {
  return `(function(){var t=${JSON.stringify(TAG)};` +
    `window.ReactNativeWebView={postMessage:function(d){` +
    `window.parent.postMessage({__denextWebView:true,data:String(d)},"*");}};` +
    `window.addEventListener("message",function(e){var m=e.data;` +
    `if(e.source===window.parent&&m&&typeof m==="object"&&m[t]==="inject"){` +
    `(0,eval)(String(m.code));e.stopImmediatePropagation();}});})();`;
}

/** `code` as a `<script>` element (a `</script` inside it cannot end the element). */
function scriptTag(code: string): string {
  return `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
}

/**
 * The `srcdoc` for inline HTML: a `<base>` for `baseUrl`, the bridge and the before-content
 * script ahead of the markup, and the after-content script run once the document has parsed.
 *
 * @param html The page markup.
 * @param options The base URL and the scripts.
 * @returns The document source.
 */
export function webViewDocument(
  html: string,
  options: { baseUrl?: string; before?: string; after?: string; scripts: boolean },
): string {
  const base = options.baseUrl ? `<base href="${options.baseUrl.replace(/"/g, "&quot;")}">` : "";
  if (!options.scripts) return base + html;
  const after = options.after
    ? scriptTag(
      `(function(){var f=function(){${options.after}\n};` +
        `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",f);` +
        `else f();})();`,
    )
    : "";
  return base + scriptTag(bridgeScript()) + (options.before ? scriptTag(options.before) : "") +
    html + after;
}

/** The (package, url) pairs that warned already. */
const warned = new Set<string>();

/** Warn once per `key`. */
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`denext react-native-webview: ${message}`);
}

/** The frame's window, when it is reachable. */
type FrameWindow = Window & { eval(code: string): unknown };

/** The frame's same-origin window, or null for a cross-origin (or missing) one. */
function sameOriginWindow(frame: HTMLIFrameElement | null): FrameWindow | null {
  const win = frame?.contentWindow as FrameWindow | null | undefined;
  if (!win) return null;
  try {
    void win.document; // throws on a cross-origin frame
    return win;
  } catch {
    return null;
  }
}

/** The `nativeEvent` fields for the frame's current state. */
function nativeEventOf(
  frame: HTMLIFrameElement | null,
  source: WebViewSource | undefined,
  loading: boolean,
): WebViewNavigation {
  const win = sameOriginWindow(frame);
  let url = source && "uri" in source ? source.uri : "about:srcdoc";
  let title = "";
  if (win) {
    try {
      url = win.location.href;
      title = win.document.title ?? "";
    } catch { /* navigated away cross-origin */ }
  }
  return {
    url,
    loading,
    title,
    canGoBack: false,
    canGoForward: false,
    lockIdentifier: 0,
    navigationType: "other",
    mainDocumentURL: url,
  };
}

/** Run `code` in the frame: through the bridge for inline HTML, by `eval` for a same-origin page. */
function runInFrame(frame: HTMLIFrameElement | null, inline: boolean, code: string): void {
  if (!frame) return;
  if (inline) {
    frame.contentWindow?.postMessage({ [TAG]: "inject", code }, "*");
    return;
  }
  const win = sameOriginWindow(frame);
  if (!win) {
    warnOnce(
      `inject:${frame.src}`,
      "a cross-origin page cannot be scripted from the app (injectJavaScript / " +
        "injectedJavaScript were skipped). Load inline HTML or a same-origin URL to script it.",
    );
    return;
  }
  try {
    win.eval(code);
  } catch (err) {
    console.error(err);
  }
}

/** Whether the frame's page posted `event` (and what it carried). */
function messageData(event: MessageEvent, frame: HTMLIFrameElement | null): string | null {
  if (!frame || event.source !== frame.contentWindow) return null;
  const d = event.data as unknown;
  if (d && typeof d === "object" && (d as Record<string, unknown>)[TAG] === true) {
    return String((d as { data?: unknown }).data ?? "");
  }
  if (d && typeof d === "object" && (d as Record<string, unknown>)[TAG] !== undefined) return null;
  return typeof d === "string" ? d : JSON.stringify(d);
}

/** Deliver the frame's messages to the latest `onMessage`, as `{ nativeEvent: { data } }`. */
function useFrameMessages(
  frameRef: { current: HTMLIFrameElement | null },
  latest: { current: WebViewProps },
  deps: unknown[],
): void {
  useEffect(() => {
    const win = globalThis as unknown as {
      addEventListener?: (t: string, f: (e: MessageEvent) => void) => void;
      removeEventListener?: (t: string, f: (e: MessageEvent) => void) => void;
    };
    if (typeof win.addEventListener !== "function") return;
    const listener = (event: MessageEvent) => {
      const data = messageData(event, frameRef.current);
      if (data === null) return;
      const source = latest.current.source;
      const handler = latest.current.onMessage;
      handler?.({ nativeEvent: { ...nativeEventOf(frameRef.current, source, false), data } });
    };
    win.addEventListener("message", listener);
    return () => win.removeEventListener?.("message", listener);
  }, deps);
}

/** The ref handle over the frame. */
function webViewHandle(
  frameRef: { current: HTMLIFrameElement | null },
  inline: boolean,
  srcDoc: string | undefined,
  uri: string | undefined,
): WebViewHandle {
  return {
    goBack: () => sameOriginWindow(frameRef.current)?.history.back(),
    goForward: () => sameOriginWindow(frameRef.current)?.history.forward(),
    reload() {
      const frame = frameRef.current;
      if (!frame) return;
      const win = sameOriginWindow(frame);
      if (win && !inline) win.location.reload();
      else if (inline && srcDoc !== undefined) frame.srcdoc = srcDoc;
      else if (uri !== undefined) frame.src = uri;
    },
    stopLoading: () => sameOriginWindow(frameRef.current)?.stop(),
    injectJavaScript: (code: string) => runInFrame(frameRef.current, inline, code),
    requestFocus: () => frameRef.current?.focus(),
    postMessage: (data: string) => frameRef.current?.contentWindow?.postMessage(data, "*"),
    clearCache: () => {},
    clearFormData: () => {},
    clearHistory: () => {},
  };
}

/** Run the bridge and the injected scripts in a loaded same-origin URL frame (warn otherwise). */
function injectOnLoad(frame: HTMLIFrameElement | null, props: WebViewProps): void {
  const before = props.injectedJavaScriptBeforeContentLoaded;
  const after = props.injectedJavaScript;
  if (sameOriginWindow(frame)) {
    runInFrame(frame, false, bridgeScript() + (before ?? "") + "\n" + (after ?? ""));
  } else if (after || before) {
    runInFrame(frame, false, ""); // cross-origin: warns once that injection is impossible
  }
}

/** The frame's `sandbox`: inline HTML never gets its parent's origin; `javaScriptEnabled` off drops scripts. */
function frameSandbox(inline: boolean, scripts: boolean): string | undefined {
  if (inline) return scripts ? "allow-scripts allow-forms allow-popups allow-modals" : "";
  return scripts ? undefined : "allow-same-origin allow-forms allow-popups";
}

/**
 * `react-native-webview`'s `WebView`, as an `<iframe>` (see the module notes for what a frame
 * can and cannot do).
 *
 * @param props The package's props.
 * @returns The frame in a view.
 */
export function WebView(props: WebViewProps): VNode {
  const {
    source,
    style,
    containerStyle,
    onLoadStart,
    onLoad,
    onLoadEnd,
    onError,
    onNavigationStateChange,
    injectedJavaScript,
    injectedJavaScriptBeforeContentLoaded,
    javaScriptEnabled = true,
    testID,
  } = props;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const inline = !!source && "html" in source;
  const uri = source && "uri" in source ? source.uri : undefined;
  const html = source && "html" in source ? source.html : undefined;
  const baseUrl = source && "html" in source ? source.baseUrl : undefined;
  const latest = useRef(props);
  latest.current = props;

  const srcDoc = useMemo(
    () =>
      html === undefined ? undefined : webViewDocument(html, {
        baseUrl,
        before: injectedJavaScriptBeforeContentLoaded,
        after: injectedJavaScript,
        scripts: javaScriptEnabled,
      }),
    [html, baseUrl, injectedJavaScript, injectedJavaScriptBeforeContentLoaded, javaScriptEnabled],
  );

  // A load starts whenever the source changes.
  useEffect(() => {
    onLoadStart?.({ nativeEvent: nativeEventOf(frameRef.current, source, true) });
  }, [uri, srcDoc]);

  useFrameMessages(frameRef, latest, [uri, srcDoc]);
  useImperativeHandle(
    props.ref as never,
    (): WebViewHandle => webViewHandle(frameRef, inline, srcDoc, uri),
    [inline, srcDoc, uri],
  );

  const handleLoad = () => {
    const frame = frameRef.current;
    if (!inline && javaScriptEnabled) injectOnLoad(frame, props);
    const nativeEvent = nativeEventOf(frame, source, false);
    onLoad?.({ nativeEvent });
    onNavigationStateChange?.(nativeEvent);
    onLoadEnd?.({ nativeEvent });
  };
  const handleError = () => {
    const nativeEvent: WebViewError = {
      ...nativeEventOf(frameRef.current, source, false),
      code: -1,
      description: "The page failed to load in the frame.",
      domain: "denext",
    };
    onError?.({ nativeEvent });
    onLoadEnd?.({ nativeEvent });
  };

  const sandbox = frameSandbox(inline, javaScriptEnabled);
  return h(
    hostView(),
    { style: viewStyle([containerStyle, style], { flex: 1, overflow: "hidden" }) },
    h("iframe", {
      ref: frameRef,
      src: inline ? undefined : uri,
      srcdoc: srcDoc,
      sandbox,
      title: "web content",
      "data-testid": testID,
      onLoad: handleLoad,
      onError: handleError,
      style: { border: "0", width: "100%", height: "100%", flex: "1 1 auto" },
    }),
  );
}

export default WebView;
