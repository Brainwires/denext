/**
 * The Credentials half of `{basePath}/callback/:provider`: a same-origin POST carrying
 * e.g. an email + password. Brute force is bounded by two rate-limit buckets, a failure
 * is always the same generic `401` (never a user-enumeration oracle), and the body is
 * read through the shared size/stall cap.
 *
 * With an {@link ./adapter.ts | AuthAdapter} configured the authorized user is resolved
 * through the same account-linking rules the OAuth callback uses, so the session carries
 * the adapter's user id and roles and the login gets a `"credentials"` account row. A
 * refusal there is answered with the SAME generic `401` a wrong password gets — the
 * reason reaches the app through `signInFailed` and the logger, never the client.
 *
 * Every outcome is observable without changing it: a completed sign-in fires `signIn`, a
 * refusal fires `signInFailed` with a stable `reason`, and anything this module swallows
 * (a provider `authorize()` that threw, an unparseable body) is routed to the configured
 * logger instead of vanishing. Neither an event handler nor the logger can alter the HTTP
 * answer — see {@link ./events.ts | emitAuthEvent}.
 *
 * @module
 */

import { bufferedRequest, readCappedBody, STALLED, TOO_LARGE } from "../body.ts";
import { emitAuthEvent } from "./events.ts";
import {
  credentialsLimiter,
  defaultRateLimitKey,
  IP_BUCKET_FACTOR,
  ipBucketKey,
  type RateLimiter,
} from "./rate-limit.ts";
import { resolveSessionUser } from "./routes-oauth.ts";
import {
  afterSignIn,
  applySignInCallback,
  type AuthRouteContext,
  isSameOrigin,
  json,
  redirect,
  wantsJson,
} from "./routes-shared.ts";
import { issueAuthSession } from "./session.ts";
import type { AuthUser, CredentialsProvider } from "./types.ts";

/** The most a credentials POST body may carry (a login form is a few hundred bytes). */
const MAX_CREDENTIALS_BYTES = 64 * 1024;

/**
 * Why a credentials attempt was refused, as `signInFailed` reports it. Stable strings —
 * an app routes on them (alerting on `"rate_limited"`, counting `"invalid_credentials"`).
 */
type FailureReason =
  | "invalid_credentials"
  | "rate_limited"
  | "access_denied"
  | "account_not_linked";

/**
 * Fire `signInFailed` for a refused attempt. The response is decided by the caller and is
 * never affected: `emitAuthEvent` swallows a throwing handler into the logger.
 */
function emitFailure(
  ctx: AuthRouteContext,
  provider: string,
  reason: FailureReason,
): Promise<void> {
  return emitAuthEvent(ctx.options, "signInFailed", { provider, reason });
}

/**
 * Run `authorize`, treating a throw as a rejection (never a 500 that leaks details) — but
 * report it, so a broken user lookup is visible to the app instead of looking to every
 * caller like a wrong password.
 */
async function authorizeCredentials(
  ctx: AuthRouteContext,
  provider: CredentialsProvider,
  creds: Record<string, string>,
): Promise<AuthUser | null> {
  try {
    return await provider.authorize(creds);
  } catch (error) {
    ctx.options.logger.error(
      `denextAuth: the "${provider.id}" provider's authorize() threw; treating it as a refusal`,
      error,
    );
    return null;
  }
}

/** Both limiter buckets for this attempt: the app's key, and an IP-wide one. */
function limiterKeys(
  ctx: AuthRouteContext,
  creds: Record<string, string>,
  limiter: RateLimiter | null,
): { key: string; ipKey: string } {
  const config = ctx.config;
  const keyGenerator = (config.rateLimit || undefined)?.keyGenerator ??
    ((req: Request, c: Record<string, string>) =>
      defaultRateLimitKey(req, c, { trustForwardedHeaders: config.trustForwardedHeaders }));
  return {
    key: limiter ? keyGenerator(ctx.request, creds) : "",
    ipKey: ipBucketKey(ctx.request, { trustForwardedHeaders: config.trustForwardedHeaders }),
  };
}

