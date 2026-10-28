/**
 * Finishing a native `id_token` sign-in that owes a second factor (see `native-mfa.ts`):
 *
 * - `POST {basePath}/native/mfa` — `{ mfa_token, code[, factor_id, challenge_id] }`: a TOTP
 *   code, a backup code, or (with `factor_id` + `challenge_id`) an SMS code. Success answers
 *   the native tokens, exactly as an id_token sign-in without a factor does; a wrong code answers
 *   `401 { error: "invalid_code", mfa_token, attempts_left }` with a fresh token (the old one is
 *   spent), until the attempts run out (`400 { error: "invalid_grant" }`).
 * - `POST {basePath}/native/mfa-challenge` — `{ mfa_token, factor_id }`: send an SMS code to one
 *   of the user's verified phone factors; answers `{ challenge_id, expires_at, mfa_token }`.
 * - `POST {basePath}/native/mfa-enroll` — `{ mfa_token }` of a sign-in answered with
 *   `mfa_enroll: true` (`mfa.required: "always"`, a user with no factor yet): start a TOTP factor;
 *   answers `{ factor_id, secret, uri, mfa_token, expires_in }`.
 * - `POST {basePath}/native/mfa-confirm` — `{ mfa_token, code }`: confirm it and finish the
 *   sign-in; answers the native tokens plus `backup_codes` (once). The web flow's rules hold: only
 *   a first factor is enrolled this way (`409 already_enrolled` once one is verified), every code
 *   check spends the MFA budget, and a wrong code costs an attempt.
 *
 * Both spend the presented token first (single-use) and re-check the user: one deleted, banned,
 * or whose address was first proven after the id_token sign-in, never finishes it. Code checks
 * draw on the `rateLimit.mfa` budget the web step-up uses; SMS sends on the verification-send one.
 *
 * @module
 */

import { emitAuthEvent } from "./events.ts";
import { hasVerifiedFactor, openFactorChallenge, userFactors } from "./factors.ts";
import {
  confirmTotp,
  enrollTotp,
  hasMfaAdapter,
  pendingSessionLive,
  verifySecondFactor,
} from "./mfa.ts";
import {
  consumeNativeMfaToken,
  issueNativeMfaToken,
  nativeMfaExpiresIn,
  type NativeMfaPending,
} from "./native-mfa.ts";
import { type ResolvedNative, resolveNative, snapshotFor, startNativeSession } from "./native.ts";
import {
  authTrustsProxy,
  clientIpBucket,
  consumeHitBudget,
  mfaLimiter,
  subjectBucketKeys,
  verificationLimiter,
} from "./rate-limit.ts";
import {
  forbidden,
  invalidGrant,
  nativeOriginAllowed,
  nativeRow,
  readFields,
} from "./routes-native.ts";
import { type AuthRoute, type AuthRouteContext, json } from "./routes-shared.ts";
import { smsSenderOf } from "./sms.ts";
import type { AuthSession } from "./types.ts";

/** What both endpoints need before they look at the body's other fields. */
interface Caller {
  native: ResolvedNative;
  pending: NativeMfaPending;
  fields: Record<string, string>;
}

/** The headers every answer carrying a token gets. */
const NO_STORE = { pragma: "no-cache", "cache-control": "no-store" };

/**
 * The shared gate: native sign-in and the MFA store configured, an allowed origin, and a live
 * `mfa_token` (spent here) whose user may still finish signing in.
 */
async function mfaCaller(ctx: AuthRouteContext): Promise<Caller | Response | null> {
  const native = resolveNative(ctx.config);
  if (!native || !hasMfaAdapter(ctx.options)) return null;
  if (!nativeOriginAllowed(ctx)) return forbidden();
  const fields = await readFields(ctx);
  const pending = await consumeNativeMfaToken(native, fields.mfa_token ?? "");
  if (!pending) return invalidGrant();
  const live = await pendingSessionLive(ctx.config, {
    user: pending.user,
    provider: pending.provider,
    expiresAt: pending.expiresAt,
    authTime: pending.authTime,
  });
  return live ? { native, pending, fields } : invalidGrant();
}

/** Hand back a fresh token for the same pending sign-in (same expiry). */
function reissue(native: ResolvedNative, pending: NativeMfaPending): Promise<string> {
  return issueNativeMfaToken(native, pending);
}

