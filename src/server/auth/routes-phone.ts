/**
 * `{basePath}/callback/:provider` for the passwordless **phone provider**
 * ({@link ./providers-phone.ts | phoneOtp}):
 *
 * - `POST { phone, callbackUrl? }` — **send**. The number is normalised to exactly ONE E.164
 *   number; anything else sends nothing and gets the same answer a real send gets. With
 *   `captcha` configured a solved captcha token comes first. A send spends the per-number +
 *   per-IP verification budget before the number is looked up, so a `429` is as blind to
 *   existence as a `200`; an unknown number under `allowSignUp: false` gets no text,
 *   comparable work and the identical answer. The code goes out through `hooks.sendSms` /
 *   `sendSms` after the response. A JSON client gets `{ ok: true }`, a form a `303` to
 *   `pages.verifyRequest` (else `pages.signIn`, else `/`) with `?sent=1`.
 * - `POST { phone, code }` — **redeem**. Failures count against the MFA budget (5 per 5
 *   minutes) per number and per client IP. Every failure is the same
 *   `401 { error: "invalid code" }` (a form: a `303` to `pages.error`, else `pages.signIn`,
 *   with `?error=Verification`); past the budget, a `429`.
 * - No GET (`405`): a code never rides a URL.
 *
 * A redeemed code proves the number: an existing user (`getUserByPhone`) whose `phoneVerified`
 * is unset first has everything set up without the proof retired — its password, second
 * factors, passkeys, bearer tokens and server-side sessions (the pre-account-hijacking
 * eviction, `markPhoneVerified`) — then is marked verified (`phoneVerified` fires). A number
 * with no account converts the request's complete anonymous session, if any (`userConverted`),
 * else becomes a new user `{ phone, phoneVerified }` when the provider allows sign-up
 * (`createUser`). `callbacks.signIn` may veto it, and the one sign-in tail decides the MFA
 * step-up and mints the session (`amr: ["sms"]`).
 *
 * The `Authorization` header is never read, and every POST is same-origin gated.
 *
 * @module
 */

import type { AdapterUser, AuthAdapter } from "./adapter.ts";
import { type ResolvedSignIn, toAuthUser } from "./adapter-link.ts";
import { captchaRefusal } from "./captcha.ts";
import { markPhoneVerified, throttledDispatch } from "./email.ts";
import { normalizePhoneNumber } from "./phone.ts";
import { subjectBucketKeys } from "./rate-limit.ts";
import { convertOrCreateUser, hasConvertibleSession } from "./routes-anonymous.ts";
import { readSignInForm, redeemAndSignIn, sentAnswer } from "./routes-passwordless.ts";
import { type AuthRouteContext, isSameOrigin, json, wantsJson } from "./routes-shared.ts";
import { deliverSmsCode, smsSenderOf } from "./sms.ts";
import type { PhoneProvider } from "./types.ts";
import {
  issueVerificationCode,
  redeemVerificationCode,
  verificationAdapter,
} from "./verification.ts";

/** The adapter surface a phone sign-in needs. */
type PhoneSignInAdapter =
  & Required<
    Pick<
      AuthAdapter,
      "createVerificationToken" | "useVerificationToken" | "getUserByPhone"
    >
  >
  & Pick<AuthAdapter, "createUser" | "updateUser">
  & Partial<
    Pick<
      AuthAdapter,
      | "getUser"
      | "getCredential"
      | "setCredential"
      | "getMfa"
      | "listApiTokens"
      | "revokeApiToken"
      | "listPasskeys"
      | "deletePasskey"
    >
  >;

/** The current time in epoch seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The adapter narrowed to what a phone sign-in needs, or `null` when it can't run one. */
function signInAdapter(ctx: AuthRouteContext): PhoneSignInAdapter | null {
  const adapter = ctx.options.adapter;
  if (!verificationAdapter(ctx.config) || !adapter) return null;
  const ok = typeof adapter.getUserByPhone === "function" &&
    typeof adapter.createUser === "function" && typeof adapter.updateUser === "function";
  return ok ? adapter as PhoneSignInAdapter : null;
}

/**
 * The answer for a config `assertPhoneProviderConfig` would have refused at boot (an embedder
 * that skipped it): logged, and a plain `404` like an unknown provider.
 */
function notConfigured(ctx: AuthRouteContext, provider: PhoneProvider): Response {
  ctx.options.logger.error(
    `denextAuth: the "${provider.id}" phone provider needs an \`adapter\` implementing the ` +
      "verification-token group, getUserByPhone, updateUser and createUser.",
  );
  return json({ error: "unknown provider" }, 404);
}

// ---- send --------------------------------------------------------------------

/** Mint a code for `phone` and hand it to the SMS sender (after the response). */
async function textCode(
  ctx: AuthRouteContext,
  phone: string,
  user: AdapterUser | undefined,
): Promise<void> {
  const send = smsSenderOf(ctx.config);
  if (!send) return;
  const { otpMaxAge, otpDigits } = ctx.options.email;
  const { token, expiresAt } = await issueVerificationCode(ctx.config, {
    identifier: phone,
    purpose: "sms",
    ttl: otpMaxAge,
    digits: otpDigits,
  });
  const message = {
    phone,
    otp: token,
    message: `Your code is ${token}`,
    channel: "sms" as const,
    type: "sms" as const,
    ...(user ? { user } : {}),
  };
  await deliverSmsCode(ctx.options, send, message, expiresAt);
}

