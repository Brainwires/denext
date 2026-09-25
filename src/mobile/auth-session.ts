/**
 * OAuth / OpenID Connect sign-in in a system browser sheet for `denext/mobile`: the web side
 * of the native `DenextAuthSession` plugin that `denext mobile add auth-session` installs, and
 * a popup fallback on the web.
 *
 * Nothing runs at import.
 *
 * @module
 */

import { isNativeShell, runtimePlatform } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";

/**
 * The `code` on an {@linkcode openAuthSession} rejection:
 *
 * - `cancelled`: the user closed the sheet (or the popup) without finishing;
 * - `busy`: another auth session is still open (one at a time);
 * - `invalid`: `url` is not an absolute `https:` URL, `callbackScheme` is not a custom scheme,
 *   or `timeoutMs` is not a positive number;
 * - `unsupported`: the shell has no `DenextAuthSession` plugin, the sheet could not be
 *   presented, the web popup was blocked, or there is no window (SSR);
 * - `timeout`: `timeoutMs` passed first (the sheet or popup is closed where the platform
 *   allows it).
 */
export type AuthSessionErrorCode = "cancelled" | "busy" | "invalid" | "unsupported" | "timeout";

/** The `Error` an {@linkcode openAuthSession} promise rejects with. */
export interface AuthSessionError extends Error {
  /** Why it failed. */
  readonly code: AuthSessionErrorCode;
}

/** Options for {@linkcode openAuthSession}. */
export interface AuthSessionOptions {
  /**
   * The custom URL scheme the provider redirects back to, without `://` (e.g. `"myapp"` for a
   * `myapp://auth/callback` redirect URI): lower-case letters, digits, `+`, `-` or `.` after a
   * letter. iOS catches it inside the sheet; Android receives it through the app's intent
   * filter for it (`denext mobile add auth-session --scheme myapp`). Ignored by the web popup,
   * whose redirect is an https page of this origin that calls {@linkcode completeAuthSession}.
   */
  readonly callbackScheme: string;
  /**
   * iOS only: do not share cookies with Safari (`prefersEphemeralWebBrowserSession`), so no
   * existing provider login is reused and none is kept. Default `false`.
   */
  readonly preferEphemeral?: boolean;
  /** Give up after this many ms with code `timeout`. Default: no limit. */
  readonly timeoutMs?: number;
}

/** What {@linkcode openAuthSession} resolves with. */
export interface AuthSessionResult {
  /** The full callback URL, query and fragment included (`code`, `state`, or `error`). */
  readonly url: string;
}

/** The JS face of the native plugin (Capacitor seeds a stub per registered method). */
interface DenextAuthSessionPlugin {
  start(options: {
    url: string;
    callbackScheme: string;
    preferEphemeral: boolean;
  }): Promise<{ url?: unknown } | undefined>;
  cancel?(): Promise<unknown>;
}

/** A session in flight: its outcome, and how to stop it early (on timeout). */
interface RunningSession {
  readonly result: Promise<string>;
  stop(): void;
}

/** The web globals the popup fallback uses. */
interface PopupWindow {
  open?: (url: string, target: string, features: string) => Window | null;
  addEventListener?: (type: "message", listener: (event: MessageEvent) => void) => void;
  removeEventListener?: (type: "message", listener: (event: MessageEvent) => void) => void;
  location?: { origin: string; href: string };
  opener?: { postMessage(message: unknown, targetOrigin: string): void } | null;
  close?: () => void;
}

const PLUGIN_NAME = "DenextAuthSession";
/** The `type` of the message {@linkcode completeAuthSession} posts to the opener. */
const CALLBACK_MESSAGE = "denext:auth-callback";
/** How often the web fallback checks whether the popup was closed. */
const POPUP_POLL_MS = 500;
/** How long a closed popup waits for its callback message before rejecting `cancelled`. */
const CLOSE_GRACE_MS = 300;
/** How long a delivered callback URL stays claimed from deep-link routing (Android). */
const CLAIM_MS = 10_000;

