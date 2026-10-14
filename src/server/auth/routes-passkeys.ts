/**
 * The passkey (WebAuthn) endpoints, under `basePath` — all JSON, same-origin gated, cookie
 * session only (the `Authorization` header is never read), bodies capped at 64 KiB:
 *
 * - `POST /passkey/register/options` — `PublicKeyCredentialCreationOptionsJSON` (WebAuthn L3
 *   §5.4) for the signed-in user: a single-use challenge, the RP, the user handle, ES256 /
 *   RS256 / EdDSA, the user's existing credentials excluded, a discoverable credential
 *   required. Needs a complete session that signed in recently (as `/mfa/enroll` does), so a
 *   stolen session can't plant a passkey of its own — and, for an account with an email
 *   address, a verified one: `403 { error: "email_unverified" }` otherwise (both rows), so whoever
 *   registered someone else's address can't leave a passkey behind for when its owner claims
 *   it. A user id too long for a WebAuthn user handle (64 bytes) is a `400`.
 * - `POST /passkey/register` — `{ credential, name? }`: the `RegistrationResponseJSON`, verified
 *   (§7.1) and stored. `{ ok: true, passkey }`; a credential ID already registered is a `409`.
 * - `POST /passkey/authenticate/options` — `PublicKeyCredentialRequestOptionsJSON`. With a
 *   pending (second-factor-owed) session it is the step-up, offering that user's credentials —
 *   unless that session's first factor was itself a passkey (a sign-in without user
 *   verification, `amr: ["hwk"]`): one key is one factor, so that step-up takes a TOTP or backup
 *   code at `/mfa` only, and this answers `403 { error: "code_required" }`; otherwise a
 *   usernameless sign-in (an empty `allowCredentials`: the authenticator offers its
 *   discoverable passkeys). Per-IP rate-limited like `/signin/*`.
 * - `POST /passkey/authenticate` — `{ credential, callbackUrl? }`: the assertion, verified
 *   (§7.2): signs the credential's owner in, or completes the pending step-up. Every failure is
 *   the same `401 { error: "invalid passkey" }` (the reason goes to `signInFailed` and the
 *   logger), and a cloned-authenticator counter is refused.
 * - `GET /passkeys` — the signed-in user's passkeys (no key material).
 * - `DELETE /passkeys/:id` — remove one; needs a recent sign-in.
 *
 * Without `denextAuth({ passkeys })` every row answers `null` (a plain 404).
 *
 * @module
 */

import { readCappedBody } from "../body.ts";
import { emitAuthEvent } from "./events.ts";
import { forgetPasskeyFactor } from "./factors.ts";
import { completeStepUp, pendingSessionLive, recentlyAuthenticated } from "./mfa.ts";
import { isVerified, toAuthUser } from "./adapter-link.ts";
import {
  type ChallengeData,
  issueChallenge,
  type PasskeyAdapter,
  passkeyAdapterOf,
  type PasskeyCeremony,
  redeemChallenge,
  type ResolvedPasskeys,
  resolvePasskeys,
  summarize,
  userHandleOf,
} from "./passkeys.ts";
import {
  authTrustsProxy,
  clientIpBucket,
  consumeHitBudget,
  mfaLimiter,
  subjectBucketKeys,
} from "./rate-limit.ts";
import {
  afterSignIn,
  applySignInCallback,
  type AuthRoute,
  type AuthRouteContext,
  contained,
  isSameOrigin,
  json,
} from "./routes-shared.ts";
import { cookieSessionOptions } from "./options.ts";
import { getSession, type SessionOptions } from "../session.ts";
import { readAuthSession } from "./session.ts";
import { isSsoUser } from "./sso-user.ts";
import { finishSignIn } from "./sign-in-tail.ts";
import type { AuthSession, SignInFailedReason } from "./types.ts";
import { base64UrlField, parseClientData, WebAuthnError } from "./webauthn.ts";
import { randomToken } from "./oauth.ts";
import {
  challengeOf,
  creationOptions,
  credentialOf,
  labelOf,
  requestOptions,
  verifyNewPasskey,
  verifyPasskeyAssertion,
} from "./passkey-ceremony.ts";

