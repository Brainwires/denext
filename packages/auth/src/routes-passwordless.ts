/**
 * What the passwordless sign-in callbacks share — the email providers
 * ({@link ./routes-email.ts | magicLink / emailOtp}), the phone provider
 * ({@link ./routes-phone.ts | phoneOtp}) and anonymous sign-in
 * ({@link ./routes-anonymous.ts | POST /anonymous}): the capped body reader, the answer pages,
 * the one generic failure, the redeem failure budget, and the tail that turns a proven
 * identifier into a session.
 *
 * @module
 */

import { bufferedRequest, readCappedBody, STALLED } from "@denext/denext/auth-kit";
import type { VerificationTokenRecord } from "./adapter.ts";
import type { ResolvedSignIn } from "./adapter-link.ts";
import type { EmailRequestResult } from "./email.ts";
import { emitAuthEvent } from "./events.ts";
import {
  type AttemptKeys,
  authTrustsProxy,
  clientIpBucket,
  consumeHitBudget,
  mfaLimiter,
  settleAttempt,
} from "./rate-limit.ts";
import {
  applySignInCallback,
  type AuthRouteContext,
  json,
  redirect,
  sameOriginRedirect,
  wantsJson,
} from "./routes-shared.ts";
import { finishSignIn } from "./sign-in-tail.ts";
import type { AuthConfig, SignInFailedReason } from "./types.ts";

/** The most a passwordless sign-in body may carry (an identifier, a code or token, a callbackUrl). */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * A passwordless sign-in body's string fields — JSON, or a form post (urlencoded or
 * multipart) — read through the shared size + stall cap; nested JSON values and files are
 * dropped. An unusable body is `{}`: a send then sends nothing and a redeem fails like any
 * wrong code — never a `500`.
 *
 * @param ctx The route context.
 * @returns The string-valued fields.
 */
export async function readSignInForm(ctx: AuthRouteContext): Promise<Record<string, string>> {
  const bytes = await readCappedBody(ctx.request, MAX_BODY_BYTES).catch(() => STALLED);
  if (typeof bytes === "symbol") return {};
  const body = bufferedRequest(ctx.request, bytes);
  const isJson = (ctx.request.headers.get("content-type") ?? "").includes("application/json");
  const parsed: unknown = await (isJson ? body.json() : body.formData().then(Object.fromEntries))
    .catch((error: unknown) => {
      ctx.options.logger.debug("denextAuth: refused a passwordless sign-in body", {
        error: String(error),
      });
      return null;
    });
  const entries = parsed && typeof parsed === "object" ? Object.entries(parsed) : [];
  return Object.fromEntries(entries.filter((entry) => typeof entry[1] === "string"));
}

/**
 * `page` carrying `query`, as a same-origin path (a configured absolute page keeps its path).
 *
 * @param config The auth config.
 * @param page The configured page.
 * @param query The query parameters to set.
 * @returns A safe `Location` value.
 */
export function pageWith(config: AuthConfig, page: string, query: Record<string, string>): string {
  const url = new URL(page, "http://denext.invalid");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return sameOriginRedirect(config, null, url.pathname + url.search + url.hash);
}

/**
 * The "check your email / phone" page — also where a code is typed in.
 *
 * @param config The auth config.
 * @returns `pages.verifyRequest`, else `pages.signIn`, else `/`.
 */
export function noticePage(config: AuthConfig): string {
  return config.pages?.verifyRequest || config.pages?.signIn || "/";
}

/**
 * Where a refused redeem lands, carrying `?error=<code>`.
 *
 * @param config The auth config.
 * @param code The `?error=` code.
 * @returns A safe `Location` value on `pages.error`, else `pages.signIn`, else `/`.
 */
export function errorLocation(config: AuthConfig, code: string): string {
  return pageWith(config, config.pages?.error || config.pages?.signIn || "/", { error: code });
}

/**
 * The answer to a send — identical whether or not anything went out: `{ ok: true }` (a form: a
 * `303` to the notice page with `?sent=1`), or the `429` of a spent send budget.
 *
 * @param ctx The route context.
 * @param result What the send core reported (`undefined`: nothing was attempted).
 * @returns The response.
 */
export function sentAnswer(
  ctx: AuthRouteContext,
  result: EmailRequestResult | undefined,
): Response {
  if (result && !result.ok) return tooManyAttempts(result.retryAfter);
  return wantsJson(ctx.request)
    ? json({ ok: true })
    : redirect(pageWith(ctx.config, noticePage(ctx.config), { sent: "1" }));
}

/**
 * The generic `429` every passwordless budget answers with.
 *
 * @param retryAfter Seconds until the budget refills.
 * @returns The response.
 */
export function tooManyAttempts(retryAfter: number): Response {
  return json({ error: "too many attempts" }, 429, { "retry-after": String(retryAfter) });
}

/**
 * The one failure answer every wrong, spent or expired token or code gets.
 *
 * @param ctx The route context.
 * @param asJson Answer JSON rather than redirect.
 * @returns `401 { error: "invalid code" }`, or a `303` with `?error=Verification`.
 */
function verificationFailed(ctx: AuthRouteContext, asJson: boolean): Response {
  return asJson
    ? json({ error: "invalid code" }, 401)
    : redirect(errorLocation(ctx.config, "Verification"));
}

/**
 * Fire `signInFailed` with the client bucket the limiter counts — it never alters the answer.
 *
 * @param ctx The route context.
 * @param provider The provider id the attempt targeted.
 * @param reason Why it failed.
 */