// Array literals, not `new Set(...)`: nothing may run at module scope in denext/mobile.
const ERROR_CODES: readonly string[] = [
  "cancelled",
  "busy",
  "invalid",
  "unsupported",
  "timeout",
] satisfies readonly AuthSessionErrorCode[];
/** Schemes that are not an app's own (the web, the OS, Capacitor's webview origin). */
const RESERVED_SCHEMES: readonly string[] = [
  "http",
  "https",
  "file",
  "content",
  "javascript",
  "data",
  "blob",
  "about",
  "mailto",
  "tel",
  "sms",
  "intent",
  "capacitor",
];

/** Whether a session is open (in this page); one at a time. */
let active = false;
/** The open native session's callback scheme, claimed from deep-link routing. */
let claimedScheme: string | undefined;
/** The last native callback URL, claimed until `claimedUntil`. */
let claimedUrl: string | undefined;
let claimedUntil = 0;

/** Build an {@linkcode AuthSessionError}. */
function authSessionError(code: AuthSessionErrorCode, message: string): AuthSessionError {
  const err = new Error(`openAuthSession: ${message}`) as Error & { code: AuthSessionErrorCode };
  err.name = "AuthSessionError";
  err.code = code;
  return err;
}

/** `url` normalised, when it is an absolute https URL; throws `invalid` otherwise. */
function checkUrl(url: unknown): string {
  let parsed: URL | undefined;
  try {
    parsed = typeof url === "string" ? new URL(url) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed?.protocol !== "https:" || parsed.hostname === "") {
    throw authSessionError("invalid", "url must be an absolute https: URL");
  }
  return parsed.href;
}

/** `scheme` when it is a lower-case custom scheme; throws `invalid` otherwise. */
function checkScheme(scheme: unknown): string {
  if (
    typeof scheme !== "string" || !/^[a-z][a-z0-9+.-]*$/.test(scheme) ||
    RESERVED_SCHEMES.includes(scheme)
  ) {
    throw authSessionError(
      "invalid",
      'callbackScheme must be a custom URL scheme without "://", such as "myapp"',
    );
  }
  return scheme;
}

/** `timeoutMs` when absent or a positive finite number; throws `invalid` otherwise. */
function checkTimeout(timeoutMs: unknown): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw authSessionError("invalid", "timeoutMs must be a positive number of milliseconds");
  }
  return timeoutMs;
}

/** A session that failed before it started. */
function failed(error: AuthSessionError): RunningSession {
  return { result: Promise.reject(error), stop: () => {} };
}

/** A native rejection as an {@linkcode AuthSessionError} (an unknown code reads `unsupported`). */
function fromNative(err: unknown): AuthSessionError {
  const code = typeof err === "object" && err !== null
    ? (err as { code?: unknown }).code
    : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return authSessionError(
    typeof code === "string" && ERROR_CODES.includes(code)
      ? code as AuthSessionErrorCode
      : "unsupported",
    message,
  );
}

/** Settle the deep-link claim: the scheme is released, the callback URL held a little longer. */
function releaseClaim(url: string | undefined): void {
  claimedScheme = undefined;
  if (url === undefined) return;
  claimedUrl = url;
  claimedUntil = Date.now() + CLAIM_MS;
}

/** The native session through the shell's `DenextAuthSession` plugin. */
function startNative(url: string, scheme: string, ephemeral: boolean): RunningSession {
  const plugin = nativePlugin<DenextAuthSessionPlugin>(PLUGIN_NAME, ["start"]);
  if (!plugin) {
    return failed(authSessionError(
      "unsupported",
      "the shell has no DenextAuthSession plugin (run `denext mobile add auth-session`)",
    ));
  }
  claimedScheme = scheme;
  const result = Promise.resolve()
    .then(() => plugin.start({ url, callbackScheme: scheme, preferEphemeral: ephemeral }))
    .then((answer) => {
      const callback = answer?.url;
      if (typeof callback !== "string" || !callback.toLowerCase().startsWith(`${scheme}:`)) {
        throw authSessionError("unsupported", "the shell answered without a callback URL");
      }
      releaseClaim(callback);
      return callback;
    }, (err) => {
      throw fromNative(err);
    });
  result.catch(() => releaseClaim(undefined));
  return {
    result,
    stop: () => void Promise.resolve().then(() => plugin.cancel?.()).catch(() => {}),
  };
}

