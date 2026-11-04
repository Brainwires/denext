/**
 * Captcha verification (hCaptcha or Turnstile) for denext auth — one check `/auth/v1` and
 * denext's own endpoints share. With `captcha` configured, the endpoints that create a session
 * or send a message from an unauthenticated request (the credentials sign-in, an email or phone
 * code / link send, anonymous sign-in, a password-reset request) refuse a request whose solved
 * challenge the provider does not confirm — before any adapter work or rate-limit spend.
 *
 * The provider call itself is the one outbound call an unauthenticated request can trigger
 * here, so it sits behind its own cheap per-IP budget (`rateLimit.captcha`, 30 per minute by
 * default): a token is counted against the client's address BEFORE the provider is asked, and
 * past the budget the request is a `429` with no provider call. A missing or oversized token
 * is refused without spending (it is never sent).
 *
 * @module
 */

import type { GoTrueCaptchaOptions } from "./gotrue/options.ts";
import { emitAuthEvent } from "./events.ts";
import { authTrustsProxy, clientIpBucket, spendCaptchaBudget } from "./rate-limit.ts";
import {
  type AuthRouteContext,
  json,
  redirect,
  sameOriginRedirect,
  wantsJson,
} from "./routes-shared.ts";
import type { AuthConfig, AuthLogger } from "./types.ts";

/** The longest token worth sending to the provider (a real one is a few hundred bytes). */
const MAX_TOKEN_LENGTH = 4096;

/** How long the provider gets to answer before the token counts as unsolved. */
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * The body fields a captcha token may arrive in: denext's own name, Supabase's, and the
 * hidden fields the Turnstile and hCaptcha widgets add to a plain HTML form.
 */
const TOKEN_FIELDS = [
  "captchaToken",
  "captcha_token",
  "cf-turnstile-response",
  "h-captcha-response",
] as const;

/** The header a script client may send the token in instead. */
const TOKEN_HEADER = "x-captcha-token";

/**
 * A usable token: a non-empty string no longer than 4096 characters.
 *
 * @param value Anything.
 * @returns The token, or `undefined`.
 */
export function usableCaptchaToken(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= MAX_TOKEN_LENGTH
    ? value
    : undefined;
}

/**
 * The client IP to hand the provider as `remoteip`: the address the rate limiters key on
 * (honouring `trustForwardedHeaders`), or `undefined` when there is no single address (an
 * IPv6 /64 bucket, an unknown peer).
 *
 * @param request The incoming request.
 * @param config The auth config.
 * @returns The address, or `undefined`.
 */
export function captchaRemoteIp(request: Request, config: AuthConfig): string | undefined {
  const ip = clientIpBucket(request, { trustForwardedHeaders: authTrustsProxy(config) });
  return ip && ip !== "unknown" && !ip.includes("/") ? ip : undefined;
}

/**
 * Ask the captcha provider whether `token` is a solved challenge. Any failure — a refusal, a
 * non-2xx answer, a malformed body, a network error, or no answer within 10 seconds — is
 * `false` (logged, without the token).
 *
 * @param captcha The provider, its secret, and optionally the endpoint and a `fetch`.
 * @param token The token the widget produced.
 * @param remoteIp The client's address, passed as `remoteip` when known.
 * @param logger Where a provider failure is reported.
 * @returns `true` only when the provider confirmed the token.
 */
export async function verifyCaptcha(
  captcha: GoTrueCaptchaOptions,
  token: string,
  remoteIp?: string,
  logger?: AuthLogger,
): Promise<boolean> {
  const url = captcha.verifyUrl ??
    (captcha.provider === "hcaptcha"
      ? "https://api.hcaptcha.com/siteverify"
      : "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  const form = new URLSearchParams({ secret: captcha.secret, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const response = await (captcha.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    const result = await response.json() as { success?: unknown } | null;
    return response.ok && result?.success === true;
  } catch (error) {
    logger?.error?.("captcha verification failed", error);
    return false;
  }
}

/** The token a native request carries: a body field, else the `x-captcha-token` header. */
function nativeToken(fields: Record<string, string>, request: Request): string | undefined {
  for (const name of TOKEN_FIELDS) {
    const token = usableCaptchaToken(fields[name]);
    if (token) return token;
  }
  return usableCaptchaToken(request.headers.get(TOKEN_HEADER) ?? undefined);
}

/** Where a refused form post lands: `pages.error`, else `pages.signIn`, else `/`. */
function refusalLocation(config: AuthConfig): string {
  const url = new URL(config.pages?.error || config.pages?.signIn || "/", "http://denext.invalid");
  url.searchParams.set("error", "CaptchaFailed");
  return sameOriginRedirect(config, null, url.pathname + url.search + url.hash);
}

/**
 * The captcha gate on one of denext's own endpoints: with `captcha` configured, the request
 * must carry a token the provider confirms (in `captchaToken` / `captcha_token` /
 * `cf-turnstile-response` / `h-captcha-response`, or the `x-captcha-token` header). Without
 * `captcha` it passes everything.
 *
 * @param ctx The route context.
 * @param fields The request body's string fields (already read).
 * @param signInProvider The provider id when the endpoint starts a sign-in — a refusal then
 *   fires `signInFailed` with `reason: "captcha_failed"`.
 * @returns `null` to proceed, or the refusal: JSON `400 { error: "captcha_failed" }`, or for a
 *   form a `303` to the error page with `?error=CaptchaFailed`; past the per-IP captcha budget
 *   (`rateLimit.captcha`, spent before the provider is called) a `429
 *   { error: "too many attempts" }` with `Retry-After`.
 */
export async function captchaRefusal(
  ctx: AuthRouteContext,
  fields: Record<string, string>,
  signInProvider?: string,
): Promise<Response | null> {
  const captcha = ctx.config.captcha;
  if (!captcha) return null;
  const token = nativeToken(fields, ctx.request);
  if (token) {
    const retryAfter = await spendCaptchaBudget(ctx.request, ctx.config);
    if (retryAfter !== null) {
      return json({ error: "too many attempts" }, 429, { "retry-after": String(retryAfter) });
    }
    const remoteIp = captchaRemoteIp(ctx.request, ctx.config);
    if (await verifyCaptcha(captcha, token, remoteIp, ctx.options.logger)) return null;
  }
  if (signInProvider !== undefined) {
    await emitAuthEvent(ctx.options, "signInFailed", {
      provider: signInProvider,
      reason: "captcha_failed",
      ip: clientIpBucket(ctx.request, { trustForwardedHeaders: authTrustsProxy(ctx.config) }),
    });
  }
  return wantsJson(ctx.request)
    ? json({ error: "captcha_failed" }, 400)
    : redirect(refusalLocation(ctx.config));
}