/** Report a refused second-factor attempt (never alters the answer). */
function emitFailure(
  ctx: AuthRouteContext,
  pending: NativeMfaPending,
  reason: "invalid_mfa_code" | "rate_limited",
): Promise<void> {
  return emitAuthEvent(ctx.options, "signInFailed", {
    provider: pending.provider,
    reason,
    ip: clientIpBucket(ctx.request, { trustForwardedHeaders: authTrustsProxy(ctx.config) }),
  });
}

/** A 429 that keeps the sign-in alive (a fresh token; no attempt spent). */
async function rateLimited(
  ctx: AuthRouteContext,
  caller: Caller,
  retryAfter: number,
): Promise<Response> {
  await emitFailure(ctx, caller.pending, "rate_limited");
  return json(
    { error: "too_many_attempts", mfa_token: await reissue(caller.native, caller.pending) },
    429,
    { ...NO_STORE, "retry-after": String(retryAfter) },
  );
}

/** A wrong code: one attempt fewer, a fresh token — or, with none left, the end of it. */
async function wrongCode(ctx: AuthRouteContext, caller: Caller): Promise<Response> {
  await emitFailure(ctx, caller.pending, "invalid_mfa_code");
  const attemptsLeft = caller.pending.attemptsLeft - 1;
  if (attemptsLeft <= 0) return invalidGrant();
  const token = await reissue(caller.native, { ...caller.pending, attemptsLeft });
  return json(
    { error: "invalid_code", mfa_token: token, attempts_left: attemptsLeft },
    401,
    NO_STORE,
  );
}

/** Spend one unit of the user's MFA budget for a code check: a `429` once it is spent. */
async function spendCodeCheck(ctx: AuthRouteContext, caller: Caller): Promise<Response | null> {
  const keys = subjectBucketKeys("mfa", caller.pending.user.id, ctx.request, ctx.config);
  const retryAfter = await consumeHitBudget(mfaLimiter(ctx.config), keys);
  return retryAfter === null ? null : await rateLimited(ctx, caller, retryAfter);
}

/** The second factor passed: start the native session and fire `signIn`; the tokens. */
async function signInNative(ctx: AuthRouteContext, caller: Caller, method: string) {
  const { native, pending } = caller;
  const first = pending.amr ?? ["ext"];
  const snapshot = await snapshotFor(ctx.config, pending.user, pending.provider, [
    ...first,
    method,
  ]);
  const tokens = await startNativeSession(ctx.config, native, snapshot);
  await emitAuthEvent(ctx.options, "signIn", {
    user: pending.user,
    provider: pending.provider,
    isNewUser: pending.isNewUser,
  });
  return tokens;
}

/** `POST {basePath}/native/mfa` — finish the pending sign-in with a second factor. */
async function handleVerify(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await mfaCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const { pending, fields } = caller;
  const limited = await spendCodeCheck(ctx, caller);
  if (limited) return limited;
  const result = await verifySecondFactor(ctx.config, {
    userId: pending.user.id,
    code: fields.code ?? "",
    ...(fields.factor_id ? { factorId: fields.factor_id } : {}),
    ...(fields.challenge_id ? { challengeId: fields.challenge_id } : {}),
  });
  if (!result.ok) {
    return result.error === "not_enrolled" ? invalidGrant() : await wrongCode(ctx, caller);
  }
  return json(await signInNative(ctx, caller, result.method), 200, NO_STORE);
}

/** `POST {basePath}/native/mfa-challenge` — text an SMS code to a verified phone factor. */
async function handleChallenge(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await mfaCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const { native, pending, fields } = caller;
  const keys = subjectBucketKeys("verify", `mfa-sms:${pending.user.id}`, ctx.request, ctx.config);
  const retryAfter = await consumeHitBudget(verificationLimiter(ctx.config), keys);
  if (retryAfter !== null) return await rateLimited(ctx, caller, retryAfter);
  const send = smsSenderOf(ctx.config);
  const factor = (await userFactors(ctx.config, pending.user.id)).find((f) =>
    f.id === fields.factor_id && f.type === "phone" && f.status === "verified"
  );
  const token = await reissue(native, pending);
  if (!factor || !send) {
    return json({ error: "no_such_factor", mfa_token: token }, 404, NO_STORE);
  }
  const opened = await openFactorChallenge(ctx.config, factor);
  await send({
    phone: factor.phone!,
    otp: opened.code!,
    message: `Your code is ${opened.code}`,
    channel: "sms",
    type: "mfa",
  });
  return json(
    { challenge_id: opened.id, expires_at: opened.expiresAt, mfa_token: token },
    200,
    NO_STORE,
  );
}

