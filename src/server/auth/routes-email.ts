/**
 * `{basePath}/callback/:provider` for the passwordless **email providers**
 * ({@link ./providers-email.ts | magicLink / emailOtp}):
 *
 * - `POST { email, callbackUrl? }` — **send**. The address is normalised to exactly ONE
 *   address; a list (`a@x.com,b@y.com`, `a@x.com; b@y.com`), a display-name form or
 *   anything invalid sends nothing and gets the same answer a real send gets. A send
 *   spends the per-address + per-IP verification budget before the address is looked up,
 *   so a `429` is as blind to existence as a `200`; an unknown address under
 *   `allowSignUp: false` gets no mail, comparable work and the identical answer. A JSON
 *   client gets `{ ok: true }`, a form a `303` to `pages.verifyRequest` (else
 *   `pages.signIn`, else `/`) with `?sent=1`.
 * - `POST { email, code }` (an `emailOtp()` provider) or `POST { email, token }` (a
 *   `magicLink()` provider, for a JS client) — **redeem**. Failures count against the MFA
 *   budget (5 per 5 minutes): per client IP always, and per address for a code. Every
 *   failure is the same `401 { error: "invalid code" }` (a form: a `303` to `pages.error`,
 *   else `pages.signIn`, with `?error=Verification`); past the budget, a `429`.
 * - `GET ?token=…&email=…[&callbackUrl=…]` — the **magic-link click**, which consumes the
 *   token (Auth.js parity: a mail gateway that pre-fetches links can spend one).
 *
 * A redeemed token proves the mailbox: an existing user's unset `emailVerified` is set
 * (firing `emailVerified`) — but first everything that authenticated that unverified
 * account without the proof (its password, bearer tokens and server-side sessions) is
 * retired, the pre-account-hijacking defence (`evictUnprovenAccess`); an unknown address becomes a new, already-verified user when
 * the provider allows sign-up (firing `createUser` — no account row is linked: as in
 * Auth.js, the address on the user record is the identity). `callbacks.signIn` may then
 * veto it (`?error=AccessDenied`), and the one sign-in tail
 * ({@link ./sign-in-tail.ts | finishSignIn}) decides the MFA step-up, mints the session
 * (`amr: ["email"]` for a link, `["otp"]` for a code) and answers.
 *
 * The `Authorization` header is never read, and every POST is same-origin gated.
 *
 * @module
 */

import { bufferedRequest, readCappedBody, STALLED } from "../body.ts";
import type { AdapterUser, AuthAdapter } from "./adapter.ts";
import { type ResolvedSignIn, toAuthUser } from "./adapter-link.ts";
import {
  type EmailFlowAdapter,
  emailFlowAdapter,
  revokeUserSessions,
  sendThrottled,
  tokenLink,
} from "./email.ts";
import { emitAuthEvent } from "./events.ts";
import { randomToken } from "./oauth.ts";
import type { ResolvedAuthOptions } from "./options.ts";
import {
  clientIpBucket,
  IP_BUCKET_FACTOR,
  mfaLimiter,
  type RateLimiter,
  subjectBucketKeys,
} from "./rate-limit.ts";
import {
  afterSignIn,
  applySignInCallback,
  type AuthRouteContext,
  isSameOrigin,
  json,
  redirect,
  sameOriginRedirect,
  wantsJson,
} from "./routes-shared.ts";
import { finishSignIn } from "./sign-in-tail.ts";
import type { AuthConfig, EmailProvider, VerificationRequestParams } from "./types.ts";
import {
  issueVerificationCode,
  issueVerificationToken,
  normalizeEmailIdentifier,
  redeemVerificationCode,
  redeemVerificationToken,
} from "./verification.ts";

/** The most an email sign-in body may carry (an address, a code or token, a callbackUrl). */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * The adapter surface an email sign-in needs — the email-flow group plus `createUser` —
 * and, where the adapter has them, the credentials + API-token methods a first
 * verification retires.
 */
type EmailSignInAdapter =
  & EmailFlowAdapter
  & Pick<AuthAdapter, "createUser">
  & Partial<Pick<AuthAdapter, "getCredential" | "listApiTokens" | "revokeApiToken">>;

/** What a redeem is handed, from a body or the link's query. */
interface RedeemInput {
  /** The submitted address. */
  email: string | undefined;
  /** The presented token (magic) or code (otp). */
  secret: string;
  /** The requested landing page, if any. */
  callbackUrl: string | undefined;
}

