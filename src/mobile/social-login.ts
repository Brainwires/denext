/**
 * Native "Sign in with Apple" and Google sign-in sheets for `denext/mobile`, through the
 * `SocialLogin` plugin that `@capgo/capacitor-social-login` installs (`denext mobile add
 * social-login`). Each resolves the provider's `id_token` (plus Apple's `authorizationCode`, and
 * the name and email the sheet returns), shaped for `nativeSession(...).signInWithIdToken()`,
 * which verifies it on a denext server (`POST /auth/native/:provider`).
 * {@linkcode signInNative} does the whole round trip, server nonce included.
 *
 * No web fallback: in a browser, sign in through the server's browser flow
 * (`nativeSession(...).signIn(open, { provider })`, or a normal web sign-in).
 *
 * @module
 */

import { nativePlatform } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";

/** What a native sign-in sheet returns: pass it to `signInWithIdToken(provider, result)`. */
export interface SocialSignInResult {
  /** The provider's OpenID Connect `id_token` (a JWT your server verifies). */
  readonly idToken: string;
  /** The raw nonce the sheet was given (the server checks it, raw or as its SHA-256 hex). */
  readonly nonce?: string;
  /** Apple: the authorization code, for the server to revoke Apple's tokens on account deletion. */
  readonly authorizationCode?: string;
  /** The display name, when the sheet returned one (Apple: only on the first sign-in). */
  readonly name?: string;
  /** The email, when the sheet returned one (Apple: possibly a private relay address). */
  readonly email?: string;
  /** The provider's stable user id (Apple's `user`, Google's `sub`), when reported. */
  readonly user?: string;
}

/** Options for {@linkcode signInWithApple}. */
export interface AppleSignInOptions {
  /** A single-use nonce from your server (`session.nonce()`); sent to Apple as its SHA-256 hex. */
  readonly nonce?: string;
}

/** Options for {@linkcode signInWithGoogle}. */
export interface GoogleSignInOptions {
  /**
   * The OAuth client id of type "Web application" in your Google Cloud project: Android signs in
   * with it, and it becomes the `id_token`'s audience on iOS too (so the server lists one id).
   */
  readonly webClientId: string;
  /** iOS: the OAuth client id of type "iOS" (its reversed form is the app's URL scheme). */
  readonly iosClientId?: string;
  /** A single-use nonce from your server (`session.nonce()`), put into the `id_token` as is. */
  readonly nonce?: string;
  /** Extra OAuth scopes (default `email`, `profile`, `openid`). */
  readonly scopes?: readonly string[];
  /** Android: offer only accounts that signed in to this app before (default `false`). */
  readonly filterByAuthorizedAccounts?: boolean;
  /** Android: sign in without a tap when exactly one account qualifies (default `false`). */
  readonly autoSelect?: boolean;
}

/** Why a native sign-in failed, as {@linkcode SocialSignInError}'s `code` reports it. */
export type SocialSignInErrorCode =
  /** The user closed the sheet. */
  | "cancelled"
  /** The provider returned no `id_token` (a misconfigured client id, Google's offline mode). */
  | "no_id_token"
  /** Not available here: the web, Apple on Android, or a shell without the plugin. */
  | "unsupported"
  /** Anything else the plugin reported (its message is kept). */
  | "failed";

/** A failed native sign-in. */
export interface SocialSignInError extends Error {
  /** Why it failed. */
  readonly code: SocialSignInErrorCode;
}

/** The JS side of `@capgo/capacitor-social-login` (its native methods). */
interface SocialLoginPlugin {
  initialize(options: Record<string, unknown>): Promise<void>;
  login(options: { provider: string; options: Record<string, unknown> }): Promise<{
    provider?: string;
    result?: Record<string, unknown>;
  }>;
}

/** The session half {@linkcode signInNative} drives: `nativeSession(...)` from `denext`. */
export interface IdTokenSession<User> {
  /** A single-use server nonce (`POST /auth/native/nonce`). */
  nonce(): Promise<string>;
  /** Verify the provider's `id_token` on the server and start the session. */
  signInWithIdToken(provider: "apple" | "google", input: SocialSignInResult): Promise<User>;
}

/** The provider config each `initialize` was last called with (the plugin keeps one per provider). */
const initialized = new Map<string, string>();

