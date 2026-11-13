/**
 * The embedded web views of one window, for the `window` capability (`webViewCapabilities`,
 * `webViewCreate`, `webViewCall`) and for `desktop.ts` (`win.createWebView`): a registry of the
 * window's views over the runtime's `BrowserWindow.prototype.createWebView` / `Deno.WebView`, the
 * checks denext adds before the runtime's own, and the views' events forwarded to the window's page.
 *
 * Wire protocol (cap `window`):
 * - `webViewCapabilities` `{}` → `{ supported, engines, capture, evaluate }`.
 * - `webViewCreate` `{ options }` (the page's `CreateWebViewOptions`) → `{ id }` (a string).
 * - `webViewCall` `{ id, method, args }` → the method's result: `setBounds` `{ x, y, width, height }`,
 *   `setVisible` `{ visible }`, `navigate` `{ url }`, `back` / `forward` / `stop` / `focus` /
 *   `close` `{}`, `reload` `{ ignoreCache? }` → `null`; `state` `{}` → `{ url, title, load,
 *   canGoBack, canGoForward }`; `capture` `{ format?, quality? }` → `{ base64, type }`; `evaluate`
 *   `{ script }` → `{ value }`.
 * - Event `webview` `{ id, event, detail }` to the window's page, for each view the page made
 *   (`detail` the draft's `WebViewEventMap` shape); `closed` is the last one for an id.
 *
 * Checks, before the runtime is touched: every argument's type, finite numbers and enums; the URL
 * of a create or a navigate is `http:` / `https:`, never one of the app's own origins (its
 * `desktop.app.origin`, the loopback origin its pages are served from) and, with
 * `desktop.webViews.allowedOrigins`, one of those (`not_allowed_url`); at most
 * `desktop.webViews.limit` views per window, page-made and `desktop.ts`-made together (`limit`). A
 * page drives only the views it made in its own window: any other id is `closed`. The runtime's
 * `WebViewError` codes map onto the bridge's: `unsupported`, `not_allowed_url`, `limit`, `closed`
 * (`no_window` too), `invalid` → `validation`, and `failed` / `error` / `not_serializable` as they
 * are.
 *
 * Runtime-only (imported by the `window` capability, never a client bundle).
 *
 * @module
 */

import { bytesToBase64 } from "../../mobile/base64.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import type {
  CreateWebViewOptions,
  WebViewBounds,
  WebViewCapabilities,
  WebViewEngine,
  WebViewEventMap,
  WebViewHandle,
} from "../webview.ts";
import { DEFAULT_WEBVIEW_SETTINGS, type DesktopWebViewSettings } from "../webview-config.ts";
import {
  fireWebViewListeners,
  webViewHandle,
  type WebViewListeners,
  webViewStateOf,
} from "../webview-handle.ts";

/** The events a runtime web view fires (each a `CustomEvent` whose `detail` is the payload). */
const WEBVIEW_EVENTS: readonly (keyof WebViewEventMap)[] = [
  "title",
  "url",
  "load",
  "console",
  "focus-change",
  "new-window",
  "find-result",
  "context-menu",
  "closed",
];

/** The longest URL a create or navigate takes. */
const MAX_URL_CHARS = 32 * 1024;
/** The longest user agent string. */
const MAX_USER_AGENT_CHARS = 1024;
/** The largest coordinate magnitude a bound takes. */
const MAX_COORD = 1e7;
/** A partition name (the runtime's rule). */
const PARTITION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** The engines the runtime names. */
const ENGINES: ReadonlySet<string> = new Set(["cef", "wkwebview", "webview2", "webkitgtk"]);
/** The runtime's `WebViewError` codes, as the bridge's. */
const ERROR_CODES: Readonly<Record<string, string>> = {
  unsupported: "unsupported",
  not_allowed_url: "not_allowed_url",
  limit: "limit",
  closed: "closed",
  no_window: "closed",
  invalid: "validation",
  failed: "failed",
  error: "error",
  not_serializable: "not_serializable",
  not_allowed: "not_allowed",
};
/** Each code's HTTP status (the page reads the envelope at any status). */
const STATUS: Readonly<Record<string, number>> = {
  unsupported: 501,
  not_allowed_url: 403,
  not_allowed: 403,
  limit: 429,
  closed: 410,
  failed: 500,
};

