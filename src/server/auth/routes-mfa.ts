/**
 * The second-factor (TOTP) endpoints:
 *
 * - `POST {basePath}/mfa` — `{ code, callbackUrl? }`: finish a pending sign-in with a
 *   TOTP code or a backup code. Needs a **pending** session. Success mints a fresh
 *   complete session (the pending one is discarded, never upgraded) and answers
 *   `{ ok: true, user }` or a `303` to `afterSignIn(callbackUrl)`; a wrong code is a
 *   generic `401` — or, for a plain form post, a `303` back to `pages.mfa` with
 *   `?error=CredentialsSignin`.
 * - `POST {basePath}/mfa/enroll` — start a TOTP enrollment: `{ secret, uri }` (render the
 *   URI as a QR code). `409` when a confirmed factor already exists. A complete session must
 *   have signed in within `mfa.freshness` (at least five minutes; `authTime`), else
 *   `403 { error: "reauth_required" }`.
 * - `POST {basePath}/mfa/confirm` — `{ code }`: confirm the enrollment and receive the
 *   backup codes, once: `{ ok: true, backupCodes }`. Confirming from a pending session
 *   (enrollment during the step-up, under `mfa.required: "always"`) also completes the
 *   step-up, and the answer carries the new session's `user`.
 * - `POST {basePath}/mfa/disable` — `{ code? }`: remove the factor. Needs a complete
 *   session AND a fresh second factor — a `code` that verifies now, or a session whose
 *   own step-up (`amr` `totp`/`bcp`) is at most `mfa.freshness` seconds old. `403`
 *   otherwise.
 *
 * `enroll` and `confirm` may be called from a complete session, or from a pending one
 * only when `mfa.required` is `"always"` (a user with no factor must enrol to finish
 * signing in). `enroll`, `confirm` and `disable` answer JSON only: what they return (a
 * secret, backup codes) is for the app's page to render, never a redirect's URL.
 *
 * Every endpoint is same-origin gated, reads the **cookie** session only (the
 * `Authorization` header is never read, so a bearer token can't step up, enrol or
 * disable), and reads its body through the shared size/stall cap. Every code check —
 * `/mfa`, `/mfa/confirm`, `/mfa/disable` with a `code` — spends one unit of the per-user
 * MFA budget (`rateLimit.mfa`, 5 per 5 minutes, plus an IP-wide bucket at 10×): EVERY
 * attempt counts, not only failures, so a correct guess can't reset the counter. Without
 * an adapter implementing the MFA group the endpoints don't exist (a plain 404).
 *
 * @module
 */

import { readCappedBody, STALLED, TOO_LARGE } from "../body.ts";
import { emitAuthEvent } from "./events.ts";
import {
  completeStepUp,
  confirmTotp,
  disableTotp,
  enrollTotp,
  hasFreshFactor,
  hasMfaAdapter,
  verifySecondFactor,
} from "./mfa.ts";
import {
  authTrustsProxy,
  clientIpBucket,
  consumeHitBudget,
  mfaLimiter,
  subjectBucketKeys,
} from "./rate-limit.ts";
import {
  afterSignIn,
  type AuthRoute,
  type AuthRouteContext,
  contained,
  isSameOrigin,
  json,
  redirect,
  wantsJson,
} from "./routes-shared.ts";
import { readAuthSession } from "./session.ts";
import { mfaStepLocation } from "./sign-in-tail.ts";
import type { AuthSession } from "./types.ts";

/** The most an MFA body may carry (a code and a return path). */
const MAX_BODY_BYTES = 4 * 1024;

/** The fields an MFA endpoint reads. */
interface MfaFields {
  /** The TOTP or backup code; `""` when absent. */
  code: string;
  /** The requested return target (`/mfa` only). */
  callbackUrl?: string;
}

