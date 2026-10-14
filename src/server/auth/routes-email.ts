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
 *   token (Auth.js parity: a mail gateway that pre-fetches links can spend one). Under
 *   `magicLink({ confirm: true })` it consumes nothing: it renders a page naming the address,
 *   whose button POSTs the token back (the redeem above).
 *
 * A redeemed token proves the mailbox: an existing user's unset `emailVerified` is set
 * (firing `emailVerified`) — but first everything set up on that unverified account
 * without the proof (its password, second factor, bearer tokens and server-side sessions)
 * is retired, the pre-account-hijacking defence (`evictUnprovenAccess`); an unknown address becomes a new, already-verified user when
 * the provider allows sign-up (firing `createUser` — no account row is linked: as in
 * Auth.js, the address on the user record is the identity) — unless the request carries a
 * complete anonymous session, whose user is converted instead (it keeps its id, gains the
 * verified address and loses `isAnonymous`; `userConverted` fires). `callbacks.signIn` may then
 * veto it (`?error=AccessDenied`), and the one sign-in tail
 * ({@link ./sign-in-tail.ts | finishSignIn}) decides the MFA step-up, mints the session
 * (`amr: ["email"]` for a link, `["otp"]` for a code) and answers.
 *
 * With `captcha` configured a send needs a solved captcha token first; a redeem does not.
 *
 * The `Authorization` header is never read, and every POST is same-origin gated.
 *
 * @module
 */

import type { AuthAdapter } from "./adapter.ts";
import { type ResolvedSignIn, toAuthUser } from "./adapter-link.ts";
import { captchaRefusal } from "./captcha.ts";
import {
  type EmailFlowAdapter,
  emailFlowAdapter,
  mailerOf,
  markVerified,
  sendThrottled,
  tokenLink,
} from "./email.ts";
import { type AttemptKeys, subjectBucketKeys } from "./rate-limit.ts";
import { convertOrCreateUser, hasConvertibleSession } from "./routes-anonymous.ts";
import { isSsoUser } from "./sso-user.ts";
import {
  errorLocation,
  noticePage,
  pageWith,
  readSignInForm,
  redeemAndSignIn,
  sentAnswer,
} from "./routes-passwordless.ts";
import {
  afterSignIn,
  type AuthRouteContext,
  isSameOrigin,
  json,
  redirect,
  wantsJson,
} from "./routes-shared.ts";
import type { AuthConfig, EmailProvider, VerificationRequestParams } from "./types.ts";
import {
  issueVerificationCode,
  issueVerificationToken,
  normalizeEmailIdentifier,
  redeemVerificationCode,
  redeemVerificationToken,
} from "./verification.ts";

/**
 * The adapter surface an email sign-in needs — the email-flow group plus `createUser` —
 * and, where the adapter has them, the credentials, MFA and API-token methods a first
 * verification retires.
 */
type EmailSignInAdapter =
  & EmailFlowAdapter
  & Pick<AuthAdapter, "createUser">
  & Partial<Pick<AuthAdapter, "getCredential" | "getMfa" | "listApiTokens" | "revokeApiToken">>;

