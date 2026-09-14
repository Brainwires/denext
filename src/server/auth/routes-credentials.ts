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
 * A provider configured **without** `authorize` verifies against the adapter's credentials
 * group instead: the submitted `email` through `getUserByEmail`, the `password` against the
 * hash `getCredential` returns, with the configured {@link ./hasher.ts | Hasher}. The record
 * the password was proven against is the session user, so that path owes no account
 * linking — and every way it can refuse is the same generic `401`, counted in the limiter.
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
  clientIpBucket,
  credentialsLimiter,
  defaultRateLimitKey,
  IP_BUCKET_FACTOR,
  ipBucketKey,
  proxiedWithoutTrust,
  type RateLimiter,
} from "./rate-limit.ts";
import type { AdapterUser } from "./adapter.ts";
import { type ResolvedSignIn, toAuthUser } from "./adapter-link.ts";
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
  | "account_not_linked"
  | "adapter_error";

/**
 * Fire `signInFailed` for a refused attempt. The response is decided by the caller and is
 * never affected: `emitAuthEvent` swallows a throwing handler into the logger.
 *
 * The payload carries the client bucket the limiter counted this attempt against — the
 * `ip` field the event has always declared and never populated, which is what makes
 * "one address, many failures" visible to an alerting pipeline.
 */
function emitFailure(
  ctx: AuthRouteContext,
  provider: string,
  reason: FailureReason,
): Promise<void> {
  return emitAuthEvent(ctx.options, "signInFailed", {
    provider,
    reason,
    ip: clientIpBucket(ctx.request, {
      trustForwardedHeaders: ctx.config.trustForwardedHeaders,
    }),
  });
}

/**
 * A credentials check that passed. `resolved` is set when the adapter-backed default made
 * the check: the stored record the password was verified against IS the identity, so the
 * sign-in owes no account linking — whose email-verification rule guards a provider
 * ASSERTING an address, not a password proven against that very record.
 */
interface Authorized {
  /** The user the check produced. */
  user: AuthUser;
  /** The finished sign-in, when no account linking is owed. */
  resolved?: ResolvedSignIn;
}

/**
 * Run the provider's `authorize` — or, when it has none, the adapter-backed
 * {@linkcode defaultAuthorize} — treating a throw as a rejection (never a 500 that leaks
 * details) but reporting it, so a broken user lookup is visible to the app instead of
 * looking to every caller like a wrong password.
 *
 * @param ctx The route context.
 * @param provider The credentials provider the callback names.
 * @param creds The submitted string fields.
 * @returns The passed check, or `null` to refuse.
 */
async function authorizeCredentials(
  ctx: AuthRouteContext,
  provider: CredentialsProvider,
  creds: Record<string, string>,
): Promise<Authorized | null> {
  const check = provider.authorize ? "authorize()" : "adapter-backed credentials check";
  try {
    if (!provider.authorize) return await defaultAuthorize(ctx, creds);
    const user = await provider.authorize(creds);
    return user ? { user } : null;
  } catch (error) {
    ctx.options.logger.error(
      `denextAuth: the "${provider.id}" provider's ${check} threw; treating it as a refusal`,
      error,
    );
    return null;
  }
}

/**
 * The check a Credentials provider WITHOUT `authorize` gets: the submitted `email` is
 * looked up through the adapter's `getUserByEmail`, and the `password` is verified against
 * the hash `getCredential` returns, with the configured {@link ./hasher.ts | Hasher}.
 *
 * Every refusal — a missing email or password, an unknown address, a user with no password
 * on file, an adapter without the credentials group, a wrong password — costs exactly one
 * `hasher.verify` (an empty stored value makes the hasher burn equal work and answer
 * `false`), so response time says nothing about whether the account exists. The caller
 * answers each of them with the same generic `401`, and counts it in the limiter.
 *
 * @param ctx The route context (its resolved options carry the adapter and the hasher).
 * @param creds The submitted string fields (`email` + `password`).
 * @returns The verified adapter user as a finished sign-in, or `null` to refuse.
 */
async function defaultAuthorize(
  ctx: AuthRouteContext,
  creds: Record<string, string>,
): Promise<Authorized | null> {
  const password = creds.password ?? "";
  const stored = await storedCredential(ctx, creds.email ?? "");
  const ok = await ctx.options.hasher.verify(password, stored?.hash ?? "");
  // `stored` is re-checked: a custom hasher that wrongly accepts an empty hash must not
  // turn an unknown address into a sign-in.
  if (!ok || !stored || password === "") return null;
  const user = toAuthUser(stored.user);
  return { user, resolved: { user, isNewUser: false } };
}

/**
 * The adapter user an address belongs to and their stored password hash, or `undefined`
 * when there is nothing to verify against (no address, no adapter credentials group, an
 * unknown address, no password on file). The address is trimmed and lower-cased — the
 * normalisation both built-in adapters apply to the addresses they store.
 *
 * @param ctx The route context (its resolved options carry the adapter).
 * @param email The submitted address.
 * @returns The record and its hash, or `undefined`.
 */
async function storedCredential(
  ctx: AuthRouteContext,
  email: string,
): Promise<{ user: AdapterUser; hash: string } | undefined> {
  const adapter = ctx.options.adapter;
  const address = email.trim().toLowerCase();
  if (address === "" || !adapter?.getCredential) return undefined;
  const user = await adapter.getUserByEmail(address);
  const hash = user ? await adapter.getCredential(user.id) : undefined;
  return user && hash ? { user, hash } : undefined;
}

