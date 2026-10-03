/**
 * Clerk in the Capacitor shell (`denext/mobile/clerk`): the same `<ClerkProvider>` an app uses on
 * the web (`@clerk/nextjs`, `@clerk/react`) signs in inside the iOS / Android app — the shell's
 * counterpart of `denext/desktop/clerk`.
 *
 * {@linkcode installClerkMobileBridge} fills `window.__clerk_internal_electron`, the bridge
 * `@clerk/electron/react` reads, and (with `nativeClerk`) switches the clerk-js instance any Clerk
 * React SDK loads into native mode, as `@clerk/electron/react` does with its bundled one:
 *
 * - the client JWT lives in the iOS Keychain / an Android Keystore-encrypted store
 *   (`secureStore`, `denext mobile add clerk` installs the plugin) and rides every Frontend API
 *   request as `Authorization` — a WebView's cookies for Clerk's domain are third-party there;
 * - Google / GitHub open in the OS's auth session (`openAuthSession`: `ASWebAuthenticationSession`
 *   on iOS, a Custom Tab on Android), which comes back to the custom-scheme redirect
 *   (`<scheme>://app/`, on the Clerk instance's native redirect allowlist);
 * - passkeys: a page at `capacitor://localhost` / `https://localhost` cannot use WebAuthn for
 *   Clerk's relying party, so a passkey sign-in continues in that auth session on Clerk's hosted
 *   pages (the RP's own domain), with `state` and S256 PKCE bound to this page
 *   ({@linkcode startClerkMobileBrowserSignIn}). Creating a passkey is done on the web.
 *
 * WHY Clerk's OAuth callback is exempt from PKCE: Clerk's native flow puts no PKCE in the URL it
 * opens (the provider's), and the callback's `rotating_token_nonce` is redeemed with
 * `signIn.reload({ rotatingTokenNonce })`, a request authenticated by this client's own client JWT
 * on this client's sign-in. On iOS the callback never leaves the sheet; on Android it comes back
 * through the app's intent filter for the scheme, so only a callback for the open session is
 * accepted (exact scheme, host and path), and a Clerk callback outside one is never routed to the
 * page's deep links.
 *
 * Client-only. Nothing runs at import.
 *
 * @module
 */

import { isNativeShell, runtimePlatform } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";
import { secureStore } from "./secure-store.ts";
import { dropStrayClerkCallbacks, openAuthSession } from "./auth-session.ts";
import {
  adoptNativeClerk,
  type ClerkBrowserSignInOptions,
  clerkHostedSignIn,
  type ClerkLike,
  type ClerkOAuthTransport,
  type ClerkPasskeysAdapter,
  type ClerkTokenCache,
  defaultClerk,
} from "../runtime/clerk-native.ts";

export type {
  ClerkBrowserSignInOptions,
  ClerkLike,
  ClerkOAuthTransport,
  ClerkPasskeysAdapter,
  ClerkTokenCache,
} from "../runtime/clerk-native.ts";

/** `@clerk/electron`'s `CALLBACK_TIMEOUT_MS`: an OAuth flow gives up after 3 minutes. */
const OAUTH_TIMEOUT_MS = 180_000;
/** How long a browser (hosted) sign-in may take. */
const BROWSER_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** A custom URL scheme (lower-case: Android matches schemes case-sensitively). */
const SCHEME = /^[a-z][a-z0-9+.-]*$/;
/** Schemes that are not an app's own. */
const RESERVED = new Set(["http", "https", "file", "capacitor", "intent", "javascript", "data"]);

/** Options for {@linkcode installClerkMobileBridge}. */
export interface ClerkMobileBridgeOptions {
  /**
   * The custom URL scheme OAuth comes back to (`denext mobile add clerk --scheme <scheme>`
   * registers it): the redirect is `<scheme>://app/` unless {@linkcode redirectUrl} says
   * otherwise.
   */
  readonly scheme: string;
  /**
   * The OAuth redirect URL (default `<scheme>://app/`). Its scheme must be `scheme`, and the URL
   * must be on the Clerk instance's native redirect allowlist.
   */
  readonly redirectUrl?: string;
  /** The secure-store key prefix for the token cache (default `"clerk."`). */
  readonly keyPrefix?: string;
  /**
   * Switch the clerk-js instance a Clerk React SDK loads (`globalThis.Clerk`) to native mode.
   * Leave it off with `@clerk/electron/react`'s provider, which does it itself.
   */
  readonly nativeClerk?: boolean;
  /**
   * Passkeys in native mode: `"browser"` (default) continues a passkey sign-in in the auth
   * session on Clerk's hosted pages; `"none"` reports them unsupported (Clerk hides them).
   */
  readonly passkeys?: "browser" | "none";
  /** The Clerk instance for the hosted sign-in (default `globalThis.Clerk`). */
  readonly getClerk?: () => ClerkLike | undefined;
}

