/**
 * Clerk on Deno Desktop (`denext/desktop/clerk`): the bridge `@clerk/electron`'s React
 * `ClerkProvider` and `@clerk/electron/passkeys` read, filled from a `desktop.preload` instead of
 * an Electron preload, so an app's Clerk code runs unchanged in a Deno Desktop window.
 *
 * {@linkcode installClerkDesktopBridge} sets the same globals, with the same shapes, as
 * `exposeClerkBridge` from `@clerk/electron/preload`:
 *
 * - `window.__clerk_internal_electron = { tokenCache, oauthTransport }`:
 *   - `tokenCache.{getToken,saveToken,clearToken}` keep Clerk's client JWT in the OS keychain (the
 *     `secure-store` capability), under a per-app key prefix (the keychain service is already
 *     the app's identifier);
 *   - `oauthTransport.getRedirectUrl()` is the page origin plus `/` (`t3code://app/`), exactly what
 *     `@clerk/electron`'s main process returns for `createClerkBridge({ renderer: { scheme, host }
 *     })`; `oauthTransport.open(url)` opens the provider in the system browser and resolves
 *     `{ callbackUrl }` once a deep link to that redirect URL (same scheme, host and path) comes
 *     back, one flow at a time, giving up after 180 s — the main process's semantics — over
 *     `openAuthSession`'s custom-scheme flow (scheme declared, owner checked, callback consumed
 *     before `onDeepLink`).
 * - `window.__clerk_internal_electron_passkeys = { create, get, capabilities, electronMajor,
 *   platform }` (with `passkeys: true`) over the `passkeys` capability (`Deno.desktop.passkeys`).
 *
 * WHY Clerk's OAuth callback is exempt from the PKCE rule: Clerk's native flow puts no PKCE in the
 * URL it opens (the provider's), and the callback carries a `rotating_token_nonce` that clerk-js
 * redeems with `signIn.reload({ rotatingTokenNonce })` — a request authenticated by this client's
 * own client JWT (from the token cache, an `Authorization` header) on this client's sign-in
 * resource. Whether Clerk's servers refuse that nonce from a DIFFERENT client cannot be checked
 * from the client code, so the custom scheme is used only when this app handles it
 * (`scheme_owned_by_other_app` otherwise). See the desktop docs ("Clerk on Deno Desktop").
 *
 * Passkeys and `invalid_rp`: a macOS build not signed by the relying party's Apple team gets
 * `invalid_rp` for every native request. The bridge then stops offering native passkeys for the
 * rest of the launch (Clerk hides them; a custom-scheme page cannot use the webview's WebAuthn
 * either) and — for a sign-in, with `passkeyFallback: "browser"` (the default) — continues the
 * sign-in in the system browser through Clerk's hosted pages ({@linkcode startClerkBrowserSignIn}),
 * where the RP's own domain makes passkeys work.
 *
 * Client-only (web APIs; runs in the page, normally from the preload). Nothing runs at import.
 *
 * @module
 */

import { desktopRpc, hasDesktopBridge, isDesktopBridgeError } from "./bridge-client.ts";
import {
  hasOsAuthSession,
  type SchemeSessionInternals,
  startDesktopSchemeAuthSession,
} from "./auth-session.ts";
import { isPasskeyEnvelope, type PasskeyEnvelope, passkeyFailure } from "./passkey-envelope.ts";

export type { PasskeyEnvelope } from "./passkey-envelope.ts";

/** `@clerk/electron`'s `CALLBACK_TIMEOUT_MS`: an OAuth flow gives up after 3 minutes. */
const OAUTH_TIMEOUT_MS = 180_000;
/** How long a browser (hosted) sign-in may take. */
const BROWSER_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** Why Clerk's native OAuth callback carries no PKCE (recorded with the session). */
const CLERK_OAUTH_PKCE_REASON = "Clerk native OAuth: the callback's rotating_token_nonce is " +
  "redeemed by this client's own FAPI request (bearer client JWT, this client's sign-in); the " +
  "URL is the provider's, with Clerk's redirect";
/** Why the hosted sign-in URL carries no PKCE (it is bound at creation). */
const CLERK_HOSTED_PKCE_REASON = "Clerk hosted auth: the S256 code challenge is bound at " +
  "POST /client/hosted_auth and the nonce is redeemed only with the verifier this page keeps";

