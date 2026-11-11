/**
 * The passkey rows for a native app (`denextAuth({ native, passkeys })`) — the cookie-less twins
 * of `/passkey/*`, for an app that runs the WebAuthn ceremony itself (Android's Credential
 * Manager, iOS's `ASAuthorization`) and so has no web origin to call the cookie rows from. On
 * Android the signed client data names the app as `android:apk-key-hash:…`, accepted when the
 * signing certificate is in `passkeys.androidApps`; the RP ID's own origin (an iOS app's
 * associated domain) is accepted as on the web.
 *
 * - `POST {basePath}/native/passkey/authenticate/options` → `PublicKeyCredentialRequestOptionsJSON`
 *   plus a `ceremonyId` (a usernameless sign-in). Per-IP rate-limited like `/signin/*`.
 * - `POST {basePath}/native/passkey/authenticate` — `{ credential, ceremonyId }`: the assertion,
 *   verified as on the web, answers the native token pair (`/native/token`'s shape). With user
 *   verification the passkey is two factors; without it (`userVerification: "preferred"`) a user
 *   who owes a second factor gets `{ mfa_required, mfa_token, … }`, finished with a code at
 *   `/native/mfa`. Every refusal is the same `401 { error: "invalid passkey" }`.
 * - The step-up of a pending native sign-in (an id_token sign-in answered `{ mfa_required,
 *   mfa_token }`): `/native/passkey/authenticate/options` with `{ mfa_token }` offers that user's
 *   passkeys (a ceremony bound to the user) and hands back a fresh `mfa_token` (the presented one
 *   is spent); `/native/passkey/authenticate` with `{ credential, ceremonyId, mfa_token }` checks
 *   the assertion against that user and answers the token pair (`amr` the first factor's, then
 *   `hwk` + `mfa`). It draws on the `/native/mfa` code budget; a refused assertion answers
 *   `401 { error: "invalid passkey", mfa_token, attempts_left }` with one attempt fewer (none left:
 *   `400 { error: "invalid_grant" }`). A sign-in whose first factor was itself a passkey (one key
 *   is one factor) or that must enroll a factor is `403 { error: "code_required", mfa_token }`:
 *   it is finished at `/native/mfa` (or `/native/mfa-enroll`).
 * - `POST {basePath}/native/passkey/register/options` and `/native/passkey/register` — as
 *   `/passkey/register*`, for the user of `Authorization: Bearer <access token>`, which must come
 *   from a recent sign-in (`403 { error: "reauth_required" }` otherwise).
 * - `GET {basePath}/native/passkeys` — the bearer's passkeys (`{ passkeys }`, no key material),
 *   and `DELETE {basePath}/native/passkeys/:id` — remove one of them, which needs a bearer from a
 *   recent sign-in (`403 { error: "reauth_required" }`); another user's id is a `404`.
 *
 * A ceremony started here completes only here, and one started on a cookie row never completes
 * here. These rows take no ambient credential, so they accept a request with no `Origin` (a
 * native HTTP client); one that carries an `Origin` must be this app or a `cors`-allowed origin.
 *
 * @module
 */

import { emitAuthEvent } from "./events.ts";
import { hasVerifiedFactor } from "./factors.ts";
import { mfaPendingFor, pendingSessionLive, recentlyAuthenticated } from "./mfa.ts";
import { consumeNativeMfaToken, issueNativeMfaToken, type NativeMfaPending } from "./native-mfa.ts";
import { finishNativeSignIn } from "./routes-native-mfa.ts";
import { consumeHitBudget, mfaLimiter, subjectBucketKeys } from "./rate-limit.ts";
import {
  nativeBearerToken,
  type ResolvedNative,
  resolveNative,
  snapshotFor,
  startNativeSession,
  verifyNativeAccessToken,
} from "./native.ts";
import { summarize, userHandleOf } from "./passkeys.ts";
import {
  challengeOf,
  creationOptions,
  credentialOf,
  requestOptions,
  verifyPasskeyAssertion,
} from "./passkey-ceremony.ts";
import {
  beginCeremony,
  deleteOwnPasskey,
  finishRegistration,
  type PasskeyContext,
  passkeyContext,
  readBody,
  redeemCeremony,
  refuse,
  registrationRefusal,
} from "./routes-passkeys.ts";
import {
  forbidden,
  invalidGrant,
  nativeOriginAllowed,
  nativeRow,
  pendingNativeSignIn,
} from "./routes-native.ts";
import {
  applySignInCallback,
  type AuthRoute,
  type AuthRouteContext,
  json,
} from "./routes-shared.ts";
import { toAuthUser } from "./adapter-link.ts";
import { isSsoUser } from "./sso-user.ts";
import { isPreflight, preflightResponse } from "../cors.ts";
import { currentContext } from "../request-context.ts";
import type { AuthSession } from "./types.ts";
import { base64UrlField, WebAuthnError } from "./webauthn.ts";

