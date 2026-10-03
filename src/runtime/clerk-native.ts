/**
 * Clerk in a native shell — what `denext/desktop/clerk` (Deno Desktop) and `denext/mobile/clerk`
 * (the Capacitor shell) share: the shapes `@clerk/electron` uses, switching the clerk-js instance
 * a Clerk React SDK loads into native mode, and Clerk's hosted (browser) sign-in with `state` and
 * S256 PKCE bound to the page.
 *
 * Client-only (web APIs). Nothing runs at import. Internal: the public names are re-exported from
 * those two modules.
 *
 * @module
 */

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

/**
 * The slice of a clerk-js `Clerk` instance the hosted sign-in uses (what `@clerk/expo`'s
 * `useHostedAuth` uses).
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

/**
 * A WebAuthn adapter clerk-js accepts (`passkeys` from `@clerk/electron/passkeys`): the shape
 * `@clerk/electron/react` attaches to its instance.
 */
export interface ClerkPasskeysAdapter {
  /** Run a registration ceremony. */
  create(publicKey: unknown): Promise<unknown>;
  /** Run an authentication ceremony. */
  get(options: unknown): Promise<unknown>;
  /** Whether passkeys are available. */
  isSupported(): boolean;
  /** Whether conditional (autofill) UI is available. */
  isAutoFillSupported(): Promise<boolean>;
  /** Whether a platform authenticator is available. */
  isPlatformAuthenticatorSupported(): Promise<boolean>;
}

/** `@clerk/electron`'s token-cache key for the client JWT. */
const CLERK_CLIENT_JWT_KEY = "__clerk_client_jwt";
/** The clerk-js instances already switched to native mode. */
const nativeInstances = new WeakSet<object>();

/** The slice of a clerk-js instance native mode hooks into. */
interface ClerkInstanceHooks {
  __internal_onBeforeRequest(hook: (request: ClerkFapiRequest) => unknown): void;
  __internal_onAfterResponse(
    hook: (request: unknown, response: { headers?: Headers } | undefined) => unknown,
  ): void;
  load(options?: Record<string, unknown>): Promise<unknown>;
  [key: string]: unknown;
}

/** A Frontend API request as clerk-js hands it to a before-request hook. */
interface ClerkFapiRequest {
  url?: URL;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
}

/** Whether `value` is a clerk-js instance with the hooks native mode needs. */
function isClerkInstance(value: unknown): value is ClerkInstanceHooks {
  const c = value as Partial<ClerkInstanceHooks> | null;
  return typeof c === "object" && c !== null &&
    typeof c.__internal_onBeforeRequest === "function" &&
    typeof c.__internal_onAfterResponse === "function" && typeof c.load === "function";
}

/**
 * Switch one clerk-js instance to native mode (what `@clerk/electron/react` does to its own
 * instance). Idempotent.
 */
