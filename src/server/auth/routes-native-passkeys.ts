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
 * - `POST {basePath}/native/passkey/register/options` and `/native/passkey/register` — as
 *   `/passkey/register*`, for the user of `Authorization: Bearer <access token>`, which must come
 *   from a recent sign-in (`403 { error: "reauth_required" }` otherwise).
 *
 * A ceremony started here completes only here, and one started on a cookie row never completes
 * here. These rows take no ambient credential, so they accept a request with no `Origin` (a
 * native HTTP client); one that carries an `Origin` must be this app or a `cors`-allowed origin.
 *
 * @module
 */

import { emitAuthEvent } from "./events.ts";
import { hasVerifiedFactor } from "./factors.ts";
import { mfaPendingFor, recentlyAuthenticated } from "./mfa.ts";
import {
  nativeBearerToken,
  type ResolvedNative,
  resolveNative,
  snapshotFor,
  startNativeSession,
  verifyNativeAccessToken,
} from "./native.ts";
import { userHandleOf } from "./passkeys.ts";
import {
  challengeOf,
  creationOptions,
  credentialOf,
  requestOptions,
  verifyPasskeyAssertion,
} from "./passkey-ceremony.ts";
import {
  beginCeremony,
  finishRegistration,
  type PasskeyContext,
  passkeyContext,
  readBody,
  redeemCeremony,
  refuse,
  registrationRefusal,
} from "./routes-passkeys.ts";
import { forbidden, nativeOriginAllowed, nativeRow, pendingNativeSignIn } from "./routes-native.ts";
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

// ---- registration -------------------------------------------------------------------

/**
 * The bearer's session, when it may register a passkey: a live access token from a recent
 * sign-in, for a stored, non-SSO user with a verified address (when it has one).
 */
async function registrationCaller(
  ctx: AuthRouteContext,
): Promise<{ pk: PasskeyContext; session: AuthSession } | Response | null> {
  const caller = nativePasskeys(ctx);
  if (!caller || caller instanceof Response) return caller;
  const bearer = nativeBearerToken(ctx.request);
  const session = bearer === undefined ? null : await verifyNativeAccessToken(ctx.config, bearer);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!recentlyAuthenticated(ctx.options, session)) return json({ error: "reauth_required" }, 403);
  return await registrationRefusal(caller.pk, session) ?? { pk: caller.pk, session };
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
];
