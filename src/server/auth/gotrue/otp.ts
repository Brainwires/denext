/**
 * One-time codes and links for `/auth/v1`: email confirmation, magic links and email OTP,
 * recovery, invites, email and phone changes, SMS OTP and reauthentication.
 *
 * One secret gives both forms GoTrue offers: a numeric code (`{{ .Token }}`) and a link hash
 * (`{{ .TokenHash }}`). The link secret is an HMAC of the code under the auth `secret`, and
 * only the SHA-256 of the link secret is stored — so a database read yields neither a usable
 * link nor (without the auth secret) a way to test codes offline. A code is consumed on its
 * first successful use; a newer code for the same address and kind replaces the older one.
 * Attempts are rate-limited per address.
 *
 * @module
 */

import { hmacSign } from "../../session.ts";
import type { AdapterUser } from "../adapter.ts";
import { sha256Hex } from "../hash.ts";
import { base64UrlDecode, base64UrlEncode } from "../oauth.ts";
import { resolveAuthOptions } from "../options.ts";
import { emitAuthEvent } from "../events.ts";
import { GOTRUE_PREFIX, type GoTrueContext, nowSeconds } from "./context.ts";
import {
  type GoTrueSmtpOptions,
  type GoTrueSmtpSender,
  goTrueSmtpSender,
  processGoTrueSmtp,
} from "./smtp-mail.ts";
import { GoTrueError } from "./errors.ts";
import { userJson } from "./user.ts";

/** The MAC domain of a link secret. */
const LINK_DOMAIN = "denext.gotrue.otp-link.v1";

/** Which token space a code belongs to (GoTrue's verification types share some). */
export type OtpKind = "email" | "recovery" | "email_change" | "sms" | "phone_change" | "reauth";

/** The verification types `/verify` takes, and the kind each redeems. */
export const VERIFY_KINDS: Record<string, OtpKind> = {
  signup: "email",
  invite: "email",
  magiclink: "email",
  email: "email",
  recovery: "recovery",
  email_change: "email_change",
  sms: "sms",
  phone_change: "phone_change",
};

/** What a code carries. */
export interface OtpData {
  /** The action that issued it (`signup`, `magiclink`, `invite`, …). */
  action: string;
  /** The user it is for, when one exists. */
  userId?: string;
  /** Where the link lands. */
  redirectTo?: string;
  /** PKCE: the S256 challenge the link's code will be bound to. */
  codeChallenge?: string;
  /** Email OTP sign-up: metadata for the user it creates. */
  data?: Record<string, unknown>;
  /** An email / phone change: the new value. */
  newValue?: string;
  /** A sign-up confirmation: the fingerprint of the password that sign-up chose. */
  pw?: string;
}

/** An issued code. */
export interface IssuedOtp {
  /** The numeric code. */
  otp: string;
  /** The link hash (`<identifier>.<secret>`). */
  tokenHash: string;
  /** Expiry, epoch seconds. */
  expiresAt: number;
}

function secrets(ctx: GoTrueContext): string[] {
  const secret = ctx.config.secret;
  return Array.isArray(secret) ? secret : [secret];
}

function identifierOf(kind: OtpKind, address: string): string {
  return `gotrue:${kind}:${address.toLowerCase()}`;
}

async function linkSecret(secret: string, identifier: string, otp: string): Promise<string> {
  return await hmacSign(`${identifier}:${otp}`, secret, LINK_DOMAIN);
}

function otpLength(ctx: GoTrueContext): number {
  const value = ctx.options.otpLength ?? 6;
  return Number.isFinite(value) ? Math.min(10, Math.max(6, Math.floor(value))) : 6;
}

/** Seconds a code stays valid. */
function otpExpiry(ctx: GoTrueContext): number {
  const value = ctx.options.otpExpiry ?? 3600;
  return Number.isFinite(value) ? Math.min(86_400, Math.max(60, Math.floor(value))) : 3600;
}

function randomDigits(length: number): string {
  // Rejection sampling keeps every digit uniform.
  let out = "";
  const buf = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] < 250) out += String(buf[0] % 10);
  }
  return out;
}

/**
 * Issue a code for an address (replacing any live one of the same kind).
 *
 * @param ctx The context.
 * @param kind The token space.
 * @param address The email (lower-cased) or E.164 phone, or a user id (`reauth`).
 * @param data What the code carries.
 * @returns The code, its link hash and expiry.
 */