/**
 * The shared gate of the enrollment endpoints: a live `mfa_token` (spent) issued to finish a
 * sign-in by enrolling, for a user who still has no verified factor, while every user must have
 * one. Anything else ends the pending sign-in (`invalid_grant`), or — when a factor appeared
 * meanwhile — answers `409 already_enrolled`: a first factor alone never adds a factor next to a
 * verified one (the web rule), and the sign-in starts over to be finished with that factor.
 */
async function enrollCaller(ctx: AuthRouteContext): Promise<Caller | Response | null> {
  const caller = await mfaCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  if (!caller.pending.enroll || ctx.options.mfa.required !== "always") return invalidGrant();
  if (await hasVerifiedFactor(ctx.config, caller.pending.user.id)) {
    return json({ error: "already_enrolled" }, 409, NO_STORE);
  }
  return caller;
}

/** The pending sign-in as the session shape the web enrollment takes (pending, so it may enrol). */
function pendingSession(pending: NativeMfaPending): AuthSession {
  return {
    user: pending.user,
    provider: pending.provider,
    expiresAt: pending.expiresAt,
    authTime: pending.authTime,
    mfaPending: true,
    amr: pending.amr ?? ["ext"],
  };
}

/**
 * `POST {basePath}/native/mfa-enroll` — `{ mfa_token }`: start the first factor of a pending
 * sign-in that owes one. Answers `{ factor_id, secret, uri, mfa_token, expires_in }` (render the
 * URI as a QR code, or offer the secret); the fresh token confirms it.
 */
async function handleEnroll(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await enrollCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const result = await enrollTotp(ctx.config, pendingSession(caller.pending));
  if (!result.ok) return json({ error: "already_enrolled" }, 409, NO_STORE);
  return json(
    {
      factor_id: result.factorId,
      secret: result.secret,
      uri: result.uri,
      mfa_token: await reissue(caller.native, caller.pending),
      expires_in: nativeMfaExpiresIn(caller.pending),
    },
    200,
    NO_STORE,
  );
}

/**
 * `POST {basePath}/native/mfa-confirm` — `{ mfa_token, code }`: confirm the enrolled factor with
 * a code from it and finish the sign-in: the native tokens, plus `backup_codes` (shown once).
 * Every attempt spends the per-user MFA budget; a wrong code costs one attempt (a fresh token
 * back, as at `/native/mfa`).
 */
async function handleConfirm(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await enrollCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const { native, pending, fields } = caller;
  const limited = await spendCodeCheck(ctx, caller);
  if (limited) return limited;
  const result = await confirmTotp(ctx.config, { user: pending.user, code: fields.code ?? "" });
  if (!result.ok) {
    if (result.error === "invalid_code") return await wrongCode(ctx, caller);
    return json(
      { error: "not_pending", mfa_token: await reissue(native, pending) },
      400,
      NO_STORE,
    );
  }
  const tokens = await signInNative(ctx, caller, "totp");
  return json({ ...tokens, backup_codes: result.backupCodes }, 200, NO_STORE);
}

/** The rows, relative to `basePath` — listed before `/native/:provider`. */
export const nativeMfaRoutes: AuthRoute[] = [
  {
    method: "POST",
    pattern: "/native/mfa",
    handler: nativeRow("finishing a native sign-in's second factor", handleVerify),
    limit: "signin-start",
  },
  {
    method: "POST",
    pattern: "/native/mfa-challenge",
    handler: nativeRow("a native sign-in's SMS challenge", handleChallenge),
    limit: "signin-start",
  },
  {
    method: "POST",
    pattern: "/native/mfa-enroll",
    handler: nativeRow("enrolling a native sign-in's first factor", handleEnroll),
    limit: "signin-start",
  },
  {
    method: "POST",
    pattern: "/native/mfa-confirm",
    handler: nativeRow("confirming a native sign-in's first factor", handleConfirm),
    limit: "signin-start",
  },
];