/** Build a {@linkcode SocialSignInError}. */
function signInError(code: SocialSignInErrorCode, message: string): SocialSignInError {
  const err = new Error(message) as Error & { code: SocialSignInErrorCode };
  err.name = "SocialSignInError";
  err.code = code;
  return err;
}

/** The plugin, or the `unsupported` error. */
function socialPlugin(fn: string): SocialLoginPlugin {
  const plugin = nativePlugin<SocialLoginPlugin>("SocialLogin", ["initialize", "login"]);
  if (plugin) return plugin;
  throw signInError(
    "unsupported",
    `${fn}: needs the iOS/Android shell with @capgo/capacitor-social-login (\`denext mobile add ` +
      "social-login`). On the web, sign in through the server's browser flow instead.",
  );
}

/** Initialize `provider` with `config` unless it already is. */
async function ensureInitialized(
  plugin: SocialLoginPlugin,
  provider: string,
  config: Record<string, unknown>,
): Promise<void> {
  const key = JSON.stringify(config);
  if (initialized.get(provider) === key) return;
  await plugin.initialize({ [provider]: config });
  initialized.set(provider, key);
}

/**
 * Whether a plugin rejection is the user closing the sheet: Apple's
 * `ASAuthorizationError.canceled` (1001), Google Sign-In's "canceled" on iOS, Credential
 * Manager's `GetCredentialCancellationException` on Android.
 */
function isCancel(err: unknown): boolean {
  const text = `${(err as { code?: unknown })?.code ?? ""} ${(err as Error)?.message ?? err}`;
  return /cancel|\b1001\b/i.test(text);
}

/** Run the plugin's `login`, mapping a rejection. */
async function login(
  fn: string,
  plugin: SocialLoginPlugin,
  provider: string,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return (await plugin.login({ provider, options })).result ?? {};
  } catch (err) {
    const message = `${fn}: ${(err as Error)?.message ?? String(err)}`;
    throw signInError(isCancel(err) ? "cancelled" : "failed", message);
  }
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** "Given Family" from the parts that are there. */
function fullName(given: unknown, family: unknown): string | undefined {
  return text([text(given), text(family)].filter(Boolean).join(" "));
}

/** Lowercase hex SHA-256 of `value`. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The result, without undefined fields. */
function compact(result: SocialSignInResult): SocialSignInResult {
  return Object.fromEntries(
    Object.entries(result).filter(([, v]) => v !== undefined),
  ) as unknown as SocialSignInResult;
}

/**
 * Show the native "Sign in with Apple" sheet (iOS 13+) and resolve its `id_token`, the
 * `authorizationCode`, and the name and email Apple sends. **Apple sends the name only on the
 * user's first sign-in**, so pass it to the server then (`signInWithIdToken` does).
 *
 * iOS only: on Android and the web it rejects with `unsupported` (sign in with Apple through the
 * server's browser flow there). The app needs the Sign in with Apple capability (`denext mobile
 * add social-login` writes the entitlement). Rejects with a {@linkcode SocialSignInError}.
 *
 * @param options The server nonce.
 * @returns The token and profile, ready for `signInWithIdToken("apple", result)`.
 * @example
 * ```ts
 * import { nativeSession } from "denext";
 * import { secureStore, signInWithApple } from "denext/mobile";
 *
 * const session = nativeSession({ base, redirectUri, storage: secureStore });
 * const nonce = await session.nonce();
 * const user = await session.signInWithIdToken("apple", await signInWithApple({ nonce }));
 * ```
 */
export async function signInWithApple(
  options: AppleSignInOptions = {},
): Promise<SocialSignInResult> {
  const fn = "signInWithApple";
  if (nativePlatform() !== "ios") {
    throw signInError(
      "unsupported",
      `${fn}: the native Apple sheet is iOS only; use the server's browser flow ` +
        '(`session.signIn(open, { provider: "apple" })`) on Android and the web.',
    );
  }
  const plugin = socialPlugin(fn);
  await ensureInitialized(plugin, "apple", { useProperTokenExchange: true });
  const nonce = text(options.nonce);
  const result = await login(fn, plugin, "apple", nonce ? { nonce: await sha256Hex(nonce) } : {});
  const idToken = text(result.idToken);
  if (!idToken) throw signInError("no_id_token", `${fn}: Apple returned no identity token`);
  const profile = (result.profile ?? {}) as Record<string, unknown>;
  const access = result.accessToken as { token?: unknown } | null | undefined;
  return compact({
    idToken,
    nonce,
    authorizationCode: text(result.authorizationCode) ?? text(access?.token),
    name: fullName(profile.givenName, profile.familyName),
    email: text(profile.email),
    user: text(profile.user),
  });
}

