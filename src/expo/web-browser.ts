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

import { isNativeShell, openExternal } from "../mobile/bridge.ts";
import {
  AUTH_SESSION_WINDOW,
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
  /** Hand the URL back without checking it starts with the session's redirect URL. */
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
  if (isNativeShell() && /^https?:/i.test(redirectUrl ?? "")) {
    // The native session ends only on a redirect to the app's own scheme: an http(s) redirect
    // would leave it waiting for good. Refuse up front, as nothing could complete it.
    throw new TypeError(
      `openAuthSessionAsync: redirectUrl "${redirectUrl}" must use the app's custom scheme ` +
        "(myapp://…) in the native shell; http(s) redirects only complete on the web",
    );
  }
  rememberRedirect(redirectUrl);
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

/** Where the expected web redirect URL is kept for the popup's {@linkcode maybeCompleteAuthSession}. */
const REDIRECT_KEY = "denext-auth-session:redirect";

/** The page's `localStorage`, or undefined (SSR, storage blocked). */
function storage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return undefined;
  }
}

/** Keep an `http(s)` redirect URL for the popup to check its own URL against (as Expo's does). */
function rememberRedirect(redirectUrl: string | null | undefined): void {
  if (!redirectUrl || !/^https?:/i.test(redirectUrl)) return;
  try {
    storage()?.setItem(REDIRECT_KEY, redirectUrl);
  } catch {
    // Storage blocked: the popup's check then fails closed unless skipRedirectCheck.
  }
}

/** Dismiss the auth session: not controllable here (it ends on redirect or cancel). */
export function dismissAuthSession(): void {}

/**
 * On a web redirect page opened by {@linkcode openAuthSessionAsync}: hand this page's URL
 * back to the opener and close the popup — only in the auth-session popup itself, and (unless
 * `skipRedirectCheck`) only when this page's URL starts with the `redirectUrl` that
 * `openAuthSessionAsync` was given, as Expo checks.
 *
 * @param options `skipRedirectCheck` hands the URL back without comparing it.
 * @returns `success` when handed back, `failed` (with the reason) otherwise.
 */
export function maybeCompleteAuthSession(
  options?: WebBrowserCompleteAuthSessionOptions,
): WebBrowserCompleteAuthSessionResult {
  const g = globalThis as { name?: string; location?: { href: string } };
  if (g.name !== AUTH_SESSION_WINDOW) {
    return { type: "failed", message: "No auth session is currently in progress" };
  }
  if (options?.skipRedirectCheck !== true) {
    let expected: string | null | undefined;
    try {
      expected = storage()?.getItem(REDIRECT_KEY);
    } catch {
      expected = undefined;
    }
    if (!expected) {
      return { type: "failed", message: "Could not find the redirect URL of the auth session" };
    }
    const url = g.location?.href ?? "";
    if (!url.startsWith(expected)) {
      return {
        type: "failed",
        message: `Current URL "${url}" and original redirect URL "${expected}" do not match.`,
      };
    }
  }
  if (!completeAuthSession()) {
    return { type: "failed", message: "Not an auth session popup (no opener)" };
  }
  try {
    storage()?.removeItem(REDIRECT_KEY);
  } catch {
    // Storage blocked: nothing to clean.
  }
  return { type: "success", message: "" };
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