export function emitSignInFailure(
  ctx: AuthRouteContext,
  provider: string,
  reason: SignInFailedReason,
): Promise<void> {
  const trust = { trustForwardedHeaders: authTrustsProxy(ctx.config) };
  const ip = clientIpBucket(ctx.request, trust);
  return emitAuthEvent(ctx.options, "signInFailed", { provider, reason, ip });
}

/**
 * Consume a presented code or link token under the MFA failure budget: spend one unit of each
 * bucket first (a `429` past the budget), redeem, and settle the buckets on success. Every
 * failure is the same {@linkcode verificationFailed} answer.
 *
 * @param ctx The route context.
 * @param provider The provider id (for `signInFailed`).
 * @param keys The buckets a failure counts against.
 * @param consume Redeem the presented secret.
 * @param asJson Answer JSON rather than redirect.
 * @returns The consumed record, or the refusal to answer with.
 */
async function redeemUnderBudget(
  ctx: AuthRouteContext,
  provider: string,
  keys: AttemptKeys,
  consume: () => Promise<VerificationTokenRecord | null>,
  asJson: boolean,
): Promise<VerificationTokenRecord | Response> {
  const limiter = mfaLimiter(ctx.config);
  const retryAfter = await consumeHitBudget(limiter, keys);
  if (retryAfter !== null) {
    await emitSignInFailure(ctx, provider, "rate_limited");
    return tooManyAttempts(retryAfter);
  }
  const record = await consume();
  if (!record) {
    await emitSignInFailure(ctx, provider, "invalid_credentials");
    return verificationFailed(ctx, asJson);
  }
  await settleAttempt(limiter, keys);
  return record;
}

/**
 * Resolve the user a proof signs in as with the adapter's failures contained: a throw (a
 * UNIQUE race between two first sign-ins, a store that went away) is logged, reported as
 * `signInFailed` / `"adapter_error"`, and answered like any other failed redeem (`null`).
 *
 * @param ctx The route context.
 * @param provider The provider id.
 * @param resolve Find, convert or create the user.
 * @returns The resolved sign-in, or `null`.
 */
export async function resolveContained(
  ctx: AuthRouteContext,
  provider: string,
  resolve: () => Promise<ResolvedSignIn | null>,
): Promise<ResolvedSignIn | null> {
  try {
    return await resolve();
  } catch (error) {
    ctx.options.logger.error(`denextAuth: the "${provider}" sign-in could not be persisted`, error);
    await emitSignInFailure(ctx, provider, "adapter_error");
    return null;
  }
}

/** How a proven identifier's sign-in answers. */
export interface ProvenSignIn {
  /** The requested landing page, if any. */
  callbackUrl: string | undefined;
  /** Answer JSON rather than redirect. */
  asJson: boolean;
  /** The authentication method the proof was (`email`, `otp`, `sms`, `anonymous`). */
  amr: string[];
}

/**
 * Turn a resolved user into a sign-in: run `callbacks.signIn` (a veto is `403` /
 * `?error=AccessDenied`), then the one sign-in tail ({@link finishSignIn}) — the MFA step-up,
 * the session and the answer. A `null` user is the generic verification failure.
 *
 * @param ctx The route context.
 * @param provider The provider id the session records.
 * @param resolved The user to sign in, or `null`.
 * @param proof The landing page, the answer format and the proven method.
 * @returns The response that ends the route.
 */
export async function finishProvenSignIn(
  ctx: AuthRouteContext,
  provider: string,
  resolved: ResolvedSignIn | null,
  proof: ProvenSignIn,
): Promise<Response> {
  if (!resolved) return verificationFailed(ctx, proof.asJson);
  const approved = await applySignInCallback(ctx.config, resolved.user, provider);
  if (!approved) {
    await emitSignInFailure(ctx, provider, "access_denied");
    return proof.asJson
      ? json({ error: "access denied" }, 403)
      : redirect(errorLocation(ctx.config, "AccessDenied"));
  }
  return await finishSignIn(ctx, approved, provider, {
    isNewUser: resolved.isNewUser,
    returnTo: proof.callbackUrl,
    amr: proof.amr,
    json: proof.asJson,
  });
}

/** What {@linkcode redeemAndSignIn} is handed. */
export interface PasswordlessRedeem extends ProvenSignIn {
  /** The buckets a failure counts against. */
  keys: AttemptKeys;
  /** Redeem the presented secret. */
  consume(): Promise<VerificationTokenRecord | null>;
  /** Find, convert or create the user the redeemed identifier signs in as. */
  resolve(identifier: string): Promise<ResolvedSignIn | null>;
}

/**
 * The whole redeem of a passwordless proof: consume the code or token under the failure budget,
 * resolve the user (adapter failures contained), then the sign-in tail.
 *
 * @param ctx The route context.
 * @param provider The provider id.
 * @param redeem The buckets, the redeem, the user resolution and how to answer.
 * @returns The response that ends the route.
 */
export async function redeemAndSignIn(
  ctx: AuthRouteContext,
  provider: string,
  redeem: PasswordlessRedeem,
): Promise<Response> {
  const record = await redeemUnderBudget(ctx, provider, redeem.keys, redeem.consume, redeem.asJson);
  if (record instanceof Response) return record;
  const resolved = await resolveContained(ctx, provider, () => redeem.resolve(record.identifier));
  return await finishProvenSignIn(ctx, provider, resolved, redeem);
}
