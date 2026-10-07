/**
 * The native-app endpoints (`denextAuth({ native })`) and account deletion:
 *
 * - `GET {basePath}/native/authorize?redirect_uri&code_challenge&code_challenge_method=S256&state[&provider]`
 *   — opened by the app in a system browser sheet (`openAuthSession`). Checks the redirect URI
 *   against `native.redirectUris`, stores the PKCE challenge + `state` in a signed `__Host-`
 *   cookie, and sends the browser to sign in (`/signin/<provider>`, or `pages.signIn`) with
 *   `callbackUrl` pointing at `/native/complete`.
 * - `GET {basePath}/native/complete` — where that sign-in lands. Mints a one-time code for the
 *   cookie session, ONLY if the user authenticated after `/native/authorize` began (so a
 *   lingering browser session can't be handed to whatever app started the flow), and
 *   redirects to the app's URI with `?code=…&state=…` (or `?error=…&state=…`).
 * - `POST {basePath}/native/token` — `grant_type=authorization_code` (`code`, `code_verifier`,
 *   `redirect_uri`) or `grant_type=refresh_token` (`refresh_token`) → `{ access_token,
 *   token_type, expires_in, refresh_token, refresh_expires_in, user }`. Any failure is a
 *   uniform `400 { error: "invalid_grant" }`.
 * - `POST {basePath}/native/revoke` — sign out: `refresh_token` in the body, or the access
 *   token as `Authorization: Bearer`. Always `200` (RFC 7009).
 * - `POST {basePath}/native/nonce` → `{ nonce, expires_in }`: a single-use nonce for the next
 *   native id_token sign-in (pass it, or its SHA-256 hex, to the native sheet).
 * - `POST {basePath}/native/apple` | `/native/google` — `{ id_token, nonce, authorization_code?,
 *   name? }`: verify the provider's id_token, create or link the account, answer the tokens.
 * - `POST {basePath}/account/delete` — delete the signed-in user (cookie session, same-origin;
 *   or a native bearer). Requires a recent sign-in (`authTime` within `mfa.freshness`, five
 *   minutes at least), else `403 { error: "reauth_required" }`.
 *
 * The native POSTs take no ambient credential (the secret rides the body or the
 * `Authorization` header), so they accept a request with no `Origin` (a native HTTP client);
 * a request that DOES carry one must come from this origin or an origin the app's `cors`
 * config allows, and `"null"` is refused. Their responses carry that CORS policy's headers,
 * and `OPTIONS` preflights on them are answered under it.
 *
 * @module
 */

import { readCappedBody, STALLED } from "../body.ts";
import { applyCors, corsOriginAllowed, isPreflight, preflightResponse } from "../cors.ts";
import { currentContext } from "../request-context.ts";
import { getSession, type SessionOptions } from "../session.ts";
import { emitAuthEvent } from "./events.ts";
import { mfaPendingFor, recentlyAuthenticated } from "./mfa.ts";
import {
  consumeNonce,
  createAuthCode,
  familyOfRefreshToken,
  issueNonce,
  matchRedirectUri,
  nativeBearerToken,
  redeemAuthCode,
  refreshNativeSession,
  type ResolvedNative,
  resolveNative,
  revokeNativeSessionsOf,
  snapshotFor,
  startNativeSession,
  verifyNativeAccessToken,
} from "./native.ts";
import {
  exchangeAppleCode,
  isNativeIdTokenProvider,
  type NativeIdTokenProvider,
  revokeAppleTokens,
  type VerifiedNativeIdToken,
  verifyNativeIdToken,
} from "./native-idtoken.ts";
import { cookieSessionOptions } from "./options.ts";
import { resolveSessionUser } from "./routes-oauth.ts";
import { oidcClaimProfile } from "./providers-presets.ts";
import {
  applySignInCallback,
  type AuthRoute,
  type AuthRouteContext,
  contained,
  findProvider,
  isSameOrigin,
  json,
  redirect,
} from "./routes-shared.ts";
import { clearAuthSession, readAuthSession } from "./session.ts";
import type { AdapterAccount } from "./adapter.ts";
import { isOAuthProvider } from "./types.ts";
import type { AuthSession, NativeIdTokenProviderConfig, SignInFailedReason } from "./types.ts";

