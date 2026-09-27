// The client half of `denextAuth({ native })`: a native app's session against a remote denext
// server, as an `auth` provider for `createApiClient({ base, auth })`.
//
//   import { createApiClient, nativeSession } from "denext";
//   import { openAuthSession, secureStore } from "denext/mobile";
//   const session = nativeSession({
//     base: "https://api.example.com",
//     redirectUri: "com.example.app://auth/callback",
//     storage: secureStore,
//   });
//   await session.signIn((url) =>
//     openAuthSession(url, { callbackScheme: "com.example.app" }).then((r) => r.url)
//   );
//   const api = createApiClient({ base: "https://api.example.com", auth: session });
//
// The refresh token lives in `storage` (the Keychain / Keystore through `secureStore`); the
// access token only in memory. Refreshes are single-flight, so a burst of 401s rotates the
// refresh token once — a second rotation with the same token would read as a replay and sign
// the user out on the server.

/** Where the refresh token is kept — `secureStore` from `denext/mobile` fits as is. */
export interface NativeSessionStorage {
  /** The value under `key`, or `null`. */
  get(key: string): Promise<string | null>;
  /** Store `value` under `key`. */
  set(key: string, value: string): Promise<void>;
  /** Remove `key`. */
  delete(key: string): Promise<void>;
}

/** Options for {@link nativeSession}. */
export interface NativeSessionOptions {
  /** The server's origin, e.g. `"https://api.example.com"`. */
  base: string;
  /** The server's `denextAuth` base path (default `"/auth"`). */
  basePath?: string;
  /** The callback URI registered in the server's `native.redirectUris`. */
  redirectUri: string;
  /** Where the refresh token persists (`secureStore`). */
  storage: NativeSessionStorage;
  /** The storage key (default `"denext.native.refreshToken"`). */
  storageKey?: string;
  /** The `fetch` to use (default: the global). */
  fetch?: typeof fetch;
}

/** The user a native sign-in answers with. */
export interface NativeSessionUser {
  /** The user id. */
  id: string;
  /** Display name. */
  name?: string;
  /** Email, when the provider granted a verified one. */
  email?: string;
  /** Roles. */
  roles?: string[];
}

/** What a native id_token sign-in sends. */
export interface NativeIdTokenSignIn {
  /** The `id_token` the native sheet returned. */
  idToken: string;
  /** The nonce from {@link NativeSession.nonce} that the sheet was given (raw, not hashed). */
  nonce?: string;
  /** Apple: the `authorizationCode`, so the server can revoke Apple's tokens on deletion. */
  authorizationCode?: string;
  /** Apple: the display name from the first-login payload (Apple sends it only once). */
  name?: string;
}

/** A failed native-session call. */
export class NativeSessionError extends Error {
  /** The HTTP status (0 for a network failure). */
  readonly status: number;
  /** The server's error code (`invalid_grant`, `reauth_required`, `mfa_required`, …). */
  readonly code: string;

  /**
   * Build the error for a failed native-session call.
   *
   * @param status The HTTP status (0 for a network failure).
   * @param code The server's error code.
   */
  constructor(status: number, code: string) {
    super(`denext native session: ${code} (${status})`);
    this.name = "NativeSessionError";
    this.status = status;
    this.code = code;
  }
}

/** A native session: an `auth` provider for `createApiClient`, plus sign-in and sign-out. */
export interface NativeSession {
  /**
   * Sign in through the server's browser flow: build the PKCE `/native/authorize` URL, hand it
   * to `open` (which resolves the callback URL — `openAuthSession`), check `state`, and redeem
   * the code.
   *
   * @param open Opens the URL in a system browser sheet and resolves the callback URL.
   * @param options `provider` — go straight to that OAuth provider instead of the sign-in page.
   */
  signIn(
    open: (url: string) => Promise<string>,
    options?: { provider?: string },
  ): Promise<NativeSessionUser>;
  /** Sign in with a native Apple / Google sheet's `id_token`. */
  signInWithIdToken(
    provider: "apple" | "google",
    input: NativeIdTokenSignIn,
  ): Promise<NativeSessionUser>;
  /** A single-use server nonce to give the native sign-in sheet. */
  nonce(): Promise<string>;
  /** The access token (refreshed first when missing or about to expire), or `null`. */
  getToken(): Promise<string | null>;
  /** Rotate the refresh token (single-flight); `null` when the session is gone. */
  refresh(): Promise<string | null>;
  /** Whether a refresh token is stored. */
  signedIn(): Promise<boolean>;
  /** Revoke the session on the server and forget it locally. */
  signOut(): Promise<void>;
  /**
   * Delete the account (`POST /account/delete`). Throws a {@link NativeSessionError} with
   * `code: "reauth_required"` when the sign-in is not recent — sign in again, then retry.
   */
  deleteAccount(): Promise<void>;
}

