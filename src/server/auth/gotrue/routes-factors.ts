/**
 * MFA factors (`supabase.auth.mfa.*`): enroll a TOTP authenticator or a phone, challenge it,
 * verify a code — which steps the session up to `aal2` — and unenroll. Factor secrets are
 * sealed under the auth `secret` (as denext's own TOTP is); a challenge is single-use and
 * lives five minutes; codes are rate-limited per user, and a TOTP step is never accepted twice.
 *
 * @module
 */

import type { AdapterUser, MfaFactorRecord } from "../adapter.ts";
import { constantTimeEqualHex, sha256Hex } from "../hash.ts";
import { nativeAdapterOf } from "../native.ts";
import { mfaLimiter, verificationLimiter } from "../rate-limit.ts";
import { generateTotpSecret, totpAuthUri, totpQrSvg, verifyTotp } from "../totp.ts";
import { authSecrets, openTotpSecret, sealTotpSecret } from "../totp-seal.ts";
import {
  type GoTrueContext,
  normalizePhone,
  nowSeconds,
  ok,
  readJson,
  requireUser,
  spend,
  str,
} from "./context.ts";
import { GoTrueError } from "./errors.ts";
import { type FactorAdapter, factorAdapterOf } from "./factors.ts";
import { canSendSms, sendAuthSms } from "./otp.ts";
import { stepUpSession } from "./session.ts";

/** How long a challenge stays answerable, seconds. */
const CHALLENGE_TTL = 300;

function factors(ctx: GoTrueContext): FactorAdapter {
  const adapter = factorAdapterOf(ctx.config);
  if (!adapter) {
    throw new GoTrueError(500, "unexpected_failure", "the auth adapter keeps no MFA factors");
  }
  return adapter;
}

function maxFactors(ctx: GoTrueContext): number {
  return Math.min(50, Math.max(1, ctx.options.mfa?.maxFactors ?? 10));
}

async function ownFactor(ctx: GoTrueContext, userId: string): Promise<MfaFactorRecord> {
  const factor = (await factors(ctx).listMfaFactors(userId)).find((f) => f.id === ctx.params.id);
  if (!factor) throw new GoTrueError(404, "mfa_factor_not_found", "Factor not found");
  return factor;
}

/** `POST /factors`: enroll a TOTP or phone factor. */
export async function enroll(ctx: GoTrueContext): Promise<Response> {
  const { user } = await requireUser(ctx);
  const body = await readJson(ctx);
  const type = str(body, "factor_type") ?? "totp";
  const friendlyName = str(body, "friendly_name");
  const store = factors(ctx);
  const existing = await store.listMfaFactors(user.id);
  // Unverified factors are disposable: a new enrollment clears the stale ones first.
  for (
    const stale of existing.filter((f) =>
      f.status === "unverified" && f.createdAt < nowSeconds() - 86_400
    )
  ) {
    await store.deleteMfaFactor(stale.id);
  }
  if (existing.length >= maxFactors(ctx)) {
    throw new GoTrueError(422, "validation_failed", "Maximum number of enrolled factors reached");
  }
  if (friendlyName && existing.some((f) => f.friendlyName === friendlyName)) {
    throw new GoTrueError(
      422,
      "validation_failed",
      `A factor with the friendly name "${friendlyName}" for this user already exists`,
    );
  }
  if (type === "totp") return ok(await enrollTotp(ctx, user, friendlyName, str(body, "issuer")));
  if (type === "phone") {
    return ok(await enrollPhone(ctx, user.id, existing, friendlyName, str(body, "phone")));
  }
  throw new GoTrueError(422, "validation_failed", "factor_type needs to be totp or phone");
}

async function enrollTotp(
  ctx: GoTrueContext,
  user: AdapterUser,
  friendlyName: string | undefined,
  issuerName: string | undefined,
): Promise<Record<string, unknown>> {
  const at = nowSeconds();
  const id = crypto.randomUUID();
  const secret = generateTotpSecret();
  const issuer = issuerName ?? new URL(ctx.siteUrl).host;
  const uri = totpAuthUri({ secret, issuer, account: user.email ?? user.phone ?? user.id });
  await factors(ctx).createMfaFactor({
    id,
    userId: user.id,
    type: "totp",
    status: "unverified",
    ...(friendlyName ? { friendlyName } : {}),
    secret: await sealTotpSecret(authSecrets(ctx.config.secret), `${user.id}:${id}`, secret),
    createdAt: at,
    updatedAt: at,
  });
  return {
    id,
    type: "totp",
    ...(friendlyName ? { friendly_name: friendlyName } : {}),
    totp: { qr_code: totpQrSvg(uri), secret, uri },
  };
}

async function enrollPhone(
  ctx: GoTrueContext,
  userId: string,
  existing: MfaFactorRecord[],
  friendlyName: string | undefined,
  rawPhone: string | undefined,
): Promise<Record<string, unknown>> {
  if (!ctx.options.mfa?.phone || !canSendSms(ctx)) {
    throw new GoTrueError(422, "mfa_phone_enroll_not_enabled", "MFA enroll is disabled for Phone");
  }
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw new GoTrueError(422, "validation_failed", "Phone number required to enroll Phone factor");
  }
  if (existing.some((f) => f.type === "phone" && f.phone === phone)) {
    throw new GoTrueError(
      422,
      "validation_failed",
      "A Phone factor with this number already exists",
    );
  }
  const at = nowSeconds();
  const id = crypto.randomUUID();
  await factors(ctx).createMfaFactor({
    id,
    userId,
    type: "phone",
    status: "unverified",
    ...(friendlyName ? { friendlyName } : {}),
    phone,
    createdAt: at,
    updatedAt: at,
  });
  return { id, type: "phone", ...(friendlyName ? { friendly_name: friendlyName } : {}), phone };
}

