/**
 * The passkey (WebAuthn) endpoints, under `basePath` — all JSON, same-origin gated, cookie
 * session only (the `Authorization` header is never read), bodies capped at 64 KiB:
 *
 * - `POST /passkey/register/options` — `PublicKeyCredentialCreationOptionsJSON` (WebAuthn L3
 *   §5.4) for the signed-in user: a single-use challenge, the RP, the user handle, ES256 /
 *   RS256 / EdDSA, the user's existing credentials excluded, a discoverable credential
 *   required. Needs a complete session that signed in recently (as `/mfa/enroll` does), so a
 *   stolen session can't plant a passkey of its own.
 * - `POST /passkey/register` — `{ credential, name? }`: the `RegistrationResponseJSON`, verified
 *   (§7.1) and stored. `{ ok: true, passkey }`; a credential ID already registered is a `409`.
 * - `POST /passkey/authenticate/options` — `PublicKeyCredentialRequestOptionsJSON`. With a
 *   pending (second-factor-owed) session it is the step-up, offering that user's credentials;
 *   otherwise a usernameless sign-in (an empty `allowCredentials`: the authenticator offers its
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
import { completeStepUp, recentlyAuthenticated } from "./mfa.ts";
import { toAuthUser } from "./adapter-link.ts";
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
import { finishSignIn } from "./sign-in-tail.ts";
import type { AuthSession } from "./types.ts";
import {
  base64UrlField,
  parseClientData,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
} from "./webauthn.ts";
import { base64UrlDecode, base64UrlEncode, randomToken } from "./oauth.ts";

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

/** The `credential` object of a body, with `id === rawId` and `type: "public-key"`. */
function credentialOf(body: Record<string, unknown>): {
  id: string;
  response: Record<string, unknown>;
} {
  const credential = body.credential as Record<string, unknown> | undefined;
  const response = credential?.response as Record<string, unknown> | undefined;
  if (
    !credential || typeof credential !== "object" || credential.type !== "public-key" ||
    typeof credential.id !== "string" || credential.id !== credential.rawId ||
    !response || typeof response !== "object"
  ) {
    throw new WebAuthnError("malformed", "not a PublicKeyCredential JSON");
  }
  base64UrlField(credential.id, "credential.id");
  return { id: credential.id, response };
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

/** `POST /passkey/register/options`. */
async function handleRegisterOptions(ctx: AuthRouteContext): Promise<Response | null> {
  const pk = passkeyContext(ctx);
  if (!pk) return null;
  const session = await recentSession(ctx);
  if (session instanceof Response) return session;
  const user = session.user;
  const existing = await pk.adapter.listPasskeys(user.id);
  const challenge = await beginCeremony(pk, "register", user.id);
  return json({
    rp: { id: pk.rp.rpId, name: pk.rp.rpName },
    user: {
      id: userHandleOf(user.id),
      name: user.email ?? user.id,
      displayName: user.name ?? user.email ?? user.id,
    },
    challenge,
    pubKeyCredParams: pk.rp.algorithms.map((alg) => ({ type: "public-key", alg })),
    timeout: pk.rp.timeout * 1000,
    excludeCredentials: existing.map((p) => ({
      type: "public-key",
      id: p.id,
      ...(p.transports ? { transports: p.transports } : {}),
    })),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: pk.rp.requireUserVerification ? "required" : "preferred",
    },
    attestation: "none",
  });
}

/** The transports a registration reported, kept only when they are short strings. */
function transportsOf(response: Record<string, unknown>): string[] | undefined {
  const list = response.transports;
  if (!Array.isArray(list)) return undefined;
  const clean = list.filter((t): t is string => typeof t === "string" && /^[a-z-]{1,32}$/.test(t));
  return clean.length > 0 ? clean.slice(0, 8) : undefined;
}

/** A user-supplied passkey label, trimmed and capped. */
function labelOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 64);
  return trimmed || undefined;
}

