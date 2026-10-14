/**
 * What every `/auth/v1` route shares: the request context, body parsing, who the caller is
 * (a user's access token, the service role), `redirect_to` validation, captcha and rate limits.
 *
 * @module
 */

import { readCappedBody, STALLED, TOO_LARGE } from "../../body.ts";
import type { AdapterUser, AuthAdapter } from "../adapter.ts";
import { bearerTokenOf } from "../bearer-header.ts";
import { captchaRemoteIp, usableCaptchaToken, verifyCaptcha } from "../captcha.ts";
import { resolveAuthOptions } from "../options.ts";
import { normalizePhoneNumber } from "../phone.ts";
import {
  authTrustsProxy,
  clientIpBucket,
  consumeHitBudget,
  proxiedWithoutTrust,
  type RateLimiter,
  settleAttempt,
  spendCaptchaBudget,
  subjectBucketKeys,
} from "../rate-limit.ts";
import type { AuthConfig } from "../types.ts";
import { hasVerifiedFactor } from "../factors.ts";
import { type VerifiedAccessToken, verifyAccessToken, verifyAccessTokenSession } from "./access.ts";
import { ssoStarted } from "../sso-user.ts";
import { fail, GoTrueError, type GoTrueErrorCode } from "./errors.ts";
import {
  apiKeyRole,
  looksLikeJwt,
  type SupabaseJwtClaims,
  SupabaseKeyError,
  type SupabaseKeys,
} from "./keys.ts";
import type { GoTrueOptions } from "./options.ts";
import type { SessionContext } from "./session.ts";

/** The `/auth/v1` prefix. */
export const GOTRUE_PREFIX = "/auth/v1";

/** The largest JSON body an `/auth/v1` endpoint reads. */
const BODY_LIMIT = 64 * 1024;

/** One request's context. */
export interface GoTrueContext {
  /** The request. */
  request: Request;
  /** Its URL. */
  url: URL;
  /** The method, upper-case. */
  method: string;
  /** The path below `/auth/v1` (`/token`). */
  path: string;
  /** Path parameters (`:id`). */
  params: Record<string, string>;
  /** The auth config. */
  config: AuthConfig;
  /** The adapter. */
  adapter: AuthAdapter;
  /** The `/auth/v1` options. */
  options: GoTrueOptions;
  /** The JWT keys. */
  keys: SupabaseKeys;
  /** The session context. */
  session: SessionContext;
  /** The app's public origin. */
  origin: string;
  /** The site URL (the default redirect). */
  siteUrl: string;
}

/**
 * Read the JSON body (an object; `{}` for an empty body).
 *
 * @param ctx The context.
 * @returns The body.
 * @throws {GoTrueError} `bad_json` for anything else.
 */
export async function readJson(ctx: GoTrueContext): Promise<Record<string, unknown>> {
  if (!ctx.request.body) return {};
  const bytes = await readCappedBody(ctx.request, BODY_LIMIT);
  if (bytes === TOO_LARGE) throw new GoTrueError(413, "bad_json", "Request body too large");
  if (bytes === STALLED) throw new GoTrueError(408, "bad_json", "Request body stalled");
  if (bytes.byteLength === 0) return {};
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Refused below.
  }
  throw new GoTrueError(400, "bad_json", "Could not parse request body as JSON");
}

