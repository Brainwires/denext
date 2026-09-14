/**
 * **Email verification** and **password reset** — the two flows built on
 * {@link ./verification.ts | verification tokens} and the app's `sendVerificationRequest`
 * (denext ships no mailer).
 *
 * The properties both flows keep:
 * - **No existence oracle.** Asking for a reset link for an unknown address resolves
 *   exactly like asking for one for a real account: no error, no different answer, and
 *   comparable work — an unknown address still runs the token hashing and one adapter
 *   round-trip (a no-op redemption of a random hash) instead of the store. Delivery runs
 *   after the response inside a request (`after()`), so the mailer's latency can't tell
 *   the two apart either, and a delivery failure is logged, never thrown.
 * - **Throttled per address and per client** by the verification limiter (3 per 15
 *   minutes by default). The budget is spent before the address is looked up, so a
 *   throttled unknown address and a throttled real one are indistinguishable too.
 * - **One recipient.** The address is normalised to exactly one address or refused — a
 *   list is never split into several sends.
 * - **Links are built on `canonicalOrigin`.** Outside production a request's own origin
 *   is accepted as a fallback; in production a link is never derived from the
 *   attacker-controllable `Host` header (a forged one would mail a victim a live reset
 *   token pointing at the attacker's site).
 * - A completed reset **revokes every server-side session** of the user.
 *
 * The send path ({@linkcode sendThrottled}) is shared with the passwordless magic-link and
 * one-time-code sign-in ({@link ./routes-email.ts | routes-email.ts}), so those inherit
 * every property above.
 *
 * @module
 */

import { requestOrigin } from "../absolute-url.ts";
import { after, currentContext } from "../request-context.ts";
import { isProductionEnv } from "../session.ts";
import type { AdapterUser, AuthAdapter, VerificationPurpose } from "./adapter.ts";
import { emitAuthEvent } from "./events.ts";
import { sha256Hex } from "./hash.ts";
import { randomToken } from "./oauth.ts";
import { resolveAuthOptions, type ResolvedAuthOptions } from "./options.ts";
import { consumeHitBudget, subjectBucketKeys, verificationLimiter } from "./rate-limit.ts";
import type { AuthConfig, SendVerificationRequest, VerificationRequestParams } from "./types.ts";
import {
  issueVerificationToken,
  normalizeEmailIdentifier,
  redeemVerificationToken,
  verificationAdapter,
  type VerificationTokenAdapter,
} from "./verification.ts";

/** Which emailed-token flow a call belongs to. */
export type EmailFlow = "email" | "reset";

/** The adapter surface one email flow needs (reset also writes the password hash). */
export type EmailFlowAdapter =
  & VerificationTokenAdapter
  & Pick<AuthAdapter, "getUserByEmail" | "updateUser">
  & Partial<Pick<AuthAdapter, "setCredential">>;

/** What a verification or reset request reports — never whether the address exists. */
export interface EmailRequestResult {
  /** `true` when the address's (or the client's) send budget is spent; nothing was sent. */
  throttled: boolean;
  /** Seconds until the budget refills, when throttled. */
  retryAfter?: number;
}

/** What {@linkcode resetPassword} reports. */
export type ResetPasswordResult =
  | {
    /** The password was replaced. */
    ok: true;
    /** The user whose password changed. */
    user: AdapterUser;
  }
  | {
    /** Nothing changed. */
    ok: false;
    /**
     * `"invalid_token"`: no live reset token for that address (wrong, spent, expired, or an
     * address with no account — deliberately one answer). `"invalid_password"`: the new
     * password was refused before the token was touched, so the link still works.
     */
    error: "invalid_token" | "invalid_password";
  };

/** The shortest new password a reset accepts (NIST SP 800-63B's floor). */
const MIN_PASSWORD_LENGTH = 8;
/** The longest one — bounds the hashing work a single request can ask for. */
const MAX_PASSWORD_LENGTH = 1024;
/** Returned whenever a request went through (sent, or deliberately not). */
const NOT_THROTTLED: EmailRequestResult = { throttled: false };
/** Configs already warned that a revocation could not reach their stateless sessions. */
const warnedStateless = new WeakSet<AuthConfig>();

/** The current time in epoch seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The adapter narrowed to what `flow` needs, or `null` when the app's adapter can't run
 * it — the verification-token group, plus `setCredential` for a reset.
 *
 * @param config The app's auth config.
 * @param flow Which flow is asking.
 * @returns The adapter, or `null` when the flow isn't configured.
 */
export function emailFlowAdapter(config: AuthConfig, flow: EmailFlow): EmailFlowAdapter | null {
  const tokens = verificationAdapter(config);
  const adapter = resolveAuthOptions(config).adapter;
  if (!tokens || !adapter) return null;
  if (flow === "reset" && !adapter.setCredential) return null;
  return adapter as EmailFlowAdapter;
}