/** The provider a passkey sign-in's session carries. */
const PASSKEY_PROVIDER = "passkey";

/** The headers a token answer carries. */
const NO_CACHE = { pragma: "no-cache", "cache-control": "no-store" };

/** Both features configured: the passkey context and the native settings. */
interface NativePasskeys {
  pk: PasskeyContext;
  native: ResolvedNative;
}

/**
 * The configured features, `null` (→ a plain 404) without `passkeys` or `native`, or the
 * refusal of a caller whose `Origin` is neither this app nor a `cors`-allowed one.
 */
function nativePasskeys(ctx: AuthRouteContext): NativePasskeys | Response | null {
  const pk = passkeyContext(ctx);
  const native = resolveNative(ctx.config);
  if (!pk || !native) return null;
  return nativeOriginAllowed(ctx) ? { pk, native } : forbidden();
}

// ---- sign-in ----------------------------------------------------------------------

/** `POST /native/passkey/authenticate/options`. */
async function handleAuthenticateOptions(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = nativePasskeys(ctx);
  if (!caller || caller instanceof Response) return caller;
  const body = await readBody(ctx);
  if (body.mfa_token !== undefined) return await stepUpOptions(ctx, caller, body);
  const { challenge, ceremonyId } = await beginCeremony(
    caller.pk,
    "signin",
    null,
    undefined,
    true,
  );
  return json({ ...requestOptions(caller.pk.rp, challenge, []), ceremonyId }, 200, NO_CACHE);
}

/** `POST /native/passkey/authenticate`. */
async function handleAuthenticate(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = nativePasskeys(ctx);
  if (!caller || caller instanceof Response) return caller;
  const { pk, native } = caller;
  const body = await readBody(ctx);
  if (body.mfa_token !== undefined) return await stepUp(ctx, caller, body);
  let userId: string;
  let userVerified: boolean;
  try {
    const credential = credentialOf(body.credential);
    const clientDataJSON = base64UrlField(credential.response.clientDataJSON, "clientDataJSON");
    const ceremony = await redeemCeremony(
      pk,
      clientDataJSON,
      ["signin"],
      body.ceremonyId,
      null,
      true,
    );
    if (!ceremony) {
      throw new WebAuthnError("challenge", "no native sign-in ceremony for this response");
    }
    const verified = await verifyPasskeyAssertion(
      pk.rp,
      pk.adapter,
      credential,
      challengeOf(credential),
      undefined,
    );
    userId = verified.record.userId;
    userVerified = verified.userVerified;
  } catch (error) {
    if (!(error instanceof WebAuthnError)) throw error;
    return await refuse(ctx, "invalid_passkey", error.code);
  }
  return await signInNative(ctx, pk, native, userId, userVerified);
}

/**
 * Sign the passkey's owner in natively: `callbacks.signIn`, then the token pair — or, for a
 * presence-only assertion of a user who owes a second factor, the pending sign-in to finish at
 * `/native/mfa` (one key is one factor).
 */
async function signInNative(
  ctx: AuthRouteContext,
  pk: PasskeyContext,
  native: ResolvedNative,
  userId: string,
  userVerified: boolean,
): Promise<Response> {
  const owner = await pk.adapter.getUser(userId);
  if (!owner) return await refuse(ctx, "invalid_passkey", "owner_missing");
  if (isSsoUser(owner)) return await refuse(ctx, "invalid_passkey", "sso_user");
  const user = await applySignInCallback(ctx.config, toAuthUser(owner), PASSKEY_PROVIDER);
  if (!user) {
    await emitAuthEvent(ctx.options, "signInFailed", {
      provider: PASSKEY_PROVIDER,
      reason: "access_denied",
    });
    return json({ error: "access denied" }, 403);
  }
  if (!userVerified && await mfaPendingFor(ctx.config, user)) {
    const enroll = !(await hasVerifiedFactor(ctx.config, user.id));
    return await pendingNativeSignIn(ctx, native, user, PASSKEY_PROVIDER, false, enroll, ["hwk"]);
  }
  const amr = userVerified ? ["hwk", "mfa"] : ["hwk"];
  const snapshot = await snapshotFor(ctx.config, user, PASSKEY_PROVIDER, amr);
  const tokens = await startNativeSession(ctx.config, native, snapshot);
  await emitAuthEvent(ctx.options, "signIn", {
    user,
    provider: PASSKEY_PROVIDER,
    isNewUser: false,
  });
  return json(tokens, 200, NO_CACHE);
}

// ---- the step-up of a pending native sign-in -------------------------------------------

/**
 * The pending native sign-in an `mfa_token` names (the token is spent here), or `null` when it is
 * unknown, spent, expired, or its user may no longer finish signing in.
 */