/**
 * Text a code — or, for an invalid number or an unknown number the provider won't sign up,
 * nothing — and answer identically either way. Without an SMS sender the answer is unchanged
 * and the misconfiguration goes to `logger.error`.
 */
async function sendSignInCode(
  ctx: AuthRouteContext,
  provider: PhoneProvider,
  adapter: PhoneSignInAdapter,
  fields: Record<string, string>,
): Promise<Response> {
  const phone = normalizePhoneNumber(fields.phone);
  if (!smsSenderOf(ctx.config)) {
    ctx.options.logger.error(
      `denextAuth: the "${provider.id}" provider needs \`sendSms\` (or \`hooks.sendSms\`) — ` +
        "no sign-in code was sent.",
    );
  }
  // An anonymous session converts on redeem, so its proof is sent even without sign-up.
  const signUp = provider.allowSignUp || await hasConvertibleSession(ctx);
  const result = phone && smsSenderOf(ctx.config)
    ? await throttledDispatch(ctx.config, {
      identifier: phone,
      purpose: "sms",
      request: ctx.request,
      tokens: adapter,
      lookup: (identifier) => adapter.getUserByPhone(identifier),
      shouldSend: (user) => user !== undefined || signUp,
      dispatch: (user) => textCode(ctx, phone, user),
    })
    : undefined;
  return sentAnswer(ctx, result);
}

// ---- redeem ------------------------------------------------------------------

/**
 * The user a proven number signs in as: the existing one (marked phone-verified, after the
 * eviction); else the signed-in anonymous user, converted; else a new phone-verified one when
 * the provider allows sign-up; else `null`.
 */
async function findOrCreateUser(
  ctx: AuthRouteContext,
  provider: PhoneProvider,
  adapter: PhoneSignInAdapter,
  phone: string,
): Promise<ResolvedSignIn | null> {
  const existing = await adapter.getUserByPhone(phone);
  if (existing) {
    const verified = await markPhoneVerified(ctx.config, ctx.options, adapter, existing);
    return { user: toAuthUser(verified), isNewUser: false };
  }
  const proof = { phone, phoneVerified: nowSeconds() };
  return await convertOrCreateUser(ctx, adapter, proof, provider);
}

/** Redeem a code under the failure budget, then sign the number's owner in. */
async function redeem(
  ctx: AuthRouteContext,
  provider: PhoneProvider,
  adapter: PhoneSignInAdapter,
  fields: Record<string, string>,
): Promise<Response> {
  const phone = normalizePhoneNumber(fields.phone) ?? "";
  // A typed code may keep the grouping the text rendered it with ("123 456", "123-456").
  const code = fields.code.replace(/[\s-]/g, "");
  return await redeemAndSignIn(ctx, provider.id, {
    keys: subjectBucketKeys("mfa", `sms:${phone}`, ctx.request, ctx.config),
    consume: () =>
      redeemVerificationCode(ctx.config, { identifier: phone, purpose: "sms", token: code }),
    resolve: (proven) => findOrCreateUser(ctx, provider, adapter, proven),
    callbackUrl: fields.callbackUrl,
    asJson: wantsJson(ctx.request),
    amr: ["sms"],
  });
}

// ---- handler -----------------------------------------------------------------

/**
 * `POST {basePath}/callback/:provider` for a phone provider: with a `code` in the body it
 * **redeems**; otherwise it **sends** a code to the body's `phone`. Same-origin gated; the body
 * (JSON or a form) is read through the shared size/stall cap.
 *
 * @param ctx The route context.
 * @param provider The phone provider the callback names.
 * @returns For a send: `{ ok: true }` or a `303` with `?sent=1` (identical for every number), a
 * `429`, or a captcha refusal. For a redeem: the sign-in answer, a generic `401` / `303
 * ?error=Verification`, a `403` / `?error=AccessDenied`, or a `429`. A cross-origin POST is a
 * `403`.
 */
async function handlePhoneRequest(
  ctx: AuthRouteContext,
  provider: PhoneProvider,
): Promise<Response> {
  if (!isSameOrigin(ctx.request, ctx.config)) return json({ error: "forbidden" }, 403);
  const adapter = signInAdapter(ctx);
  if (!adapter) return notConfigured(ctx, provider);
  const fields = await readSignInForm(ctx);
  if (fields.code !== undefined) return await redeem(ctx, provider, adapter, fields);
  return await captchaRefusal(ctx, fields, provider.id) ??
    await sendSignInCode(ctx, provider, adapter, fields);
}

/**
 * The phone provider's verbs on `{basePath}/callback/:provider`: `POST` only (send / redeem).
 * A GET — or any other method — is the dispatcher's `405`.
 */
export const phoneCallbacks: Readonly<
  Record<"POST", (ctx: AuthRouteContext, provider: PhoneProvider) => Promise<Response>>
> = { POST: handlePhoneRequest };