/** A proven mailbox, and how the sign-in it earned should answer. */
interface MailboxProof {
  /** The normalised address the redeemed token was issued for. */
  identifier: string;
  /** The requested landing page, if any. */
  callbackUrl: string | undefined;
  /** Answer JSON rather than redirect. */
  asJson: boolean;
}

/** The two buckets a redeem failure counts against (`null`: not counted there). */
interface RedeemKeys {
  /** The per-address bucket (codes only). */
  key: string | null;
  /** The per-client-IP bucket. */
  ipKey: string | null;
}

/** The current time in epoch seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The adapter narrowed to what an email sign-in needs, or `null` when it can't run one. */
function signInAdapter(config: AuthConfig): EmailSignInAdapter | null {
  const adapter = emailFlowAdapter(config, "email") as EmailSignInAdapter | null;
  return typeof adapter?.createUser === "function" ? adapter : null;
}

/**
 * The answer for a config `assertEmailProviderConfig` would have refused at boot (an
 * embedder that skipped it): logged, and a plain `404` like an unknown provider.
 */
function notConfigured(ctx: AuthRouteContext, provider: EmailProvider): Response {
  ctx.options.logger.error(
    `denextAuth: the "${provider.id}" email provider needs an \`adapter\` implementing the ` +
      "verification-token group, getUserByEmail, updateUser and createUser.",
  );
  return json({ error: "unknown provider" }, 404);
}

/**
 * An email sign-in body's string fields — JSON, or a form post (urlencoded or multipart) —
 * read through the shared size + stall cap; nested JSON values and files are dropped. An
 * unusable body is `{}`: a send then sends nothing and a redeem fails like any wrong
 * code — never a `500`.
 */
async function readEmailForm(ctx: AuthRouteContext): Promise<Record<string, string>> {
  const bytes = await readCappedBody(ctx.request, MAX_BODY_BYTES).catch(() => STALLED);
  if (typeof bytes === "symbol") return {};
  const body = bufferedRequest(ctx.request, bytes);
  const isJson = (ctx.request.headers.get("content-type") ?? "").includes("application/json");
  const parsed: unknown = await (isJson ? body.json() : body.formData().then(Object.fromEntries))
    .catch((error: unknown) => {
      ctx.options.logger.debug("denextAuth: refused an email sign-in body", {
        error: String(error),
      });
      return null;
    });
  const entries = parsed && typeof parsed === "object" ? Object.entries(parsed) : [];
  return Object.fromEntries(entries.filter((entry) => typeof entry[1] === "string"));
}

/** `page` carrying `query`, as a same-origin path (a configured absolute page keeps its path). */
function pageWith(config: AuthConfig, page: string, query: Record<string, string>): string {
  const url = new URL(page, "http://denext.invalid");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return sameOriginRedirect(config, null, url.pathname + url.search + url.hash);
}

/** The "check your email" page — also where a code is typed in. */
function noticePage(config: AuthConfig): string {
  return config.pages?.verifyRequest || config.pages?.signIn || "/";
}

/** Where a refused redeem lands, carrying `?error=<code>`. */
function errorLocation(config: AuthConfig, code: string): string {
  return pageWith(config, config.pages?.error || config.pages?.signIn || "/", { error: code });
}

/** The generic `429` both budgets answer with. */
function tooManyAttempts(retryAfter: number): Response {
  return json({ error: "too many attempts" }, 429, { "retry-after": String(retryAfter) });
}

/** The one failure answer every wrong, spent or expired token or code gets. */
function verificationFailed(ctx: AuthRouteContext, asJson: boolean): Response {
  return asJson
    ? json({ error: "invalid code" }, 401)
    : redirect(errorLocation(ctx.config, "Verification"));
}

/** Fire `signInFailed` with the client bucket the limiter counts — it never alters the answer. */
function emitFailure(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  reason: string,
): Promise<void> {
  const trust = { trustForwardedHeaders: ctx.config.trustForwardedHeaders };
  const ip = clientIpBucket(ctx.request, trust);
  return emitAuthEvent(ctx.options, "signInFailed", { provider: provider.id, reason, ip });
}

// ---- send --------------------------------------------------------------------

/** A magic-link mail: the callback URL carrying the token, the address, a same-origin `callbackUrl`. */
async function magicLinkMessage(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  identifier: string,
  origin: string,
  callbackUrl: string | undefined,
): Promise<VerificationRequestParams> {
  const ttl = ctx.options.email.magicMaxAge;
  const { token, expiresAt } = await issueVerificationToken(ctx.config, {
    identifier,
    purpose: "magic",
    ttl,
  });
  const path = `${ctx.options.prefix}callback/${encodeURIComponent(provider.id)}`;
  const url = new URL(tokenLink(origin, path, token, identifier));
  if (callbackUrl) url.searchParams.set("callbackUrl", afterSignIn(ctx.config, callbackUrl));
  return { identifier, url: url.href, token, purpose: "magic", expiresAt };
}