async function pendingOf(
  ctx: AuthRouteContext,
  native: ResolvedNative,
  token: unknown,
): Promise<NativeMfaPending | null> {
  if (typeof token !== "string") return null;
  const pending = await consumeNativeMfaToken(native, token);
  if (!pending) return null;
  const live = await pendingSessionLive(ctx.config, {
    user: pending.user,
    provider: pending.provider,
    expiresAt: pending.expiresAt,
    authTime: pending.authTime,
  });
  return live ? pending : null;
}

/**
 * Whether a pending sign-in can be finished with a passkey: not when its first factor was a
 * passkey (one key, presence alone, would count as both factors) and not when it must enroll a
 * first factor (`mfa.required: "always"`).
 */
function passkeyCanFinish(pending: NativeMfaPending): boolean {
  return pending.enroll !== true && !(pending.amr?.includes("hwk") ?? false);
}

/** The answer for a pending sign-in a passkey can't finish: a fresh token for the code rows. */
async function codeRequired(native: ResolvedNative, pending: NativeMfaPending): Promise<Response> {
  return json(
    { error: "code_required", mfa_token: await issueNativeMfaToken(native, pending) },
    403,
    NO_CACHE,
  );
}

/** The pending sign-in a step-up's `mfa_token` names, when a passkey may finish it; else the answer. */
async function stepUpPending(
  ctx: AuthRouteContext,
  native: ResolvedNative,
  body: Record<string, unknown>,
): Promise<NativeMfaPending | Response> {
  const pending = await pendingOf(ctx, native, body.mfa_token);
  if (!pending) return invalidGrant();
  return passkeyCanFinish(pending) ? pending : await codeRequired(native, pending);
}

/** `POST /native/passkey/authenticate/options` with `{ mfa_token }`: the step-up's options. */
async function stepUpOptions(
  ctx: AuthRouteContext,
  caller: NativePasskeys,
  body: Record<string, unknown>,
): Promise<Response> {
  const { pk, native } = caller;
  const pending = await stepUpPending(ctx, native, body);
  if (pending instanceof Response) return pending;
  const allow = await pk.adapter.listPasskeys(pending.user.id);
  const { challenge, ceremonyId } = await beginCeremony(pk, "mfa", null, pending.user.id, true);
  return json(
    {
      ...requestOptions(pk.rp, challenge, allow),
      ceremonyId,
      mfa_token: await issueNativeMfaToken(native, pending),
    },
    200,
    NO_CACHE,
  );
}

/** A refused step-up assertion: one attempt fewer and a fresh token, or the end of it. */
async function stepUpRefused(
  ctx: AuthRouteContext,
  native: ResolvedNative,
  pending: NativeMfaPending,
  code: string,
): Promise<Response> {
  await refuse(ctx, "invalid_mfa_code", code);
  const attemptsLeft = pending.attemptsLeft - 1;
  if (attemptsLeft <= 0) return invalidGrant();
  const token = await issueNativeMfaToken(native, { ...pending, attemptsLeft });
  return json(
    { error: "invalid passkey", mfa_token: token, attempts_left: attemptsLeft },
    401,
    NO_CACHE,
  );
}

/** `POST /native/passkey/authenticate` with `{ mfa_token }`: finish the step-up. */
async function stepUp(
  ctx: AuthRouteContext,
  caller: NativePasskeys,
  body: Record<string, unknown>,
): Promise<Response> {
  const { pk, native } = caller;
  const pending = await stepUpPending(ctx, native, body);
  if (pending instanceof Response) return pending;
  // The same per-user budget a code at `/native/mfa` spends.
  const keys = subjectBucketKeys("mfa", pending.user.id, ctx.request, ctx.config);
  const retryAfter = await consumeHitBudget(mfaLimiter(ctx.config), keys);
  if (retryAfter !== null) {
    return json(
      { error: "too_many_attempts", mfa_token: await issueNativeMfaToken(native, pending) },
      429,
      { ...NO_CACHE, "retry-after": String(retryAfter) },
    );
  }
  try {
    const credential = credentialOf(body.credential);
    const clientDataJSON = base64UrlField(credential.response.clientDataJSON, "clientDataJSON");
    const ceremony = await redeemCeremony(pk, clientDataJSON, ["mfa"], body.ceremonyId, null, true);
    if (!ceremony || ceremony.userId !== pending.user.id) {
      throw new WebAuthnError("challenge", "no native step-up ceremony for this response");
    }
    await verifyPasskeyAssertion(
      pk.rp,
      pk.adapter,
      credential,
      challengeOf(credential),
      pending.user.id,
    );
  } catch (error) {
    if (!(error instanceof WebAuthnError)) throw error;
    return await stepUpRefused(ctx, native, pending, error.code);
  }
  // As on the web: the key, and that the session is now multi-factor.
  return json(await finishNativeSignIn(ctx, native, pending, ["hwk", "mfa"]), 200, NO_CACHE);
}