/** The slice of the runtime's `Deno.WebView` used here. */
interface RuntimeWebView extends EventTarget {
  readonly id: number;
  readonly closed?: boolean;
  setBounds(bounds: WebViewBounds): void;
  setVisible(visible: boolean): void;
  navigate(url: string): void;
  back(): void;
  forward(): void;
  reload(options?: { ignoreCache?: boolean }): void;
  stop(): void;
  focus(): void;
  state(): unknown;
  capture(
    options?: { format?: "png" | "jpeg"; quality?: number; scale?: number },
  ): Promise<Uint8Array>;
  evaluate(script: string): Promise<unknown>;
  close(): void;
  // The stacking, zoom, find, DevTools and print members (a runtime with each capability).
  raise?(): boolean;
  lower?(): boolean;
  setZOrder?(n: number): boolean;
  setZoom?(factor: number): boolean;
  getZoom?(): number;
  find?(text: string, options?: { forward?: boolean; matchCase?: boolean }): boolean;
  stopFind?(): boolean;
  openDevTools?(): void;
  print?(): boolean;
}

/** The runtime's web view options (`BrowserWindow.prototype.createWebView`'s argument). */
interface RuntimeWebViewOptions extends Omit<CreateWebViewOptions, "permissions"> {
  permissions?: "deny" | "ask";
  clipboardRead?: boolean;
  clipboardWrite?: boolean;
}

/**
 * The optional features: each the runtime's capability flag and the `Deno.WebView` members it
 * needs (none: an option, not a method).
 */
const FEATURES: ReadonlyArray<readonly [keyof WebViewCapabilities, readonly string[]]> = [
  ["zOrder", ["raise", "lower", "setZOrder"]],
  ["zoom", ["setZoom", "getZoom"]],
  ["find", ["find", "stopFind"]],
  ["devTools", ["openDevTools"]],
  ["contextMenu", []],
  ["print", ["print"]],
  ["clipboard", []],
];

/** The window and app API members the web views need (each feature-detected). */
export interface WebViewHostOptions {
  /** The runtime's window (`createWebView` from the runtime that has web views). */
  readonly window: { createWebView?(options: RuntimeWebViewOptions): unknown } | undefined;
  /** `Deno.desktop` (`webViewCapabilities()` from the runtime that has web views). */
  readonly api: { webViewCapabilities?(): unknown } | undefined;
  /** `desktop.webViews` as resolved (default: 8 per window, any http(s) origin). */
  readonly settings?: () => DesktopWebViewSettings;
  /** The app's own origins (refused): `desktop.app.origin`, the origin its pages load from. */
  readonly appOrigins?: () => readonly string[];
  /** Push a `window` event to this window's page. */
  readonly emit: (event: string, data: unknown) => void;
  /** The runtime's `Deno.WebView` class (its prototype shows which members exist). */
  readonly webViewClass?: unknown;
}

/** Who made a view: the page drives only its own. */
type Owner = "page" | "backend";

/** One registered view. */
interface Entry extends WebViewListeners {
  readonly id: string;
  readonly view: RuntimeWebView;
  readonly owner: Owner;
}

/** What {@linkcode createWebViewHost} returns. */
export interface WebViewHost {
  /** The `window` capability's web view methods. */
  readonly methods: DesktopCapability["methods"];
  /** `win.createWebView` for `desktop.ts`. */
  create(options: CreateWebViewOptions): Promise<WebViewHandle>;
  /** How many views the window has open. */
  count(): number;
  /** The window closed: every view is gone (`closed` to `desktop.ts`'s listeners). */
  windowClosed(): void;
}

/** A `validation` error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** A web view error with the bridge's code and its status. */
function fail(code: string, message: string): DesktopCapError {
  return new DesktopCapError(code, message, { status: STATUS[code] ?? 400 });
}

/** The runtime's error as the bridge's (a `WebViewError`'s code mapped; anything else `failed`). */
function fromRuntime(err: unknown, what: string): DesktopCapError {
  if (err instanceof DesktopCapError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  const mapped = typeof code === "string" ? ERROR_CODES[code] : undefined;
  return fail(mapped ?? "failed", `the web view could not ${what}: ${message || "failed"}`);
}

/** The args object (or `{}`). */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

/** A finite coordinate (`min` 0 for a size). */
function coord(value: unknown, name: string, min = -MAX_COORD): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > MAX_COORD) {
    throw invalid(
      `${name} must be a finite number${min === 0 ? " (at least 0)" : ""} up to ${MAX_COORD}`,
    );
  }
  return value;
}