/** The most a native POST body may carry (an id_token is a couple of KiB). */
const MAX_BODY_BYTES = 16 * 1024;
/** An OAuth `state`: 1–512 visible ASCII characters (it is echoed into a URL). */
const STATE_RE = /^[\x21-\x7E]{1,512}$/;
/** An S256 PKCE challenge: exactly 43 base64url characters. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** How long the authorize → complete round-trip may take (seconds). */
const NATIVE_TX_TTL = 600;

// ---- shared ---------------------------------------------------------------------

/** The app-level CORS policy for this request (the `cors` config), if any. */
function corsPolicy() {
  return currentContext()?.cors ?? null;
}

/**
 * The origin gate of a native POST: no `Origin` (a native HTTP client — nothing ambient to
 * forge) passes; a present one must be this app or a `cors`-allowed origin; `"null"` never.
 */
function nativeOriginAllowed(ctx: AuthRouteContext): boolean {
  const origin = ctx.request.headers.get("origin");
  if (origin === null) return true;
  if (origin === "" || origin === "null") return false;
  const policy = corsPolicy();
  if (policy && corsOriginAllowed(policy, origin)) return true;
  return isSameOrigin(ctx.request, ctx.config);
}

/** Wrap a handler so its answer carries the app's CORS headers, and failures are contained. */
function nativeRow(what: string, handler: AuthRoute["handler"]): AuthRoute["handler"] {
  const guarded = contained(what, handler);
  return async (ctx) => {
    const res = await guarded(ctx);
    return res ? applyCors(ctx.request, res, corsPolicy()) : res;
  };
}

/** `OPTIONS` on a native path: a preflight answered under the app's CORS policy. */
function handlePreflight(ctx: AuthRouteContext): Response | null {
  const policy = corsPolicy();
  if (!policy || !isPreflight(ctx.request)) return null;
  if (ctx.params.action !== undefined && !resolveNative(ctx.config)) return null;
  return preflightResponse(ctx.request, policy);
}

/** The body as text, through the size/stall cap; `null` when it is over-long, stalled or broken. */
async function bodyText(request: Request): Promise<string | null> {
  const bytes = await readCappedBody(request, MAX_BODY_BYTES).catch(() => STALLED);
  return bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : null;
}

/** The string entries of a JSON object; anything else (an array, a nested value) is dropped. */
function jsonStrings(text: string): Record<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** The body's string fields — JSON or a urlencoded form. Anything unusable is `{}`. */
async function readFields(ctx: AuthRouteContext): Promise<Record<string, string>> {
  const text = await bodyText(ctx.request);
  if (text === null) return {};
  const isJson = (ctx.request.headers.get("content-type") ?? "").includes("application/json");
  try {
    return isJson ? jsonStrings(text) : Object.fromEntries(new URLSearchParams(text));
  } catch {
    return {};
  }
}

/** The answer every failed grant shares. */
function invalidGrant(): Response {
  return json({ error: "invalid_grant" }, 400, { pragma: "no-cache" });
}

/** The cross-origin refusal. */
function forbidden(): Response {
  return json({ error: "forbidden" }, 403);
}

// ---- authorize → complete (the browser half) --------------------------------------

/** What the native transaction cookie carries between authorize and complete. */
interface NativeTx {
  /** The registered redirect URI. */
  r: string;
  /** The PKCE S256 challenge. */
  c: string;
  /** The app's `state`. */
  s: string;
  /** When the flow started, epoch seconds. */
  t: number;
}

/** The signed `__Host-` cookie the native transaction rides (the OAuth tx cookie's sibling). */
function nativeTxOptions(ctx: AuthRouteContext): SessionOptions {
  const tx = ctx.options.cookies.transaction;
  return cookieSessionOptions(ctx.config, { ...tx, name: `${tx.name}_native` }, NATIVE_TX_TTL);
}

