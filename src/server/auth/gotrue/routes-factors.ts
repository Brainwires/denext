/**
 * MFA factors (`supabase.auth.mfa.*`) over the factor store denext's own sign-in shares: enroll
 * a TOTP authenticator, a phone or a WebAuthn authenticator, challenge it, verify — which steps
 * the session up to `aal2` — and unenroll; and the backup codes as recovery codes
 * (`mfa.recoveryCodes.*`). A challenge is single-use and lives five minutes; codes are
 * rate-limited per user; a TOTP step is never accepted twice; a WebAuthn ceremony is verified by
 * denext's WebAuthn code against the configured relying party (never one the client names).
 *
 * @module
 */

import type { AdapterUser, MfaFactorRecord } from "../adapter.ts";
import { backupCodeMatcher, generateBackupCodes, isBackupCodeShaped } from "../backup-codes.ts";
import {
  markFactorVerified,
  openFactorChallenge,
  phoneCodeMatches,
  redeemFactorChallenge,
  totpFactorAccepts,
  userFactors,
} from "../factors.ts";
import { resolveAuthOptions } from "../options.ts";
import { mfaLimiter, verificationLimiter } from "../rate-limit.ts";
import { generateTotpSecret, totpAuthUri, totpQrSvg } from "../totp.ts";
import { authSecrets, sealTotpSecret } from "../totp-seal.ts";
import {
  type CallerUser,
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
import { factorAdapterOf, recoveryFactorId } from "./factors.ts";
import { canSendSms, sendAuthSms } from "./otp.ts";
import { stepUpSession } from "./session.ts";
import {
  completeWebauthnFactor,
  requireRelyingParty,
  webauthnChallengeOptions,
} from "./webauthn-factors.ts";

function store(ctx: GoTrueContext) {
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
  const factor = (await userFactors(ctx.config, userId)).find((f) => f.id === ctx.params.id);
  if (!factor) throw new GoTrueError(404, "mfa_factor_not_found", "Factor not found");
  return factor;
}

/** Refuse a new enrollment over the factor cap or with a taken friendly name. */
async function checkRoom(
  ctx: GoTrueContext,
  existing: MfaFactorRecord[],
  friendlyName: string | undefined,
): Promise<void> {
  // Unverified factors are disposable: a day-old one goes before a new enrollment.
  const day = nowSeconds() - 86_400;
  for (const stale of existing.filter((f) => f.status === "unverified" && f.createdAt < day)) {
    await store(ctx).deleteMfaFactor(stale.id);
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
}

/**
 * Once a user holds a verified factor, adding (or first verifying) another needs an `aal2`
 * session — else a password alone could enroll a factor of its own and step up with it.
 */
function requireAalWithFactor(
  caller: CallerUser,
  factors: MfaFactorRecord[],
  what: string,
): void {
  if (caller.claims.aal !== "aal2" && factors.some((f) => f.status === "verified")) {
    throw new GoTrueError(403, "insufficient_aal", `AAL2 required to ${what}`);
  }
}

/** `POST /factors`: enroll a TOTP, phone or WebAuthn factor. */
export async function enroll(ctx: GoTrueContext): Promise<Response> {
  const caller = await requireUser(ctx);
  const { user } = caller;
  const body = await readJson(ctx);
  const type = str(body, "factor_type") ?? "totp";
  const friendlyName = str(body, "friendly_name");
  const existing = await userFactors(ctx.config, user.id);
  requireAalWithFactor(caller, existing, "enroll a new factor");
  await checkRoom(ctx, existing, friendlyName);
  if (type === "totp") return ok(await enrollTotp(ctx, user, friendlyName, str(body, "issuer")));
  if (type === "phone") {
    return ok(await enrollPhone(ctx, user.id, existing, friendlyName, str(body, "phone")));
  }
  if (type === "webauthn") return ok(await enrollWebauthn(ctx, user.id, friendlyName));
  throw new GoTrueError(
    422,
    "validation_failed",
    "factor_type needs to be totp, phone or webauthn",
  );
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
  await store(ctx).createMfaFactor({
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
  await store(ctx).createMfaFactor({
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

async function enrollWebauthn(
  ctx: GoTrueContext,
  userId: string,
  friendlyName: string | undefined,
): Promise<Record<string, unknown>> {
  requireRelyingParty(ctx);
  const at = nowSeconds();
  const id = crypto.randomUUID();
  await store(ctx).createMfaFactor({
    id,
    userId,
    type: "webauthn",
    status: "unverified",
    ...(friendlyName ? { friendlyName } : {}),
    createdAt: at,
    updatedAt: at,
  });
  return { id, type: "webauthn", ...(friendlyName ? { friendly_name: friendlyName } : {}) };
}

/** `POST /factors/:id/challenge`. */
export async function challenge(ctx: GoTrueContext): Promise<Response> {
  const { user } = await requireUser(ctx);
  const factor = await ownFactor(ctx, user.id);
  const body = await readJson(ctx);
  if (factor.type === "webauthn") {
    const ceremony = await webauthnChallengeOptions(ctx, user, factor, body);
    const opened = await openFactorChallenge(ctx.config, factor, ceremony.extra);
    return ok({
      id: opened.id,
      type: "webauthn",
      expires_at: opened.expiresAt,
      webauthn: ceremony.json,
    });
  }
  if (factor.type === "phone") {
    await spend(
      ctx,
      verificationLimiter(ctx.config),
      "verify",
      `mfa-sms:${factor.id}`,
      "over_sms_send_rate_limit",
    );
  }
  const opened = await openFactorChallenge(ctx.config, factor);
  if (opened.code) {
    await sendAuthSms(ctx, {
      phone: factor.phone!,
      otp: opened.code,
      type: "mfa",
      channel: str(body, "channel") === "whatsapp" ? "whatsapp" : "sms",
      user,
    });
  }
  return ok({ id: opened.id, type: factor.type, expires_at: opened.expiresAt });
}

/** Whether the proof answers the challenge: a TOTP code, an SMS code or a WebAuthn response. */
async function proofAccepted(
  ctx: GoTrueContext,
  user: AdapterUser,
  factor: MfaFactorRecord,
  body: Record<string, unknown>,
): Promise<boolean> {
  const challengeId = str(body, "challenge_id") ?? "";
  const redeemed = await redeemFactorChallenge(ctx.config, challengeId, factor);
  if (!redeemed) {
    throw new GoTrueError(
      422,
      "mfa_challenge_expired",
      "Challenge and verify IP addresses mismatch or challenge expired",
    );
  }
  if (redeemed.expired) {
    throw new GoTrueError(
      422,
      "mfa_challenge_expired",
      "MFA challenge has expired, verify against another challenge or create a new challenge.",
    );
  }
  const code = str(body, "code") ?? "";
  if (factor.type === "totp") {
    const window = resolveAuthOptions(ctx.config).mfa.window;
    return await totpFactorAccepts(ctx.config, factor, code, window);
  }
  if (factor.type === "phone") return await phoneCodeMatches(challengeId, code, redeemed.codeHash);
  return await completeWebauthnFactor(ctx, user, factor, body, redeemed.extra);
}

const METHODS: Record<MfaFactorRecord["type"], string> = {
  totp: "totp",
  phone: "mfa/phone",
  webauthn: "webauthn",
};

/** `POST /factors/:id/verify`: answer a challenge; the session becomes `aal2`. */
export async function verify(ctx: GoTrueContext): Promise<Response> {
  const caller = await requireUser(ctx);
  const factor = await ownFactor(ctx, caller.user.id);
  if (factor.status === "unverified") {
    requireAalWithFactor(
      caller,
      await userFactors(ctx.config, caller.user.id),
      "verify a new factor",
    );
  }
  const body = await readJson(ctx);
  const attempt = await spend(ctx, mfaLimiter(ctx.config), "mfa", `factor:${caller.user.id}`);
  if (!(await proofAccepted(ctx, caller.user, factor, body))) {
    throw new GoTrueError(422, "mfa_verification_failed", "Invalid MFA code entered");
  }
  await attempt.settle();
  await markFactorVerified(ctx.config, factor);
  return ok(await stepUp(ctx, caller, METHODS[factor.type]));
}

async function stepUp(ctx: GoTrueContext, caller: CallerUser, method: string) {
  if (!caller.sessionId) throw new GoTrueError(401, "session_not_found", "Session not found");
  return await stepUpSession(ctx.session, caller.user, caller.sessionId, {
    method,
    timestamp: nowSeconds(),
  });
}

/** `DELETE /factors/:id`: a verified factor needs an `aal2` session to remove. */
export async function unenroll(ctx: GoTrueContext): Promise<Response> {
  const caller = await requireUser(ctx);
  const factor = await ownFactor(ctx, caller.user.id);
  if (factor.status === "verified" && caller.claims.aal !== "aal2") {
    throw new GoTrueError(403, "insufficient_aal", "AAL2 required to unenroll verified factor");
  }
  await store(ctx).deleteMfaFactor(factor.id);
  if (factor.type === "webauthn" && factor.secret) await ctx.adapter.deletePasskey?.(factor.secret);
  return ok({ id: factor.id });
}

// ── recovery codes (denext's backup codes) ───────────────────────────────────

/** The caller and their stored backup codes. */
async function recoveryState(ctx: GoTrueContext) {
  const caller = await requireUser(ctx);
  const record = await ctx.adapter.getMfa?.(caller.user.id);
  return { caller, record, id: await recoveryFactorId(caller.user.id) };
}

/** A change to the codes needs `aal2` once the user holds a verified factor. */
async function requireAalForCodes(ctx: GoTrueContext, caller: CallerUser): Promise<void> {
  const factors = await userFactors(ctx.config, caller.user.id);
  if (factors.some((f) => f.status === "verified") && caller.claims.aal !== "aal2") {
    throw new GoTrueError(403, "insufficient_aal", "AAL2 required to manage recovery codes");
  }
}

/** `GET /factors/recovery-codes`. */
export async function recoveryStatus(ctx: GoTrueContext): Promise<Response> {
  const { record, id } = await recoveryState(ctx);
  if (!record || record.backupCodeHashes.length === 0) {
    throw new GoTrueError(404, "mfa_factor_not_found", "Recovery codes not found");
  }
  const total = Math.max(
    resolveAuthOptions(ctx.config).mfa.backupCodes,
    record.backupCodeHashes.length,
  );
  return ok({ id, type: "recovery_code", total, remaining: record.backupCodeHashes.length });
}

async function mintCodes(ctx: GoTrueContext, userId: string, friendlyName?: string) {
  const options = resolveAuthOptions(ctx.config);
  const { codes, hashes } = await generateBackupCodes(options.hasher, options.mfa.backupCodes);
  const record = await ctx.adapter.getMfa?.(userId);
  await ctx.adapter.setMfa?.({
    ...(record ?? { userId }),
    secret: "",
    confirmedAt: nowSeconds(),
    backupCodeHashes: hashes,
  });
  return ok({
    id: await recoveryFactorId(userId),
    type: "recovery_code",
    friendly_name: friendlyName ?? "Recovery codes",
    total: codes.length,
    codes,
  });
}

/** `POST /factors/recovery-codes`: mint codes (refused while a set exists). */
export async function recoveryGenerate(ctx: GoTrueContext): Promise<Response> {
  const { caller, record } = await recoveryState(ctx);
  await requireAalForCodes(ctx, caller);
  if (record && record.backupCodeHashes.length > 0) {
    throw new GoTrueError(
      422,
      "validation_failed",
      "Recovery codes already exist; regenerate them instead",
    );
  }
  const body = await readJson(ctx);
  return await mintCodes(ctx, caller.user.id, str(body, "friendly_name"));
}

/** `POST /factors/recovery-codes/regenerate`: a new set replaces the old one. */
export async function recoveryRegenerate(ctx: GoTrueContext): Promise<Response> {
  const { caller } = await recoveryState(ctx);
  await requireAalForCodes(ctx, caller);
  return await mintCodes(ctx, caller.user.id);
}

/** `DELETE /factors/recovery-codes`. */
export async function recoveryRemove(ctx: GoTrueContext): Promise<Response> {
  const { caller, record, id } = await recoveryState(ctx);
  await requireAalForCodes(ctx, caller);
  if (record) await ctx.adapter.setMfa?.({ ...record, backupCodeHashes: [] });
  return ok({ id });
}

/** `POST /factors/recovery-codes/verify`: spend one code; the session becomes `aal2`. */
export async function recoveryVerify(ctx: GoTrueContext): Promise<Response> {
  const caller = await requireUser(ctx);
  const body = await readJson(ctx);
  const code = str(body, "code") ?? "";
  const attempt = await spend(ctx, mfaLimiter(ctx.config), "mfa", `factor:${caller.user.id}`);
  const options = resolveAuthOptions(ctx.config);
  const spent = isBackupCodeShaped(code) && !!ctx.adapter.consumeBackupCode &&
    await ctx.adapter.consumeBackupCode(caller.user.id, backupCodeMatcher(options.hasher, code));
  if (!spent) throw new GoTrueError(422, "mfa_verification_failed", "Invalid recovery code");
  await attempt.settle();
  return ok(await stepUp(ctx, caller, "recovery_code"));
}