/** What a redeem is handed, from a body or the link's query. */
interface RedeemInput {
  /** The submitted address. */
  email: string | undefined;
  /** The presented token (magic) or code (otp). */
  secret: string;
  /** The requested landing page, if any. */
  callbackUrl: string | undefined;
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
  const send = mailerOf(ctx.config);
  if (!send) {
    ctx.options.logger.error(
      `denextAuth: the "${provider.id}" provider needs \`sendVerificationRequest\` (or ` +
        "`hooks.sendEmail`) — no sign-in email was sent.",
    );
  }
  // An anonymous session converts on redeem, so its proof is sent even without sign-up.
  const signUp = provider.allowSignUp || await hasConvertibleSession(ctx);
  const result = send && identifier
    ? await sendThrottled(ctx.config, {
      adapter,
      send,
      request: ctx.request,
      identifier,
      purpose: provider.mode,
      shouldSend: (user) => user !== undefined || signUp,
      issue: (origin) =>
        provider.mode === "magic"
          ? magicLinkMessage(ctx, provider, identifier, origin, fields.callbackUrl)
          : codeMessage(ctx, identifier, origin),
    })
    : undefined;
  return sentAnswer(ctx, result);
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
): AttemptKeys {
  const keys = subjectBucketKeys("mfa", `${provider.mode}:${identifier}`, ctx.request, ctx.config);
  return { key: provider.mode === "otp" ? keys.key : null, ipKey: keys.ipKey };
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
 * The user a proven address signs in as: the existing one; else the signed-in anonymous user,
 * converted (it keeps its id — even under `allowSignUp: false`, since it exists already); else
 * a new verified one when the provider allows sign-up; else `null`.
 */
async function findOrCreateUser(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  adapter: EmailSignInAdapter,
  identifier: string,
): Promise<ResolvedSignIn | null> {
  const existing = await adapter.getUserByEmail(identifier);
  // An SSO user signs in through its identity provider only — and its address is not free for
  // a new account either.
  if (existing && isSsoUser(existing)) return null;
  if (existing) {
    return {
      user: toAuthUser(await markVerified(ctx.config, ctx.options, adapter, existing)),
      isNewUser: false,
    };
  }
  const proof = { email: identifier, emailVerified: nowSeconds() };
  return await convertOrCreateUser(ctx, adapter, proof, provider);
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
  return await redeemAndSignIn(ctx, provider.id, {
    keys: redeemKeys(ctx, provider, identifier),
    consume: () => redeemSecret(ctx.config, provider, identifier, input.secret),
    resolve: (proven) => findOrCreateUser(ctx, provider, adapter, proven),
    callbackUrl: input.callbackUrl,
    asJson,
    amr: [provider.mode === "magic" ? "email" : "otp"],
  });
}

// ---- handlers ----------------------------------------------------------------

/**
 * `POST {basePath}/callback/:provider` for an email provider. With a `token` (a
 * `magicLink()` provider) or a `code` (an `emailOtp()` provider) in the body it
 * **redeems**; otherwise it **sends** a link or code to the body's `email` — after the
 * captcha check when `captcha` is configured. Same-origin gated; the body (JSON or a form)
 * is read through the shared size/stall cap.
 *
 * @param ctx The route context.
 * @param provider The email provider the callback names.
 * @returns For a send: `{ ok: true }` or a `303` with `?sent=1` (identical for every
 * address), a `429`, or a captcha refusal. For a redeem: the sign-in answer
 * (`finishSignIn`), a generic `401` / `303 ?error=Verification`, a `403` /
 * `?error=AccessDenied`, or a `429`. A cross-origin POST is a `403`.
 */
export async function handleEmailRequest(
  ctx: AuthRouteContext,
  provider: EmailProvider,
): Promise<Response> {
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  const adapter = signInAdapter(ctx.config);
  if (!adapter) return notConfigured(ctx, provider);
  const fields = await readSignInForm(ctx);
  const secret = fields[provider.mode === "magic" ? "token" : "code"];
  if (secret === undefined) {
    return await captchaRefusal(ctx, fields, provider.id) ??
      await sendSignInEmail(ctx, provider, adapter, fields);
  }
  const input = { email: fields.email, secret, callbackUrl: fields.callbackUrl };
  return await redeem(ctx, provider, adapter, input, wantsJson(ctx.request));
}

/**
 * `GET {basePath}/callback/:provider?token=…&email=…[&callbackUrl=…]` — the magic-link
 * click. Consumes the token and signs the mailbox's owner in (always a redirect) — or, for a
 * `magicLink({ confirm: true })` provider, renders the confirmation page and consumes
 * nothing. A code provider has no GET: codes are never put in a URL.
 *
 * @param ctx The route context.
 * @param provider The email provider the callback names.
 * @returns A `303` to `afterSignIn` / `callbackUrl` (or `pages.mfa` for a pending
 * session), to the error page with `?error=Verification` / `?error=AccessDenied`, a
 * `429`, the `200` confirmation page, or a `405` for a code provider.
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
  if (provider.confirm) return await confirmPage(ctx, provider, input);
  return await redeem(ctx, provider, adapter, input, false);
}

// ---- the confirmation page -----------------------------------------------------

/** The confirmation page's only style sheet — allowed by its hash, so the CSP stays `'none'`. */
const CONFIRM_STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;" +
  "min-height:100vh;background:#f6f6f7;color:#18181b}main{max-width:24rem;padding:2rem;" +
  "background:#fff;border-radius:12px;box-shadow:0 1px 3px #0002}h1{font-size:1.25rem;" +
  "margin:0 0 .5rem}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:8px;" +
  "background:#18181b;color:#fff;cursor:pointer}p.note{color:#71717a;font-size:.875rem}" +
  "@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:" +
  "#18181b}button{background:#fafafa;color:#18181b}}";

/** `'sha256-…'` of {@link CONFIRM_STYLE}, computed once. */
let confirmStyleHash: Promise<string> | undefined;

/** The CSP source for the confirmation page's `<style>`. */
function styleHash(): Promise<string> {
  confirmStyleHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(CONFIRM_STYLE))
    .then((digest) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
  return confirmStyleHash;
}

/** Escape text for an HTML text node or a double-quoted attribute. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The `magicLink({ confirm: true })` page: the address the link signs in as, and a form that
 * POSTs the token (plus `email` and `callbackUrl`) back to this callback, where the redeem
 * spends it under the same-origin gate and the failure budget. Rendering it spends nothing
 * and reads nothing from the adapter, so a link scanner's GET is harmless.
 *
 * Every value is HTML-escaped (the query is attacker-controlled). The page is `no-store`,
 * can't be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY` — no clickjacking the
 * button), runs no script (`default-src 'none'`, the style allowed by hash), may post only to
 * this origin (`form-action 'self'`), and sends `Referrer-Policy: same-origin` — the URL
 * carries the token, so it must not leak cross-origin, while the form's POST must still carry
 * this origin in `Origin` (`no-referrer` would make that `null` and fail the gate).
 */
async function confirmPage(
  ctx: AuthRouteContext,
  provider: EmailProvider,
  input: RedeemInput,
): Promise<Response> {
  const email = normalizeEmailIdentifier(input.email);
  if (!email || !input.secret) return redirect(errorLocation(ctx.config, "Verification"));
  const action = `${ctx.options.prefix}callback/${encodeURIComponent(provider.id)}`;
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const fields = [
    hidden("email", email),
    hidden("token", input.secret),
    ...(input.callbackUrl ? [hidden("callbackUrl", input.callbackUrl)] : []),
  ].join("");
  const html = "<!doctype html>" +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Confirm sign-in</title>' +
    `<style>${CONFIRM_STYLE}</style></head><body><main><h1>Sign in</h1>` +
    `<p>Continue as <strong>${escapeHtml(email)}</strong>?</p>` +
    `<form method="post" action="${escapeHtml(action)}">${fields}` +
    '<button type="submit">Sign in</button></form>' +
    '<p class="note">If you didn\'t ask to sign in, close this page.</p></main></body></html>';
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; style-src ${await styleHash()}; ` +
        "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

/**
 * The email providers' verbs on `{basePath}/callback/:provider`: `GET` is the magic-link
 * click, `POST` the send / redeem. Any other method is the dispatcher's `405`.
 */
export const emailCallbacks: Readonly<
  Record<"GET" | "POST", (ctx: AuthRouteContext, provider: EmailProvider) => Promise<Response>>
> = { GET: handleEmailRedeem, POST: handleEmailRequest };