/** A one-time-code mail: the code as `token`; `url` opens the page it is typed into, never carrying it. */
async function codeMessage(
  ctx: AuthRouteContext,
  identifier: string,
  origin: string,
): Promise<VerificationRequestParams> {
  const { otpMaxAge, otpDigits } = ctx.options.email;
  const { token, expiresAt } = await issueVerificationCode(ctx.config, {
    identifier,
    purpose: "otp",
    ttl: otpMaxAge,
    digits: otpDigits,
  });
  const url = new URL(pageWith(ctx.config, noticePage(ctx.config), { email: identifier }), origin);
  return { identifier, url: url.href, token, purpose: "otp", expiresAt };
}

/**
 * Send a link or a code — or, for a list, an invalid address, or an unknown address the
 * provider won't sign up, nothing — and answer identically either way. Without a mailer
 * the answer is unchanged and the misconfiguration goes to `logger.error`.
 */
async function sendSignInEmail(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  adapter: EmailSignInAdapter,
  fields: Record<string, string>,
): Promise<Response> {
  const identifier = normalizeEmailIdentifier(fields.email);
  const send = ctx.config.sendVerificationRequest;
  if (!send) {
    ctx.options.logger.error(
      `denextAuth: the "${provider.id}" provider needs \`sendVerificationRequest\` — no ` +
        "sign-in email was sent.",
    );
  }
  const result = send && identifier
    ? await sendThrottled(ctx.config, {
      adapter,
      send,
      request: ctx.request,
      identifier,
      purpose: provider.mode,
      shouldSend: (user) => user !== undefined || provider.allowSignUp,
      issue: (origin) =>
        provider.mode === "magic"
          ? magicLinkMessage(ctx, provider, identifier, origin, fields.callbackUrl)
          : codeMessage(ctx, identifier, origin),
    })
    : undefined;
  if (result?.throttled) return tooManyAttempts(result.retryAfter ?? 1);
  return wantsJson(ctx.request)
    ? json({ ok: true })
    : redirect(pageWith(ctx.config, noticePage(ctx.config), { sent: "1" }));
}

// ---- redeem ------------------------------------------------------------------

/**
 * The buckets a redeem failure counts against, in the MFA budget: the client IP always
 * (checked at `IP_BUCKET_FACTOR`×), and the address for a code. A link token carries 256
 * bits — nobody guesses one — so a per-address bucket there would buy no brute-force
 * resistance and only let a stranger lock a user out of their own link.
 */
function redeemKeys(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  identifier: string,
): RedeemKeys {
  const keys = subjectBucketKeys("mfa", `${provider.mode}:${identifier}`, ctx.request, ctx.config);
  return { key: provider.mode === "otp" ? keys.key : null, ipKey: keys.ipKey };
}

/** Seconds until the budget refills when either bucket is spent, else `null`. */
async function retryAfterFor(
  limiter: RateLimiter | null,
  keys: RedeemKeys,
): Promise<number | null> {
  if (!limiter) return null;
  const own = keys.key === null ? null : await limiter.lockedOut(keys.key);
  if (own !== null || keys.ipKey === null) return own;
  return await limiter.lockedOut(keys.ipKey, IP_BUCKET_FACTOR);
}

/** Count one failed redeem against every bucket it belongs to. */
async function countFailure(limiter: RateLimiter | null, keys: RedeemKeys): Promise<void> {
  for (const key of [keys.key, keys.ipKey]) {
    if (key !== null) await limiter?.fail(key);
  }
}

/** Consume the presented link token or code for `identifier`, or `null`. */
function redeemSecret(
  config: AuthConfig,
  provider: EmailProvider,
  identifier: string,
  secret: string,
): ReturnType<typeof redeemVerificationToken> {
  if (provider.mode === "magic") {
    return redeemVerificationToken(config, { identifier, purpose: "magic", token: secret });
  }
  // A typed code may keep the grouping the mail rendered it with ("123 456", "123-456").
  const code = secret.replace(/[\s-]/g, "");
  return redeemVerificationCode(config, { identifier, purpose: "otp", token: code });
}

/**
 * Retire the password of an account whose address was never verified, by replacing it
 * with the configured hasher's hash of a random secret nobody holds. The adapter contract
 * has no way to delete a credential (`setCredential` only replaces one); this keeps to its
 * letter — a value `Hasher.hash` produced — so every verifier (the built-in check, or an
 * app's `authorize` over `getCredential`) refuses every password for the account. An
 * adapter that can read a password but not replace one fails the redeem instead.
 */