/** {@link emailFlowAdapter}, or an actionable error naming the missing adapter methods. */
function requireFlowAdapter(config: AuthConfig, flow: EmailFlow, fn: string): EmailFlowAdapter {
  const adapter = emailFlowAdapter(config, flow);
  if (adapter) return adapter;
  const needs = flow === "reset"
    ? "createVerificationToken / useVerificationToken / setCredential"
    : "createVerificationToken / useVerificationToken";
  throw new Error(
    `${fn}: this flow needs a denextAuth \`adapter\` implementing ${needs} — pass e.g. ` +
      "`adapter: inMemoryAuthAdapter()` or `adapter: sqliteAuthAdapter({ path })`.",
  );
}

/** The configured mailer, or an actionable error: the sending flows refuse to start without one. */
function requireMailer(config: AuthConfig, fn: string): SendVerificationRequest {
  if (config.sendVerificationRequest) return config.sendVerificationRequest;
  throw new Error(
    `${fn}: denext ships no mailer — pass \`sendVerificationRequest\` to denextAuth ` +
      "(it receives { identifier, url, token, purpose, expiresAt } for every outbound token).",
  );
}

/**
 * The origin emailed links are built on: `canonicalOrigin`, else (outside production
 * only) the request's own origin. Resolved BEFORE the address is looked up, so a
 * misconfiguration fails the same way for every address.
 */
function linkOrigin(config: AuthConfig, request: Request | undefined): string {
  if (config.canonicalOrigin) return config.canonicalOrigin;
  if (request && !isProductionEnv()) {
    return requestOrigin(request, { trustForwardedHeaders: config.trustForwardedHeaders });
  }
  throw new Error(
    "denextAuth: emailed links need `canonicalOrigin` — a link derived from the request's " +
      "Host header would let a forged header mail users a live token pointing at another site.",
  );
}

/**
 * The absolute link for a token: `path` on `origin`, carrying the token and the address.
 *
 * @param origin The origin emailed links are built on (the `canonicalOrigin` rule).
 * @param path The same-origin path the link opens.
 * @param token The plaintext token.
 * @param identifier The normalised address.
 * @returns The absolute URL.
 */
export function tokenLink(
  origin: string,
  path: string,
  token: string,
  identifier: string,
): string {
  const url = new URL(path, origin);
  url.searchParams.set("token", token);
  url.searchParams.set("email", identifier);
  return url.href;
}

/**
 * Hand one message to the mailer. Inside a request it runs after the response
 * (`after()`), so how long the mailer takes can't reveal that an address exists; outside
 * one it is awaited. A delivery failure is logged — without the token or the link — and
 * never thrown, for the same reason.
 */
function deliver(
  options: ResolvedAuthOptions,
  send: SendVerificationRequest,
  params: VerificationRequestParams,
): Promise<void> {
  const job = async (): Promise<void> => {
    try {
      await send(params);
    } catch (error) {
      options.logger.error(
        `denextAuth: sendVerificationRequest failed for a "${params.purpose}" token`,
        error,
      );
      return;
    }
    await emitAuthEvent(options, "verificationRequested", {
      identifier: params.identifier,
      purpose: params.purpose,
      expiresAt: params.expiresAt,
    });
  };
  if (!currentContext()) return job();
  after(job);
  return Promise.resolve();
}

/** What {@linkcode startEmailFlow} is handed. */
export interface StartEmailFlowOptions {
  /** Which flow — decides the token space, the lifetime and the link target. */
  flow: EmailFlow;
  /** The normalised address (from {@link normalizeEmailIdentifier}). */
  identifier: string;
  /** The incoming request, when there is one (the IP bucket and the dev link origin). */
  request?: Request;
  /** The adapter, from {@link emailFlowAdapter}. */
  adapter: EmailFlowAdapter;
  /** The app's mailer. */
  send: SendVerificationRequest;
}

/** What {@linkcode sendThrottled} is handed. */
export interface ThrottledSendOptions {
  /** The normalised address (from {@link normalizeEmailIdentifier}). */
  identifier: string;
  /** The token space a send issues into — also what the no-send path's dummy round-trip names. */
  purpose: VerificationPurpose;
  /** The incoming request, when there is one (the IP bucket and the dev link origin). */
  request?: Request;
  /** The adapter, from {@link emailFlowAdapter}. */
  adapter: EmailFlowAdapter;
  /** The app's mailer. */
  send: SendVerificationRequest;
  /**
   * Whether the looked-up address gets mail (`user` is `undefined` for an address with no
   * account). `false` does comparable dummy work instead, so the two can't be told apart.
   */
  shouldSend(user: AdapterUser | undefined): boolean;
  /** Mint the token and build the message, with its link on `origin`. */
  issue(origin: string): Promise<VerificationRequestParams>;
}