/** `@clerk/electron`'s token cache shape. */
export interface ClerkTokenCache {
  /** The stored value for `key`, or `null`. */
  getToken(key: string): Promise<string | null>;
  /** Store `value` under `key`. */
  saveToken(key: string, value: string): Promise<void>;
  /** Forget `key`. */
  clearToken(key: string): Promise<void>;
}

/** `@clerk/electron`'s OAuth transport shape. */
export interface ClerkOAuthTransport {
  /** The redirect URL Clerk sends the provider back to (the app origin plus `/`). */
  getRedirectUrl(): Promise<string>;
  /** Open `url` in the system browser; resolves with the callback deep link. */
  open(url: string): Promise<{ callbackUrl: string }>;
}

/** `@clerk/electron`'s passkey bridge shape (`__clerk_internal_electron_passkeys`). */
export interface ClerkPasskeyBridge {
  /** A registration ceremony; resolves the envelope. */
  create(options: unknown): Promise<PasskeyEnvelope>;
  /** An authentication ceremony; resolves the envelope. */
  get(options: unknown): Promise<PasskeyEnvelope>;
  /** What the native path offers: `{ available, platformAuthenticator, securityKeys }`. */
  capabilities(): Promise<
    { available: boolean; platformAuthenticator: boolean; securityKeys: boolean }
  >;
  /** `0`: not Electron (`@clerk/electron/passkeys` reads it only for an https page origin). */
  readonly electronMajor: number;
  /** `process.platform` spelling (`darwin` / `win32` / `linux`); `none` after `invalid_rp`. */
  readonly platform: string;
}

/**
 * The slice of a clerk-js `Clerk` instance {@linkcode startClerkBrowserSignIn} uses (what
 * `@clerk/expo`'s `useHostedAuth` uses).
 */
export interface ClerkLike {
  /** The Frontend API client. */
  getFapiClient(): {
    request(init: { method: string; path: string; body?: Record<string, unknown> }): Promise<{
      ok: boolean;
      status: number;
      statusText?: string;
      payload?: unknown;
    }>;
  };
  /** The current client resource. */
  readonly client?: { fromJSON?(json: unknown): unknown } | null;
  /** Activate a session. */
  setActive(params: { session: string }): Promise<unknown>;
}

/** Options for {@linkcode installClerkDesktopBridge}. */
export interface ClerkDesktopBridgeOptions {
  /** Also expose the native passkey bridge (as `exposeClerkBridge({ passkeys: true })`). */
  readonly passkeys?: boolean;
  /**
   * The OAuth redirect URL: default the page origin plus `/` (`desktop.app.origin`, e.g.
   * `t3code://app/`). Its scheme must be in `desktop.app.deepLinks`, and the URL in the Clerk
   * instance's allowed redirect URLs.
   */
  readonly redirectUrl?: string;
  /** The keychain key prefix for the token cache (default `"clerk."`). */
  readonly keyPrefix?: string;
  /**
   * After native passkeys answer `invalid_rp`: `"browser"` (default) continues a sign-in in the
   * system browser through Clerk's hosted pages; `"none"` only reports the error.
   */
  readonly passkeyFallback?: "browser" | "none";
  /** The Clerk instance for the browser fallback (default `globalThis.Clerk`). */
  readonly getClerk?: () => ClerkLike | undefined;
}

/** What {@linkcode installClerkDesktopBridge} installed. */
export interface ClerkDesktopBridge {
  /** `window.__clerk_internal_electron`. */
  readonly bridge: { tokenCache: ClerkTokenCache; oauthTransport: ClerkOAuthTransport };
  /** `window.__clerk_internal_electron_passkeys`, when installed. */
  readonly passkeys?: ClerkPasskeyBridge;
}

/** The page origin plus `/` (a custom-scheme origin only), or `undefined`. */
function originRedirect(): string | undefined {
  const location = (globalThis as { location?: { protocol?: string; origin?: string } }).location;
  const protocol = location?.protocol ?? "";
  if (protocol === "" || protocol === "http:" || protocol === "https:" || protocol === "file:") {
    return undefined;
  }
  // A custom scheme's origin may serialize as "null"; rebuild it from the href's scheme + host.
  const href = (globalThis as { location?: { href?: string } }).location?.href ?? "";
  const url = new URL(href);
  return `${url.protocol}//${url.host}/`;
}

/** The scheme of `url` without `:`. */
function schemeOf(url: string): string {
  return new URL(url).protocol.slice(0, -1);
}