/** `uri` with `params` added to its query (works for custom schemes too). */
function withParams(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

/** `GET {basePath}/native/authorize` — validate, remember the challenge, go sign in. */
async function handleAuthorize(ctx: AuthRouteContext): Promise<Response | null> {
  const native = resolveNative(ctx.config);
  if (!native) return null;
  const q = ctx.url.searchParams;
  // Never redirect anywhere unregistered — an unknown redirect_uri is a plain 400.
  const redirectUri = matchRedirectUri(native, q.get("redirect_uri"));
  if (!redirectUri) return json({ error: "invalid_request", reason: "redirect_uri" }, 400);
  const state = q.get("state") ?? "";
  if (!STATE_RE.test(state)) return json({ error: "invalid_request", reason: "state" }, 400);
  const back = (error: string) => redirect(withParams(redirectUri, { error, state }));
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !CHALLENGE_RE.test(challenge)) {
    return back("invalid_request");
  }
  const providerId = q.get("provider");
  const provider = providerId ? findProvider(ctx.config, providerId) : undefined;
  if (providerId && (!provider || !isOAuthProvider(provider))) return back("invalid_request");
  const tx: NativeTx = { r: redirectUri, c: challenge, s: state, t: Math.floor(Date.now() / 1000) };
  await (await getSession<NativeTx>(nativeTxOptions(ctx))).set(tx);
  const complete = `${ctx.options.prefix}native/complete`;
  const target = provider
    ? `${ctx.options.prefix}signin/${encodeURIComponent(provider.id)}`
    : (ctx.config.pages?.signIn || "/");
  const next = new URL(target, ctx.url);
  next.searchParams.set("callbackUrl", complete);
  return redirect(next.pathname + next.search);
}

/**
 * `GET {basePath}/native/complete` — the sign-in finished in the browser: hand the app a code.
 * The transaction cookie is single-use (cleared before anything is judged).
 */
async function handleComplete(ctx: AuthRouteContext): Promise<Response | null> {
  const native = resolveNative(ctx.config);
  if (!native) return null;
  const cookie = await getSession<NativeTx>(nativeTxOptions(ctx));
  const tx = cookie.data;
  cookie.clear();
  const redirectUri = tx ? matchRedirectUri(native, tx.r) : null;
  if (!tx || !redirectUri || !CHALLENGE_RE.test(tx.c) || !STATE_RE.test(tx.s)) {
    return json({ error: "invalid_request" }, 400);
  }
  const back = (params: Record<string, string>) =>
    redirect(withParams(redirectUri, { ...params, state: tx.s }));
  const session = await readAuthSession(ctx.config);
  // A session that predates this flow is not proof the user is here now: require a sign-in
  // (or a second-factor step-up, which re-stamps authTime) made after /native/authorize.
  if (!session || session.mfaPending || (session.authTime ?? 0) < tx.t) {
    return back({ error: "login_required" });
  }
  const code = await createAuthCode(native, {
    redirectUri,
    challenge: tx.c,
    snapshot: {
      user: session.user,
      provider: session.provider,
      amr: session.amr,
      authTime: session.authTime,
    },
  });
  return back({ code });
}

// ---- the token endpoint ---------------------------------------------------------

/** `POST {basePath}/native/token` — redeem a code, or rotate a refresh token. */
async function handleToken(ctx: AuthRouteContext): Promise<Response | null> {
  const native = resolveNative(ctx.config);
  if (!native) return null;
  if (!nativeOriginAllowed(ctx)) return forbidden();
  const fields = await readFields(ctx);
  if (fields.grant_type === "authorization_code") return await redeemCode(ctx, native, fields);
  if (fields.grant_type === "refresh_token") {
    const outcome = await refreshNativeSession(ctx.config, native, fields.refresh_token ?? "");
    return outcome.ok ? json(outcome.tokens, 200, { pragma: "no-cache" }) : invalidGrant();
  }
  return json({ error: "unsupported_grant_type" }, 400);
}