/** What {@linkcode installClerkMobileBridge} installed. */
export interface ClerkMobileBridge {
  /** `window.__clerk_internal_electron`. */
  readonly bridge: { tokenCache: ClerkTokenCache; oauthTransport: ClerkOAuthTransport };
  /** The redirect URL OAuth comes back to. */
  readonly redirectUrl: string;
}

/** Where a callback must land: scheme, host and path. */
function targetOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname || "/"}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/** `options.redirectUrl` (or `<scheme>://app/`), checked against `scheme`. */
function redirectFor(options: ClerkMobileBridgeOptions): { scheme: string; redirect: string } {
  const scheme = options?.scheme;
  if (typeof scheme !== "string" || !SCHEME.test(scheme) || RESERVED.has(scheme)) {
    throw new TypeError(
      'installClerkMobileBridge: scheme must be the app\'s own URL scheme, such as "myapp"',
    );
  }
  const redirect = options.redirectUrl ?? `${scheme}://app/`;
  if (!targetOf(redirect) || new URL(redirect).protocol !== `${scheme}:`) {
    throw new TypeError(`installClerkMobileBridge: redirectUrl must be a ${scheme}: URL`);
  }
  return { scheme, redirect };
}

/** Whether the shell has the secure-storage plugin (`denext mobile add clerk` / `secure-store`). */
function hasSecureStorage(): boolean {
  return nativePlugin("SecureStorage", ["internalGetItem"]) !== undefined;
}

/**
 * The token cache: the Keychain / Keystore through `secureStore`. Without the plugin the token is
 * kept in memory (the session lasts until the app quits) rather than in the WebView's IndexedDB,
 * which is not secret.
 */
function tokenCache(prefix: string): ClerkTokenCache {
  const memory = new Map<string, string>();
  const native = hasSecureStorage();
  if (!native) {
    console.warn(
      "denext/mobile/clerk: the secure-storage plugin is not installed (`denext mobile add " +
        "clerk`); Clerk's session lasts only until the app quits.",
    );
  }
  return {
    getToken: async (key) => native ? await secureStore.get(prefix + key) : memory.get(key) ?? null,
    saveToken: async (key, value) => {
      if (native) await secureStore.set(prefix + key, value);
      else memory.set(key, value);
    },
    clearToken: async (key) => {
      if (native) await secureStore.delete(prefix + key);
      else memory.delete(key);
    },
  };
}

/** The OAuth transport (`@clerk/electron`'s main-process semantics over `openAuthSession`). */
function oauthTransport(scheme: string, redirect: string): ClerkOAuthTransport {
  let pending = false;
  const target = targetOf(redirect);
  return {
    getRedirectUrl: () => Promise.resolve(redirect),
    open: async (url) => {
      if (pending) throw new Error("Clerk: an OAuth flow is already pending.");
      if (new URL(url).protocol !== "https:") {
        throw new TypeError(`Clerk: refusing to open unsupported OAuth URL protocol: ${url}`);
      }
      pending = true;
      try {
        const { url: callbackUrl } = await openAuthSession(url, {
          callbackScheme: scheme,
          timeoutMs: OAUTH_TIMEOUT_MS,
        });
        // Only this session's redirect: another path or host of the scheme is not Clerk's answer.
        if (targetOf(callbackUrl) !== target) {
          throw new Error("Clerk: the sign-in came back to another URL than its redirect");
        }
        return { callbackUrl };
      } finally {
        pending = false;
      }
    },
  };
}

/** A clerk-js WebAuthn result carrying an error (`ClerkWebAuthnError`'s `code` shape). */
function webAuthnError(code: string, message: string) {
  const error = Object.assign(new Error(message), { code });
  error.name = "ClerkWebAuthnError";
  return { publicKeyCredential: null, error };
}

/**
 * The passkeys adapter clerk-js gets in native mode: a sign-in continues on Clerk's hosted pages
 * in the auth session (where the RP's own domain serves the passkey); creating one is refused
 * (create passkeys on the web).
 */