/** The token cache over the keychain (`secure-store`), in memory when that is not enabled. */
function tokenCache(prefix: string): ClerkTokenCache {
  const memory = new Map<string, string>();
  let warned = false;
  const fallback = (err: unknown): boolean => {
    if ((err as { code?: unknown })?.code !== "unavailable") return false;
    if (!warned) {
      warned = true;
      console.warn(
        "denext/desktop/clerk: the secure-store capability is not enabled (`denext desktop add " +
          "secure-store`); Clerk's session lasts only until the app quits.",
      );
    }
    return true;
  };
  const rpc = async <T>(method: string, args: unknown, memo: () => T): Promise<T> => {
    try {
      return await desktopRpc<T>("secureStore", method, args);
    } catch (err) {
      if (fallback(err)) return memo();
      throw err;
    }
  };
  return {
    getToken: async (key) => {
      const v = await rpc<unknown>("get", { key: prefix + key }, () => memory.get(key) ?? null);
      return typeof v === "string" ? v : null;
    },
    saveToken: async (key, value) => {
      await rpc("set", { key: prefix + key, value }, () => memory.set(key, value));
    },
    clearToken: async (key) => {
      await rpc("delete", { key: prefix + key }, () => memory.delete(key));
    },
  };
}

/**
 * How a Clerk OAuth session is bound, since Clerk's callback carries no `state` the transport
 * could set: in the OS's auth session where the runtime has one (macOS; the callback goes to the
 * sheet, never through a deep link), else by Clerk's own client-bound `rotating_token_nonce`,
 * claimed with the preload key (only a bridge installed from `desktop.preload` holds it).
 */
async function clerkBinding(preloadKey: string | undefined): Promise<SchemeSessionInternals> {
  if (await hasOsAuthSession()) return { osSessionOnly: true };
  return preloadKey ? { binding: "clerk-client-nonce", bindingKey: preloadKey } : {};
}

/** The OAuth transport (`@clerk/electron`'s main-process semantics, see the module docs). */
function oauthTransport(
  redirectUrl: () => string,
  preloadKey: string | undefined,
): ClerkOAuthTransport {
  let pending = false;
  return {
    getRedirectUrl: () => Promise.resolve().then(redirectUrl),
    open: async (url) => {
      if (pending) throw new Error("Clerk: an OAuth flow is already pending.");
      if (new URL(url).protocol !== "https:") {
        throw new TypeError(`Clerk: refusing to open unsupported OAuth URL protocol: ${url}`);
      }
      const redirect = redirectUrl();
      pending = true;
      try {
        const { url: callbackUrl } = await startDesktopSchemeAuthSession(url, {
          callbackScheme: schemeOf(redirect),
          callbackPrefix: redirect,
          pkce: "not-applicable",
          reason: CLERK_OAUTH_PKCE_REASON,
          timeoutMs: OAUTH_TIMEOUT_MS,
        }, await clerkBinding(preloadKey));
        return { callbackUrl };
      } finally {
        pending = false;
      }
    },
  };
}

/** The `process.platform` spelling of the runtime's OS (`__denext.os`). */
function processPlatform(): string {
  const os = (globalThis as { __denext?: { os?: unknown } }).__denext?.os;
  return os === "windows" ? "win32" : typeof os === "string" ? os : "";
}

/** The native passkey bridge over the `passkeys` capability. */
function passkeyBridge(
  options: ClerkDesktopBridgeOptions,
  redirectUrl: () => string,
): ClerkPasskeyBridge {
  let rpRejected = false;
  const platform = processPlatform();
  const ceremony = (kind: "create" | "get") => async (opts: unknown): Promise<PasskeyEnvelope> => {
    let result: unknown;
    try {
      result = await desktopRpc("passkeys", kind, { optionsJson: JSON.stringify(opts) }, {
        timeoutMs: false,
      });
    } catch (err) {
      return isDesktopBridgeError(err) && err.code === "unavailable"
        ? passkeyFailure("not_supported", "the passkeys capability is not enabled")
        : passkeyFailure("unknown", err instanceof Error ? err.message : String(err));
    }
    if (!isPasskeyEnvelope(result)) {
      return passkeyFailure("unknown", "the native module returned an unexpected result");
    }
    if (result.ok || result.error.code !== "invalid_rp") return result;
    // This build cannot use native passkeys for the RP: stop offering them for this launch.
    rpRejected = true;
    const clerk = (options.getClerk ?? defaultClerk)();
    if (kind !== "get" || options.passkeyFallback === "none" || !clerk) return result;
    startClerkBrowserSignIn(clerk, { redirectUrl: redirectUrl() }).catch((err) =>
      console.error("denext/desktop/clerk: the browser sign-in failed", err)
    );
    return passkeyFailure("cancelled", "continuing the sign-in in the browser");
  };
  return {
    create: ceremony("create"),
    get: ceremony("get"),
    capabilities: async () => {
      if (rpRejected) {
        return { available: false, platformAuthenticator: false, securityKeys: false };
      }
      try {
        const c = await desktopRpc<Record<string, unknown>>("passkeys", "capabilities", {});
        return {
          available: c?.available === true,
          platformAuthenticator: c?.platformAuthenticator === true,
          securityKeys: c?.securityKeys === true,
        };
      } catch {
        return { available: false, platformAuthenticator: false, securityKeys: false };
      }
    },
    electronMajor: 0,
    get platform() {
      return rpRejected ? "none" : platform;
    },
  };
}

