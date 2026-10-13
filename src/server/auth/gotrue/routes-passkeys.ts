/**
 * Passkeys through `/auth/v1` (`supabase.auth.passkey.*`, `signInWithPasskey`,
 * `auth.admin.passkey.*`) over the passkey store denext's own `{basePath}/passkey*` endpoints
 * use — a passkey registered either way signs in either way.
 *
 * - Registration needs a signed-in user who authenticated recently (`mfa.freshness`, five
 *   minutes at least) and, for an account with an email address, a verified one — a passkey
 *   planted by a stolen session or on an unverified account would be a lasting way in.
 * - A ceremony's challenge is single-use (stored hashed) and bound to the `challenge_id` it was
 *   issued with; the response must be signed over it.
 * - A passkey sign-in with user verification is two factors (`aal2`, amr `webauthn`); without it
 *   (`passkeys.userVerification: "preferred"`) the session is `aal1`.
 *
 * @module
 */

import type { PasskeyRecord } from "../adapter.ts";
import { isVerified } from "../adapter-link.ts";
import { forgetPasskeyFactor, hasVerifiedFactor } from "../factors.ts";
import { recentlyAuthenticated } from "../mfa.ts";
import { randomToken } from "../oauth.ts";
import { resolveAuthOptions } from "../options.ts";
import {
  challengeOf,
  creationOptions,
  credentialOf,
  labelOf,
  requestOptions,
  verifyNewPasskey,
  verifyPasskeyAssertion,
} from "../passkey-ceremony.ts";
import { issueChallenge, redeemChallenge } from "../passkeys.ts";
import { signinStartLimiter } from "../rate-limit.ts";
import { WebAuthnError } from "../webauthn.ts";
import {
  type CallerUser,
  checkCaptcha,
  type GoTrueContext,
  nowSeconds,
  ok,
  readJson,
  requireUser,
  spendIp,
  str,
} from "./context.ts";
import { fail, GoTrueError } from "./errors.ts";
import { startSessionWithAal } from "./session.ts";
import { iso } from "./user.ts";
import { requireRelyingParty } from "./webauthn-factors.ts";

/** A passkey in the list shape supabase-js reads. */
function listItem(record: PasskeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    ...(record.name ? { friendly_name: record.name } : {}),
    created_at: iso(record.createdAt),
    ...(record.lastUsedAt ? { last_used_at: iso(record.lastUsedAt) } : {}),
  };
}

/**
 * The caller, refused unless they authenticated recently, verified their address and — when
 * they hold a verified factor — passed it.
 */
async function registrant(ctx: GoTrueContext): Promise<CallerUser> {
  const caller = await requireUser(ctx);
  const authTime = Array.isArray(caller.claims.amr)
    ? Math.max(
      ...caller.claims.amr.map((entry) => Number((entry as { timestamp?: number }).timestamp ?? 0)),
    )
    : 0;
  const options = resolveAuthOptions(ctx.config);
  const session = { user: { id: caller.user.id }, provider: "", expiresAt: 0, authTime };
  if (!recentlyAuthenticated(options, session)) {
    throw new GoTrueError(401, "reauthentication_needed", "A recent sign-in is required");
  }
  if (caller.user.email && !isVerified(caller.user.emailVerified)) {
    throw new GoTrueError(403, "email_not_confirmed", "Email not confirmed");
  }
  // A passkey signs in at `aal2`: a session that has not passed the user's second factor must
  // not be able to plant one (nor remove one).
  if (caller.claims.aal !== "aal2" && await hasVerifiedFactor(ctx.config, caller.user.id)) {
    throw new GoTrueError(403, "insufficient_aal", "AAL2 required to manage passkeys");
  }
  return caller;
}

/** Issue a challenge bound to a fresh `challenge_id`. */
async function begin(
  ctx: GoTrueContext,
  kind: "register" | "signin",
  userId?: string,
): Promise<{ challengeId: string; challenge: string; expiresAt: number }> {
  const { rp, store } = requireRelyingParty(ctx);
  const challengeId = randomToken(16);
  const challenge = await issueChallenge(store, rp, { kind, userId, binding: challengeId });
  return { challengeId, challenge, expiresAt: nowSeconds() + rp.timeout };
}

/** Redeem the challenge a response signed over; it must be this `challenge_id`'s. */
async function redeem(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
  kind: "register" | "signin",
): Promise<{ credential: ReturnType<typeof credentialOf>; userId?: string; challenge: string }> {
  const { store } = requireRelyingParty(ctx);
  const credential = credentialOf(body.credential);
  const challenge = challengeOf(credential);
  const data = await redeemChallenge(store, challenge);
  if (!data || data.kind !== kind || data.binding !== str(body, "challenge_id")) {
    throw new WebAuthnError("challenge", "no ceremony for this response");
  }
  return { credential, userId: data.userId, challenge };
}

function refused(error: unknown): never {
  if (!(error instanceof WebAuthnError)) throw error;
  throw new GoTrueError(400, "validation_failed", `Passkey refused (${error.code})`);
}