/** A parsed body as a plain object; anything unusable is `{}`. */
function bodyObject(text: string, isJson: boolean): Record<string, unknown> {
  if (!isJson) return Object.fromEntries(new URLSearchParams(text));
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * The body's `code` and `callbackUrl` — JSON or a plain urlencoded form — read through
 * the shared cap. Only string values count; an oversized, stalled, aborted or malformed
 * body reads as no code at all, which every endpoint then refuses like a wrong one.
 */
async function readMfaFields(ctx: AuthRouteContext): Promise<MfaFields> {
  let bytes: Awaited<ReturnType<typeof readCappedBody>>;
  try {
    bytes = await readCappedBody(ctx.request, MAX_BODY_BYTES);
  } catch {
    return { code: "" };
  }
  if (bytes === TOO_LARGE || bytes === STALLED) return { code: "" };
  const isJson = (ctx.request.headers.get("content-type") ?? "").includes("application/json");
  const body = bodyObject(new TextDecoder().decode(bytes), isJson);
  return {
    code: typeof body.code === "string" ? body.code : "",
    callbackUrl: typeof body.callbackUrl === "string" ? body.callbackUrl : undefined,
  };
}

/**
 * The gate every MFA endpoint shares: the feature must be configured, the request
 * same-origin, and the caller must hold a cookie session of the kind `accepts` allows.
 *
 * @param ctx The route context.
 * @param accepts Whether this endpoint serves the session (pending vs complete).
 * @returns The session when everything passes, otherwise the answer to send — `null`
 * meaning "this endpoint doesn't exist here", so the dispatcher falls through.
 */
async function mfaCaller(
  ctx: AuthRouteContext,
  accepts: (session: AuthSession) => boolean,
): Promise<AuthSession | Response | null> {
  if (!hasMfaAdapter(ctx.options)) return null;
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  const session = await readAuthSession(ctx.config);
  if (!session) return json({ error: "unauthorized" }, 401);
  return accepts(session) ? session : json({ error: "forbidden" }, 403);
}

/** Enrollment is for a complete session — or a pending one when every user must enrol. */
function mayEnrol(ctx: AuthRouteContext): (session: AuthSession) => boolean {
  return (session) => !session.mfaPending || ctx.options.mfa.required === "always";
}

/** Report a refused second-factor attempt (never alters the answer). */
function emitMfaFailure(
  ctx: AuthRouteContext,
  session: AuthSession,
  reason: "invalid_mfa_code" | "rate_limited",
): Promise<void> {
  return emitAuthEvent(ctx.options, "signInFailed", {
    provider: session.provider,
    reason,
    ip: clientIpBucket(ctx.request, { trustForwardedHeaders: authTrustsProxy(ctx.config) }),
  });
}

/**
 * Spend one unit of the user's MFA budget (and the client IP's) for a code check.
 *
 * @param ctx The route context.
 * @param session The caller's session (its user is the budget's subject).
 * @returns A `429` once the budget is spent, else `null` (go ahead).
 */
async function spendAttempt(ctx: AuthRouteContext, session: AuthSession): Promise<Response | null> {
  const keys = subjectBucketKeys("mfa", session.user.id, ctx.request, ctx.config);
  const retryAfter = await consumeHitBudget(mfaLimiter(ctx.config), keys);
  if (retryAfter === null) return null;
  await emitMfaFailure(ctx, session, "rate_limited");
  return json({ error: "too many attempts" }, 429, { "retry-after": String(retryAfter) });
}

/** The shared answer to a wrong code. */
function invalidCode(): Response {
  return json({ error: "invalid code" }, 401);
}

/** `POST {basePath}/mfa` — finish a pending sign-in with a TOTP or backup code. */
async function handleStepUp(ctx: AuthRouteContext): Promise<Response | null> {
  const session = await mfaCaller(ctx, (s) => s.mfaPending === true);
  if (!session || session instanceof Response) return session;
  const limited = await spendAttempt(ctx, session);
  if (limited) return limited;
  const { code, callbackUrl } = await readMfaFields(ctx);
  const result = await verifySecondFactor(ctx.config, { userId: session.user.id, code });
  const asJson = wantsJson(ctx.request);
  if (!result.ok) {
    await emitMfaFailure(ctx, session, "invalid_mfa_code");
    return asJson
      ? invalidCode()
      : redirect(mfaStepLocation(ctx, callbackUrl, "CredentialsSignin"));
  }
  const fresh = await completeStepUp(ctx, session, result.method);
  return asJson
    ? json({ ok: true, user: fresh.user })
    : redirect(afterSignIn(ctx.config, callbackUrl));
}

/** `POST {basePath}/mfa/enroll` — mint an unconfirmed TOTP secret and its URI. */
async function handleEnroll(ctx: AuthRouteContext): Promise<Response | null> {
  const session = await mfaCaller(ctx, mayEnrol(ctx));
  if (!session || session instanceof Response) return session;
  // enrollTotp() refuses a complete session that didn't sign in recently: a stolen one
  // must not set up a factor of its own and lock the owner out.
  const result = await enrollTotp(ctx.config, session);
  if (result.ok) return json({ secret: result.secret, uri: result.uri });
  return result.error === "reauth_required"
    ? json({ error: "reauth_required" }, 403)
    : json({ error: "already enrolled" }, 409);
}

/**
 * `POST {basePath}/mfa/confirm` — confirm the enrollment with a code; answer the backup
 * codes once. From a pending session this also completes the step-up (amr `totp`).
 */
async function handleConfirm(ctx: AuthRouteContext): Promise<Response | null> {
  const session = await mfaCaller(ctx, mayEnrol(ctx));
  if (!session || session instanceof Response) return session;
  const limited = await spendAttempt(ctx, session);
  if (limited) return limited;
  const { code } = await readMfaFields(ctx);
  const result = await confirmTotp(ctx.config, { user: session.user, code });
  if (!result.ok) return invalidCode();
  if (!session.mfaPending) return json({ ok: true, backupCodes: result.backupCodes });
  const fresh = await completeStepUp(ctx, session, "totp");
  return json({ ok: true, backupCodes: result.backupCodes, user: fresh.user });
}

/**
 * Whether the caller of `/mfa/disable` proved a fresh second factor: a presented `code`
 * that verifies now (spending the MFA budget), else the session's own recent step-up.
 */
async function freshFactor(
  ctx: AuthRouteContext,
  session: AuthSession,
  code: string,
): Promise<boolean | Response> {
  if (!code) return hasFreshFactor(ctx.options, session);
  const limited = await spendAttempt(ctx, session);
  if (limited) return limited;
  return (await verifySecondFactor(ctx.config, { userId: session.user.id, code })).ok;
}

/** `POST {basePath}/mfa/disable` — remove the factor, given a fresh second factor. */
async function handleDisable(ctx: AuthRouteContext): Promise<Response | null> {
  const session = await mfaCaller(ctx, (s) => !s.mfaPending);
  if (!session || session instanceof Response) return session;
  const fresh = await freshFactor(ctx, session, (await readMfaFields(ctx)).code);
  if (fresh instanceof Response) return fresh;
  if (!fresh) return json({ error: "a fresh second factor is required" }, 403);
  await disableTotp(ctx.config, session.user.id);
  return json({ ok: true });
}

/**
 * The MFA rows, relative to `basePath`. Each is same-origin gated and spends the per-user
 * MFA budget itself wherever it checks a code, so none carries a dispatch-level `limit`; an
 * adapter failure is logged and answered `503` ({@link contained}).
 */
export const mfaRoutes: AuthRoute[] = [
  {
    method: "POST",
    pattern: "/mfa",
    handler: contained("the second-factor step-up", handleStepUp),
  },
  { method: "POST", pattern: "/mfa/enroll", handler: contained("TOTP enrollment", handleEnroll) },
  {
    method: "POST",
    pattern: "/mfa/confirm",
    handler: contained("TOTP confirmation", handleConfirm),
  },
  { method: "POST", pattern: "/mfa/disable", handler: contained("disabling TOTP", handleDisable) },
];