/** Whether `data` is the message {@linkcode completeAuthSession} posts. */
function isCallbackMessage(data: unknown): data is { type: string; url: string } {
  if (typeof data !== "object" || data === null) return false;
  const message = data as { type?: unknown; url?: unknown };
  return message.type === CALLBACK_MESSAGE && typeof message.url === "string";
}

/** The web fallback: a popup whose callback page posts the URL back. */
function startWeb(url: string): RunningSession {
  const g = globalThis as PopupWindow;
  const location = g.location;
  if (typeof g.open !== "function" || typeof g.addEventListener !== "function" || !location) {
    return failed(
      authSessionError("unsupported", "no window to open the sign-in popup from (SSR?)"),
    );
  }
  const popup = g.open(url, "denext-auth-session", "popup,width=520,height=720");
  if (!popup) return failed(authSessionError("unsupported", "the sign-in popup was blocked"));
  let finish: (outcome: { url: string } | { error: AuthSessionError }) => void = () => {};
  const result = new Promise<string>((resolve, reject) => {
    let grace: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== popup) return;
      if (isCallbackMessage(event.data)) finish({ url: event.data.url });
    };
    const poll = setInterval(() => {
      if (!popup.closed || grace !== undefined) return;
      // The callback page posts and then closes: give its message a moment to land.
      grace = setTimeout(
        () => finish({ error: authSessionError("cancelled", "the sign-in popup was closed") }),
        CLOSE_GRACE_MS,
      );
    }, POPUP_POLL_MS);
    let settled = false;
    finish = (outcome) => {
      if (settled) return;
      settled = true;
      g.removeEventListener?.("message", onMessage);
      clearInterval(poll);
      clearTimeout(grace);
      if ("url" in outcome) resolve(outcome.url);
      else reject(outcome.error);
    };
    g.addEventListener!("message", onMessage);
  });
  return {
    result,
    stop: () => {
      finish({ error: authSessionError("timeout", "timed out") });
      try {
        popup.close();
      } catch {
        // Already gone.
      }
    },
  };
}

