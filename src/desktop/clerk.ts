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
 *     })`, plus a per-flow `?denext_nonce=…` on Windows and Linux (see below);
 *     `oauthTransport.open(url)` opens the provider in the system browser and resolves
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
 * resource. Where the callback travels as a deep link (Windows and Linux), any same-user program
 * can open `<scheme>://app/?rotating_token_nonce=…` while a sign-in is pending, so the transport
 * does not rely on Clerk binding that nonce to this client: `getRedirectUrl()` writes a fresh
 * per-session secret (`denext_nonce`, 256 bits) into the redirect URL Clerk returns to, and the
 * runtime completes the session only with a callback that carries it back (compared in constant
 * time; a callback without it, with another one or replayed later is swallowed). On macOS the OS
 * sheet catches its own callback, which never travels as a deep link. The custom scheme is still
 * used only when this app handles it (`scheme_owned_by_other_app` otherwise, on Windows and
 * Linux), since a program that receives the real callback learns the nonce too. See the desktop
 * docs ("Clerk on Deno Desktop").
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

export type { PasskeyEnvelope } from "./passkey-envelope.ts";
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

/** Why Clerk's native OAuth callback carries no PKCE (recorded with the session). */
const CLERK_OAUTH_PKCE_REASON = "Clerk native OAuth: the callback's rotating_token_nonce is " +
  "redeemed by this client's own FAPI request (bearer client JWT, this client's sign-in); the " +
  "URL is the provider's, with Clerk's redirect";
/** Why the hosted sign-in URL carries no PKCE (it is bound at creation). */
const CLERK_HOSTED_PKCE_REASON = "Clerk hosted auth: the S256 code challenge is bound at " +
  "POST /client/hosted_auth and the nonce is redeemed only with the verifier this page keeps";

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
  /**
   * Also run the clerk-js instance any other Clerk React SDK creates in native mode — the one
   * `@clerk/nextjs`'s or `@clerk/react`'s `ClerkProvider` loads from the Frontend API and keeps at
   * `globalThis.Clerk` — the way `@clerk/electron/react`'s provider runs its bundled one: Frontend
   * API requests carry the client JWT from the token cache as `Authorization` (no cookies,
   * `_is_native=1`), the JWT the API returns is saved, and `load()` gets `standardBrowser: false`
   * plus this bridge's OAuth transport. So the app's own `<ClerkProvider>` signs in on desktop
   * unchanged. `{ passkeys }` attaches a WebAuthn adapter (`passkeys` from
   * `@clerk/electron/passkeys`, over `window.__clerk_internal_electron_passkeys`, so with
   * `passkeys: true`). Leave it off with `@clerk/electron/react`'s provider, which does this itself.
   */
  readonly nativeClerk?: boolean | { readonly passkeys?: ClerkPasskeysAdapter };
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

/**
 * `scheme_owned_by_other_app` from a Clerk sign-in, with what to do about it. It reaches the page
 * only where the callback must travel as a deep link (Windows and Linux; macOS runs the sign-in in
 * the OS's sheet, which catches its own callback whoever handles the scheme). Clerk has no
 * fallback without the custom scheme: its native redirect allowlist takes an `https://` or a
 * custom-scheme URL, not a loopback one, so the user has to make this app the scheme's handler.
 * Keeps `code` and `handler`; other errors pass through unchanged.
 */
function explainSchemeOwner(err: unknown, scheme: string): unknown {
  const e = err as { code?: unknown; handler?: unknown; message?: unknown } | null;
  if (e?.code !== "scheme_owned_by_other_app" || !(err instanceof Error)) return err;
  const other = typeof e.handler === "string" ? ` (${e.handler})` : "";
  err.message = `Clerk: another app${other} handles ${scheme}: links, so the sign-in would ` +
    `return to it. Clerk's native sign-in needs this app to handle ${scheme}: (its redirect ` +
    `allowlist takes no loopback URL): make this app the handler with ` +
    `claimDeepLinkScheme("${scheme}") from denext/desktop/client, called from the user's click, ` +
    `then sign in again.`;
  return err;
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

/** The query parameter the per-session callback nonce rides in (the runtime checks it). */
const CALLBACK_NONCE_PARAM = "denext_nonce";

/** A fresh callback nonce: 32 random bytes, base64url (43 characters, 256 bits). */
function callbackNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * How a Clerk OAuth session is bound, since Clerk's callback carries no `state` the transport
 * could set: in the OS's auth session where the runtime has one (macOS; the callback goes to the
 * sheet, never through a deep link), else by a per-session callback nonce in the redirect URL,
 * claimed with the preload key (only a bridge installed from `desktop.preload` holds it).
 */
async function clerkBinding(preloadKey: string | undefined): Promise<SchemeSessionInternals> {
  if (await hasOsAuthSession()) return { osSessionOnly: true };
  return preloadKey
    ? { binding: "clerk-client-nonce", bindingKey: preloadKey, nonce: callbackNonce() }
    : {};
}

/** `base` with the session's callback nonce (when it has one) as `denext_nonce`. */
function withNonce(base: string, binding: SchemeSessionInternals): string {
  if (binding.nonce === undefined) return base;
  const url = new URL(base);
  url.searchParams.set(CALLBACK_NONCE_PARAM, binding.nonce);
  return url.href;
}

/** A flow's redirect URL and binding, made by `getRedirectUrl()` and used by the next `open()`. */
interface PreparedFlow {
  readonly redirect: string;
  readonly binding: SchemeSessionInternals;
}

