/**
 * Native-shell detection and external-link opening for `denext/mobile`.
 *
 * Everything here reads the `window.Capacitor` global that a Capacitor iOS/Android shell
 * injects at document start (before any page script). There is no `@capacitor/*` import and
 * nothing runs at import time; on the web every function takes its plain-browser path.
 *
 * @module
 */

/**
 * The slice of Capacitor's `window.Capacitor` global this module reads. The v8 native bridge
 * (`native-bridge.js`) defines `isNativePlatform` (always `true` there) and `getPlatform`
 * (`"ios"` / `"android"`), and the native side seeds `Plugins[name]` with a method stub for
 * every natively registered plugin, so no JS `registerPlugin` call is needed. On the web,
 * `@capacitor/core` (if bundled) defines the same global with `isNativePlatform() === false`.
 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

/** The JS side of `@capacitor/browser` (SFSafariViewController / Android Custom Tabs). */
interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
}

/** The platform a page runs on, as `denext/mobile` distinguishes them. */
export type NativePlatform = "ios" | "android" | "web";

/**
 * The page's `window.Capacitor` (read off `globalThis`, which is `window` in a browser), or
 * `undefined` during SSR and on a page without it.
 */
function capacitorGlobal(): CapacitorGlobal | undefined {
  const cap = (globalThis as { Capacitor?: unknown }).Capacitor;
  return typeof cap === "object" && cap !== null ? cap as CapacitorGlobal : undefined;
}

/** `window.Capacitor`, only when it reports a native platform. */
function nativeCapacitor(): CapacitorGlobal | undefined {
  const cap = capacitorGlobal();
  return cap?.isNativePlatform?.() === true ? cap : undefined;
}

/** Narrow a `getPlatform()` result to one of the two shells; anything else is `"web"`. */
function shellPlatform(platform: string | undefined): NativePlatform {
  return platform === "ios" || platform === "android" ? platform : "web";
}

/**
 * The platform the page runs on: `"ios"` or `"android"` inside a Capacitor native shell,
 * otherwise `"web"`. SSR-safe (`"web"` when there is no `window`). A Capacitor custom platform
 * (e.g. Electron) also reads `"web"`: only the iOS and Android shells count.
 *
 * @returns `"ios"`, `"android"` or `"web"`.
 * @example
 * ```ts
 * import { nativePlatform } from "denext/mobile";
 * document.documentElement.dataset.platform = nativePlatform();
 * ```
 */
export function nativePlatform(): NativePlatform {
  return shellPlatform(nativeCapacitor()?.getPlatform?.());
}

/**
 * Whether the page runs inside a Capacitor iOS/Android native shell (webview origin
 * `capacitor://localhost` on iOS, `https://localhost` on Android). `false` on the web, when
 * `@capacitor/core` is merely bundled into a web build, and during SSR.
 *
 * @returns `true` only inside the native shell.
 * @example
 * ```ts
 * import { isNativeShell } from "denext/mobile";
 * if (isNativeShell()) document.documentElement.classList.add("native");
 * ```
 */
export function isNativeShell(): boolean {
  return nativePlatform() !== "web";
}

/** Whether `protocol` is one {@linkcode openExternal} may hand to the OS. */
function isExternalScheme(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ||
    protocol === "tel:";
}

/** Whether the in-app browser can load `protocol` (it takes http(s) only). */
function isWebScheme(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

/** Parse and vet `url` for {@linkcode openExternal}; throws a `TypeError` when refused. */
function externalUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("openExternal: expected an absolute http(s), mailto: or tel: URL");
  }
  if (!isExternalScheme(parsed.protocol)) {
    throw new TypeError(
      `openExternal: refusing a "${parsed.protocol}" URL (only http:, https:, mailto: and tel:)`,
    );
  }
  return parsed;
}

/** `Capacitor.Plugins[name]` inside the iOS/Android shell, else `undefined`. */
function shellPlugin(name: string): unknown {
  return isNativeShell() ? capacitorGlobal()?.Plugins?.[name] : undefined;
}

/** `plugin` as the Browser plugin, when it has an `open` method. */
function asBrowserPlugin(plugin: unknown): BrowserPlugin | undefined {
  const open = (plugin as Partial<BrowserPlugin> | undefined)?.open;
  return typeof open === "function" ? plugin as BrowserPlugin : undefined;
}

/**
 * Open a URL outside the app.
 *
 * - Inside the native shell, an http(s) URL opens in the in-app browser of the
 *   `@capacitor/browser` plugin when it is installed natively (read from
 *   `Capacitor.Plugins.Browser`; no JS import of the plugin is needed).
 * - Otherwise, including `mailto:`/`tel:` and on the web, it calls
 *   `window.open(url, "_blank", "noopener,noreferrer")`. The iOS shell hands a
 *   `window.open` to the OS (Safari, Mail, Phone); Android routes it to an intent.
 *
 * Only `http:`, `https:`, `mailto:` and `tel:` URLs are accepted. Anything else, including
 * `javascript:`, `data:`, `file:` and relative URLs, is refused **synchronously** with a
 * `TypeError` before anything opens. The vetted, normalized `URL.href` is what gets opened.
 *
 * @param url An absolute `http:`, `https:`, `mailto:` or `tel:` URL.
 * @returns A promise that settles once the URL has been handed off. It rejects if the
 * `Browser` plugin rejects, or when there is no `window` (SSR).
 * @throws {TypeError} Synchronously, for a relative URL or a disallowed scheme.
 * @example
 * ```tsx
 * "use client";
 * import { openExternal } from "denext/mobile";
 *
 * export function DocsLink() {
 *   return <button type="button" onClick={() => openExternal("https://denext.dev/docs")}>Docs</button>;
 * }
 * ```
 */
export function openExternal(url: string): Promise<void> {
  const target = externalUrl(url);
  const browser = isWebScheme(target.protocol)
    ? asBrowserPlugin(shellPlugin("Browser"))
    : undefined;
  if (browser) return browser.open({ url: target.href });
  if (typeof globalThis.open !== "function") {
    return Promise.reject(new Error("openExternal: no window to open from (called during SSR?)"));
  }
  globalThis.open(target.href, "_blank", "noopener,noreferrer");
  return Promise.resolve();
}
