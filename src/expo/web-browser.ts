/**
 * `expo-web-browser` for denext: `openBrowserAsync` over `denext/mobile`'s
 * {@linkcode openExternal} (the in-app browser through `@capacitor/browser` in the Capacitor
 * shell, a new window on the web), and the auth-session calls over
 * {@linkcode openAuthSession} / {@linkcode completeAuthSession} (ASWebAuthenticationSession
 * on iOS, a Custom Tab on Android, a popup on the web).
 *
 * The Android Custom Tabs warm-up calls resolve with an empty result.
 *
 * @example
 * ```ts
 * import * as WebBrowser from "denext/expo/web-browser";
 *
 * WebBrowser.maybeCompleteAuthSession(); // on the web redirect page
 * const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, "myapp://auth");
 * if (result.type === "success") handle(result.url);
 * ```
 *
 * @module
 */

import { openExternal } from "../mobile/bridge.ts";
import {
  type AuthSessionError,
  completeAuthSession,
  openAuthSession,
} from "../mobile/auth-session.ts";

/** How a browser session ended. */
export enum WebBrowserResultType {
  /** The user cancelled. */
  CANCEL = "cancel",
  /** The browser was dismissed. */
  DISMISS = "dismiss",
  /** The browser opened (Android and web: no dismissal is reported). */
  OPENED = "opened",
  /** Another session was already open. */
  LOCKED = "locked",
}

/** The iOS presentation style (ignored here). */
export enum WebBrowserPresentationStyle {
  /** Full screen. */
  FULL_SCREEN = "fullScreen",
  /** Page sheet. */
  PAGE_SHEET = "pageSheet",
  /** Form sheet. */
  FORM_SHEET = "formSheet",
  /** Current context. */
  CURRENT_CONTEXT = "currentContext",
  /** Over full screen. */
  OVER_FULL_SCREEN = "overFullScreen",
  /** Over current context. */
  OVER_CURRENT_CONTEXT = "overCurrentContext",
  /** Popover. */
  POPOVER = "popover",
  /** Automatic. */
  AUTOMATIC = "automatic",
}

/** Window features for the web popup (ignored here). */
export type WebBrowserWindowFeatures = Record<string, number | boolean | string>;

/** Options for {@linkcode openBrowserAsync} (all accepted, none needed here). */
export interface WebBrowserOpenOptions {
  /** The toolbar colour (ignored). */
  toolbarColor?: string;
  /** The Android browser package (ignored). */
  browserPackage?: string;
  /** Collapse the toolbar on scroll (ignored). */
  enableBarCollapsing?: boolean;
  /** The secondary toolbar colour (ignored). */
  secondaryToolbarColor?: string;
  /** Show the page title (ignored). */
  showTitle?: boolean;
  /** Show the share menu item (ignored). */
  enableDefaultShareMenuItem?: boolean;
  /** Keep the tab in recents (ignored). */
  showInRecents?: boolean;
  /** Open in a new task (ignored). */
  createTask?: boolean;
  /** Use a proxy activity (ignored). */
  useProxyActivity?: boolean;
  /** The controls colour (ignored). */
  controlsColor?: string;
  /** The dismiss button style (ignored). */
  dismissButtonStyle?: "done" | "close" | "cancel";
  /** Open in reader mode (ignored). */
  readerMode?: boolean;
  /** The presentation style (ignored). */
  presentationStyle?: WebBrowserPresentationStyle;
  /** The web window name (ignored). */
  windowName?: string;
  /** The web window features (ignored). */
  windowFeatures?: string | WebBrowserWindowFeatures;
}

/** Options for {@linkcode openAuthSessionAsync}. */
export type AuthSessionOpenOptions = WebBrowserOpenOptions & {
  /** iOS: do not share cookies with Safari. */
  preferEphemeralSession?: boolean;
  /** iOS: prefer universal links (ignored). */
  preferUniversalLinks?: boolean;
};

/** A plain session result. */
export interface WebBrowserResult {
  /** How it ended. */
  type: WebBrowserResultType;
}

/** A successful auth session: the redirect URL. */
export interface WebBrowserRedirectResult {
  /** `"success"`. */
  type: "success";
  /** The URL the provider redirected to. */
  url: string;
}

/** What {@linkcode openAuthSessionAsync} resolves with. */
export type WebBrowserAuthSessionResult = WebBrowserRedirectResult | WebBrowserResult;

/** What the Custom Tabs warm-up calls resolve with. */
export interface ServiceActionResult {
  /** The Custom Tabs service package (none here). */
  servicePackage?: string;
}

/** What {@linkcode getCustomTabsSupportingBrowsersAsync} resolves with. */
export interface WebBrowserCustomTabsResults {
  /** The default browser package. */
  defaultBrowserPackage?: string;
  /** The preferred browser package. */
  preferredBrowserPackage?: string;
  /** Browsers supporting Custom Tabs. */
  browserPackages: string[];
  /** Custom Tabs service packages. */
  servicePackages: string[];
}