/** The path of Clerk's OAuth callback on its Frontend API (every provider's redirect URI). */
const CLERK_OAUTH_CALLBACK_PATH = "/v1/oauth_callback";

/**
 * Whether `target` is a Clerk OAuth URL: on the Frontend API itself, or a provider's
 * authorization URL whose `redirect_uri` is the Frontend API's OAuth callback (over https; on
 * `fapiHost` or a Clerk-operated domain when the Clerk instance names its host). Anything else is
 * a page script using the transport to open an arbitrary site in the OS auth session.
 */
function isClerkOAuthUrl(target: URL, fapiHost: string | undefined): boolean {
  if (fapiHost !== undefined && target.host === fapiHost) return true;
  let redirect: URL;
  try {
    redirect = new URL(target.searchParams.get("redirect_uri") ?? "");
  } catch {
    return false;
  }
  return redirect.protocol === "https:" && redirect.pathname === CLERK_OAUTH_CALLBACK_PATH &&
    (fapiHost === undefined || redirect.host === fapiHost || isClerkOperatedHost(redirect.host));
}

/** Clerk's own domains (a development instance's shared OAuth credentials call back there). */
const CLERK_DOMAINS = ["clerk.accounts.dev", "accounts.dev", "clerk.dev", "clerk.com"];

/** Whether `host` is one of {@linkcode CLERK_DOMAINS} or under one. */
function isClerkOperatedHost(host: string): boolean {
  return CLERK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The Clerk instance's Frontend API host (`clerk.example.com`), when it is loaded. */
function frontendApiHost(getClerk: () => ClerkLike | undefined): string | undefined {
  const fapi = (getClerk() as { frontendApi?: unknown } | undefined)?.frontendApi;
  return typeof fapi === "string" && fapi !== "" ? fapi.replace(/^https?:\/\//, "") : undefined;
}

/** The OAuth transport (`@clerk/electron`'s main-process semantics, see the module docs). */
function oauthTransport(
  redirectUrl: () => string,
  preloadKey: string | undefined,
  getClerk: () => ClerkLike | undefined,
): ClerkOAuthTransport {
  let pending = false;
  /** The flow `getRedirectUrl()` prepared (clerk-js calls it right before `open()`). */
  let prepared: PreparedFlow | undefined;
  const prepare = async (): Promise<PreparedFlow> => {
    const base = redirectUrl();
    const binding = await clerkBinding(preloadKey);
    return { redirect: withNonce(base, binding), binding };
  };
  return {
    getRedirectUrl: async () => {
      const flow = await prepare();
      prepared = flow;
      return flow.redirect;
    },
    open: async (url) => {
      if (pending) throw new Error("Clerk: an OAuth flow is already pending.");
      const target = new URL(url);
      if (target.protocol !== "https:") {
        throw new TypeError(`Clerk: refusing to open unsupported OAuth URL protocol: ${url}`);
      }
      if (!isClerkOAuthUrl(target, frontendApiHost(getClerk))) {
        throw new TypeError(
          `Clerk: refusing to open ${target.origin}: not a Clerk OAuth URL (its redirect_uri ` +
            `must be the Frontend API's ${CLERK_OAUTH_CALLBACK_PATH})`,
        );
      }
      pending = true;
      // The redirect (and its nonce) Clerk was given for this flow; a fresh one when `open()` came
      // without `getRedirectUrl()` (a nonce Clerk never saw: the session then fails closed).
      const flow = prepared ?? await prepare().catch((err) => {
        pending = false;
        throw err;
      });
      prepared = undefined;
      const redirect = flow.redirect;
      try {
        const { url: callbackUrl } = await startDesktopSchemeAuthSession(url, {
          callbackScheme: schemeOf(redirect),
          callbackPrefix: redirect,
          pkce: "not-applicable",
          reason: CLERK_OAUTH_PKCE_REASON,
          timeoutMs: OAUTH_TIMEOUT_MS,
        }, flow.binding);
        return { callbackUrl };
      } catch (err) {
        throw explainSchemeOwner(err, schemeOf(redirect));
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
      options.getClerk ?? defaultClerk,
    ),
  };
  const g = globalThis as {
    __clerk_internal_electron?: unknown;
    __clerk_internal_electron_passkeys?: unknown;
  };
  g.__clerk_internal_electron = bridge;
  if (options.nativeClerk) {
    adoptNativeClerk(
      bridge,
      options.nativeClerk === true ? undefined : options.nativeClerk.passkeys,
    );
  }
  if (options.passkeys !== true) return { bridge };
  const passkeys = passkeyBridge(options, redirectUrl);
  g.__clerk_internal_electron_passkeys = passkeys;
  return { bridge, passkeys };
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
export function startClerkBrowserSignIn(
  clerk: ClerkLike,
  options: ClerkBrowserSignInOptions,
): Promise<{ createdSessionId: string }> {
  const scheme = schemeOf(options.redirectUrl);
  return clerkHostedSignIn(clerk, options, async (hostedUrl, state) => {
    const { url } = await startDesktopSchemeAuthSession(hostedUrl, {
      callbackScheme: scheme,
      callbackPrefix: options.redirectUrl,
      pkce: "not-applicable",
      reason: CLERK_HOSTED_PKCE_REASON,
      state,
      timeoutMs: options.timeoutMs ?? BROWSER_SIGN_IN_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    }).catch((err) => {
      throw explainSchemeOwner(err, scheme);
    });
    return url;
  });
}