function makeClerkNative(
  clerk: ClerkInstanceHooks,
  bridge: { tokenCache: ClerkTokenCache; oauthTransport: ClerkOAuthTransport },
  passkeys: ClerkPasskeysAdapter | undefined,
): void {
  if (nativeInstances.has(clerk)) return;
  nativeInstances.add(clerk);
  clerk.__internal_onBeforeRequest(async (request) => {
    request.credentials = "omit";
    request.url?.searchParams.set("_is_native", "1");
    const token = await bridge.tokenCache.getToken(CLERK_CLIENT_JWT_KEY);
    if (token) {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${token}`);
      request.headers = headers;
    }
  });
  clerk.__internal_onAfterResponse(async (_request, response) => {
    const authorization = response?.headers?.get("Authorization");
    if (!authorization) return;
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;
    await bridge.tokenCache.saveToken(CLERK_CLIENT_JWT_KEY, token);
  });
  if (passkeys) {
    clerk.__internal_createPublicCredentials = passkeys.create;
    clerk.__internal_getPublicCredentials = passkeys.get;
    clerk.__internal_isWebAuthnSupported = passkeys.isSupported;
    clerk.__internal_isWebAuthnAutofillSupported = passkeys.isAutoFillSupported;
    clerk.__internal_isWebAuthnPlatformAuthenticatorSupported =
      passkeys.isPlatformAuthenticatorSupported;
  }
  const load = clerk.load.bind(clerk);
  const pageProtocol = (globalThis as { location?: { protocol?: string } }).location?.protocol;
  clerk.load = (options: Record<string, unknown> = {}) => {
    const allowed = Array.isArray(options.allowedRedirectProtocols)
      ? options.allowedRedirectProtocols as string[]
      : [];
    return load({
      ...options,
      standardBrowser: false,
      __internal_oauthTransport: {
        getRedirectUrl: () => bridge.oauthTransport.getRedirectUrl(),
        open: (url: URL | string) => bridge.oauthTransport.open(String(url)),
      },
      allowedRedirectProtocols: [
        ...new Set([...allowed, ...(pageProtocol ? [pageProtocol] : [])]),
      ],
    });
  };
}

/**
 * Switch whatever clerk-js instance lands on `globalThis.Clerk` to native mode — the one already
 * there and every later one (the Clerk React SDKs assign it after loading clerk-js from the
 * Frontend API, before calling `load()`).
 *
 * @param bridge The token cache and OAuth transport the instance uses.
 * @param passkeys A WebAuthn adapter to attach, if any.
 */
export function adoptNativeClerk(
  bridge: { tokenCache: ClerkTokenCache; oauthTransport: ClerkOAuthTransport },
  passkeys: ClerkPasskeysAdapter | undefined,
): void {
  const g = globalThis as { Clerk?: unknown };
  // `@clerk/nextjs` sets `window.__internal_onBeforeSetActive` to run its `invalidateCacheAction`
  // server action before a session change, and `setActive` waits for it. A native shell serves a
  // static export: the action has no server there, its promise never settles, and sign-in hangs.
  // In native mode there are no cookies for that action to invalidate, so the hook resolves at once.
  Object.defineProperty(globalThis, "__internal_onBeforeSetActive", {
    configurable: true,
    enumerable: false,
    get: () => () => Promise.resolve(),
    set: () => {},
  });
  let current = g.Clerk;
  if (isClerkInstance(current)) makeClerkNative(current, bridge, passkeys);
  Object.defineProperty(globalThis, "Clerk", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (value: unknown) => {
      current = value;
      if (isClerkInstance(value)) makeClerkNative(value, bridge, passkeys);
    },
  });
}

/** Options for the hosted (browser) sign-in. */
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
 * Opens Clerk's hosted page and resolves the callback URL: the shell's auth session, which must
 * hold the callback to `redirectUrl` with this `state` (Deno Desktop) or catch it in the OS sheet
 * (iOS), and returns only a callback for this session.
 */
export type OpenHostedAuth = (hostedUrl: string, state: string) => Promise<string>;

/**
 * Sign in through Clerk's hosted pages and activate the session here: the protocol of
 * `@clerk/expo`'s `useHostedAuth`. A fresh `state` and PKCE pair are made per call; the hosted-auth
 * record is created with the S256 challenge, the callback must come back to `redirectUrl` with the
 * same `state`, and its `rotating_token_nonce` is redeemed ONLY together with the verifier, which
 * never leaves this page — so a callback intercepted by another app is useless to it.
 *
 * @param clerk The Clerk instance.
 * @param options The redirect URL and mode.
 * @param open Opens the hosted URL in the shell's auth session; resolves the callback URL.
 * @returns The activated session's id.
 */
export async function clerkHostedSignIn(
  clerk: ClerkLike,
  options: ClerkBrowserSignInOptions,
  open: OpenHostedAuth,
): Promise<{ createdSessionId: string }> {
  const state = crypto.randomUUID();
  const { verifier, challenge } = await pkcePair();
  const hostedUrl = await createHostedAuth(clerk, {
    redirectUrl: options.redirectUrl,
    codeChallenge: challenge,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    state,
  });
  const url = await open(hostedUrl, state);
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

/** `globalThis.Clerk` (the instance `@clerk/react` publishes there), or `undefined`. */
export function defaultClerk(): ClerkLike | undefined {
  const clerk = (globalThis as { Clerk?: unknown }).Clerk;
  return typeof clerk === "object" && clerk !== null ? clerk as ClerkLike : undefined;
}