async function retirePassword(
  options: ResolvedAuthOptions,
  adapter: EmailSignInAdapter,
  userId: string,
): Promise<void> {
  if (!(await adapter.getCredential?.(userId))) return;
  if (!adapter.setCredential) {
    throw new Error(
      "denextAuth: the adapter implements `getCredential` but not `setCredential`, so the " +
        "password of an unverified account can't be retired before its address is verified.",
    );
  }
  await adapter.setCredential(userId, await options.hasher.hash(randomToken(32)));
}

/** Revoke every live bearer API token of `userId` (a no-op without the api-token group). */
async function revokeApiTokens(adapter: EmailSignInAdapter, userId: string): Promise<void> {
  if (!adapter.listApiTokens || !adapter.revokeApiToken) return;
  for (const token of await adapter.listApiTokens(userId)) await adapter.revokeApiToken(token.id);
}

/**
 * The **pre-account-hijacking** defence. An existing account whose `emailVerified` is
 * unset was set up by someone who never proved the mailbox — possibly an attacker who
 * registered the victim's address with a password and is waiting for the victim's first
 * email sign-in to make the account the victim's while that password (and any session or
 * bearer token it earned) still works. So before a redeem marks the address verified,
 * everything that authenticated the account without that proof is retired: the password
 * (`retirePassword`), every bearer API token, and every server-side session
 * (`sessionRevoked`). A stateless cookie session can't be revoked — it lives until it
 * expires, which is warned once. A throw leaves the address unverified: fail closed.
 */
async function evictUnprovenAccess(
  ctx: AuthRouteContext,
  adapter: EmailSignInAdapter,
  userId: string,
): Promise<void> {
  await retirePassword(ctx.options, adapter, userId);
  await revokeApiTokens(adapter, userId);
  await revokeUserSessions(ctx.config, ctx.options, userId);
}

/**
 * Set an existing user's `emailVerified` if it isn't yet — the redeem just proved the
 * mailbox — after retiring the access the unverified account had (`evictUnprovenAccess`).
 */
async function markVerified(
  ctx: AuthRouteContext,
  adapter: EmailSignInAdapter,
  user: AdapterUser,
): Promise<AdapterUser> {
  if (user.emailVerified !== undefined) return user;
  await evictUnprovenAccess(ctx, adapter, user.id);
  const verified = await adapter.updateUser({ id: user.id, emailVerified: nowSeconds() });
  await emitAuthEvent(ctx.options, "emailVerified", { user: verified });
  return verified;
}

/** The user a proven address signs in as: the existing one, a new verified one, or `null`. */
async function findOrCreateUser(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  adapter: EmailSignInAdapter,
  identifier: string,
): Promise<ResolvedSignIn | null> {
  const existing = await adapter.getUserByEmail(identifier);
  if (existing) {
    return { user: toAuthUser(await markVerified(ctx, adapter, existing)), isNewUser: false };
  }
  if (!provider.allowSignUp) return null;
  const created = await adapter.createUser({ email: identifier, emailVerified: nowSeconds() });
  await emitAuthEvent(ctx.options, "createUser", { user: created });
  return { user: toAuthUser(created), isNewUser: true };
}

/**
 * {@link findOrCreateUser} with the adapter's failures contained: a throw (a UNIQUE race
 * between two first sign-ins, a store that went away) is logged, reported as
 * `signInFailed` / `"adapter_error"`, and answered like any other failed redeem.
 */
async function resolveEmailUser(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  adapter: EmailSignInAdapter,
  identifier: string,
): Promise<ResolvedSignIn | null> {
  try {
    return await findOrCreateUser(ctx, provider, adapter, identifier);
  } catch (error) {
    ctx.options.logger.error(
      `denextAuth: the "${provider.id}" sign-in could not be persisted`,
      error,
    );
    await emitFailure(ctx, provider, "adapter_error");
    return null;
  }
}

/** Turn a proven mailbox into a sign-in: resolve the user, run `callbacks.signIn`, finish. */
async function signInByEmail(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  adapter: EmailSignInAdapter,
  proof: MailboxProof,
): Promise<Response> {
  const resolved = await resolveEmailUser(ctx, provider, adapter, proof.identifier);
  if (!resolved) return verificationFailed(ctx, proof.asJson);
  const approved = await applySignInCallback(ctx.config, resolved.user, provider.id);
  if (!approved) {
    await emitFailure(ctx, provider, "access_denied");
    return proof.asJson
      ? json({ error: "access denied" }, 403)
      : redirect(errorLocation(ctx.config, "AccessDenied"));
  }
  return await finishSignIn(ctx, approved, provider.id, {
    isNewUser: resolved.isNewUser,
    returnTo: proof.callbackUrl,
    amr: [provider.mode === "magic" ? "email" : "otp"],
    json: proof.asJson,
  });
}