/**
 * `POST {basePath}/callback/:provider` for a Credentials provider: rate-limit, authorize,
 * resolve through the adapter (when one is configured), then issue a session. Failures
 * are counted per client key (IP + identifier by default) and, past the limit, answered
 * with a generic `429` — like the generic `401`, it never reveals whether the account
 * exists.
 *
 * @param ctx The route context.
 * @param provider The credentials provider the callback names.
 * @returns A JSON result for an API client, a redirect for a plain form post, or 401/403/429.
 */
export async function handleCredentials(
  ctx: AuthRouteContext,
  provider: CredentialsProvider,
): Promise<Response> {
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);

  const creds = await readCredentials(ctx);
  const limiter = credentialsLimiter(ctx.config);
  // Two buckets: the app's key (IP + identifier by default) and an IP-wide one, so varying
  // the identifier / identifier field per attempt can't dodge the limiter.
  const { key, ipKey } = limiterKeys(ctx, creds, limiter);
  const retryAfter = limiter
    ? (await limiter.lockedOut(key)) ?? (await limiter.lockedOut(ipKey, IP_BUCKET_FACTOR))
    : null;
  if (retryAfter !== null) {
    await emitFailure(ctx, provider.id, "rate_limited");
    return json({ error: "too many attempts" }, 429, { "retry-after": String(retryAfter) });
  }

  const user = await authorizeCredentials(ctx, provider, creds);
  if (!user) {
    await limiter?.fail(key);
    await limiter?.fail(ipKey);
    await emitFailure(ctx, provider.id, "invalid_credentials");
    // Generic failure — never reveal whether the account exists.
    return json({ error: "invalid credentials" }, 401);
  }
  await limiter?.succeed(key);

  // With an adapter, the session carries the ADAPTER's user id and roles rather than
  // whatever `authorize()` minted, and the login gets an account row like any provider's.
  const resolved = await resolveSessionUser(ctx, provider, user, {
    provider: provider.id,
    providerAccountId: user.id,
    type: "credentials",
  });
  if (!resolved) {
    await emitFailure(ctx, provider.id, "account_not_linked");
    // The same generic failure a wrong password gets: that this address already belongs
    // to another identity is precisely what this endpoint must not disclose.
    return json({ error: "invalid credentials" }, 401);
  }

  const approved = await applySignInCallback(ctx.config, resolved, provider.id);
  if (!approved) {
    await emitFailure(ctx, provider.id, "access_denied");
    return json({ error: "access denied" }, 403);
  }

  await issueAuthSession(ctx.config, approved, provider.id);
  await emitAuthEvent(ctx.options, "signIn", { user: approved, provider: provider.id });
  if (wantsJson(ctx.request)) return json({ ok: true, user: approved });
  const callbackUrl = typeof creds.callbackUrl === "string" ? creds.callbackUrl : undefined;
  return redirect(afterSignIn(ctx.config, callbackUrl));
}

/**
 * Parse credentials from a JSON or form-encoded POST body. The body is read through the
 * shared cap (an oversized/stalled body is refused, never buffered whole), and only STRING
 * values survive — a JSON body's nested objects/arrays never reach `authorize`, which
 * expects `Record<string, string>` and may hand a value straight to a query.
 *
 * An unusable body is `{}` (which `authorize` then refuses), never a `500`; the reason is
 * logged, at `debug` for a capped body (routine hostile traffic) and at `error` for a
 * parse failure.
 *
 * @param ctx The route context (its request is read; its logger hears about a bad body).
 * @returns The string-valued fields, or `{}` when the body is unusable.
 */
async function readCredentials(ctx: AuthRouteContext): Promise<Record<string, string>> {
  const { request, options } = ctx;
  const type = request.headers.get("content-type") ?? "";
  try {
    const bytes = await readCappedBody(request, MAX_CREDENTIALS_BYTES);
    if (bytes === TOO_LARGE || bytes === STALLED) {
      options.logger.debug("denextAuth: refused a credentials body", {
        reason: bytes === TOO_LARGE ? "too_large" : "stalled",
        maxBytes: MAX_CREDENTIALS_BYTES,
      });
      return {};
    }
    const capped = bufferedRequest(request, bytes);
    return type.includes("application/json")
      ? stringFields(await capped.json())
      : stringFields(Object.fromEntries(await capped.formData()));
  } catch (error) {
    options.logger.error("denextAuth: could not parse the credentials body", error);
    return {};
  }
}

/** The string-valued entries of a parsed body (anything else — nested JSON, files — is dropped). */
function stringFields(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}