/** `globalThis.Clerk` (the instance `@clerk/react` publishes there). */
function defaultClerk(): ClerkLike | undefined {
  const clerk = (globalThis as { Clerk?: unknown }).Clerk;
  return typeof clerk === "object" && clerk !== null ? clerk as ClerkLike : undefined;
}

/**
 * Fill `window.__clerk_internal_electron` (and, with `passkeys: true`,
 * `window.__clerk_internal_electron_passkeys`) for `@clerk/electron` on Deno Desktop. Call it from
 * the app's `desktop.preload`, so the globals exist before the page's Clerk code reads them.
 * Outside a Deno Desktop window it installs nothing.
 *
 * Needs `desktop.app.origin` (a custom-scheme page origin, e.g. `t3code://app`) whose scheme is in
 * `desktop.app.deepLinks`, the `secure-store` and `auth-session` capabilities (and `passkeys` for
 * native passkeys), and denext's pinned runtime.
 *
 * @param options Passkeys on/off, the redirect URL, the key prefix and the passkey fallback.
 * @returns What was installed, or `undefined` off desktop.
 * @example
 * ```ts
 * // desktop/preload.ts  (desktop.preload in denext.config.ts)
 * import { installClerkDesktopBridge } from "denext/desktop/clerk";
 * installClerkDesktopBridge({ passkeys: true });
 * ```
 */
export function installClerkDesktopBridge(
  options: ClerkDesktopBridgeOptions = {},
): ClerkDesktopBridge | undefined {
  if (!hasDesktopBridge()) return undefined;
  // The per-launch preload key exists only while desktop.preload runs (read it now, synchronously).
  const preloadKey = (globalThis as { __denextPreloadKey?: unknown }).__denextPreloadKey;
  const redirectUrl = () => {
    const url = options.redirectUrl ?? originRedirect();
    if (url === undefined) {
      throw new Error(
        "denext/desktop/clerk: Clerk's native OAuth needs a custom page origin " +
          "(desktop.app.origin, e.g. t3code://app) or a redirectUrl option",
      );
    }
    return url;
  };
  const bridge = {
    tokenCache: tokenCache(options.keyPrefix ?? "clerk."),
    oauthTransport: oauthTransport(
      redirectUrl,
      typeof preloadKey === "string" ? preloadKey : undefined,
    ),
  };
  const g = globalThis as {
    __clerk_internal_electron?: unknown;
    __clerk_internal_electron_passkeys?: unknown;
  };
  g.__clerk_internal_electron = bridge;
  if (options.passkeys !== true) return { bridge };
  const passkeys = passkeyBridge(options, redirectUrl);
  g.__clerk_internal_electron_passkeys = passkeys;
  return { bridge, passkeys };
}

/** Options for {@linkcode startClerkBrowserSignIn}. */
export interface ClerkBrowserSignInOptions {
  /** The redirect URL (the app origin plus `/`); on the Clerk instance's allowlist. */
  readonly redirectUrl: string;
  /** Clerk's hosted-auth mode (`"sign-in"` / `"sign-up"`), passed through. */
  readonly mode?: string;
  /** Give up after this many ms (default 10 minutes). */
  readonly timeoutMs?: number;
  /** Cancel the sign-in. */
  readonly signal?: AbortSignal;
}