/** A string field, trimmed; `undefined` when absent or empty. */
export function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw fail.validation(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** An object field (`data`, `user_metadata`), or `undefined`. */
export function obj(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw fail.validation(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** The bearer token of the request, if any. */
function bearerOf(request: Request): string | undefined {
  return bearerTokenOf(request.headers.get("authorization"));
}

/** The caller, when authenticated as a user. */
export interface CallerUser {
  /** The verified access-token claims. */
  claims: SupabaseJwtClaims;
  /** The user record. */
  user: AdapterUser;
  /** The session (family) id. */
  sessionId?: string;
  /** The session still owes its second factor (an `aal1` sign-in of an MFA user). */
  pending: boolean;
  /**
   * The session's stored family says a SAML sign-in started it (`sso/saml`). Read from the
   * stored session, never the token's `amr` claim (the custom access token hook may rewrite
   * that); `false` for a token with no stored session.
   */
  ssoSession: boolean;
}

/**
 * The calling user: a valid access token whose session is live and whose user exists.
 *
 * An access token issued to an OAuth client (it carries `client_id`) acts for the user only
 * where `allowOAuthClient` says so: a third-party app must not change the user's password,
 * factors or identities, approve its own consent, or list the user's grants.
 *
 * A session that still owes its second factor (`pending`: an `aal1` sign-in of a user who must
 * complete MFA) is refused with `insufficient_aal` unless `allowPending` says the endpoint is
 * part of finishing the sign-in (reading the user, the factor endpoints, sign-out) or checks
 * the assurance level itself.
 *
 * @param ctx The context.
 * @param options `allowOAuthClient` — accept an OAuth client's token (`GET /user`, userinfo);
 *   `allowPending` — accept a session that still owes its second factor.
 * @returns The caller.
 * @throws {GoTrueError} `no_authorization` / `bad_jwt` / `session_not_found` / `user_not_found`
 *   / `insufficient_aal`.
 */
export async function requireUser(
  ctx: GoTrueContext,
  options: { allowOAuthClient?: boolean; allowPending?: boolean } = {},
): Promise<CallerUser> {
  const token = bearerOf(ctx.request);
  if (!token || !looksLikeJwt(token)) throw fail.noAuthorization();
  const { claims, pending, user: stored, storedAmr } = await verifiedCaller(ctx, token);
  if (claims.role !== "authenticated") throw fail.badJwt("invalid JWT: not a user token");
  if (claims.client_id !== undefined && !options.allowOAuthClient) {
    throw fail.badJwt("invalid JWT: an OAuth client's token cannot call this endpoint");
  }
  const user = stored ?? await ctx.adapter.getUser(claims.sub!);
  if (!user) {
    throw new GoTrueError(403, "user_not_found", "User from sub claim in JWT does not exist");
  }
  if (pending && !options.allowPending) {
    throw new GoTrueError(403, "insufficient_aal", "AAL2 session is required");
  }
  const sessionId = typeof claims.session_id === "string" ? claims.session_id : undefined;
  return { claims, user, sessionId, pending, ssoSession: ssoStarted(storedAmr ?? []) };
}

/** The caller's verified token, its refusals as GoTrue's errors. */
async function verifiedCaller(
  ctx: GoTrueContext,
  token: string,
): Promise<VerifiedAccessToken> {
  try {
    return await verifyAccessTokenSession(ctx.keys, token, ctx.config);
  } catch (error) {
    if (error instanceof SupabaseKeyError && error.message.includes("session not found")) {
      throw new GoTrueError(
        403,
        "session_not_found",
        "Session from session_id claim in JWT does not exist",
      );
    }
    throw fail.badJwt(error instanceof SupabaseKeyError ? error.message : undefined);
  }
}

/**
 * Refuse an account change from a session below `aal2` once the user holds a verified factor
 * (a password alone must not change what MFA protects).
 *
 * @param ctx The context.
 * @param caller The caller.
 * @param what What is being done, for the message.
 * @throws {GoTrueError} 403 `insufficient_aal`.
 */
export async function requireAal2WithFactor(
  ctx: GoTrueContext,
  caller: CallerUser,
  what: string,
): Promise<void> {
  if (caller.claims.aal === "aal2") return;
  if (!(await hasVerifiedFactor(ctx.config, caller.user.id))) return;
  throw new GoTrueError(403, "insufficient_aal", `AAL2 required to ${what}`);
}

/**
 * Require the service role: the secret key (or the legacy `service_role` JWT) as the bearer,
 * or as the `apikey` when no bearer is sent.
 *
 * @param ctx The context.
 * @throws {GoTrueError} `no_authorization` without a credential, `not_admin` for anything else.
 */
export async function requireServiceRole(ctx: GoTrueContext): Promise<void> {
  const presented = bearerOf(ctx.request) ?? ctx.request.headers.get("apikey")?.trim();
  if (!presented) throw fail.noAuthorization();
  let role: string | null = null;
  try {
    role = await apiKeyRole(ctx.keys, presented);
  } catch {
    role = null;
  }
  if (role !== "service_role") throw fail.notAdmin();
}

/**
 * Require an API key (the publishable or secret key, or a legacy JWT key) — what Supabase's
 * gateway asks of every `/auth/v1` call a client makes. A user's access token as the bearer
 * also passes.
 *
 * @param ctx The context.
 * @throws {GoTrueError} 401 without a valid key.
 */
export async function requireApiKey(ctx: GoTrueContext): Promise<void> {
  const apikey = ctx.request.headers.get("apikey")?.trim() ??
    ctx.url.searchParams.get("apikey") ?? undefined;
  const bearer = bearerOf(ctx.request);
  const candidate = apikey ?? bearer;
  if (!candidate) {
    throw new GoTrueError(401, "no_authorization", "No API key found in request");
  }
  try {
    await apiKeyRole(ctx.keys, candidate);
    return;
  } catch {
    // A user's access token as the only credential is enough (an API key is still expected).
    if (!apikey && bearer && looksLikeJwt(bearer)) {
      try {
        await verifyAccessToken(ctx.keys, bearer, ctx.config);
        return;
      } catch { /* refused below */ }
    }
  }
  throw new GoTrueError(401, "no_authorization", "Invalid API key");
}

/** Escape a string for a RegExp. */
function escape(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** A redirect-URL pattern (`*` within a segment / label, `**` anything) as a RegExp. */
function patternOf(glob: string): RegExp {
  const source = glob.split("**").map((part) => part.split("*").map(escape).join("[^/.?#]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/**
 * Validate a `redirect_to`: the site URL (and anything below it), or a URL the
 * `redirectUrls` allow-list matches. Anything else falls back to the site URL — never an open
 * redirect.
 *
 * @param ctx The context.
 * @param requested The requested URL.
 * @returns The URL to redirect to.
 */
export function redirectTarget(ctx: GoTrueContext, requested: string | null | undefined): string {
  if (!requested) return ctx.siteUrl;
  let url: URL;
  try {
    url = new URL(requested, ctx.siteUrl);
  } catch {
    return ctx.siteUrl;
  }
  if (url.username || url.password) return ctx.siteUrl;
  if (["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(url.protocol)) {
    return ctx.siteUrl;
  }
  const href = url.href;
  const site = new URL(ctx.siteUrl);
  if (url.origin === site.origin && (url.protocol === "https:" || url.protocol === "http:")) {
    return href;
  }
  for (const pattern of ctx.options.redirectUrls ?? []) {
    if (pattern === href || patternOf(pattern).test(href)) return href;
  }
  return ctx.siteUrl;
}

/**
 * Verify the `captcha_token` (`gotrue_meta_security.captcha_token`) when captcha is on. A
 * present token first spends the per-IP captcha budget (`rateLimit.captcha`), so the provider
 * is never called past it; a missing or oversized one is refused without spending.
 *
 * @param ctx The context.
 * @param body The request body.
 * @throws {GoTrueError} `captcha_failed`, or 429 `over_request_rate_limit` past the budget.
 */
export async function checkCaptcha(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
): Promise<void> {
  const captcha = ctx.options.captcha;
  if (!captcha) return;
  const token = captchaTokenOf(body);
  if (!token) {
    throw new GoTrueError(
      400,
      "captcha_failed",
      "captcha protection: request disallowed (no captcha response)",
    );
  }
  if (await spendCaptchaBudget(ctx.request, ctx.config) !== null) throw fail.rateLimited();
  if (!(await captchaVerified(ctx, captcha, token))) {
    throw new GoTrueError(
      400,
      "captcha_failed",
      "captcha protection: request disallowed (captcha verification failed)",
    );
  }
}

/** The `captcha_token` a body carries (`gotrue_meta_security.captcha_token`, or top level). */
function captchaTokenOf(body: Record<string, unknown>): string | undefined {
  const security = body.gotrue_meta_security as Record<string, unknown> | undefined;
  return usableCaptchaToken(security?.captcha_token ?? body.captcha_token);
}

/** Ask the captcha provider whether `token` is a solved challenge (a failure is "no"). */
function captchaVerified(
  ctx: GoTrueContext,
  captcha: NonNullable<GoTrueOptions["captcha"]>,
  token: string,
): Promise<boolean> {
  const remoteIp = captchaRemoteIp(ctx.request, ctx.config);
  return verifyCaptcha(captcha, token, remoteIp, resolveAuthOptions(ctx.config).logger);
}

/** A budget to spend before an attempt runs; a 429 when it is spent. */
export async function spend(
  ctx: GoTrueContext,
  limiter: RateLimiter | null,
  budget: "verify" | "mfa",
  subject: string,
  code: GoTrueErrorCode = "over_request_rate_limit",
): Promise<{ settle(): Promise<void> }> {
  const keys = subjectBucketKeys(budget, `gotrue:${subject}`, ctx.request, ctx.config);
  const retry = await consumeHitBudget(limiter, keys);
  if (retry !== null) throw fail.rateLimited(code);
  return { settle: () => settleAttempt(limiter, keys) };
}

/** Spend one hit of a per-IP budget; a 429 when it is spent. */
export async function spendIp(
  ctx: GoTrueContext,
  limiter: RateLimiter | null,
  name: string,
): Promise<void> {
  if (!limiter || proxiedWithoutTrust(ctx.request, ctx.config)) return;
  const key = `gotrue-${name}|${
    clientIpBucket(ctx.request, { trustForwardedHeaders: authTrustsProxy(ctx.config) })
  }`;
  if (await limiter.hit(key) !== null) throw fail.rateLimited();
}

/** E.164: `+` and 8–15 digits (spaces, dashes and parentheses are dropped first). */
export function normalizePhone(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const e164 = normalizePhoneNumber(input);
  if (!e164) throw fail.validation("Invalid phone number format (E.164 required)");
  return e164;
}

/** A plausible email address, lower-cased domain; `undefined` when absent. */
export function normalizeEmail(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const email = input.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GoTrueError(
      400,
      "email_address_invalid",
      "Unable to validate email address: invalid format",
    );
  }
  const at = email.lastIndexOf("@");
  return email.slice(0, at) + "@" + email.slice(at + 1).toLowerCase();
}

/** Epoch seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Answer with JSON, `no-store`. */
export function ok(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}