function passkeysAdapter(
  options: ClerkMobileBridgeOptions,
  redirect: string,
): ClerkPasskeysAdapter {
  const browser = options.passkeys !== "none";
  return {
    create: () =>
      Promise.resolve(webAuthnError(
        "passkey_not_supported",
        "Create a passkey on the web (the app signs in with it through Clerk's hosted page).",
      )),
    get: () => {
      const clerk = (options.getClerk ?? defaultClerk)();
      if (!browser || !clerk) {
        return Promise.resolve(webAuthnError("passkey_not_supported", "Passkeys are unavailable."));
      }
      startClerkMobileBrowserSignIn(clerk, { redirectUrl: redirect, scheme: options.scheme })
        .catch((err) => console.error("denext/mobile/clerk: the browser sign-in failed", err));
      return Promise.resolve(
        webAuthnError("passkey_retrieval_cancelled", "Continuing the sign-in in the browser."),
      );
    },
    isSupported: () => browser,
    isAutoFillSupported: () => Promise.resolve(false),
    isPlatformAuthenticatorSupported: () => Promise.resolve(browser),
  };
}

/**
 * Install Clerk's native bridge in the Capacitor shell (see the module docs). Call it once, before
 * the page's Clerk code loads clerk-js — from `instrumentation-client.ts` in an App Router app, or
 * at the top of a SPA entry. Outside the shell (the web, Deno Desktop) it installs nothing.
 *
 * Needs `denext mobile add clerk --scheme <scheme>` (the auth-session and secure-storage plugins
 * and the scheme's registration), `<scheme>://app/` on the Clerk instance's native redirect
 * allowlist, and the shell's page origin (`capacitor://localhost` on iOS, `https://localhost` on
 * Android) in its allowed origins: native mode sends `Authorization` and the WebView adds
 * `Origin`, and the Frontend API refuses both together from an origin it does not allow.
 *
 * @param options The callback scheme, and the redirect URL, key prefix, native mode and passkeys.
 * @returns What was installed, or `undefined` outside the shell.
 * @example
 * ```ts
 * // instrumentation-client.ts
 * import { installClerkMobileBridge } from "denext/mobile/clerk";
 * installClerkMobileBridge({ scheme: "myapp", nativeClerk: true });
 * ```
 */
export function installClerkMobileBridge(
  options: ClerkMobileBridgeOptions,
): ClerkMobileBridge | undefined {
  if (!isNativeShell() || runtimePlatform() === "desktop") return undefined;
  const { scheme, redirect } = redirectFor(options);
  const bridge = {
    tokenCache: tokenCache(options.keyPrefix ?? "clerk."),
    oauthTransport: oauthTransport(scheme, redirect),
  };
  (globalThis as { __clerk_internal_electron?: unknown }).__clerk_internal_electron = bridge;
  // A Clerk callback outside its session is a forgery or a replay: never routed to the page.
  dropStrayClerkCallbacks(redirect);
  if (options.nativeClerk === true) adoptNativeClerk(bridge, passkeysAdapter(options, redirect));
  return { bridge, redirectUrl: redirect };
}

/** Options for {@linkcode startClerkMobileBrowserSignIn}. */
export interface ClerkMobileBrowserSignInOptions extends ClerkBrowserSignInOptions {
  /** The redirect's custom scheme (the auth session's callback scheme). */
  readonly scheme: string;
}

/**
 * Sign in through Clerk's hosted pages in the shell's auth session and activate the session here:
 * `@clerk/expo`'s `useHostedAuth` protocol over {@linkcode openAuthSession}, with a fresh `state`
 * and S256 PKCE pair; the callback's nonce is redeemed only with the verifier, which never leaves
 * this page. The passkey path of {@linkcode installClerkMobileBridge}, and any method Clerk's
 * hosted pages offer.
 *
 * @param clerk The Clerk instance (`useClerk()`, or `globalThis.Clerk`).
 * @param options The redirect URL and its scheme, mode and timeout.
 * @returns The activated session's id.
 */
export function startClerkMobileBrowserSignIn(
  clerk: ClerkLike,
  options: ClerkMobileBrowserSignInOptions,
): Promise<{ createdSessionId: string }> {
  const target = targetOf(options.redirectUrl);
  return clerkHostedSignIn(clerk, options, async (hostedUrl) => {
    const { url } = await openAuthSession(hostedUrl, {
      callbackScheme: options.scheme,
      timeoutMs: options.timeoutMs ?? BROWSER_SIGN_IN_TIMEOUT_MS,
    });
    if (targetOf(url) !== target) {
      throw new Error("Clerk: the sign-in came back to another URL than its redirect");
    }
    return url;
  });
}