/** base64url of `bytes`, unpadded. */
function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE pair: a hex verifier and its S256 challenge (`@clerk/expo`'s `createPKCE`). */
async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** The `response` of a FAPI payload when it is a `kind` object. */
function responseOf(payload: unknown, kind: string): Record<string, unknown> | undefined {
  const response = (payload as { response?: { object?: unknown } } | undefined)?.response;
  return response?.object === kind ? response as Record<string, unknown> : undefined;
}

/** A FAPI failure as an Error (the first error's long message). */
function fapiError(res: { status: number; statusText?: string; payload?: unknown }): Error {
  const errors = (res.payload as { errors?: Array<{ long_message?: string }> } | undefined)?.errors;
  return new Error(
    `Clerk: ${errors?.[0]?.long_message ?? res.statusText ?? "hosted auth failed"} (${res.status})`,
  );
}

/** Create the hosted-auth URL (one retry on a `signed_out` 401, as `@clerk/expo` does). */
async function createHostedAuth(clerk: ClerkLike, body: Record<string, unknown>): Promise<string> {
  const request = () =>
    clerk.getFapiClient().request({ method: "POST", path: "/client/hosted_auth", body });
  let res = await request();
  const signedOut = (res.payload as { errors?: Array<{ code?: string }> } | undefined)?.errors
    ?.some((e) => e.code === "signed_out");
  if (!res.ok && res.status === 401 && signedOut) res = await request();
  if (!res.ok) throw fapiError(res);
  const url = responseOf(res.payload, "hosted_auth")?.url;
  if (typeof url !== "string") throw new Error("Clerk: hosted auth returned no URL");
  return url;
}

/**
 * Sign in through Clerk's hosted pages in the system browser and activate the session here: the
 * protocol of `@clerk/expo`'s `useHostedAuth`, over `openAuthSession`'s custom-scheme flow. A
 * fresh `state` and PKCE pair are made per call; the hosted-auth record is created with the S256
 * challenge, the callback must come back to `redirectUrl` with the same `state`, and its
 * `rotating_token_nonce` is redeemed ONLY together with the verifier, which never leaves this
 * page — so a callback intercepted by another app is useless to it.
 *
 * This is the passkey fallback when native passkeys answer `invalid_rp` (the RP's own domain in
 * the browser has its passkeys), and works for any sign-in method Clerk's hosted pages offer.
 *
 * @param clerk The Clerk instance (`useClerk()`, or `globalThis.Clerk`).
 * @param options The redirect URL, mode, timeout and cancel signal.
 * @returns The activated session's id.
 */
export async function startClerkBrowserSignIn(
  clerk: ClerkLike,
  options: ClerkBrowserSignInOptions,
): Promise<{ createdSessionId: string }> {
  const state = crypto.randomUUID();
  const { verifier, challenge } = await pkcePair();
  const hostedUrl = await createHostedAuth(clerk, {
    redirectUrl: options.redirectUrl,
    codeChallenge: challenge,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    state,
  });
  const { url } = await startDesktopSchemeAuthSession(hostedUrl, {
    callbackScheme: schemeOf(options.redirectUrl),
    callbackPrefix: options.redirectUrl,
    pkce: "not-applicable",
    reason: CLERK_HOSTED_PKCE_REASON,
    state,
    timeoutMs: options.timeoutMs ?? BROWSER_SIGN_IN_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const params = new URL(url).searchParams;
  if (params.get("state") !== state) throw new Error("Clerk: hosted auth state did not match");
  const nonce = params.get("rotating_token_nonce");
  const sessionId = params.get("created_session_id");
  if (!nonce || !sessionId) throw new Error("Clerk: hosted auth callback is incomplete");
  const res = await clerk.getFapiClient().request({
    method: "POST",
    path: "/client",
    body: { _method: "GET", rotatingTokenNonce: nonce, codeVerifier: verifier },
  });
  if (!res.ok) throw fapiError(res);
  const clientJson = responseOf(res.payload, "client");
  if (!clientJson || typeof clerk.client?.fromJSON !== "function") {
    throw new Error("Clerk: hosted auth completion returned no client");
  }
  clerk.client.fromJSON(clientJson);
  const sessions = clientJson.sessions as Array<{ id?: unknown }> | undefined;
  if (!sessions?.some((s) => s.id === sessionId)) {
    throw new Error("Clerk: hosted auth completion did not include the created session");
  }
  await clerk.setActive({ session: sessionId });
  return { createdSessionId: sessionId };
}