/** Options for {@linkcode maybeCompleteAuthSession}. */
export interface WebBrowserCompleteAuthSessionOptions {
  /** Skip the redirect check (there is none here). */
  skipRedirectCheck?: boolean;
}

/** What {@linkcode maybeCompleteAuthSession} returns. */
export interface WebBrowserCompleteAuthSessionResult {
  /** Whether the popup's URL was handed back to its opener. */
  type: "success" | "failed";
  /** Why, in words. */
  message: string;
}

/**
 * Open `url` in the in-app browser (native) or a new window (web).
 *
 * @param url An `http(s):` URL.
 * @param _options Accepted for compatibility.
 * @returns `{ type: "opened" }` once handed off: no dismissal is observable here.
 */
export async function openBrowserAsync(
  url: string,
  _options?: WebBrowserOpenOptions,
): Promise<WebBrowserResult> {
  await openExternal(url);
  return { type: WebBrowserResultType.OPENED };
}

/**
 * Dismiss the in-app browser: not controllable here.
 *
 * @returns `{ type: "dismiss" }`.
 */
export function dismissBrowser(): Promise<{ type: WebBrowserResultType.DISMISS }> {
  return Promise.resolve({ type: WebBrowserResultType.DISMISS });
}

/** The custom scheme of `redirectUrl`, or a placeholder the web popup ignores. */
function callbackScheme(redirectUrl: string | null | undefined): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(redirectUrl ?? "")?.[1]?.toLowerCase();
  return scheme && scheme !== "http" && scheme !== "https" ? scheme : "denext-web";
}

/**
 * Sign in through an auth session: open `url` and resolve with the URL the provider
 * redirects to.
 *
 * - Natively `redirectUrl` must use the app's custom scheme (`myapp://auth`), which ends the
 *   session.
 * - On the web the redirect is an https page of this origin that calls
 *   {@linkcode maybeCompleteAuthSession}.
 *
 * @param url The provider's authorization URL (absolute `https:`).
 * @param redirectUrl The redirect URL the provider sends back to.
 * @param options `preferEphemeralSession` (iOS); the rest is ignored.
 * @returns `{ type: "success", url }`, `{ type: "cancel" }` when the user closed it,
 * `{ type: "locked" }` when another session is open, or `{ type: "dismiss" }` on timeout.
 */
export async function openAuthSessionAsync(
  url: string,
  redirectUrl?: string | null,
  options: AuthSessionOpenOptions = {},
): Promise<WebBrowserAuthSessionResult> {
  try {
    const result = await openAuthSession(url, {
      callbackScheme: callbackScheme(redirectUrl),
      preferEphemeral: options.preferEphemeralSession === true,
    });
    return { type: "success", url: result.url };
  } catch (err) {
    const code = (err as AuthSessionError | undefined)?.code;
    if (code === "cancelled") return { type: WebBrowserResultType.CANCEL };
    if (code === "busy") return { type: WebBrowserResultType.LOCKED };
    if (code === "timeout") return { type: WebBrowserResultType.DISMISS };
    throw err;
  }
}

/** Dismiss the auth session: not controllable here (it ends on redirect or cancel). */
export function dismissAuthSession(): void {}

/**
 * On a web redirect page opened by {@linkcode openAuthSessionAsync}: hand this page's URL
 * back to the opener and close the popup.
 *
 * @param _options Accepted for compatibility.
 * @returns `success` when handed back, `failed` when this page has no opener.
 */
export function maybeCompleteAuthSession(
  _options?: WebBrowserCompleteAuthSessionOptions,
): WebBrowserCompleteAuthSessionResult {
  return completeAuthSession()
    ? { type: "success", message: "" }
    : { type: "failed", message: "Not an auth session popup (no opener)" };
}

/**
 * Warm up a Custom Tabs browser (Android): nothing to do here.
 *
 * @param _browserPackage Ignored.
 * @returns An empty result.
 */
export function warmUpAsync(_browserPackage?: string): Promise<ServiceActionResult> {
  return Promise.resolve({});
}

/**
 * Pre-load a URL in a Custom Tabs browser (Android): nothing to do here.
 *
 * @param _url Ignored.
 * @param _browserPackage Ignored.
 * @returns An empty result.
 */
export function mayInitWithUrlAsync(
  _url: string,
  _browserPackage?: string,
): Promise<ServiceActionResult> {
  return Promise.resolve({});
}

/**
 * Release a warmed-up Custom Tabs browser (Android): nothing to do here.
 *
 * @param _browserPackage Ignored.
 * @returns An empty result.
 */
export function coolDownAsync(_browserPackage?: string): Promise<ServiceActionResult> {
  return Promise.resolve({});
}

/**
 * The browsers supporting Custom Tabs (Android): none are listed here.
 *
 * @returns Empty lists.
 */
export function getCustomTabsSupportingBrowsersAsync(): Promise<WebBrowserCustomTabsResults> {
  return Promise.resolve({ browserPackages: [], servicePackages: [] });
}