/**
 * The send path every emailed-token flow shares (email verification, password reset,
 * magic link, one-time code): resolve the link origin, spend the send budget, look the
 * address up, then either issue + deliver a token or do the equivalent dummy work —
 * hashing a fresh token and making one adapter round-trip that matches nothing, where the
 * real path hashes and stores. Callers have already validated the address and the
 * configuration.
 *
 * @param config The app's auth config.
 * @param input The address, the budget inputs, the adapter, the mailer and the flow's two
 * decisions (whether to send, and what).
 * @returns Whether the request was throttled — identical for known and unknown addresses.
 */
export async function sendThrottled(
  config: AuthConfig,
  input: ThrottledSendOptions,
): Promise<EmailRequestResult> {
  const origin = linkOrigin(config, input.request);
  const keys = subjectBucketKeys("verify", input.identifier, input.request, config);
  const retryAfter = await consumeHitBudget(verificationLimiter(config), keys);
  if (retryAfter !== null) return { throttled: true, retryAfter };
  const user = await input.adapter.getUserByEmail(input.identifier);
  if (!input.shouldSend(user)) {
    const tokenHash = await sha256Hex(randomToken(32));
    await input.adapter.useVerificationToken({
      identifier: input.identifier,
      purpose: input.purpose,
      tokenHash,
    });
    return NOT_THROTTLED;
  }
  await deliver(resolveAuthOptions(config), input.send, await input.issue(origin));
  return NOT_THROTTLED;
}

/**
 * The core both request functions (and `POST {basePath}/reset`) share: spend the send
 * budget, look the address up, then either issue + deliver a token or do the equivalent
 * dummy work. Callers have already validated the address and the configuration.
 *
 * An address with no account gets no token and no mail; so does an email-verification
 * request for an address that is already verified.
 *
 * @param config The app's auth config.
 * @param input The flow, address, request, adapter and mailer.
 * @returns Whether the request was throttled — identical for known and unknown addresses.
 */
export async function startEmailFlow(
  config: AuthConfig,
  input: StartEmailFlowOptions,
): Promise<EmailRequestResult> {
  const options = resolveAuthOptions(config);
  const reset = input.flow === "reset";
  return await sendThrottled(config, {
    identifier: input.identifier,
    purpose: input.flow,
    request: input.request,
    adapter: input.adapter,
    send: input.send,
    shouldSend: (user) => user !== undefined && (reset || user.emailVerified === undefined),
    issue: async (origin) => {
      const { token, expiresAt } = await issueVerificationToken(config, {
        identifier: input.identifier,
        purpose: input.flow,
        ttl: reset ? options.email.resetMaxAge : options.email.verifyMaxAge,
      });
      const path = reset ? options.email.resetPath : options.email.verifyPath;
      const url = tokenLink(origin, path, token, input.identifier);
      return { identifier: input.identifier, url, token, purpose: input.flow, expiresAt };
    },
  });
}

/**
 * Email a verification link to a user (or an address). The link opens
 * `email.verifyPath` (default `{basePath}/verify`, which verifies and redirects).
 *
 * Resolves normally — sending nothing — for an address with no account, an
 * already-verified one, or a value that isn't exactly one address. Throws only for a
 * misconfiguration: no `sendVerificationRequest`, or an adapter without the
 * verification-token group.
 *
 * @param config The app's auth config.
 * @param userOrEmail The user record (its `email` is used) or the address.
 * @returns Whether the request was throttled.
 */
export async function requestEmailVerification(
  config: AuthConfig,
  userOrEmail: Pick<AdapterUser, "email"> | string,
): Promise<EmailRequestResult> {
  const adapter = requireFlowAdapter(config, "email", "requestEmailVerification");
  const send = requireMailer(config, "requestEmailVerification");
  const identifier = normalizeEmailIdentifier(
    typeof userOrEmail === "string" ? userOrEmail : userOrEmail.email,
  );
  if (!identifier) return NOT_THROTTLED;
  const request = currentContext()?.request;
  return await startEmailFlow(config, { flow: "email", identifier, request, adapter, send });
}

/**
 * Redeem an email-verification token and mark the address verified (`emailVerified`,
 * epoch seconds, through `adapter.updateUser`). Fires `emailVerified`.
 *
 * Unlike a first magic-link / one-time-code sign-in, this does **not** retire the
 * account's password or revoke its sessions. In the normal register → verify → sign-in
 * flow the password was set by the very person now proving the mailbox, so wiping it
 * would break that flow; and verifying signs nobody in, so the mailbox owner gains no
 * access here. The residual risk is a victim confirming an account someone else
 * registered with their address — it then counts as verified (a later OAuth sign-in with
 * that address links to it) — so word the mail to say that ignoring it is safe.
 *
 * @param config The app's auth config.
 * @param input The address and the presented token.
 * @returns The updated user, or `null` for any failure (wrong, spent or expired token; an
 * address whose account is gone). Throws only when the adapter lacks the token group.
 */