function challengeHash(id: string): Promise<string> {
  return sha256Hex(`gotrue-challenge:${id}`);
}

function randomCode(): string {
  let out = "";
  const buf = new Uint8Array(1);
  while (out.length < 6) {
    crypto.getRandomValues(buf);
    if (buf[0] < 250) out += String(buf[0] % 10);
  }
  return out;
}

/** `POST /factors/:id/challenge`. */
export async function challenge(ctx: GoTrueContext): Promise<Response> {
  const { user } = await requireUser(ctx);
  const factor = await ownFactor(ctx, user.id);
  const grants = nativeAdapterOf(ctx.adapter);
  if (!grants) throw new GoTrueError(500, "unexpected_failure", "the auth adapter keeps no grants");
  const id = crypto.randomUUID();
  const expiresAt = nowSeconds() + CHALLENGE_TTL;
  let codeHash: string | undefined;
  if (factor.type === "phone") {
    await spend(
      ctx,
      verificationLimiter(ctx.config),
      "verify",
      `mfa-sms:${factor.id}`,
      "over_sms_send_rate_limit",
    );
    const code = randomCode();
    codeHash = await sha256Hex(`${id}:${code}`);
    const body = await readJson(ctx);
    await sendAuthSms(ctx, {
      phone: factor.phone!,
      otp: code,
      type: "mfa",
      channel: str(body, "channel") === "whatsapp" ? "whatsapp" : "sms",
      user,
    });
  }
  await grants.createNativeGrant({
    hash: await challengeHash(id),
    kind: "nonce",
    expiresAt,
    data: JSON.stringify({ gotrue: 1, factorId: factor.id, userId: user.id, codeHash }),
  });
  await factors(ctx).updateMfaFactor(factor.id, { lastChallengedAt: nowSeconds() });
  return ok({ id, type: factor.type, expires_at: expiresAt });
}

/** `POST /factors/:id/verify`: answer a challenge; the session becomes `aal2`. */
export async function verify(ctx: GoTrueContext): Promise<Response> {
  const caller = await requireUser(ctx);
  const { user } = caller;
  const factor = await ownFactor(ctx, user.id);
  const body = await readJson(ctx);
  const challengeId = str(body, "challenge_id") ?? "";
  const code = str(body, "code") ?? "";
  const attempt = await spend(ctx, mfaLimiter(ctx.config), "mfa", `factor:${user.id}`);
  const challenge = await takeChallenge(ctx, challengeId, factor.id, user.id);
  const valid = factor.type === "totp"
    ? await totpMatches(ctx, user.id, factor, code)
    : !!challenge.codeHash && /^[0-9]{6}$/.test(code) &&
      constantTimeEqualHex(await sha256Hex(`${challengeId}:${code}`), challenge.codeHash);
  if (!valid) throw new GoTrueError(422, "mfa_verification_failed", "Invalid TOTP code entered");
  await attempt.settle();
  if (factor.status !== "verified") {
    await factors(ctx).updateMfaFactor(factor.id, { status: "verified", updatedAt: nowSeconds() });
  }
  if (!caller.sessionId) throw new GoTrueError(401, "session_not_found", "Session not found");
  const session = await stepUpSession(ctx.session, user, caller.sessionId, {
    method: factor.type === "totp" ? "totp" : "mfa/phone",
    timestamp: nowSeconds(),
  });
  return ok(session);
}

/** Redeem a challenge (single-use) for this factor and user, or refuse. */
async function takeChallenge(
  ctx: GoTrueContext,
  challengeId: string,
  factorId: string,
  userId: string,
): Promise<{ codeHash?: string }> {
  const grants = nativeAdapterOf(ctx.adapter)!;
  const record = challengeId
    ? await grants.useNativeGrant(await challengeHash(challengeId), "nonce")
    : undefined;
  let data: { gotrue?: number; factorId?: string; userId?: string; codeHash?: string } = {};
  try {
    data = record?.data ? JSON.parse(record.data) : {};
  } catch { /* refused below */ }
  if (!record || data.gotrue !== 1 || data.factorId !== factorId || data.userId !== userId) {
    throw new GoTrueError(
      422,
      "mfa_challenge_expired",
      "Challenge and verify IP addresses mismatch or challenge expired",
    );
  }
  if (record.expiresAt <= nowSeconds()) {
    throw new GoTrueError(
      422,
      "mfa_challenge_expired",
      "MFA challenge has expired, verify against another challenge or create a new challenge.",
    );
  }
  return data;
}

/** A TOTP code for this factor, accepted at most once per step. */
async function totpMatches(
  ctx: GoTrueContext,
  userId: string,
  factor: MfaFactorRecord,
  code: string,
): Promise<boolean> {
  const opened = await openTotpSecret(
    authSecrets(ctx.config.secret),
    `${userId}:${factor.id}`,
    factor.secret ?? "",
  );
  if (!opened.ok) return false;
  const result = await verifyTotp(opened.secret, code, { window: 1 });
  return result.ok && await factors(ctx).claimMfaFactorStep(factor.id, result.step);
}

/** `DELETE /factors/:id`: a verified factor needs an `aal2` session to remove. */
export async function unenroll(ctx: GoTrueContext): Promise<Response> {
  const caller = await requireUser(ctx);
  const factor = await ownFactor(ctx, caller.user.id);
  if (factor.status === "verified" && caller.claims.aal !== "aal2") {
    throw new GoTrueError(403, "insufficient_aal", "AAL2 required to unenroll verified factor");
  }
  await factors(ctx).deleteMfaFactor(factor.id);
  return ok({ id: factor.id });
}