/**
 * Show Google's native account sheet (Credential Manager on Android, Google Sign-In on iOS) and
 * resolve its `id_token` plus the profile's name and email.
 *
 * Configure a "Web application" OAuth client (`webClientId`, the token's audience on both
 * platforms) and, for iOS, an "iOS" client (`iosClientId`) whose reversed id is registered as a
 * URL scheme (`denext mobile add social-login --scheme com.googleusercontent.apps.<id>`). List
 * both ids in the server's Google provider. Rejects with a {@linkcode SocialSignInError}.
 *
 * @param options The client ids, the server nonce and the Android sheet's behaviour.
 * @returns The token and profile, ready for `signInWithIdToken("google", result)`.
 * @example
 * ```ts
 * import { signInWithGoogle } from "denext/mobile";
 *
 * const result = await signInWithGoogle({
 *   webClientId: "1234-web.apps.googleusercontent.com",
 *   iosClientId: "1234-ios.apps.googleusercontent.com",
 *   nonce: await session.nonce(),
 * });
 * await session.signInWithIdToken("google", result);
 * ```
 */
export async function signInWithGoogle(options: GoogleSignInOptions): Promise<SocialSignInResult> {
  const fn = "signInWithGoogle";
  if (typeof options?.webClientId !== "string" || options.webClientId === "") {
    throw new TypeError(`${fn}: webClientId (your "Web application" OAuth client id) is required`);
  }
  const plugin = socialPlugin(fn);
  const ios = nativePlatform() === "ios";
  if (ios && !text(options.iosClientId)) {
    throw new TypeError(`${fn}: iosClientId (your "iOS" OAuth client id) is required on iOS`);
  }
  await ensureInitialized(
    plugin,
    "google",
    ios
      ? { iOSClientId: options.iosClientId, iOSServerClientId: options.webClientId, mode: "online" }
      : { webClientId: options.webClientId, mode: "online" },
  );
  const nonce = text(options.nonce);
  const result = await login(fn, plugin, "google", {
    ...(options.scopes ? { scopes: [...options.scopes] } : {}),
    ...(nonce ? { nonce } : {}),
    ...(options.filterByAuthorizedAccounts === undefined
      ? {}
      : { filterByAuthorizedAccounts: options.filterByAuthorizedAccounts }),
    ...(options.autoSelect === undefined ? {} : { autoSelectEnabled: options.autoSelect }),
  });
  const idToken = text(result.idToken);
  if (!idToken) throw signInError("no_id_token", `${fn}: Google returned no id_token`);
  const profile = (result.profile ?? {}) as Record<string, unknown>;
  return compact({
    idToken,
    nonce,
    name: text(profile.name) ?? fullName(profile.givenName, profile.familyName),
    email: text(profile.email),
    user: text(profile.id),
  });
}

/**
 * The whole native sign-in against a denext server: fetch a single-use nonce from the server,
 * show the provider's sheet with it, and hand the `id_token` to
 * `session.signInWithIdToken(provider, result)` (`POST /auth/native/:provider`), which verifies
 * it and starts the session.
 *
 * @param session A `nativeSession(...)` from `denext`.
 * @param provider `"apple"` or `"google"`.
 * @param options Google's client ids (required for `"google"`).
 * @returns The signed-in user, as the session reports it.
 * @example
 * ```ts
 * import { nativeSession } from "denext";
 * import { secureStore, signInNative } from "denext/mobile";
 *
 * const session = nativeSession({ base: "https://api.example.com", redirectUri, storage: secureStore });
 * const user = await signInNative(session, "apple");
 * ```
 */
export async function signInNative<User>(
  session: IdTokenSession<User>,
  provider: "apple" | "google",
  options?: Omit<GoogleSignInOptions, "nonce">,
): Promise<User> {
  const nonce = await session.nonce();
  if (provider === "apple") {
    return await session.signInWithIdToken("apple", await signInWithApple({ nonce }));
  }
  if (!options) throw new TypeError('signInNative: "google" needs { webClientId, iosClientId }');
  return await session.signInWithIdToken("google", await signInWithGoogle({ ...options, nonce }));
}

/** Forget which providers were initialized (tests only). */
export function resetSocialLoginForTesting(): void {
  initialized.clear();
}