/** The token endpoint's answer. */
interface TokenAnswer {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  user: NativeSessionUser;
}

/** Refresh this long before the access token actually expires (ms). */
const EXPIRY_SKEW_MS = 30_000;

/** URL-safe base64 without padding. */
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** `bytes` random bytes, base64url. */
function random(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The S256 challenge for a verifier. */
async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/**
 * A native session against a remote denext server (`denextAuth({ native })`). Pass it as
 * `createApiClient({ base, auth: session })`.
 *
 * @param options The server, the registered redirect URI and the token storage.
 * @returns The session.
 */
export function nativeSession(options: NativeSessionOptions): NativeSession {
  const base = options.base.replace(/\/+$/, "");
  const prefix = `${base}${(options.basePath ?? "/auth").replace(/\/+$/, "")}`;
  const key = options.storageKey ?? "denext.native.refreshToken";
  const doFetch = options.fetch ?? fetch;
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string | null> | null = null;

  const post = async (path: string, body: Record<string, string>, bearer?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      res = await doFetch(`${prefix}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      throw new NativeSessionError(0, "network_error");
    }
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      throw new NativeSessionError(
        res.status,
        typeof json.error === "string" ? json.error : "http_error",
      );
    }
    return json;
  };

  const accept = async (answer: TokenAnswer): Promise<NativeSessionUser> => {
    access = { token: answer.access_token, expiresAt: Date.now() + answer.expires_in * 1000 };
    await options.storage.set(key, answer.refresh_token);
    return answer.user;
  };

  const forget = async () => {
    access = null;
    await options.storage.delete(key);
  };

  const rotate = async (): Promise<string | null> => {
    const stored = await options.storage.get(key);
    if (!stored) return null;
    try {
      const answer = await post("/native/token", {
        grant_type: "refresh_token",
        refresh_token: stored,
      }) as unknown as TokenAnswer;
      await accept(answer);
      return answer.access_token;
    } catch (error) {
      // A refused refresh token is dead (expired, revoked, replayed): forget it. A network
      // failure keeps it for the next attempt.
      if (error instanceof NativeSessionError && error.status >= 400 && error.status < 500) {
        await forget();
      }
      return null;
    }
  };

  const session: NativeSession = {
    async signIn(open, signInOptions = {}) {
      const verifier = random(32);
      const state = random(16);
      const url = new URL(`${prefix}/native/authorize`);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("code_challenge", await challengeOf(verifier));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      if (signInOptions.provider) url.searchParams.set("provider", signInOptions.provider);
      const callback = new URL(await open(url.href));
      if (callback.searchParams.get("state") !== state) {
        throw new NativeSessionError(400, "state_mismatch");
      }
      const error = callback.searchParams.get("error");
      const code = callback.searchParams.get("code");
      if (error || !code) throw new NativeSessionError(400, error ?? "no_code");
      return await accept(
        await post("/native/token", {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: options.redirectUri,
        }) as unknown as TokenAnswer,
      );
    },
    async signInWithIdToken(provider, input) {
      const body: Record<string, string> = { id_token: input.idToken };
      if (input.nonce) body.nonce = input.nonce;
      if (input.authorizationCode) body.authorization_code = input.authorizationCode;
      if (input.name) body.name = input.name;
      return await accept(
        await post(`/native/${encodeURIComponent(provider)}`, body) as unknown as TokenAnswer,
      );
    },
    async nonce() {
      const answer = await post("/native/nonce", {});
      return String(answer.nonce);
    },
    async getToken() {
      if (access && access.expiresAt - EXPIRY_SKEW_MS > Date.now()) return access.token;
      return await session.refresh();
    },
    refresh() {
      refreshing ??= rotate().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    async signedIn() {
      return (await options.storage.get(key)) !== null;
    },
    async signOut() {
      const stored = await options.storage.get(key);
      const token = access?.token;
      await forget();
      if (!stored && !token) return;
      try {
        await post("/native/revoke", stored ? { refresh_token: stored } : {}, token);
      } catch {
        // Signed out locally either way; the server-side family expires on its own.
      }
    },
    async deleteAccount() {
      const token = await session.getToken();
      if (!token) throw new NativeSessionError(401, "unauthorized");
      await post("/account/delete", {}, token);
      await forget();
    },
  };
  return session;
}