// ---- registration -------------------------------------------------------------------

/** The bearer's live session (and the feature), or the answer to send. */
async function bearerCaller(
  ctx: AuthRouteContext,
): Promise<{ pk: PasskeyContext; session: AuthSession } | Response | null> {
  const caller = nativePasskeys(ctx);
  if (!caller || caller instanceof Response) return caller;
  const bearer = nativeBearerToken(ctx.request);
  const session = bearer === undefined ? null : await verifyNativeAccessToken(ctx.config, bearer);
  return session ? { pk: caller.pk, session } : json({ error: "unauthorized" }, 401);
}

/**
 * The bearer's session, when it may register a passkey: a live access token from a recent
 * sign-in, for a stored, non-SSO user with a verified address (when it has one).
 */
async function registrationCaller(
  ctx: AuthRouteContext,
): Promise<{ pk: PasskeyContext; session: AuthSession } | Response | null> {
  const caller = await recentBearer(ctx);
  if (!caller || caller instanceof Response) return caller;
  return await registrationRefusal(caller.pk, caller.session) ?? caller;
}

/** {@link bearerCaller}, from a recent sign-in (`403 reauth_required` otherwise). */
async function recentBearer(
  ctx: AuthRouteContext,
): Promise<{ pk: PasskeyContext; session: AuthSession } | Response | null> {
  const caller = await bearerCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  return recentlyAuthenticated(ctx.options, caller.session)
    ? caller
    : json({ error: "reauth_required" }, 403);
}

/** `POST /native/passkey/register/options`. */
async function handleRegisterOptions(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await registrationCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const { pk, session } = caller;
  try {
    userHandleOf(session.user.id);
  } catch (error) {
    if (!(error instanceof WebAuthnError)) throw error;
    return json({ error: "invalid passkey", code: error.code }, 400);
  }
  const existing = await pk.adapter.listPasskeys(session.user.id);
  const { challenge, ceremonyId } = await beginCeremony(
    pk,
    "register",
    null,
    session.user.id,
    true,
  );
  return json({ ...creationOptions(pk.rp, session.user, existing, challenge), ceremonyId });
}

/** `POST /native/passkey/register`. */
async function handleRegister(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await registrationCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  return await finishRegistration(caller.pk, caller.session, null, true);
}

// ---- management -----------------------------------------------------------------------

/** `GET /native/passkeys`. */
async function handleList(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await bearerCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const passkeys = await caller.pk.adapter.listPasskeys(caller.session.user.id);
  return json({ passkeys: passkeys.map(summarize) }, 200, NO_CACHE);
}

/** `DELETE /native/passkeys/:id`. */
async function handleDelete(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await recentBearer(ctx);
  if (!caller || caller instanceof Response) return caller;
  return await deleteOwnPasskey(caller.pk, caller.session.user.id);
}

/** `OPTIONS` on a native passkey path: a preflight under the app's `cors` policy. */
function handlePreflight(ctx: AuthRouteContext): Response | null {
  const policy = currentContext()?.cors ?? null;
  if (!policy || !isPreflight(ctx.request)) return null;
  if (!passkeyContext(ctx) || !resolveNative(ctx.config)) return null;
  return preflightResponse(ctx.request, policy);
}

/** The native passkey rows, relative to `basePath`. */
export const nativePasskeyRoutes: AuthRoute[] = [
  { method: "OPTIONS", pattern: "/native/passkey/:step", handler: handlePreflight },
  { method: "OPTIONS", pattern: "/native/passkey/:step/options", handler: handlePreflight },
  {
    method: "POST",
    pattern: "/native/passkey/authenticate/options",
    handler: nativeRow("native passkey sign-in options", handleAuthenticateOptions),
    limit: "signin-start",
  },
  {
    method: "POST",
    pattern: "/native/passkey/authenticate",
    handler: nativeRow("native passkey sign-in", handleAuthenticate),
    limit: "signin-start",
  },
  {
    method: "POST",
    pattern: "/native/passkey/register/options",
    handler: nativeRow("native passkey registration options", handleRegisterOptions),
  },
  {
    method: "POST",
    pattern: "/native/passkey/register",
    handler: nativeRow("native passkey registration", handleRegister),
  },
  { method: "OPTIONS", pattern: "/native/passkeys", handler: handlePreflight },
  { method: "OPTIONS", pattern: "/native/passkeys/:id", handler: handlePreflight },
  {
    method: "GET",
    pattern: "/native/passkeys",
    handler: nativeRow("listing native passkeys", handleList),
  },
  {
    method: "DELETE",
    pattern: "/native/passkeys/:id",
    handler: nativeRow("deleting a native passkey", handleDelete),
  },
];