/** The `authorization_code` grant: consume the code, check PKCE, start a session family. */
async function redeemCode(
  ctx: AuthRouteContext,
  native: ResolvedNative,
  fields: Record<string, string>,
): Promise<Response> {
  const snapshot = await redeemAuthCode(native, {
    code: fields.code ?? "",
    verifier: fields.code_verifier ?? "",
    redirectUri: fields.redirect_uri ?? "",
  });
  if (!snapshot) return invalidGrant();
  // The user may have been deleted in the code's short life.
  if (!(await ctx.options.adapter?.getUser(snapshot.user.id))) return invalidGrant();
  const tokens = await startNativeSession(ctx.config, native, snapshot);
  return json(tokens, 200, { pragma: "no-cache" });
}

/** `POST {basePath}/native/revoke` — end the session family a token names. Always 200. */
async function handleRevoke(ctx: AuthRouteContext): Promise<Response | null> {
  const native = resolveNative(ctx.config);
  if (!native) return null;
  if (!nativeOriginAllowed(ctx)) return forbidden();
  const bearer = nativeBearerToken(ctx.request);
  const fromBearer = bearer ? await verifyNativeAccessToken(ctx.config, bearer) : null;
  const refresh = (await readFields(ctx)).refresh_token;
  const family = fromBearer?.nativeSessionId ??
    (refresh ? await familyOfRefreshToken(ctx.config, native, refresh) : null);
  if (family) {
    await native.adapter.revokeNativeSession(family);
    await emitAuthEvent(ctx.options, "signOut", { session: fromBearer });
    await emitAuthEvent(ctx.options, "sessionRevoked", { sessionId: family });
  }
  return json({ ok: true });
}

/** `POST {basePath}/native/nonce` — a single-use nonce for a native id_token sign-in. */
async function handleNonce(ctx: AuthRouteContext): Promise<Response | null> {
  const native = resolveNative(ctx.config);
  if (!native) return null;
  if (!nativeOriginAllowed(ctx)) return forbidden();
  return json({ nonce: await issueNonce(native), expires_in: 600 });
}

// ---- native id_token sign-in ------------------------------------------------------

/** A display name from the client's first-login payload: trimmed, control chars out, bounded. */
function cleanName(raw: string | undefined): string | undefined {
  const name = [...(raw ?? "")].filter((c) => c >= " " && c !== "\x7F").join("").trim()
    .slice(0, 200);
  return name || undefined;
}

/**
 * `POST {basePath}/native/:provider` — a native Apple / Google sign-in sheet's `id_token`.
 * The email comes ONLY from the verified token; the client's first-login payload contributes a
 * display name at most (Apple sends it once, outside the token).
 */
async function handleIdToken(ctx: AuthRouteContext): Promise<Response | null> {
  const native = resolveNative(ctx.config);
  const id = ctx.params.provider;
  if (!native || !isNativeIdTokenProvider(id)) return null;
  const settings = native.config[id];
  if (!settings) return null;
  if (!nativeOriginAllowed(ctx)) return forbidden();
  const fields = await readFields(ctx);
  const verified = await verifiedIdToken(ctx, native, id, settings, fields);
  if (verified instanceof Response) return verified;
  return await signInWithIdToken(ctx, native, id, settings, fields, verified);
}

/** A refused native id_token sign-in: the `signInFailed` event, then a uniform JSON error. */
async function refusedSignIn(
  ctx: AuthRouteContext,
  provider: string,
  reason: Extract<
    SignInFailedReason,
    "invalid_nonce" | "invalid_token" | "account_not_linked" | "access_denied"
  >,
  status = 401,
): Promise<Response> {
  await emitAuthEvent(ctx.options, "signInFailed", { provider, reason });
  return json({ error: reason }, status);
}