/** `session`'s result, or a `timeout` rejection (stopping it) after `timeoutMs`. */
async function within(session: RunningSession, timeoutMs: number | undefined): Promise<string> {
  if (timeoutMs === undefined) return await session.result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      session.stop();
      reject(authSessionError("timeout", `no callback within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([session.result, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sign in with an OAuth 2 / OpenID Connect provider in a system browser sheet, and get the
 * callback URL the provider redirected to.
 *
 * - **iOS** (inside the Capacitor shell): an `ASWebAuthenticationSession` sheet. It shares
 *   Safari's cookies unless `preferEphemeral`, and catches the redirect to
 *   `<callbackScheme>:` itself.
 * - **Android** (inside the shell): a Custom Tab. The redirect reaches the app through its
 *   intent filter for `callbackScheme` (`denext mobile add auth-session --scheme <scheme>`)
 *   and resolves the call. Coming back without a callback (back button, closing the tab)
 *   rejects `cancelled`. While a session is open, a link with that scheme is not routed by
 *   {@linkcode onDeepLink}.
 * - **Web**: a popup window. Register an https page of this origin as the redirect URI and
 *   call {@linkcode completeAuthSession} there; the popup posts its URL back and closes. A
 *   blocked popup rejects `unsupported` (call this from a click handler), and a popup closed
 *   without a callback rejects `cancelled`. A provider page served with
 *   `Cross-Origin-Opener-Policy: same-origin` cuts the popup off from this page, which then
 *   reads as `cancelled`: use a full-page redirect for such providers.
 *
 * Only one session is open at a time (`busy` otherwise). PKCE and `state` stay your job: this
 * only opens the page and hands back the callback URL. Generate `state` (and a PKCE verifier)
 * before the call, compare `state` after it, and exchange the `code` on your server.
 *
 * @param url The provider's authorization URL (absolute `https:`).
 * @param options The callback scheme, and the iOS ephemeral and timeout options.
 * @returns The callback URL. It rejects with an {@linkcode AuthSessionError} whose `code` is
 * one of {@linkcode AuthSessionErrorCode}.
 * @example
 * ```ts
 * import { openAuthSession } from "denext/mobile";
 *
 * export async function signIn(): Promise<void> {
 *   const state = crypto.randomUUID();
 *   const authorize = new URL("https://auth.example.com/authorize");
 *   authorize.searchParams.set("client_id", "my-app");
 *   authorize.searchParams.set("redirect_uri", "myapp://auth/callback");
 *   authorize.searchParams.set("response_type", "code");
 *   authorize.searchParams.set("state", state);
 *   // (add code_challenge / code_challenge_method for PKCE)
 *   const { url } = await openAuthSession(authorize.href, { callbackScheme: "myapp" });
 *   const params = new URL(url).searchParams;
 *   if (params.get("state") !== state) throw new Error("state mismatch");
 *   await fetch("/api/auth/exchange", { method: "POST", body: params.get("code") });
 * }
 * ```
 */
export async function openAuthSession(
  url: string,
  options: AuthSessionOptions,
): Promise<AuthSessionResult> {
  const target = checkUrl(url);
  const timeoutMs = checkTimeout(options?.timeoutMs);
  // Deno Desktop: hand off to the loopback system-browser flow (it ignores callbackScheme, so
  // this runs before checkScheme). Dynamic import keeps the desktop client out of web/mobile bundles.
  if (runtimePlatform() === "desktop") {
    return await (await import("../desktop/auth-session.ts"))
      .startDesktopAuthSession(target, { timeoutMs });
  }
  const scheme = checkScheme(options?.callbackScheme);
  if (active) throw authSessionError("busy", "another auth session is still open");
  active = true;
  try {
    const session = isNativeShell()
      ? startNative(target, scheme, options.preferEphemeral === true)
      : startWeb(target);
    return { url: await within(session, timeoutMs) };
  } finally {
    active = false;
  }
}

/**
 * Finish a web {@linkcode openAuthSession}: call it on the callback page the provider redirects
 * the popup to (an https page of the same origin). It posts this page's full URL (`code`,
 * `state` and all) to the window that opened the popup, addressed to this origin only, then
 * closes the popup. Not needed inside the native shell, where the callback never loads a page.
 *
 * @returns `true` when it posted to an opener; `false` when this page has no opener (it was
 * opened directly, or the provider's `Cross-Origin-Opener-Policy` severed it), so the page can
 * fall back to handling the callback itself.
 * @example
 * ```tsx
 * // app/auth/callback/complete.tsx
 * "use client";
 * import { useEffect } from "denext";
 * import { completeAuthSession } from "denext/mobile";
 *
 * export function Complete() {
 *   useEffect(() => {
 *     if (!completeAuthSession()) location.replace("/login");
 *   }, []);
 *   return <p>Signing you in…</p>;
 * }
 * ```
 */
export function completeAuthSession(): boolean {
  const g = globalThis as PopupWindow;
  const opener = g.opener;
  const location = g.location;
  if (!opener || !location || typeof opener.postMessage !== "function") return false;
  opener.postMessage({ type: CALLBACK_MESSAGE, url: location.href }, location.origin);
  g.close?.();
  return true;
}

/**
 * Whether `url` is the callback of a native auth session (open now, or delivered in the last
 * few seconds). Internal: `onDeepLink` skips it, since on Android the same redirect intent also
 * reaches the `App` plugin's `appUrlOpen`. Not re-exported from `denext/mobile`.
 */
export function isAuthSessionCallback(url: string): boolean {
  if (claimedScheme !== undefined && url.toLowerCase().startsWith(`${claimedScheme}:`)) {
    return true;
  }
  return url === claimedUrl && Date.now() < claimedUntil;
}

/** Forget the module's session state (tests only). */
export function resetAuthSessionForTesting(): void {
  active = false;
  claimedScheme = undefined;
  claimedUrl = undefined;
  claimedUntil = 0;
}
