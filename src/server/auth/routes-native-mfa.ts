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
 *
 * Both spend the presented token first (single-use) and re-check the user: one deleted, banned,
 * or whose address was first proven after the id_token sign-in, never finishes it. Code checks
 * draw on the `rateLimit.mfa` budget the web step-up uses; SMS sends on the verification-send one.
 *
 * @module
 */

import { emitAuthEvent } from "./events.ts";
import { openFactorChallenge, userFactors } from "./factors.ts";
import { hasMfaAdapter, pendingSessionLive, verifySecondFactor } from "./mfa.ts";
import { consumeNativeMfaToken, issueNativeMfaToken, type NativeMfaPending } from "./native-mfa.ts";
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

/** `POST {basePath}/native/mfa` — finish the pending sign-in with a second factor. */
async function handleVerify(ctx: AuthRouteContext): Promise<Response | null> {
  const caller = await mfaCaller(ctx);
  if (!caller || caller instanceof Response) return caller;
  const { native, pending, fields } = caller;
  const keys = subjectBucketKeys("mfa", pending.user.id, ctx.request, ctx.config);
  const retryAfter = await consumeHitBudget(mfaLimiter(ctx.config), keys);
  if (retryAfter !== null) return await rateLimited(ctx, caller, retryAfter);
  const result = await verifySecondFactor(ctx.config, {
    userId: pending.user.id,
    code: fields.code ?? "",
    ...(fields.factor_id ? { factorId: fields.factor_id } : {}),
    ...(fields.challenge_id ? { challengeId: fields.challenge_id } : {}),
  });
  if (!result.ok) {
    return result.error === "not_enrolled" ? invalidGrant() : await wrongCode(ctx, caller);
  }
  const snapshot = await snapshotFor(ctx.config, pending.user, pending.provider, [
    "ext",
    result.method,
  ]);
  const tokens = await startNativeSession(ctx.config, native, snapshot);
  await emitAuthEvent(ctx.options, "signIn", {
    user: pending.user,
    provider: pending.provider,
    isNewUser: pending.isNewUser,
  });
  return json(tokens, 200, NO_STORE);
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
];