/** `POST /passkeys/registration/options`. */
export async function registrationOptions(ctx: GoTrueContext): Promise<Response> {
  const { user } = await registrant(ctx);
  const { rp, store } = requireRelyingParty(ctx);
  const existing = await store.listPasskeys(user.id);
  const started = await begin(ctx, "register", user.id);
  return ok({
    challenge_id: started.challengeId,
    options: creationOptions(rp, user, existing, started.challenge),
    expires_at: started.expiresAt,
  });
}

/** `POST /passkeys/registration/verify`. */
export async function registrationVerify(ctx: GoTrueContext): Promise<Response> {
  const { user } = await registrant(ctx);
  const body = await readJson(ctx);
  const { rp, store } = requireRelyingParty(ctx);
  try {
    const { credential, userId, challenge } = await redeem(ctx, body, "register");
    if (userId !== user.id) throw new WebAuthnError("challenge", "another user's ceremony");
    const record = await verifyNewPasskey(
      rp,
      credential,
      challenge,
      user.id,
      labelOf(body.friendly_name),
    );
    if (!(await store.createPasskey(record))) {
      throw new GoTrueError(422, "validation_failed", "This passkey is already registered");
    }
    return ok({
      id: record.id,
      ...(record.name ? { friendly_name: record.name } : {}),
      created_at: iso(record.createdAt),
    });
  } catch (error) {
    if (error instanceof GoTrueError) throw error;
    return refused(error);
  }
}

/** `POST /passkeys/authentication/options` (no session: a discoverable credential). */
export async function authenticationOptions(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  await checkCaptcha(ctx, body);
  await spendIp(ctx, signinStartLimiter(ctx.config), "passkey");
  const { rp } = requireRelyingParty(ctx);
  const started = await begin(ctx, "signin");
  return ok({
    challenge_id: started.challengeId,
    options: requestOptions(rp, started.challenge, []),
    expires_at: started.expiresAt,
  });
}

/** `POST /passkeys/authentication/verify`: a session for the passkey's owner. */
export async function authenticationVerify(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  const { rp, store } = requireRelyingParty(ctx);
  let verified;
  try {
    const { credential, challenge } = await redeem(ctx, body, "signin");
    verified = await verifyPasskeyAssertion(rp, store, credential, challenge, undefined);
  } catch (error) {
    if (!(error instanceof WebAuthnError)) throw error;
    throw fail.credentials();
  }
  const user = await ctx.adapter.getUser(verified.record.userId);
  if (!user) throw fail.credentials();
  const session = await startSessionWithAal(ctx.session, user, {
    method: "webauthn",
    timestamp: nowSeconds(),
  }, verified.userVerified ? "aal2" : "aal1");
  return ok(session);
}

/** `GET /passkeys`. */
export async function listOwnPasskeys(ctx: GoTrueContext): Promise<Response> {
  const { user } = await requireUser(ctx);
  const { store } = requireRelyingParty(ctx);
  return ok((await store.listPasskeys(user.id)).map(listItem));
}

/** The caller's passkey `:id`, or a 404. */
async function ownPasskey(ctx: GoTrueContext, userId: string): Promise<PasskeyRecord> {
  const { store } = requireRelyingParty(ctx);
  const record = await store.getPasskey(ctx.params.id);
  if (!record || record.userId !== userId) {
    throw new GoTrueError(404, "not_found", "Passkey not found");
  }
  return record;
}

/** `PATCH /passkeys/:id`: rename. */
export async function updatePasskey(ctx: GoTrueContext): Promise<Response> {
  const { user } = await requireUser(ctx);
  const record = await ownPasskey(ctx, user.id);
  const body = await readJson(ctx);
  const name = labelOf(body.friendly_name);
  if (!name) throw fail.validation("friendly_name is required");
  const { store } = requireRelyingParty(ctx);
  const renamed = { ...record, name };
  await store.deletePasskey(record.id);
  await store.createPasskey(renamed);
  return ok(listItem(renamed));
}

/** `DELETE /passkeys/:id`: needs a recent sign-in (a stolen session must not strip it). */
export async function deleteOwnPasskey(ctx: GoTrueContext): Promise<Response> {
  const { user } = await registrant(ctx);
  const record = await ownPasskey(ctx, user.id);
  await requireRelyingParty(ctx).store.deletePasskey(record.id);
  await forgetPasskeyFactor(ctx.config, user.id, record.id);
  return new Response(null, { status: 204 });
}

/** `GET /admin/users/:id/passkeys`. */
export async function adminListPasskeys(ctx: GoTrueContext): Promise<Response> {
  const { store } = requireRelyingParty(ctx);
  return ok((await store.listPasskeys(ctx.params.id)).map(listItem));
}

/** `DELETE /admin/users/:id/passkeys/:passkey`. */
export async function adminDeletePasskey(ctx: GoTrueContext): Promise<Response> {
  const { store } = requireRelyingParty(ctx);
  const record = await store.getPasskey(ctx.params.passkey);
  if (!record || record.userId !== ctx.params.id) {
    throw new GoTrueError(404, "not_found", "Passkey not found");
  }
  await store.deletePasskey(record.id);
  await forgetPasskeyFactor(ctx.config, record.userId, record.id);
  return new Response(null, { status: 204 });
}