/** The most a passkey body may carry (an attestation with a certificate chain fits). */
const MAX_BODY_BYTES = 64 * 1024;

/** The provider id a passkey sign-in's session carries. */
const PASSKEY_PROVIDER = "passkey";

/** Everything a passkey route needs, once the feature is known to be configured. */
interface PasskeyContext {
  ctx: AuthRouteContext;
  rp: ResolvedPasskeys;
  adapter: PasskeyAdapter;
}

/** The configured feature, or `null` (→ a plain 404) when passkeys are off. */
function passkeyContext(ctx: AuthRouteContext): PasskeyContext | null {
  const rp = resolvePasskeys(ctx.config);
  const adapter = passkeyAdapterOf(ctx.options.adapter);
  return rp && adapter ? { ctx, rp, adapter } : null;
}

/** The JSON body as an object; anything unusable (oversized, stalled, not JSON) is `{}`. */
async function readBody(ctx: AuthRouteContext): Promise<Record<string, unknown>> {
  const bytes = await readCappedBody(ctx.request, MAX_BODY_BYTES).catch(() => null);
  if (!(bytes instanceof Uint8Array)) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

// ---- the ceremony cookie -------------------------------------------------------------

/**
 * The signed cookie binding a ceremony to the browser that started it: its random `binding`
 * must match the challenge record's. Same attributes as the OAuth transaction cookie.
 */
function ceremonyCookie(pk: PasskeyContext): SessionOptions {
  const tx = pk.ctx.options.cookies.transaction;
  return cookieSessionOptions(pk.ctx.config, { ...tx, name: `${tx.name}_pk` }, pk.rp.timeout);
}

/** Start a ceremony: a challenge record plus the cookie that binds it here. */
async function beginCeremony(
  pk: PasskeyContext,
  kind: PasskeyCeremony,
  userId?: string,
): Promise<string> {
  const binding = randomToken(16);
  const challenge = await issueChallenge(pk.adapter, pk.rp, { kind, userId, binding });
  const cookie = await getSession<{ binding: string }>(ceremonyCookie(pk));
  await cookie.set({ binding });
  return challenge;
}

/**
 * Redeem the challenge `clientDataJSON` carries — once — and check it belongs to this browser
 * and to one of `kinds`. The cookie is cleared either way.
 *
 * @returns The ceremony data, or `null`.
 */
async function redeemCeremony(
  pk: PasskeyContext,
  clientDataJSON: Uint8Array,
  kinds: readonly PasskeyCeremony[],
): Promise<ChallengeData | null> {
  const cookie = await getSession<{ binding: string }>(ceremonyCookie(pk));
  const binding = cookie.data?.binding;
  cookie.clear();
  const challenge = parseClientData(clientDataJSON).challenge;
  const data = await redeemChallenge(pk.adapter, challenge);
  if (!data || !binding || data.binding !== binding || !kinds.includes(data.kind)) return null;
  return data;
}

// ---- registration -------------------------------------------------------------------

/** The complete, recently signed-in cookie session, or the answer to send. */
async function recentSession(ctx: AuthRouteContext): Promise<AuthSession | Response> {
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  const session = await readAuthSession(ctx.config);
  if (!session || session.mfaPending) return json({ error: "unauthorized" }, 401);
  if (!recentlyAuthenticated(ctx.options, session)) {
    return json({ error: "reauth_required" }, 403);
  }
  return session;
}

/**
 * {@link recentSession}, plus the account's address verified when it has one. The stored user
 * is read, not the session's copy: the pre-account-hijacking eviction ({@link ./email.ts}) keys
 * on the stored `emailVerified`, and so does this — a passkey registered before the owner
 * proves the mailbox would be the attacker's.
 */
async function registrationSession(pk: PasskeyContext): Promise<AuthSession | Response> {
  const session = await recentSession(pk.ctx);
  if (session instanceof Response) return session;
  const stored = await pk.adapter.getUser(session.user.id);
  if (!stored) return json({ error: "unauthorized" }, 401);
  // An SSO user signs in through its identity provider only: no passkey to bypass it with.
  if (isSsoUser(stored)) return json({ error: "sso_user" }, 403);
  if (stored.email && !isVerified(stored.emailVerified)) {
    return json({ error: "email_unverified" }, 403);
  }
  return session;
}

/** `POST /passkey/register/options`. */
async function handleRegisterOptions(ctx: AuthRouteContext): Promise<Response | null> {
  const pk = passkeyContext(ctx);
  if (!pk) return null;
  const session = await registrationSession(pk);
  if (session instanceof Response) return session;
  const user = session.user;
  try {
    const existing = await pk.adapter.listPasskeys(user.id);
    userHandleOf(user.id);
    const challenge = await beginCeremony(pk, "register", user.id);
    return json(creationOptions(pk.rp, user, existing, challenge));
  } catch (error) {
    if (!(error instanceof WebAuthnError)) throw error;
    ctx.options.logger.warn("denextAuth: refused a passkey registration", { code: error.code });
    return json({ error: "invalid passkey", code: error.code }, 400);
  }
}

/** `POST /passkey/register`. */
async function handleRegister(ctx: AuthRouteContext): Promise<Response | null> {
  const pk = passkeyContext(ctx);
  if (!pk) return null;
  const session = await registrationSession(pk);
  if (session instanceof Response) return session;
  const body = await readBody(ctx);
  try {
    const credential = credentialOf(body.credential);
    const clientDataJSON = base64UrlField(credential.response.clientDataJSON, "clientDataJSON");
    const ceremony = await redeemCeremony(pk, clientDataJSON, ["register"]);
    if (!ceremony || ceremony.userId !== session.user.id) {
      throw new WebAuthnError("challenge", "no registration ceremony for this response");
    }
    const record = await verifyNewPasskey(
      pk.rp,
      credential,
      challengeOf(credential),
      session.user.id,
      labelOf(body.name),
    );
    if (!await pk.adapter.createPasskey(record)) {
      return json({ error: "credential already registered" }, 409);
    }
    return json({ ok: true, passkey: summarize(record) });
  } catch (error) {
    if (!(error instanceof WebAuthnError)) throw error;
    ctx.options.logger.warn("denextAuth: refused a passkey registration", { code: error.code });
    return json({ error: "invalid passkey", code: error.code }, 400);
  }
}

// ---- authentication -----------------------------------------------------------------

/**
 * The gate both authentication rows share: the feature configured (else `null`), a
 * same-origin request, and the cookie session's pending (second-factor-owed) state.
 */
async function authenticationCaller(
  ctx: AuthRouteContext,
): Promise<{ pk: PasskeyContext; pending: AuthSession | null } | Response | null> {
  const pk = passkeyContext(ctx);
  if (!pk) return null;
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  const session = await readAuthSession(ctx.config);
  if (!session?.mfaPending) return { pk, pending: null };
  // A stateless pending cookie outlives a ban or an eviction: refuse it from the stored user.
  if (!(await pendingSessionLive(ctx.config, session))) {
    return json({ error: "unauthorized" }, 401);
  }
  return { pk, pending: session };
}

/**
 * Whether a pending session's first factor was a passkey (`amr` has `hwk`: a sign-in without
 * user verification). Its step-up must be a code: offering — or accepting — a passkey there
 * would let one key, presence alone, count as both factors.
 */
function passkeyWasFirstFactor(pending: AuthSession): boolean {
  return pending.amr?.includes("hwk") ?? false;
}

/** `POST /passkey/authenticate/options`. */
async function handleAuthenticateOptions(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await authenticationCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const { pk, pending: stepUp } = caller;
  if (stepUp && passkeyWasFirstFactor(stepUp)) return json({ error: "code_required" }, 403);
  const allow = stepUp ? await pk.adapter.listPasskeys(stepUp.user.id) : [];
  const challenge = await beginCeremony(pk, stepUp ? "mfa" : "signin", stepUp?.user.id);
  return json(requestOptions(pk.rp, challenge, allow));
}

/** Report a refused passkey sign-in; the answer is always the same generic `401`. */
async function refuse(
  ctx: AuthRouteContext,
  reason: Extract<SignInFailedReason, "invalid_passkey" | "invalid_mfa_code">,
  code?: string,
): Promise<Response> {
  if (code) ctx.options.logger.warn("denextAuth: refused a passkey sign-in", { code });
  await emitAuthEvent(ctx.options, "signInFailed", {
    provider: PASSKEY_PROVIDER,
    reason,
    ip: clientIpBucket(ctx.request, { trustForwardedHeaders: authTrustsProxy(ctx.config) }),
  });
  return json({ error: "invalid passkey" }, 401);
}

/** The verified assertion: whose credential, and whether UV was set. */
interface VerifiedAssertion {
  ceremony: ChallengeData;
  userId: string;
  userVerified: boolean;
}

/**
 * Verify an assertion end to end: the ceremony (single-use, this browser), the credential
 * (registered, and — for a step-up — the pending user's; a presented `userHandle` must be its
 * owner's, §7.2 step 6), the WebAuthn checks, and the counter write (a compare-and-swap, so
 * two racing assertions can't both pass the clone check).
 */
async function verifyAssertion(
  pk: PasskeyContext,
  body: Record<string, unknown>,
  pending: AuthSession | null,
): Promise<VerifiedAssertion> {
  const credential = credentialOf(body.credential);
  const clientDataJSON = base64UrlField(credential.response.clientDataJSON, "clientDataJSON");
  const ceremony = await redeemCeremony(pk, clientDataJSON, pending ? ["mfa"] : ["signin"]);
  if (!ceremony || (pending && ceremony.userId !== pending.user.id)) {
    throw new WebAuthnError("challenge", "no authentication ceremony for this response");
  }
  const { record, userVerified } = await verifyPasskeyAssertion(
    pk.rp,
    pk.adapter,
    credential,
    challengeOf(credential),
    ceremony.userId,
  );
  return { ceremony, userId: record.userId, userVerified };
}

/** A step-up spends the same per-user budget as a code at `/mfa`: a `429` once it's spent. */
async function spendStepUp(ctx: AuthRouteContext, pending: AuthSession): Promise<Response | null> {
  const keys = subjectBucketKeys("mfa", pending.user.id, ctx.request, ctx.config);
  const retryAfter = await consumeHitBudget(mfaLimiter(ctx.config), keys);
  return retryAfter === null
    ? null
    : json({ error: "too many attempts" }, 429, { "retry-after": String(retryAfter) });
}

/**
 * Sign the passkey's owner in: `callbacks.signIn`, then the one sign-in tail — with user
 * verification the passkey was two factors, so no step-up is owed. The JSON answer also names
 * the (same-origin-coerced) landing page, so the client never navigates to a target the server
 * didn't vet.
 */
async function signInOwner(
  ctx: AuthRouteContext,
  pk: PasskeyContext,
  verified: VerifiedAssertion,
  callbackUrl: string | undefined,
): Promise<Response> {
  const owner = await pk.adapter.getUser(verified.userId);
  if (!owner) return await refuse(ctx, "invalid_passkey", "owner_missing");
  // A passkey from before the account became an SSO user signs nobody in.
  if (isSsoUser(owner)) return await refuse(ctx, "invalid_passkey", "sso_user");
  const approved = await applySignInCallback(ctx.config, toAuthUser(owner), PASSKEY_PROVIDER);
  if (!approved) {
    await emitAuthEvent(ctx.options, "signInFailed", {
      provider: PASSKEY_PROVIDER,
      reason: "access_denied",
    });
    return json({ error: "access denied" }, 403);
  }
  const answer = await finishSignIn(ctx, approved, PASSKEY_PROVIDER, {
    amr: verified.userVerified ? ["hwk", "mfa"] : ["hwk"],
    satisfiesMfa: verified.userVerified,
    returnTo: callbackUrl,
    json: true,
  });
  const payload = await answer.json() as Record<string, unknown>;
  return json(
    payload.mfa ? payload : { ...payload, url: afterSignIn(ctx.config, callbackUrl) },
    answer.status,
  );
}

/** `POST /passkey/authenticate`. */
async function handleAuthenticate(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await authenticationCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const { pk, pending } = caller;
  if (pending && passkeyWasFirstFactor(pending)) {
    return await refuse(ctx, "invalid_mfa_code", "passkey_was_first_factor");
  }
  const limited = pending ? await spendStepUp(ctx, pending) : null;
  if (limited) return limited;
  const body = await readBody(ctx);
  let verified: VerifiedAssertion;
  try {
    verified = await verifyAssertion(pk, body, pending);
  } catch (error) {
    if (!(error instanceof WebAuthnError)) throw error;
    return await refuse(ctx, pending ? "invalid_mfa_code" : "invalid_passkey", error.code);
  }
  const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl : undefined;
  if (!pending) return await signInOwner(ctx, pk, verified, callbackUrl);
  const fresh = await completeStepUp(ctx, pending, "hwk");
  return json({ ok: true, user: fresh.user, url: afterSignIn(ctx.config, callbackUrl) });
}

// ---- management -----------------------------------------------------------------------

/** `GET /passkeys`. */
async function handleList(ctx: AuthRouteContext): Promise<Response | null> {
  const pk = passkeyContext(ctx);
  if (!pk) return null;
  const session = await readAuthSession(ctx.config);
  if (!session || session.mfaPending) return json({ error: "unauthorized" }, 401);
  return json({ passkeys: (await pk.adapter.listPasskeys(session.user.id)).map(summarize) });
}

/** `DELETE /passkeys/:id`. */
async function handleDelete(ctx: AuthRouteContext): Promise<Response | null> {
  const pk = passkeyContext(ctx);
  if (!pk) return null;
  const session = await recentSession(ctx);
  if (session instanceof Response) return session;
  const record = await pk.adapter.getPasskey(ctx.params.id);
  if (!record || record.userId !== session.user.id) return json({ error: "not found" }, 404);
  await pk.adapter.deletePasskey(record.id);
  await forgetPasskeyFactor(ctx.config, record.userId, record.id);
  return json({ ok: true });
}

/** The passkey rows, relative to `basePath`. */
export const passkeyRoutes: AuthRoute[] = [
  {
    method: "POST",
    pattern: "/passkey/register/options",
    handler: contained("passkey registration options", handleRegisterOptions),
  },
  {
    method: "POST",
    pattern: "/passkey/register",
    handler: contained("passkey registration", handleRegister),
  },
  {
    method: "POST",
    pattern: "/passkey/authenticate/options",
    handler: contained("passkey sign-in options", handleAuthenticateOptions),
    limit: "signin-start",
  },
  {
    method: "POST",
    pattern: "/passkey/authenticate",
    handler: contained("passkey sign-in", handleAuthenticate),
    limit: "signin-start",
  },
  { method: "GET", pattern: "/passkeys", handler: contained("listing passkeys", handleList) },
  {
    method: "DELETE",
    pattern: "/passkeys/:id",
    handler: contained("removing a passkey", handleDelete),
  },
];
