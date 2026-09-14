/**
 * The Credentials half of `{basePath}/callback/:provider`: a same-origin POST carrying
 * e.g. an email + password. Brute force is bounded by two rate-limit buckets, a failure
 * is always the same generic `401` (never a user-enumeration oracle), and the body is
 * read through the shared size/stall cap.
 *
 * @module
 */

import { bufferedRequest, readCappedBody, STALLED, TOO_LARGE } from "../body.ts";
import {
  createRateLimiter,
  defaultRateLimitKey,
  IP_BUCKET_FACTOR,
  ipBucketKey,
  type RateLimiter,
} from "./rate-limit.ts";
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
import type { AuthConfig, AuthUser, CredentialsProvider } from "./types.ts";

/** The most a credentials POST body may carry (a login form is a few hundred bytes). */
const MAX_CREDENTIALS_BYTES = 64 * 1024;

// One limiter per config object (the plugin hands the same `config` to every request),
// created lazily so an app that opts out (`rateLimit: false`) allocates nothing.
const limiters = new WeakMap<AuthConfig, RateLimiter | null>();

/** The credentials brute-force limiter for this config, or `null` when disabled. */
function credentialsLimiter(config: AuthConfig): RateLimiter | null {
  let limiter = limiters.get(config);
  if (limiter === undefined) {
    limiter = config.rateLimit === false ? null : createRateLimiter(config.rateLimit ?? {});
    limiters.set(config, limiter);
  }
  return limiter;
}

/** Run `authorize`, treating a throw as a rejection (never a 500 that leaks details). */
async function authorizeCredentials(
  provider: CredentialsProvider,
  creds: Record<string, string>,
): Promise<AuthUser | null> {
  try {
    return await provider.authorize(creds);
  } catch {
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
 * then issue a session. Failures are counted per client key (IP + identifier by default)
 * and, past the limit, answered with a generic `429` — like the generic `401`, it never
 * reveals whether the account exists.
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

  const creds = await readCredentials(ctx.request);
  const limiter = credentialsLimiter(ctx.config);
  // Two buckets: the app's key (IP + identifier by default) and an IP-wide one, so varying
  // the identifier / identifier field per attempt can't dodge the limiter.
  const { key, ipKey } = limiterKeys(ctx, creds, limiter);
  const retryAfter = limiter
    ? (await limiter.lockedOut(key)) ?? (await limiter.lockedOut(ipKey, IP_BUCKET_FACTOR))
    : null;
  if (retryAfter !== null) {
    return json({ error: "too many attempts" }, 429, { "retry-after": String(retryAfter) });
  }

  const user = await authorizeCredentials(provider, creds);
  if (!user) {
    await limiter?.fail(key);
    await limiter?.fail(ipKey);
    // Generic failure — never reveal whether the account exists.
    return json({ error: "invalid credentials" }, 401);
  }
  await limiter?.succeed(key);

  const approved = await applySignInCallback(ctx.config, user, provider.id);
  if (!approved) return json({ error: "access denied" }, 403);

  await issueAuthSession(ctx.config, approved, provider.id);
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
 * @param request The credentials POST.
 * @returns The string-valued fields, or `{}` when the body is unusable.
 */
async function readCredentials(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  try {
    const bytes = await readCappedBody(request, MAX_CREDENTIALS_BYTES);
    if (bytes === TOO_LARGE || bytes === STALLED) return {};
    const capped = bufferedRequest(request, bytes);
    return type.includes("application/json")
      ? stringFields(await capped.json())
      : stringFields(Object.fromEntries(await capped.formData()));
  } catch {
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