export async function issueOtp(
  ctx: GoTrueContext,
  kind: OtpKind,
  address: string,
  data: OtpData,
): Promise<IssuedOtp> {
  const adapter = ctx.adapter;
  if (!adapter.createVerificationToken || !adapter.useVerificationToken) {
    throw new GoTrueError(
      500,
      "unexpected_failure",
      "the auth adapter keeps no verification tokens",
    );
  }
  const identifier = identifierOf(kind, address);
  const otp = randomDigits(otpLength(ctx));
  const secret = await linkSecret(secrets(ctx)[0], identifier, otp);
  const expiresAt = nowSeconds() + otpExpiry(ctx);
  await adapter.createVerificationToken({
    identifier,
    purpose: "otp",
    tokenHash: await sha256Hex(secret),
    expires: expiresAt,
    data: JSON.stringify(data),
  });
  const tokenHash = `${base64UrlEncode(new TextEncoder().encode(identifier))}.${secret}`;
  return { otp, tokenHash, expiresAt };
}

async function consume(
  ctx: GoTrueContext,
  identifier: string,
  secret: string,
): Promise<OtpData | null> {
  const record = await ctx.adapter.useVerificationToken!({
    identifier,
    purpose: "otp",
    tokenHash: await sha256Hex(secret),
  });
  if (!record?.data) return null;
  try {
    const data = JSON.parse(record.data) as OtpData;
    return data && typeof data.action === "string" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Redeem a numeric code (consumed on success). Every configured auth secret is tried, so a
 * code issued before a secret rotation still works.
 *
 * @param ctx The context.
 * @param kind The token space.
 * @param address The address it was sent to.
 * @param otp The code.
 * @returns What the code carried, or `null`.
 */
export async function redeemOtp(
  ctx: GoTrueContext,
  kind: OtpKind,
  address: string,
  otp: string,
): Promise<OtpData | null> {
  if (!/^[0-9]{6,10}$/.test(otp)) return null;
  const identifier = identifierOf(kind, address);
  for (const secret of secrets(ctx)) {
    const data = await consume(ctx, identifier, await linkSecret(secret, identifier, otp));
    if (data) return data;
  }
  return null;
}

/**
 * Redeem a link hash (consumed on success).
 *
 * @param ctx The context.
 * @param kind The token space the link's type names.
 * @param tokenHash The hash.
 * @returns The address and what the code carried, or `null`.
 */
export async function redeemTokenHash(
  ctx: GoTrueContext,
  kind: OtpKind,
  tokenHash: string,
): Promise<{ address: string; data: OtpData } | null> {
  const dot = tokenHash.indexOf(".");
  if (dot <= 0 || tokenHash.length > 512) return null;
  let identifier: string;
  try {
    identifier = new TextDecoder().decode(base64UrlDecode(tokenHash.slice(0, dot)));
  } catch {
    return null;
  }
  const prefix = `gotrue:${kind}:`;
  if (!identifier.startsWith(prefix)) return null;
  const data = await consume(ctx, identifier, tokenHash.slice(dot + 1));
  return data ? { address: identifier.slice(prefix.length), data } : null;
}

/** The verification link for a code. */
export function verifyLink(
  ctx: GoTrueContext,
  tokenHash: string,
  type: string,
  redirectTo: string,
): string {
  const url = new URL(`${ctx.origin}${GOTRUE_PREFIX}/verify`);
  url.searchParams.set("token", tokenHash);
  url.searchParams.set("type", type);
  url.searchParams.set("redirect_to", redirectTo);
  return url.href;
}

/** One SMTP sender per `smtp` options object (built on first use, so a bad setting fails loudly). */
const smtpSenders = new WeakMap<GoTrueSmtpOptions, GoTrueSmtpSender>();

/** The SMTP sender for `options`. */
function smtpSenderOf(ctx: GoTrueContext, options: GoTrueSmtpOptions): GoTrueSmtpSender {
  let sender = smtpSenders.get(options);
  if (!sender) {
    sender = goTrueSmtpSender(options, resolveAuthOptions(ctx.config).logger);
    smtpSenders.set(options, sender);
  }
  return sender;
}

/** The `sendVerificationRequest` purpose an email action maps to. */
function purposeOf(action: string): "email" | "reset" | "magic" | "otp" {
  if (action === "recovery") return "reset";
  if (action === "magiclink") return "magic";
  if (action === "reauthentication") return "otp";
  return "email";
}

/** What {@linkcode sendAuthEmail} is handed. */
interface AuthEmailInput {
  email: string;
  action: string;
  issued: IssuedOtp;
  redirectTo: string;
  user?: AdapterUser;
}

/**
 * Send over SMTP: the `/auth/v1` `smtp` options, else Supabase Auth's `GOTRUE_SMTP_*` settings.
 *
 * @throws {Error} When neither is configured.
 */
async function sendOverSmtp(ctx: GoTrueContext, input: AuthEmailInput, link: string) {
  const smtp = ctx.options.smtp ?? processGoTrueSmtp();
  if (!smtp) {
    throw new Error(
      "no email delivery: set sendVerificationRequest, hooks.sendEmail or GOTRUE_SMTP_*",
    );
  }
  await smtpSenderOf(ctx, smtp).send({
    action: input.action,
    to: input.email,
    confirmationUrl: link,
    token: input.issued.otp,
    tokenHash: input.issued.tokenHash,
    siteUrl: ctx.siteUrl,
    redirectTo: input.redirectTo,
    email: input.user?.email ?? input.email,
    ...(input.action === "email_change" ? { newEmail: input.email } : {}),
  });
}

/**
 * Deliver an auth email: the `sendEmail` hook when configured, else the auth config's
 * `sendVerificationRequest`, else the `/auth/v1` SMTP settings (`GOTRUE_SMTP_*`).
 *
 * @param ctx The context.
 * @param input The address, action, code and link target.
 * @throws {GoTrueError} When no delivery is configured, or it fails.
 */
export async function sendAuthEmail(ctx: GoTrueContext, input: AuthEmailInput): Promise<void> {
  const link = verifyLink(ctx, input.issued.tokenHash, input.action, input.redirectTo);
  const hook = ctx.options.hooks?.sendEmail;
  try {
    if (hook) {
      await hook({
        user: input.user ? await userJson(ctx.adapter, input.user) : { email: input.email },
        email_data: {
          token: input.issued.otp,
          token_hash: input.issued.tokenHash,
          redirect_to: input.redirectTo,
          email_action_type: input.action,
          site_url: ctx.siteUrl,
          action_link: link,
        },
      });
    } else if (ctx.config.sendVerificationRequest) {
      await ctx.config.sendVerificationRequest({
        identifier: input.email,
        url: link,
        token: input.issued.otp,
        purpose: purposeOf(input.action),
        expiresAt: input.issued.expiresAt,
      });
    } else {
      await sendOverSmtp(ctx, input, link);
    }
  } catch (error) {
    resolveAuthOptions(ctx.config).logger.error("/auth/v1: sending an email failed", error);
    throw new GoTrueError(500, "unexpected_failure", "Error sending email");
  }
  await emitAuthEvent(resolveAuthOptions(ctx.config), "verificationRequested", {
    identifier: input.email,
    purpose: purposeOf(input.action),
    expiresAt: input.issued.expiresAt,
  });
}

/** Whether SMS delivery is configured. */
export function canSendSms(ctx: GoTrueContext): boolean {
  return !!(ctx.options.hooks?.sendSms ?? ctx.options.sendSms);
}

/**
 * Deliver an SMS code through the `sendSms` hook (or option).
 *
 * @param ctx The context.
 * @param input The number, code, purpose and channel.
 * @throws {GoTrueError} `sms_send_failed`, or `phone_provider_disabled` with no delivery.
 */
export async function sendAuthSms(
  ctx: GoTrueContext,
  input: {
    phone: string;
    otp: string;
    type: "signup" | "sms" | "phone_change" | "reauthentication" | "mfa";
    channel?: "sms" | "whatsapp";
    user?: AdapterUser;
  },
): Promise<void> {
  const send = ctx.options.hooks?.sendSms ?? ctx.options.sendSms;
  if (!send) throw new GoTrueError(400, "phone_provider_disabled", "Phone logins are disabled");
  try {
    await send({
      phone: input.phone,
      otp: input.otp,
      message: `Your code is ${input.otp}`,
      channel: input.channel ?? "sms",
      type: input.type,
      ...(input.user ? { user: input.user } : {}),
    });
  } catch (error) {
    resolveAuthOptions(ctx.config).logger.error("/auth/v1: sending an SMS failed", error);
    throw new GoTrueError(500, "sms_send_failed", "Error sending SMS");
  }
}