/** `{ x, y, width, height }`, checked. */
function boundsOf(value: unknown, name: string): WebViewBounds {
  if (typeof value !== "object" || value === null) {
    throw invalid(`${name} must be { x, y, width, height }`);
  }
  const b = value as Record<string, unknown>;
  return {
    x: coord(b.x, `${name}.x`),
    y: coord(b.y, `${name}.y`),
    width: coord(b.width, `${name}.width`, 0),
    height: coord(b.height, `${name}.height`, 0),
  };
}

/** An optional enum option. */
function oneOf<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${name} must be ${allowed.map((a) => `"${a}"`).join(", ")}`);
  }
  return value as T;
}

/** A URL string (its parsed form), before the origin checks. */
function urlOf(value: unknown): URL {
  if (typeof value !== "string" || value === "" || value.length > MAX_URL_CHARS) {
    throw invalid(`url must be a string of 1 to ${MAX_URL_CHARS} characters`);
  }
  try {
    return new URL(value);
  } catch {
    throw fail("not_allowed_url", "url is not an absolute URL");
  }
}

/** `partition`, checked (the runtime's rule). */
function partitionOf(value: unknown): string {
  if (typeof value !== "string" || !PARTITION.test(value)) {
    throw invalid(
      "partition must be 1 to 64 letters, digits, '.', '_', ':' or '-', starting with a " +
        "letter or digit",
    );
  }
  return value;
}

/** `userAgent`, checked: one line, bounded. */
function userAgentOf(value: unknown): string {
  if (
    typeof value !== "string" || value.length > MAX_USER_AGENT_CHARS ||
    // deno-lint-ignore no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalid(`userAgent must be one line of at most ${MAX_USER_AGENT_CHARS} characters`);
  }
  return value;
}

/** The popup, download and permission policies, checked (only those given). */
function policiesOf(o: Record<string, unknown>): Partial<RuntimeWebViewOptions> {
  const allowPopups = oneOf(o.allowPopups, "allowPopups", ["deny", "same-view", "browser"]);
  const downloads = oneOf(o.downloads, "downloads", ["deny", "ask", "browser"]);
  const contextMenu = oneOf(o.contextMenu, "contextMenu", ["native", "app"]);
  return {
    ...(allowPopups ? { allowPopups } : {}),
    ...(downloads ? { downloads } : {}),
    ...permissionsOf(o.permissions),
    ...(contextMenu ? { contextMenu } : {}),
  };
}

/** An optional boolean field of `o`. */
function optBool(o: Record<string, unknown>, key: string, name: string): boolean | undefined {
  if (o[key] === undefined) return undefined;
  if (typeof o[key] !== "boolean") throw invalid(`${name} must be a boolean`);
  return o[key] as boolean;
}

/**
 * `permissions` as the runtime takes it: the string form as it is; the object form's `prompts`
 * (default `"deny"`), `clipboardRead` and `clipboardWrite` as the runtime's three options.
 */
function permissionsOf(raw: unknown): Partial<RuntimeWebViewOptions> {
  if (raw === undefined) return {};
  if (typeof raw === "string") {
    return { permissions: oneOf(raw, "permissions", ["deny", "ask"]) };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid(
      'permissions must be "deny", "ask" or { prompts?, clipboardRead?, clipboardWrite? }',
    );
  }
  const p = raw as Record<string, unknown>;
  const read = optBool(p, "clipboardRead", "permissions.clipboardRead");
  const write = optBool(p, "clipboardWrite", "permissions.clipboardWrite");
  return {
    permissions: oneOf(p.prompts, "permissions.prompts", ["deny", "ask"]) ?? "deny",
    ...(read !== undefined ? { clipboardRead: read } : {}),
    ...(write !== undefined ? { clipboardWrite: write } : {}),
  };
}

/** The page's create options, checked (unknown keys are dropped). */
function createOptionsOf(raw: unknown): RuntimeWebViewOptions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("options must be an object: { url, bounds, … }");
  }
  const o = raw as Record<string, unknown>;
  urlOf(o.url);
  const bounds = boundsOf(o.bounds, "bounds");
  if (o.visible !== undefined && typeof o.visible !== "boolean") {
    throw invalid("visible must be a boolean");
  }
  return {
    url: o.url as string,
    bounds,
    ...(o.partition !== undefined ? { partition: partitionOf(o.partition) } : {}),
    ...(o.visible !== undefined ? { visible: o.visible as boolean } : {}),
    ...policiesOf(o),
    ...(o.userAgent !== undefined ? { userAgent: userAgentOf(o.userAgent) } : {}),
  };
}

/** The loopback host names (one server answers on all of them). */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Whether `url` is on one of the app's own origins (a loopback alias of one included). */
function isAppOrigin(url: URL, appOrigins: readonly string[]): boolean {
  for (const entry of appOrigins) {
    let app: URL;
    try {
      app = new URL(entry);
    } catch {
      continue;
    }
    if (app.origin !== "null" && app.origin === url.origin) return true;
    if (
      app.protocol === url.protocol && app.port === url.port &&
      isLoopbackHost(app.hostname) && isLoopbackHost(url.hostname)
    ) {
      return true;
    }
  }
  return false;
}

/** The host's state. */
interface HostState {
  readonly options: WebViewHostOptions;
  readonly views: Map<string, Entry>;
}

/** `url` may be loaded in a web view of this app (create and navigate), else `not_allowed_url`. */
function checkUrl(h: HostState, raw: unknown): string {
  const url = urlOf(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw fail("not_allowed_url", "a web view loads http: and https: URLs only");
  }
  if (isAppOrigin(url, h.options.appOrigins?.() ?? [])) {
    throw fail("not_allowed_url", "a web view never loads the app's own origin");
  }
  const allowed = settingsOf(h).allowedOrigins;
  if (allowed !== null && !allowed.includes(url.origin)) {
    throw fail(
      "not_allowed_url",
      `${url.origin} is not in desktop.webViews.allowedOrigins`,
    );
  }
  return raw as string;
}

/** `desktop.webViews` as resolved. */
function settingsOf(h: HostState): DesktopWebViewSettings {
  return h.options.settings?.() ?? DEFAULT_WEBVIEW_SETTINGS;
}

/** The runtime's web view capabilities, or `undefined` (an older runtime, or it threw). */
function runtimeCapabilities(h: HostState): Record<string, unknown> | undefined {
  const api = h.options.api;
  if (typeof api?.webViewCapabilities !== "function") return undefined;
  try {
    const caps = api.webViewCapabilities();
    return typeof caps === "object" && caps !== null ? caps as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** What this window can do with web views (`supported: false` on an older runtime). */
function capabilitiesOf(h: HostState): WebViewCapabilities {
  const caps = runtimeCapabilities(h);
  const supported = caps?.supported === true &&
    typeof h.options.window?.createWebView === "function";
  const out: WebViewCapabilities = {
    supported,
    engines: [],
    capture: supported && caps.capture === true,
    evaluate: supported && caps.evaluate === true,
    zOrder: false,
    zoom: false,
    find: false,
    devTools: false,
    contextMenu: false,
    print: false,
    clipboard: false,
  };
  if (!supported) return out;
  const engine = caps.engine;
  if (typeof engine === "string" && ENGINES.has(engine)) out.engines = [engine as WebViewEngine];
  return { ...out, ...featuresOf(h, caps) };
}

/** Each optional feature: the runtime reports it and `Deno.WebView` has its members. */
function featuresOf(h: HostState, caps: Record<string, unknown>): Record<string, boolean> {
  const proto = (h.options.webViewClass as { prototype?: Record<string, unknown> } | undefined)
    ?.prototype;
  return Object.fromEntries(
    FEATURES.map(([key, members]) => [
      key,
      caps[key] === true && members.every((m) => typeof proto?.[m] === "function"),
    ]),
  );
}

/** A runtime event's detail as JSON-safe data (a JSON string parsed; anything else `{}`). */
function detailOf(raw: unknown): unknown {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

/** Hand `detail` to `desktop.ts`'s listeners of `event` (a throw is logged, not fatal). */
function fireListeners(entry: Entry, event: string, detail: unknown): void {
  fireWebViewListeners(
    entry,
    event,
    detail,
    (err) => console.error(`desktop: a web view "${event}" listener threw:`, err),
  );
}

/** The view is gone: out of the registry, `closed` delivered once, listeners dropped. */
function dropView(h: HostState, entry: Entry, tellPage: boolean): void {
  if (entry.closed) return;
  entry.closed = true;
  h.views.delete(entry.id);
  if (entry.owner === "page" && tellPage) {
    h.options.emit("webview", { id: entry.id, event: "closed", detail: {} });
  }
  fireListeners(entry, "closed", {});
  entry.listeners.clear();
}

/** Follow `entry`'s runtime events: to the page (its own views) and `desktop.ts`'s listeners. */
function follow(h: HostState, entry: Entry): void {
  for (const event of WEBVIEW_EVENTS) {
    entry.view.addEventListener(event, (e) => {
      if (entry.closed) return;
      if (event === "closed") return dropView(h, entry, true);
      const detail = detailOf((e as CustomEvent).detail);
      if (entry.owner === "page") {
        h.options.emit("webview", { id: entry.id, event, detail });
      }
      fireListeners(entry, event, detail);
    });
  }
}

/** Open a view for `owner` (every check first, then the runtime). */
function open(h: HostState, raw: unknown, owner: Owner): Entry {
  const options = createOptionsOf(raw);
  checkUrl(h, options.url);
  const win = h.options.window;
  if (typeof win?.createWebView !== "function") {
    throw fail(
      "unsupported",
      "this Deno Desktop runtime has no web views (BrowserWindow.createWebView)",
    );
  }
  const limit = settingsOf(h).limit;
  if (h.views.size >= limit) {
    throw fail(
      "limit",
      `this window has ${limit} web views open already (desktop.webViews.limit)`,
    );
  }
  let view: RuntimeWebView;
  try {
    view = win.createWebView(options) as RuntimeWebView;
  } catch (err) {
    throw fromRuntime(err, "be created");
  }
  if (typeof view !== "object" || view === null || typeof view.addEventListener !== "function") {
    throw fail("failed", "the runtime answered no web view");
  }
  const entry: Entry = {
    id: String(view.id),
    view,
    owner,
    listeners: new Map(),
    closed: false,
  };
  h.views.set(entry.id, entry);
  follow(h, entry);
  return entry;
}

/** The page's view `id` (only its own, open ones; anything else `closed`). */
function pageView(h: HostState, id: unknown): Entry {
  if (typeof id !== "string" || id === "") throw invalid("id must be a web view id");
  const entry = h.views.get(id);
  if (!entry || entry.owner !== "page" || entry.closed) {
    throw fail("closed", "no open web view with that id in this window");
  }
  return entry;
}

/** A runtime call on `entry`, its error mapped. */
function run<T>(entry: Entry, what: string, fn: (view: RuntimeWebView) => T): T {
  if (entry.closed) throw fail("closed", "the web view is closed");
  try {
    return fn(entry.view);
  } catch (err) {
    throw fromRuntime(err, what);
  }
}

/** {@linkcode run} for an async runtime call. */
async function runAsync<T>(
  entry: Entry,
  what: string,
  fn: (view: RuntimeWebView) => Promise<T>,
): Promise<T> {
  if (entry.closed) throw fail("closed", "the web view is closed");
  try {
    return await fn(entry.view);
  } catch (err) {
    throw fromRuntime(err, what);
  }
}

/** Whether `v` is a finite number in `min..max`. */
function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

/** `capture`'s options, checked. */
function captureOptionsOf(
  a: Record<string, unknown>,
): { format: "png" | "jpeg"; quality?: number; scale?: number } {
  const format = oneOf(a.format, "format", ["png", "jpeg"]) ?? "png";
  const q = a.quality;
  if (q !== undefined && !inRange(q, 0, 100)) {
    throw invalid("quality must be a number from 0 to 100");
  }
  const scale = a.scale;
  if (scale !== undefined && (!inRange(scale, 0, 4) || scale === 0)) {
    throw invalid("scale must be a number above 0, at most 4 (output pixels per CSS pixel)");
  }
  return {
    format,
    ...(q !== undefined ? { quality: Math.round(q) } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
}

/** `navigate`: the same URL checks as a create. */
function navigate(h: HostState, entry: Entry, url: unknown): null {
  const checked = checkUrl(h, url);
  run(entry, "navigate", (v) => v.navigate(checked));
  return null;
}

/** `capture`: the image bytes. */
async function capture(entry: Entry, a: Record<string, unknown>): Promise<Uint8Array> {
  const opts = captureOptionsOf(a);
  const bytes = await runAsync(entry, "capture", (v) => v.capture(opts));
  if (!(bytes instanceof Uint8Array)) throw fail("failed", "the runtime answered no image");
  return bytes;
}

/** `evaluate`: the script's JSON result. */
async function evaluate(entry: Entry, script: unknown): Promise<unknown> {
  if (typeof script !== "string") throw invalid("script must be a string");
  const value = await runAsync(entry, "evaluate the script", (v) => v.evaluate(script));
  return value === undefined ? null : value;
}

/** Close `entry` (idempotent); `closed` follows from the runtime, or now when it said nothing. */
function close(h: HostState, entry: Entry): null {
  if (entry.closed) return null;
  run(entry, "close", (v) => v.close());
  // The runtime fires `closed` (maybe later); a view it reports closed already is dropped now.
  if (entry.view.closed === true) dropView(h, entry, true);
  return null;
}

/** One `webViewCall` method: its checks, then the runtime call. */
type ViewMethod = (h: HostState, entry: Entry, a: Record<string, unknown>) => unknown;

/** The runtime view's optional member `name`, or `unsupported` (a runtime without it). */
function member(entry: Entry, name: string, what: string): (...args: unknown[]) => unknown {
  const fn = (entry.view as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw fail("unsupported", `this Deno Desktop runtime's web views can't ${what} (no ${name})`);
  }
  return fn as (...args: unknown[]) => unknown;
}

/**
 * An optional feature's method: `args` checked into the runtime call's arguments, then the call;
 * the runtime's `false` (the engine can't) is `unsupported`.
 */
function feature(
  name: string,
  what: string,
  args: (a: Record<string, unknown>) => unknown[],
): ViewMethod {
  return (_h, entry, a) => {
    const callArgs = args(a);
    const fn = member(entry, name, what);
    if (run(entry, what, (v) => fn.apply(v, callArgs)) === false) {
      throw fail("unsupported", `this web view's engine can't ${what}`);
    }
    return null;
  };
}

/** A 32-bit integer argument. */
function int32(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < -(2 ** 31) || (value as number) >= 2 ** 31) {
    throw invalid(`${name} must be a 32-bit integer`);
  }
  return value as number;
}

/** A zoom factor (0.25 to 5). */
function zoomFactor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.25 || value > 5) {
    throw invalid("factor must be a number from 0.25 to 5");
  }
  return value;
}

/** `find`'s arguments: non-empty text (bounded) and its two flags. */
function findArgs(a: Record<string, unknown>): unknown[] {
  if (typeof a.text !== "string" || a.text === "" || a.text.length > 4096) {
    throw invalid("text must be a string of 1 to 4096 characters");
  }
  const forward = optBool(a, "forward", "forward");
  const matchCase = optBool(a, "matchCase", "matchCase");
  return [a.text, {
    forward: forward ?? true,
    matchCase: matchCase ?? false,
  }];
}

/** A method with no arguments and no result. */
const simple = (what: string, fn: (v: RuntimeWebView) => void): ViewMethod => (_h, entry) => {
  run(entry, what, fn);
  return null;
};

/** The `webViewCall` methods. */
const VIEW_METHODS: Readonly<Record<string, ViewMethod>> = {
  setBounds: (_h, entry, a) => {
    const b = boundsOf(a, "bounds");
    run(entry, "move", (v) => v.setBounds(b));
    return null;
  },
  setVisible: (_h, entry, a) => {
    const visible = a.visible;
    if (typeof visible !== "boolean") throw invalid("visible must be a boolean");
    run(entry, "show or hide", (v) => v.setVisible(visible));
    return null;
  },
  navigate: (h, entry, a) => navigate(h, entry, a.url),
  back: simple("go back", (v) => v.back()),
  forward: simple("go forward", (v) => v.forward()),
  reload: (_h, entry, a) => {
    if (a.ignoreCache !== undefined && typeof a.ignoreCache !== "boolean") {
      throw invalid("ignoreCache must be a boolean");
    }
    const opts = a.ignoreCache === true ? { ignoreCache: true } : undefined;
    run(entry, "reload", (v) => v.reload(opts));
    return null;
  },
  stop: simple("stop", (v) => v.stop()),
  focus: simple("take the focus", (v) => v.focus()),
  state: (_h, entry) => {
    const raw = run(entry, "report its state", (v) => v.state());
    return webViewStateOf(typeof raw === "string" ? detailOf(raw) : raw);
  },
  capture: async (_h, entry, a) => ({
    base64: bytesToBase64(await capture(entry, a)),
    type: a.format === "jpeg" ? "image/jpeg" : "image/png",
  }),
  evaluate: async (_h, entry, a) => ({ value: await evaluate(entry, a.script) }),
  close: (h, entry) => close(h, entry),
  raise: feature("raise", "come to the front", () => []),
  lower: feature("lower", "go to the back", () => []),
  setZOrder: feature("setZOrder", "take a stacking order", (a) => [int32(a.zOrder, "zOrder")]),
  setZoom: feature("setZoom", "zoom", (a) => [zoomFactor(a.factor)]),
  getZoom: (_h, entry) => {
    const fn = member(entry, "getZoom", "report its zoom");
    const factor = run(entry, "report its zoom", (v) => fn.call(v));
    return { factor: typeof factor === "number" && Number.isFinite(factor) ? factor : 1 };
  },
  find: feature("find", "find in its page", findArgs),
  stopFind: feature("stopFind", "stop finding", () => []),
  openDevTools: (h, entry) => {
    if (!settingsOf(h).devTools) {
      throw fail(
        "not_allowed",
        "a web view's DevTools open only where the app's are on (denext desktop dev, or " +
          "desktop.inspectable: true)",
      );
    }
    const fn = member(entry, "openDevTools", "open its DevTools");
    run(entry, "open its DevTools", (v) => fn.call(v));
    return null;
  },
  print: feature("print", "print", () => []),
};

/** One `webViewCall` method on `entry`. */
function callMethod(
  h: HostState,
  entry: Entry,
  method: string,
  a: Record<string, unknown>,
): unknown {
  const fn = Object.hasOwn(VIEW_METHODS, method) ? VIEW_METHODS[method] : undefined;
  if (!fn) throw invalid(`unknown web view method "${method}"`);
  return fn(h, entry, a);
}

/** `desktop.ts`'s handle over `entry`: the same methods, run in-process. */
function backendHandle(h: HostState, entry: Entry): WebViewHandle {
  return webViewHandle(entry.id, entry, {
    call: async (method, args) => await callMethod(h, entry, method, args),
    capture: async (opts) => {
      const bytes = await capture(entry, opts);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return new Blob([copy], { type: opts.format === "jpeg" ? "image/jpeg" : "image/png" });
    },
    evaluate: (script) => evaluate(entry, script),
    close: async () => {
      await callMethod(h, entry, "close", {});
    },
  });
}

/**
 * Make the web view host of one window.
 *
 * @param options The window, the app API, the settings, the app's origins and the page emitter.
 * @returns The `window` capability's methods, `desktop.ts`'s create, and the close hook.
 */
export function createWebViewHost(options: WebViewHostOptions): WebViewHost {
  const h: HostState = { options, views: new Map() };
  return {
    methods: {
      webViewCapabilities: { handler: () => capabilitiesOf(h) },
      webViewCreate: {
        handler: (args) => ({ id: open(h, argsOf(args).options, "page").id }),
      },
      webViewCall: {
        handler: (args) => {
          const a = argsOf(args);
          if (typeof a.method !== "string") throw invalid("method must be a string");
          const entry = pageView(h, a.id);
          if (a.args !== undefined && a.args !== null && argsOf(a.args) !== a.args) {
            throw invalid("args must be an object");
          }
          return callMethod(h, entry, a.method, argsOf(a.args));
        },
      },
    },
    create: (opts) => {
      try {
        return Promise.resolve(backendHandle(h, open(h, opts, "backend")));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    count: () => h.views.size,
    windowClosed: () => {
      for (const entry of [...h.views.values()]) dropView(h, entry, false);
    },
  };
}