/** Spend the server nonce (when required) and verify the id_token; a refusal is a Response. */
async function verifiedIdToken(
  ctx: AuthRouteContext,
  native: ResolvedNative,
  id: NativeIdTokenProvider,
  settings: NativeIdTokenProviderConfig,
  fields: Record<string, string>,
): Promise<VerifiedNativeIdToken | Response> {
  const nonce = fields.nonce;
  if (native.requireNonce && !(nonce && await consumeNonce(native, nonce))) {
    return await refusedSignIn(ctx, id, "invalid_nonce", 400);
  }
  try {
    return await verifyNativeIdToken(ctx.config, id, settings, fields.id_token ?? "", nonce);
  } catch (error) {
    ctx.options.logger.debug("denextAuth: a native id_token was refused", {
      provider: id,
      reason: error instanceof Error ? error.message : String(error),
    });
    return await refusedSignIn(ctx, id, "invalid_token");
  }
}

/** Create or link the account for a verified id_token, then start the native session. */
async function signInWithIdToken(
  ctx: AuthRouteContext,
  native: ResolvedNative,
  id: NativeIdTokenProvider,
  settings: NativeIdTokenProviderConfig,
  fields: Record<string, string>,
  verified: VerifiedNativeIdToken,
): Promise<Response> {
  const profile = oidcClaimProfile({ tokens: {}, claims: verified.claims });
  if (!profile.id) return await refusedSignIn(ctx, id, "invalid_token");
  profile.name ??= cleanName(fields.name);
  const account: Omit<AdapterAccount, "userId"> = {
    provider: id,
    providerAccountId: profile.id,
    type: "oidc",
    ...(id === "apple" ? await appleTokens(ctx, fields, verified.audience, profile.id) : {}),
  };
  const linking = {
    id,
    allowDangerousEmailAccountLinking: settings.allowDangerousEmailAccountLinking,
  };
  const resolved = await resolveSessionUser(ctx, linking, profile, account);
  if (!resolved) return await refusedSignIn(ctx, id, "account_not_linked", 403);
  if (account.refreshToken) {
    await ctx.options.adapter?.linkAccount({ ...account, userId: resolved.user.id });
  }
  const user = await applySignInCallback(ctx.config, resolved.user, id);
  if (!user) return await refusedSignIn(ctx, id, "access_denied", 403);
  // A native sheet can't run the second-factor step: an enrolled user signs in through the
  // browser flow (/native/authorize), which does.
  if (await mfaPendingFor(ctx.options, user)) return json({ error: "mfa_required" }, 403);
  const snapshot = await snapshotFor(ctx.config, user, id, ["ext"]);
  const tokens = await startNativeSession(ctx.config, native, snapshot);
  await emitAuthEvent(ctx.options, "signIn", { user, provider: id, isNewUser: resolved.isNewUser });
  return json(tokens, 200, { pragma: "no-cache" });
}

/**
 * Apple's refresh token, via the `authorization_code` the native sheet returned — kept so
 * account deletion can revoke it. A failed exchange is logged and the sign-in goes on.
 */
async function appleTokens(
  ctx: AuthRouteContext,
  fields: Record<string, string>,
  clientId: string,
  sub: string,
): Promise<Partial<AdapterAccount>> {
  const code = fields.authorization_code;
  if (!code) return {};
  try {
    return await exchangeAppleCode(ctx.config, { code, clientId, sub }) ?? {};
  } catch (error) {
    ctx.options.logger.error("denextAuth: the Sign in with Apple code exchange failed", error);
    return {};
  }
}

// ---- account deletion -------------------------------------------------------------

/** The caller of `/account/delete`: a native bearer, or the same-origin cookie session. */
async function deletionCaller(
  ctx: AuthRouteContext,
): Promise<{ session: AuthSession; cookie: boolean } | Response> {
  const bearer = nativeBearerToken(ctx.request);
  if (bearer !== undefined) {
    if (!nativeOriginAllowed(ctx)) return forbidden();
    const session = await verifyNativeAccessToken(ctx.config, bearer);
    return session ? { session, cookie: false } : json({ error: "unauthorized" }, 401);
  }
  if (!isSameOrigin(ctx.request, ctx.config)) return forbidden();
  const session = await readAuthSession(ctx.config);
  if (!session || session.mfaPending) return json({ error: "unauthorized" }, 401);
  return { session, cookie: true };
}