export async function verifyEmail(
  config: AuthConfig,
  input: { email: string; token: string },
): Promise<AdapterUser | null> {
  const adapter = requireFlowAdapter(config, "email", "verifyEmail");
  const record = await redeemVerificationToken(config, {
    identifier: input.email,
    purpose: "email",
    token: input.token,
  });
  const user = record ? await adapter.getUserByEmail(record.identifier) : undefined;
  if (!user) return null;
  const verified = user.emailVerified !== undefined
    ? user
    : await adapter.updateUser({ id: user.id, emailVerified: nowSeconds() });
  await emitAuthEvent(resolveAuthOptions(config), "emailVerified", { user: verified });
  return verified;
}

/**
 * Email a password-reset link. The link opens `email.resetPath` (default
 * `{basePath}/reset`) — a page your app renders, posting `email`, `token` and `password`
 * to `{basePath}/reset/confirm` (or calling {@linkcode resetPassword}).
 *
 * Resolves normally for an address with no account — with no mail, and comparable work —
 * so a caller can't learn which addresses have accounts. Throws only for a
 * misconfiguration: no `sendVerificationRequest`, or an adapter without the
 * verification-token group and `setCredential`.
 *
 * @param config The app's auth config.
 * @param email The submitted address (exactly one; a list sends nothing).
 * @returns Whether the request was throttled — the same for known and unknown addresses.
 */
export async function requestPasswordReset(
  config: AuthConfig,
  email: string,
): Promise<EmailRequestResult> {
  const adapter = requireFlowAdapter(config, "reset", "requestPasswordReset");
  const send = requireMailer(config, "requestPasswordReset");
  const identifier = normalizeEmailIdentifier(email);
  if (!identifier) return NOT_THROTTLED;
  const request = currentContext()?.request;
  return await startEmailFlow(config, { flow: "reset", identifier, request, adapter, send });
}

/** Whether a new password is within the accepted length range. */
function acceptablePassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH;
}

/**
 * End every server-side session of `userId` and fire `sessionRevoked` — after a password
 * reset, and when a first email sign-in retires the access an unverified account had
 * ({@link ./routes-email.ts | routes-email.ts}). Stateless cookie sessions can't be
 * revoked; that is said once per config rather than silently skipped.
 *
 * @param config The app's auth config (it keys the one-time stateless warning).
 * @param options The resolved options: their store is revoked, their logger warns.
 * @param userId The user whose sessions end.
 */
export async function revokeUserSessions(
  config: AuthConfig,
  options: ResolvedAuthOptions,
  userId: string,
): Promise<void> {
  if (!options.sessionStore) {
    if (!warnedStateless.has(config)) {
      warnedStateless.add(config);
      options.logger.warn(
        "denextAuth: sessions are stateless signed cookies, so a password reset (or a first " +
          "email sign-in into an unverified account) can't sign out the user's existing " +
          "sessions — they stay valid until they expire. Configure a `sessionStore` (or " +
          '`session: { strategy: "database" }`) so either one signs out every device.',
      );
    }
    return;
  }
  await options.sessionStore.deleteByUser(userId);
  await emitAuthEvent(options, "sessionRevoked", { userId });
}

/**
 * Redeem a password-reset token and set a new password: the configured `hasher` hashes it,
 * `adapter.setCredential` stores it, and every server-side session of the user is revoked.
 * Fires `passwordReset` (after `sessionRevoked`).
 *
 * The password is checked (8–1024 characters) **before** the token is touched, so a
 * refused password leaves the link usable.
 *
 * @param config The app's auth config.
 * @param input The address, the presented token and the new password.
 * @returns `{ ok: true, user }`, or `{ ok: false, error }`. Throws only when the adapter
 * lacks the verification-token group or `setCredential`.
 */
export async function resetPassword(
  config: AuthConfig,
  input: { email: string; token: string; password: string },
): Promise<ResetPasswordResult> {
  const adapter = requireFlowAdapter(config, "reset", "resetPassword");
  if (!acceptablePassword(input.password)) return { ok: false, error: "invalid_password" };
  const record = await redeemVerificationToken(config, {
    identifier: input.email,
    purpose: "reset",
    token: input.token,
  });
  const user = record ? await adapter.getUserByEmail(record.identifier) : undefined;
  if (!user) return { ok: false, error: "invalid_token" };
  const options = resolveAuthOptions(config);
  await adapter.setCredential!(user.id, await options.hasher.hash(input.password));
  await revokeUserSessions(config, options, user.id);
  await emitAuthEvent(options, "passwordReset", { user });
  return { ok: true, user };
}