/** Hex of a byte string. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `POST /passkey/register`. */
async function handleRegister(ctx: AuthRouteContext): Promise<Response | null> {
  const pk = passkeyContext(ctx);
  if (!pk) return null;
  const session = await recentSession(ctx);
  if (session instanceof Response) return session;
  const body = await readBody(ctx);
  try {
    const { id, response } = credentialOf(body);
    const clientDataJSON = base64UrlField(response.clientDataJSON, "clientDataJSON");
    const attestationObject = base64UrlField(response.attestationObject, "attestationObject");
    const ceremony = await redeemCeremony(pk, clientDataJSON, ["register"]);
    if (!ceremony || ceremony.userId !== session.user.id) {
      throw new WebAuthnError("challenge", "no registration ceremony for this response");
    }
    const result = await verifyRegistration(
      { clientDataJSON, attestationObject },
      {
        challenge: parseClientData(clientDataJSON).challenge,
        origins: pk.rp.origins,
        rpId: pk.rp.rpId,
        requireUserVerification: pk.rp.requireUserVerification,
        algorithms: pk.rp.algorithms,
      },
    );
    const credentialId = base64UrlEncode(result.credentialId);
    if (credentialId !== id) throw new WebAuthnError("malformed", "credential.id mismatch");
    const record = {
      id: credentialId,
      userId: session.user.id,
      publicKey: base64UrlEncode(result.publicKey),
      alg: result.alg,
      signCount: result.signCount,
      backupEligible: result.backupEligible,
      backedUp: result.backedUp,
      aaguid: hex(result.aaguid),
      createdAt: Math.floor(Date.now() / 1000),
      ...withDefined({ transports: transportsOf(response), name: labelOf(body.name) }),
    };
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

/** The entries of `values` that are defined. */
function withDefined<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
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
  return { pk, pending: session?.mfaPending ? session : null };
}

/** `POST /passkey/authenticate/options`. */
async function handleAuthenticateOptions(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await authenticationCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const { pk, pending: stepUp } = caller;
  const allow = stepUp ? await pk.adapter.listPasskeys(stepUp.user.id) : [];
  const challenge = await beginCeremony(pk, stepUp ? "mfa" : "signin", stepUp?.user.id);
  return json({
    challenge,
    rpId: pk.rp.rpId,
    timeout: pk.rp.timeout * 1000,
    userVerification: pk.rp.requireUserVerification ? "required" : "preferred",
    allowCredentials: allow.map((p) => ({
      type: "public-key",
      id: p.id,
      ...(p.transports ? { transports: p.transports } : {}),
    })),
  });
}

/** Report a refused passkey sign-in; the answer is always the same generic `401`. */
async function refuse(
  ctx: AuthRouteContext,
  reason: string,
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
  const { id, response } = credentialOf(body);
  const clientDataJSON = base64UrlField(response.clientDataJSON, "clientDataJSON");
  const authenticatorData = base64UrlField(response.authenticatorData, "authenticatorData");
  const signature = base64UrlField(response.signature, "signature");
  const ceremony = await redeemCeremony(pk, clientDataJSON, pending ? ["mfa"] : ["signin"]);
  if (!ceremony || (pending && ceremony.userId !== pending.user.id)) {
    throw new WebAuthnError("challenge", "no authentication ceremony for this response");
  }
  const record = await pk.adapter.getPasskey(id);
  if (!record) throw new WebAuthnError("signature", "unknown credential");
  if (ceremony.userId !== undefined && record.userId !== ceremony.userId) {
    throw new WebAuthnError("signature", "the credential belongs to another user");
  }
  if (response.userHandle !== undefined && response.userHandle !== null) {
    if (response.userHandle !== userHandleOf(record.userId)) {
      throw new WebAuthnError("signature", "the user handle is not the credential's owner");
    }
  }
  const result = await verifyAuthentication(
    { clientDataJSON, authenticatorData, signature },
    {
      publicKey: base64UrlDecode(record.publicKey),
      signCount: record.signCount,
      backupEligible: record.backupEligible,
    },
    {
      challenge: parseClientData(clientDataJSON).challenge,
      origins: pk.rp.origins,
      rpId: pk.rp.rpId,
      requireUserVerification: pk.rp.requireUserVerification,
    },
  );
  const swapped = await pk.adapter.updatePasskey(record.id, record.signCount, {
    signCount: result.signCount,
    backedUp: result.backedUp,
    lastUsedAt: Math.floor(Date.now() / 1000),
  });
  if (!swapped) throw new WebAuthnError("counter", "a concurrent assertion advanced the counter");
  return { ceremony, userId: record.userId, userVerified: result.userVerified };
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