/**
 * `POST {basePath}/account/delete` — delete the signed-in user (Apple 5.1.1(v)). A recent
 * sign-in is required, exactly as for enrolling a second factor.
 */
async function handleDeleteAccount(ctx: AuthRouteContext): Promise<Response | null> {
  const adapter = ctx.options.adapter;
  if (!adapter?.deleteUser) return null;
  const caller = await deletionCaller(ctx);
  if (caller instanceof Response) return caller;
  if (!recentlyAuthenticated(ctx.options, caller.session)) {
    return json({ error: "reauth_required" }, 403);
  }
  await deleteAccount(ctx, caller.session.user.id);
  if (caller.cookie) await clearAuthSession(ctx.config);
  return json({ ok: true });
}

/**
 * Remove a user: revoke their Apple tokens (while the account rows still exist), their native
 * session families and server-side sessions, then delete the user and everything keyed by
 * them, then tell the app (`onAccountDeleted`).
 */
async function deleteAccount(ctx: AuthRouteContext, userId: string): Promise<void> {
  const { options, config } = ctx;
  const adapter = options.adapter!;
  const user = await adapter.getUser(userId);
  const accounts = await adapter.listAccounts?.(userId) ?? [];
  const appleRevoked = await revokeAppleTokens(config, accounts).catch(() => false);
  if (appleRevoked === false) {
    options.logger.warn(
      "denextAuth: could not revoke the deleted user's Sign in with Apple tokens — configure " +
        "`native.apple.clientSecret` (or an apple() provider) so deletion can revoke them",
      { userId },
    );
  }
  await revokeNativeSessionsOf(config, userId);
  if (options.sessionStore) await options.sessionStore.deleteByUser(userId);
  await adapter.deleteUser!(userId);
  await emitAuthEvent(options, "sessionRevoked", { userId });
  if (!user || !config.onAccountDeleted) return;
  try {
    await config.onAccountDeleted({ user, appleRevoked });
  } catch (error) {
    options.logger.error("denextAuth: onAccountDeleted threw", error);
  }
}

/**
 * The native + account-deletion rows, relative to `basePath`. Specific `/native/*` paths come
 * before `/native/:provider`. The sign-in starts carry the per-IP `"signin-start"` budget; the
 * token and revoke calls the larger `"session-read"` one.
 */
export const nativeRoutes: AuthRoute[] = [
  { method: "OPTIONS", pattern: "/native/:action", handler: handlePreflight },
  { method: "OPTIONS", pattern: "/account/delete", handler: handlePreflight },
  {
    method: "GET",
    pattern: "/native/authorize",
    handler: contained("starting a native sign-in", handleAuthorize),
    limit: "signin-start",
  },
  {
    method: "GET",
    pattern: "/native/complete",
    handler: contained("completing a native sign-in", handleComplete),
  },
  {
    method: "POST",
    pattern: "/native/token",
    handler: nativeRow("the native token endpoint", handleToken),
    limit: "session-read",
  },
  {
    method: "POST",
    pattern: "/native/revoke",
    handler: nativeRow("revoking a native session", handleRevoke),
    limit: "session-read",
  },
  {
    method: "POST",
    pattern: "/native/nonce",
    handler: nativeRow("issuing a native nonce", handleNonce),
    limit: "signin-start",
  },
  {
    method: "POST",
    pattern: "/native/:provider",
    handler: nativeRow("a native id_token sign-in", handleIdToken),
    limit: "signin-start",
  },
  {
    method: "POST",
    pattern: "/account/delete",
    handler: nativeRow("deleting an account", handleDeleteAccount),
  },
];