/** Redeem a link token or a code under the failure budget, then sign the mailbox's owner in. */
async function redeem(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  adapter: EmailSignInAdapter,
  input: RedeemInput,
  asJson: boolean,
): Promise<Response> {
  const identifier = normalizeEmailIdentifier(input.email) ?? "";
  const limiter = mfaLimiter(ctx.config);
  const keys = redeemKeys(ctx, provider, identifier);
  const retryAfter = await retryAfterFor(limiter, keys);
  if (retryAfter !== null) {
    await emitFailure(ctx, provider, "rate_limited");
    return tooManyAttempts(retryAfter);
  }
  const record = await redeemSecret(ctx.config, provider, identifier, input.secret);
  if (!record) {
    await countFailure(limiter, keys);
    await emitFailure(ctx, provider, "invalid_credentials");
    return verificationFailed(ctx, asJson);
  }
  if (keys.key !== null) await limiter?.succeed(keys.key);
  const proof = { identifier: record.identifier, callbackUrl: input.callbackUrl, asJson };
  return await signInByEmail(ctx, provider, adapter, proof);
}

// ---- handlers ----------------------------------------------------------------

/**
 * `POST {basePath}/callback/:provider` for an email provider. With a `token` (a
 * `magicLink()` provider) or a `code` (an `emailOtp()` provider) in the body it
 * **redeems**; otherwise it **sends** a link or code to the body's `email`. Same-origin
 * gated; the body (JSON or a form) is read through the shared size/stall cap.
 *
 * @param ctx The route context.
 * @param provider The email provider the callback names.
 * @returns For a send: `{ ok: true }` or a `303` with `?sent=1` (identical for every
 * address), or a `429`. For a redeem: the sign-in answer (`finishSignIn`), a generic `401`
 * / `303 ?error=Verification`, a `403` / `?error=AccessDenied`, or a `429`. A cross-origin
 * POST is a `403`.
 */
export async function handleEmailRequest(
  ctx: AuthRouteContext,
  provider: EmailProvider,
): Promise<Response> {
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  const adapter = signInAdapter(ctx.config);
  if (!adapter) return notConfigured(ctx, provider);
  const fields = await readEmailForm(ctx);
  const secret = fields[provider.mode === "magic" ? "token" : "code"];
  if (secret === undefined) return await sendSignInEmail(ctx, provider, adapter, fields);
  const input = { email: fields.email, secret, callbackUrl: fields.callbackUrl };
  return await redeem(ctx, provider, adapter, input, wantsJson(ctx.request));
}

/**
 * `GET {basePath}/callback/:provider?token=…&email=…[&callbackUrl=…]` — the magic-link
 * click. Consumes the token and signs the mailbox's owner in (always a redirect). A code
 * provider has no GET: codes are never put in a URL.
 *
 * @param ctx The route context.
 * @param provider The email provider the callback names.
 * @returns A `303` to `afterSignIn` / `callbackUrl` (or `pages.mfa` for a pending
 * session), to the error page with `?error=Verification` / `?error=AccessDenied`, a
 * `429`, or a `405` for a code provider.
 */
export async function handleEmailRedeem(
  ctx: AuthRouteContext,
  provider: EmailProvider,
): Promise<Response> {
  if (provider.mode !== "magic") return json({ error: "method not allowed" }, 405);
  const adapter = signInAdapter(ctx.config);
  if (!adapter) return notConfigured(ctx, provider);
  const query = ctx.url.searchParams;
  const input = {
    email: query.get("email") ?? undefined,
    secret: query.get("token") ?? "",
    callbackUrl: query.get("callbackUrl") ?? undefined,
  };
  return await redeem(ctx, provider, adapter, input, false);
}

/**
 * The email providers' verbs on `{basePath}/callback/:provider`: `GET` is the magic-link
 * click, `POST` the send / redeem. Any other method is the dispatcher's `405`.
 */
export const emailCallbacks: Readonly<
  Record<"GET" | "POST", (ctx: AuthRouteContext, provider: EmailProvider) => Promise<Response>>
> = { GET: handleEmailRedeem, POST: handleEmailRequest };