/**
 * Both limiter buckets for this attempt: the app's key (IP + identifier by default), and
 * an IP-wide one.
 *
 * Behind an **undeclared** reverse proxy the IP-wide bucket is dropped (`ipKey: null`):
 * every client looks like the proxy there, so 50 failures anywhere would lock out
 * everyone. The identifier-scoped key keeps counting, so a single account is still
 * protected from brute force.
 */
function limiterKeys(
  ctx: AuthRouteContext,
  creds: Record<string, string>,
  limiter: RateLimiter | null,
): { key: string; ipKey: string | null } {
  const config = ctx.config;
  const keyGenerator = (config.rateLimit || undefined)?.keyGenerator ??
    ((req: Request, c: Record<string, string>) =>
      defaultRateLimitKey(req, c, { trustForwardedHeaders: config.trustForwardedHeaders }));
  return {
    key: limiter ? keyGenerator(ctx.request, creds) : "",
    ipKey: proxiedWithoutTrust(ctx.request, config)
      ? null
      : ipBucketKey(ctx.request, { trustForwardedHeaders: config.trustForwardedHeaders }),
  };
}

/**
 * The `429` this attempt owes, if any: the app's key first, then the looser IP-wide bucket.
 *
 * @param ctx The route context.
 * @param provider The provider the callback names.
 * @param limiter The credentials limiter, or `null` when rate limiting is off.
 * @param keys The two buckets this attempt counts against.
 * @returns The `429` response, or `null` to let the attempt through.
 */
async function refuseIfLimited(
  ctx: AuthRouteContext,
  provider: CredentialsProvider,
  limiter: RateLimiter | null,
  keys: { key: string; ipKey: string | null },
): Promise<Response | null> {
  if (!limiter) return null;
  const retryAfter = (await limiter.lockedOut(keys.key)) ??
    (keys.ipKey === null ? null : await limiter.lockedOut(keys.ipKey, IP_BUCKET_FACTOR));
  if (retryAfter === null) return null;
  await emitFailure(ctx, provider.id, "rate_limited");
  return json({ error: "too many attempts" }, 429, { "retry-after": String(retryAfter) });
}

/**
 * The persistence step, with the adapter's failures contained. An adapter that throws —
 * a UNIQUE race between two concurrent first sign-ins, a database that went away — used to
 * escape as a raw `500` with no `signInFailed` at all; here it is the SAME generic `401` a
 * wrong password gets, plus an event and a logged exception. Answering anything else would
 * also tell the client that this address exists.
 *
 * @param ctx The route context.
 * @param provider The credentials provider.
 * @param user The user `authorize()` returned.
 * @returns The resolved sign-in, or the response to send instead.
 */
async function persistSignIn(
  ctx: AuthRouteContext,
  provider: CredentialsProvider,
  user: AuthUser,
): Promise<ResolvedSignIn | Response> {
  let resolved: ResolvedSignIn | undefined;
  try {
    // With an adapter, the session carries the ADAPTER's user id and roles rather than
    // whatever `authorize()` minted, and the login gets an account row like any provider's.
    resolved = await resolveSessionUser(ctx, provider, user, {
      provider: provider.id,
      providerAccountId: user.id,
      type: "credentials",
    });
  } catch (error) {
    ctx.options.logger.error(
      `denextAuth: the "${provider.id}" sign-in could not be persisted`,
      error,
    );
    await emitFailure(ctx, provider.id, "adapter_error");
    return json({ error: "invalid credentials" }, 401);
  }
  if (resolved) return resolved;
  await emitFailure(ctx, provider.id, "account_not_linked");
  // The same generic failure a wrong password gets: that this address already belongs
  // to another identity is precisely what this endpoint must not disclose.
  return json({ error: "invalid credentials" }, 401);
}

/**
 * `POST {basePath}/callback/:provider` for a Credentials provider: rate-limit, authorize
 * (the provider's `authorize`, or the adapter-backed default), resolve through the adapter
 * (when one is configured), then issue a session. Failures
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
  const keys = limiterKeys(ctx, creds, limiter);
  const limited = await refuseIfLimited(ctx, provider, limiter, keys);
  if (limited) return limited;

  const authorized = await authorizeCredentials(ctx, provider, creds);
  if (!authorized) {
    await limiter?.fail(keys.key);
    if (keys.ipKey !== null) await limiter?.fail(keys.ipKey);
    await emitFailure(ctx, provider.id, "invalid_credentials");
    // Generic failure — never reveal whether the account exists.
    return json({ error: "invalid credentials" }, 401);
  }
  await limiter?.succeed(keys.key);

  const resolved = authorized.resolved ?? await persistSignIn(ctx, provider, authorized.user);
  if (resolved instanceof Response) return resolved;

  const approved = await applySignInCallback(ctx.config, resolved.user, provider.id);
  if (!approved) {
    await emitFailure(ctx, provider.id, "access_denied");
    return json({ error: "access denied" }, 403);
  }

  await issueAuthSession(ctx.config, approved, provider.id);
  await emitAuthEvent(ctx.options, "signIn", {
    user: approved,
    provider: provider.id,
    isNewUser: resolved.isNewUser,
  });
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
