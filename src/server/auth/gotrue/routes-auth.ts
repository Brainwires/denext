/**
 * The sign-in half of `/auth/v1`: `signup` (password, anonymous), `token` (password,
 * refresh_token, pkce, id_token), `otp`, `verify` (POST and the GET a link opens), `resend`,
 * `recover`, `logout` and `settings`.
 *
 * @module
 */

import type { AdapterUser } from "../adapter.ts";
import { isNativeIdTokenProvider, verifyNativeIdToken } from "../native-idtoken.ts";
import { resolveAuthOptions } from "../options.ts";
import {
  credentialsLimiter,
  defaultRateLimitKey,
  mfaLimiter,
  sessionReadLimiter,
  signinStartLimiter,
  verificationLimiter,
} from "../rate-limit.ts";
import { authTrustsProxy } from "../rate-limit.ts";
import { isOAuthProvider } from "../types.ts";
import {
  checkPassword,
  createAccount,
  credentialFingerprint,
  linkIdentity,
  markIdentityVerified,
  obfuscatedUser,
  passwordMatches,
  retireForeignPassword,
  updateAccount,
} from "./accounts.ts";
import {
  checkCaptcha,
  type GoTrueContext,
  normalizeEmail,
  normalizePhone,
  nowSeconds,
  obj,
  ok,
  readJson,
  redirectTarget,
  requireUser,
  spend,
  spendIp,
  str,
} from "./context.ts";
import { fail, GoTrueError } from "./errors.ts";
import {
  canSendSms,
  issueOtp,
  type OtpData,
  type OtpKind,
  redeemOtp,
  redeemTokenHash,
  sendAuthEmail,
  sendAuthSms,
  VERIFY_KINDS,
} from "./otp.ts";
import { createFlowCode, readChallenge, redeemFlowCode } from "./pkce.ts";
import { spLogoutUrl } from "./routes-slo.ts";
import {
  type AmrEntry,
  familiesOf,
  type GoTrueSessionJson,
  refreshSession,
  startSession,
} from "./session.ts";
import { promoteAnonymous } from "./routes-user.ts";
import { userJson } from "./user.ts";

/** Whether an email still needs confirming before sign-in. */
function emailUnconfirmed(ctx: GoTrueContext, user: AdapterUser): boolean {
  return !ctx.options.autoconfirm && user.email !== undefined && user.emailVerified === undefined;
}

function phoneUnconfirmed(ctx: GoTrueContext, user: AdapterUser): boolean {
  return !ctx.options.phoneAutoconfirm && user.phone !== undefined &&
    user.phoneVerified === undefined;
}

function amr(method: string, provider?: string): AmrEntry {
  return { method, timestamp: nowSeconds(), ...(provider ? { provider } : {}) };
}

function readChallengeFrom(body: Record<string, unknown>): string | undefined {
  return readChallenge(str(body, "code_challenge"), str(body, "code_challenge_method"));
}

// ── settings ─────────────────────────────────────────────────────────────────

/** `GET /settings`. */
export function settings(ctx: GoTrueContext): Response {
  const external: Record<string, boolean> = {
    email: true,
    phone: canSendSms(ctx),
    anonymous_users: ctx.options.anonymousUsers === true,
    saml: !!ctx.options.saml,
  };
  for (const provider of ctx.config.providers) {
    if (isOAuthProvider(provider)) external[provider.id] = true;
  }
  return ok({
    external,
    disable_signup: ctx.options.disableSignup === true,
    mailer_autoconfirm: ctx.options.autoconfirm === true,
    phone_autoconfirm: ctx.options.phoneAutoconfirm === true,
    sms_provider: canSendSms(ctx) ? "custom" : "",
    mfa_enabled: true,
    saml_enabled: !!ctx.options.saml,
  });
}

// ── signup ───────────────────────────────────────────────────────────────────

/** `POST /signup`: email or phone with a password, or an anonymous user. */
export async function signup(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  await checkCaptcha(ctx, body);
  await spendIp(ctx, signinStartLimiter(ctx.config), "signup");
  const email = normalizeEmail(str(body, "email"));
  const phone = email ? undefined : normalizePhone(str(body, "phone"));
  const data = obj(body, "data");
  if (!email && !phone) return await anonymousSignup(ctx, data);
  if (ctx.options.disableSignup) {
    throw new GoTrueError(422, "signup_disabled", "Signups not allowed for this instance");
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    throw new GoTrueError(422, "validation_failed", "Signup requires a valid password");
  }
  checkPassword(ctx, password);
  const challenge = readChallengeFrom(body);
  const redirectTo = redirectTarget(
    ctx,
    ctx.url.searchParams.get("redirect_to") ?? str(body, "redirect_to"),
  );
  return email
    ? await emailSignup(ctx, email, password, data, challenge, redirectTo)
    : await phoneSignup(ctx, phone!, password, data, str(body, "channel"));
}

async function anonymousSignup(
  ctx: GoTrueContext,
  data: Record<string, unknown> | undefined,
): Promise<Response> {
  if (!ctx.options.anonymousUsers) {
    throw new GoTrueError(422, "anonymous_provider_disabled", "Anonymous sign-ins are disabled");
  }
  const user = await createAccount(ctx, { anonymous: true, userMetadata: data });
  return ok(await startSession(ctx.session, user, amr("anonymous")));
}

async function emailSignup(
  ctx: GoTrueContext,
  email: string,
  password: string,
  data: Record<string, unknown> | undefined,
  challenge: string | undefined,
  redirectTo: string,
): Promise<Response> {
  const existing = await ctx.adapter.getUserByEmail(email);
  if (existing && !emailUnconfirmed(ctx, existing)) {
    if (ctx.options.autoconfirm) {
      throw new GoTrueError(422, "user_already_exists", "User already registered");
    }
    // Confirmations on: answer as if a new user signed up, so the address isn't revealed.
    return ok(obfuscatedUser(email));
  }
  const user = existing ??
    await createAccount(ctx, {
      email,
      password,
      userMetadata: data,
      emailVerified: ctx.options.autoconfirm,
    });
  if (existing) {
    // An unconfirmed account: the newest sign-up's password is the one its confirmation binds.
    await ctx.adapter.setCredential?.(
      existing.id,
      await resolveAuthOptions(ctx.config).hasher.hash(password),
    );
  }
  if (ctx.options.autoconfirm) return ok(await startSession(ctx.session, user, amr("password")));
  await spend(ctx, verificationLimiter(ctx.config), "verify", email, "over_email_send_rate_limit");
  const issued = await issueOtp(ctx, "email", email, {
    action: "signup",
    userId: user.id,
    redirectTo,
    ...(challenge ? { codeChallenge: challenge } : {}),
    pw: await credentialFingerprint(ctx, user.id),
  });
  await sendAuthEmail(ctx, { email, action: "signup", issued, redirectTo, user });
  return ok({
    ...(await userJson(ctx.adapter, user)),
    confirmation_sent_at: new Date().toISOString(),
  });
}

async function phoneSignup(
  ctx: GoTrueContext,
  phone: string,
  password: string,
  data: Record<string, unknown> | undefined,
  channel: string | undefined,
): Promise<Response> {
  if (!canSendSms(ctx) && !ctx.options.phoneAutoconfirm) {
    throw new GoTrueError(400, "phone_provider_disabled", "Phone signups are disabled");
  }
  const existing = await ctx.adapter.getUserByPhone?.(phone);
  if (existing && !phoneUnconfirmed(ctx, existing)) {
    throw new GoTrueError(422, "user_already_exists", "User already registered");
  }
  const user = existing ??
    await createAccount(ctx, {
      phone,
      password,
      userMetadata: data,
      phoneVerified: ctx.options.phoneAutoconfirm,
    });
  if (existing) {
    await ctx.adapter.setCredential?.(
      existing.id,
      await resolveAuthOptions(ctx.config).hasher.hash(password),
    );
  }
  if (ctx.options.phoneAutoconfirm) {
    return ok(await startSession(ctx.session, user, amr("password")));
  }
  await spend(ctx, verificationLimiter(ctx.config), "verify", phone, "over_sms_send_rate_limit");
  const issued = await issueOtp(ctx, "sms", phone, {
    action: "signup",
    userId: user.id,
    pw: await credentialFingerprint(ctx, user.id),
  });
  await sendAuthSms(ctx, {
    phone,
    otp: issued.otp,
    type: "signup",
    channel: channel === "whatsapp" ? "whatsapp" : "sms",
    user,
  });
  return ok({
    ...(await userJson(ctx.adapter, user)),
    confirmation_sent_at: new Date().toISOString(),
  });
}

// ── token ────────────────────────────────────────────────────────────────────

/** `POST /token?grant_type=…`. */
export async function token(ctx: GoTrueContext): Promise<Response> {
  const grant = ctx.url.searchParams.get("grant_type");
  const body = await readJson(ctx);
  switch (grant) {
    case "password":
      return ok(await passwordGrant(ctx, body));
    case "refresh_token":
      await spendIp(ctx, sessionReadLimiter(ctx.config), "refresh");
      return ok(await refreshSession(ctx.session, str(body, "refresh_token") ?? ""));
    case "pkce":
      return ok(await pkceGrant(ctx, body));
    case "id_token":
      return ok(await idTokenGrant(ctx, body));
    default:
      throw new GoTrueError(400, "validation_failed", "unsupported_grant_type");
  }
}

async function passwordGrant(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
): Promise<GoTrueSessionJson & { weak_password: null }> {
  await checkCaptcha(ctx, body);
  const email = normalizeEmail(str(body, "email"));
  const phone = email ? undefined : normalizePhone(str(body, "phone"));
  const password = typeof body.password === "string" ? body.password : "";
  if ((!email && !phone) || !password) throw fail.credentials();
  const limiter = credentialsLimiter(ctx.config);
  const key = `gotrue|${
    defaultRateLimitKey(ctx.request, { email: email ?? phone! }, {
      trustForwardedHeaders: authTrustsProxy(ctx.config),
    })
  }`;
  if (limiter && await limiter.lockedOut(key) !== null) throw fail.rateLimited();
  const user = email
    ? await ctx.adapter.getUserByEmail(email)
    : await ctx.adapter.getUserByPhone?.(phone!);
  if (!(await passwordMatches(ctx, user, password)) || !user) {
    await limiter?.fail(key);
    throw fail.credentials();
  }
  await limiter?.succeed(key);
  if (email && emailUnconfirmed(ctx, user)) {
    throw new GoTrueError(400, "email_not_confirmed", "Email not confirmed");
  }
  if (phone && phoneUnconfirmed(ctx, user)) {
    throw new GoTrueError(400, "validation_failed", "Phone not confirmed");
  }
  return { ...(await startSession(ctx.session, user, amr("password"))), weak_password: null };
}

async function pkceGrant(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
): Promise<GoTrueSessionJson> {
  const state = await redeemFlowCode(
    ctx,
    str(body, "auth_code") ?? "",
    str(body, "code_verifier") ?? "",
  );
  const user = await ctx.adapter.getUser(state.userId);
  if (!user) throw fail.userNotFound();
  if (state.link) {
    const owner = await ctx.adapter.getUserByAccount(state.link);
    if (owner && owner.id !== user.id) {
      throw new GoTrueError(
        422,
        "identity_already_exists",
        "Identity is already linked to another user",
      );
    }
    await linkIdentity(ctx, user, state.link);
  }
  const session = await startSession(ctx.session, user, state.amr, state.sso);
  return {
    ...session,
    ...(state.providerToken ? { provider_token: state.providerToken } : {}),
    ...(state.providerRefreshToken ? { provider_refresh_token: state.providerRefreshToken } : {}),
  };
}

async function idTokenGrant(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
): Promise<GoTrueSessionJson> {
  await checkCaptcha(ctx, body);
  await spendIp(ctx, signinStartLimiter(ctx.config), "id-token");
  const provider = str(body, "provider") ?? "";
  const idToken = str(body, "id_token") ?? "";
  const settings = isNativeIdTokenProvider(provider)
    ? ctx.options.idTokenProviders?.[provider] ?? ctx.config.native?.[provider]
    : undefined;
  if (!settings || !isNativeIdTokenProvider(provider)) {
    throw new GoTrueError(
      400,
      "provider_disabled",
      `Provider (issuer) is not enabled: ${provider}`,
    );
  }
  let claims: Record<string, unknown>;
  try {
    ({ claims } = await verifyNativeIdToken(
      ctx.config,
      provider,
      settings,
      idToken,
      str(body, "nonce"),
    ));
  } catch {
    throw new GoTrueError(400, "bad_oauth_callback", "Bad ID token");
  }
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) throw new GoTrueError(400, "bad_oauth_callback", "Bad ID token");
  const email = typeof claims.email === "string" && claims.email_verified !== false &&
      claims.email_verified !== "false"
    ? normalizeEmail(claims.email)
    : undefined;
  const user = await idTokenUser(ctx, provider, sub, email, claims);
  await linkIdentity(ctx, user, {
    provider,
    providerAccountId: sub,
    email,
    type: "oidc",
    identityData: { ...claims, provider_id: sub },
  });
  return await startSession(ctx.session, user, amr("oauth", provider));
}

/** The user an id_token signs in: its linked account, a confirmed account by email, or new. */
async function idTokenUser(
  ctx: GoTrueContext,
  provider: string,
  sub: string,
  email: string | undefined,
  claims: Record<string, unknown>,
): Promise<AdapterUser> {
  const linked = await ctx.adapter.getUserByAccount({ provider, providerAccountId: sub });
  if (linked) return linked;
  if (email) {
    const byEmail = await ctx.adapter.getUserByEmail(email);
    // Link only onto a confirmed account: an unconfirmed one may be an attacker's squat.
    if (byEmail && byEmail.emailVerified !== undefined) return byEmail;
    if (byEmail) {
      throw new GoTrueError(
        422,
        "email_exists",
        "A user with this email address has already been registered",
      );
    }
  }
  if (ctx.options.disableSignup) {
    throw new GoTrueError(422, "signup_disabled", "Signups not allowed for this instance");
  }
  return await ctx.adapter.createUser({
    ...(email ? { email, emailVerified: nowSeconds() } : {}),
    userMetadata: {
      ...(typeof claims.name === "string" ? { full_name: claims.name, name: claims.name } : {}),
      ...(typeof claims.picture === "string" ? { avatar_url: claims.picture } : {}),
      ...(email ? { email, email_verified: true } : {}),
      iss: claims.iss,
      sub,
      provider_id: sub,
    },
    appMetadata: { provider, providers: [provider] },
    createdAt: nowSeconds(),
    updatedAt: nowSeconds(),
  });
}

// ── otp ──────────────────────────────────────────────────────────────────────

/** The user an OTP is for: found, or created when sign-ups are allowed. */
async function otpUser(
  ctx: GoTrueContext,
  email: string | undefined,
  phone: string | undefined,
  createAllowed: boolean,
  data: Record<string, unknown> | undefined,
): Promise<{ user: AdapterUser; isNew: boolean }> {
  const found = email
    ? await ctx.adapter.getUserByEmail(email)
    : await ctx.adapter.getUserByPhone?.(phone!);
  if (found) return { user: found, isNew: false };
  if (!createAllowed) throw new GoTrueError(422, "otp_disabled", "Signups not allowed for otp");
  if (ctx.options.disableSignup) {
    throw new GoTrueError(422, "signup_disabled", "Signups not allowed for this instance");
  }
  if (phone && !canSendSms(ctx)) {
    throw new GoTrueError(400, "phone_provider_disabled", "Phone logins are disabled");
  }
  return { user: await createAccount(ctx, { email, phone, userMetadata: data }), isNew: true };
}

/** `POST /otp`: send an email magic link / code, or an SMS code. */
export async function otp(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  await checkCaptcha(ctx, body);
  const email = normalizeEmail(str(body, "email"));
  const phone = email ? undefined : normalizePhone(str(body, "phone"));
  if (!email && !phone) throw fail.validation("An email address or phone number is required");
  const createAllowed = body.create_user !== false;
  const data = obj(body, "data");
  const challenge = readChallengeFrom(body);
  const redirectTo = redirectTarget(
    ctx,
    ctx.url.searchParams.get("redirect_to") ?? str(body, "redirect_to"),
  );
  const address = (email ?? phone)!;
  await spend(
    ctx,
    verificationLimiter(ctx.config),
    "verify",
    address,
    email ? "over_email_send_rate_limit" : "over_sms_send_rate_limit",
  );
  const { user, isNew } = await otpUser(ctx, email, phone, createAllowed, data);
  if (email) {
    const action = isNew ? "signup" : "magiclink";
    const issued = await issueOtp(ctx, "email", email, {
      action,
      userId: user.id,
      redirectTo,
      ...(challenge ? { codeChallenge: challenge } : {}),
      pw: isNew ? undefined : await credentialFingerprint(ctx, user.id),
    });
    await sendAuthEmail(ctx, { email, action, issued, redirectTo, user });
    return ok({});
  }
  const issued = await issueOtp(ctx, "sms", phone!, { action: "sms", userId: user.id });
  await sendAuthSms(ctx, {
    phone: phone!,
    otp: issued.otp,
    type: "sms",
    channel: str(body, "channel") === "whatsapp" ? "whatsapp" : "sms",
    user,
  });
  return ok({ message_id: null });
}

// ── verify ───────────────────────────────────────────────────────────────────

/** The verified user after a redeemed code, with the code's effect applied. */
async function applyVerification(
  ctx: GoTrueContext,
  type: string,
  address: string,
  data: OtpData,
): Promise<{ user: AdapterUser; method: string }> {
  const kind = VERIFY_KINDS[type];
  const user = data.userId
    ? await ctx.adapter.getUser(data.userId)
    : kind === "sms"
    ? await ctx.adapter.getUserByPhone?.(address)
    : await ctx.adapter.getUserByEmail(address);
  if (!user) throw fail.otpExpired();
  switch (kind) {
    case "email":
      if (user.email?.toLowerCase() !== address) throw fail.otpExpired();
      return { user: await confirmAddress(ctx, user, "email", data.pw), method: "otp" };
    case "recovery": {
      if (user.email?.toLowerCase() !== address) throw fail.otpExpired();
      const updated = user.emailVerified === undefined
        ? await updateAccount(ctx, { id: user.id, emailVerified: nowSeconds() })
        : user;
      return { user: updated, method: "recovery" };
    }
    case "sms":
      if (user.phone !== address) throw fail.otpExpired();
      return { user: await confirmAddress(ctx, user, "phone", data.pw), method: "otp" };
    case "email_change":
    case "phone_change":
      return { user: await applyChange(ctx, user, kind, address, data), method: "otp" };
    default:
      throw fail.otpExpired();
  }
}

/** The first proof of an email / phone: retire a foreign password, mark it verified. */
async function confirmAddress(
  ctx: GoTrueContext,
  user: AdapterUser,
  which: "email" | "phone",
  pw: string | undefined,
): Promise<AdapterUser> {
  const verified = which === "email" ? user.emailVerified : user.phoneVerified;
  if (verified !== undefined) return user;
  await retireForeignPassword(ctx, user, pw);
  await markIdentityVerified(ctx, user, which);
  return await updateAccount(
    ctx,
    which === "email"
      ? { id: user.id, emailVerified: nowSeconds() }
      : { id: user.id, phoneVerified: nowSeconds() },
  );
}

/** A confirmed email / phone change (an anonymous user becomes permanent). */
async function applyChange(
  ctx: GoTrueContext,
  user: AdapterUser,
  kind: "email_change" | "phone_change",
  address: string,
  data: OtpData,
): Promise<AdapterUser> {
  if (!data.newValue || data.newValue !== address) throw fail.otpExpired();
  await updateAccount(
    ctx,
    kind === "email_change"
      ? { id: user.id, email: data.newValue, emailVerified: nowSeconds() }
      : { id: user.id, phone: data.newValue, phoneVerified: nowSeconds() },
  );
  await promoteAnonymous(ctx, user.id);
  return (await ctx.adapter.getUser(user.id))!;
}

function kindOf(type: string | undefined): OtpKind {
  const kind = type ? VERIFY_KINDS[type] : undefined;
  if (!kind) throw fail.validation("Verify requires a verification type");
  return kind;
}

/** `POST /verify`: a code (`token` + `email` / `phone`) or a link hash (`token_hash`). */
export async function verifyPost(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  const type = str(body, "type");
  const kind = kindOf(type);
  const tokenHash = str(body, "token_hash");
  let redeemed: { address: string; data: OtpData } | null;
  if (tokenHash) {
    await spendIp(ctx, signinStartLimiter(ctx.config), "verify");
    redeemed = await redeemTokenHash(ctx, kind, tokenHash);
  } else {
    const address = kind === "sms" || kind === "phone_change"
      ? normalizePhone(str(body, "phone"))
      : normalizeEmail(str(body, "email"));
    const code = str(body, "token");
    if (!address || !code) throw fail.validation("Verify requires a token and an email or phone");
    const attempt = await spend(ctx, mfaLimiter(ctx.config), "mfa", `otp:${address}`);
    const data = await redeemOtp(ctx, kind, address.toLowerCase(), code);
    if (data) await attempt.settle();
    redeemed = data ? { address: address.toLowerCase(), data } : null;
  }
  if (!redeemed) throw fail.otpExpired();
  const { user, method } = await applyVerification(ctx, type!, redeemed.address, redeemed.data);
  return ok(await startSession(ctx.session, user, amr(method)));
}

function fragment(params: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
}

/** `GET /verify?token=…&type=…&redirect_to=…`: the link in an email. */
export async function verifyGet(ctx: GoTrueContext): Promise<Response> {
  const type = ctx.url.searchParams.get("type") ?? "";
  const tokenHash = ctx.url.searchParams.get("token") ?? ctx.url.searchParams.get("token_hash");
  const fallback = redirectTarget(ctx, ctx.url.searchParams.get("redirect_to"));
  const refuse = (target: string, pkce: boolean) => {
    const error = fragment({
      error: "access_denied",
      error_code: "otp_expired",
      error_description: "Email link is invalid or has expired",
    });
    return redirect(
      pkce ? `${target}${target.includes("?") ? "&" : "?"}${error}` : `${target}#${error}`,
    );
  };
  const kind = VERIFY_KINDS[type];
  if (!kind || !tokenHash) return refuse(fallback, false);
  await spendIp(ctx, signinStartLimiter(ctx.config), "verify");
  const redeemed = await redeemTokenHash(ctx, kind, tokenHash);
  if (!redeemed) return refuse(fallback, false);
  const target = redirectTarget(
    ctx,
    redeemed.data.redirectTo ?? ctx.url.searchParams.get("redirect_to"),
  );
  let result: { user: AdapterUser; method: string };
  try {
    result = await applyVerification(ctx, type, redeemed.address, redeemed.data);
  } catch {
    return refuse(target, !!redeemed.data.codeChallenge);
  }
  if (redeemed.data.codeChallenge) {
    const code = await createFlowCode(ctx, redeemed.data.codeChallenge, {
      userId: result.user.id,
      amr: amr(result.method),
    });
    const url = new URL(target);
    url.searchParams.set("code", code);
    return redirect(url.href);
  }
  const session = await startSession(ctx.session, result.user, amr(result.method));
  return redirect(
    `${target.split("#")[0]}#${
      fragment({
        access_token: session.access_token,
        expires_at: session.expires_at,
        expires_in: session.expires_in,
        refresh_token: session.refresh_token,
        token_type: "bearer",
        type,
      })
    }`,
  );
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

// ── resend / recover ─────────────────────────────────────────────────────────

/** Re-send an unconfirmed email sign-up's confirmation (nothing for anyone else). */
async function resendEmailConfirmation(
  ctx: GoTrueContext,
  email: string,
  redirectTo: string,
): Promise<void> {
  const user = await ctx.adapter.getUserByEmail(email);
  if (!user || user.emailVerified !== undefined) return;
  const issued = await issueOtp(ctx, "email", email, {
    action: "signup",
    userId: user.id,
    redirectTo,
    pw: await credentialFingerprint(ctx, user.id),
  });
  await sendAuthEmail(ctx, { email, action: "signup", issued, redirectTo, user });
}

/** Re-send an unconfirmed phone sign-up's code (nothing for anyone else). */
async function resendSmsConfirmation(ctx: GoTrueContext, phone: string): Promise<void> {
  const user = await ctx.adapter.getUserByPhone?.(phone);
  if (!user || user.phoneVerified !== undefined) return;
  const issued = await issueOtp(ctx, "sms", phone, {
    action: "signup",
    userId: user.id,
    pw: await credentialFingerprint(ctx, user.id),
  });
  await sendAuthSms(ctx, { phone, otp: issued.otp, type: "signup", user });
}

/** `POST /resend`: resend a sign-up confirmation or change confirmation. */
export async function resend(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  await checkCaptcha(ctx, body);
  const type = str(body, "type");
  const email = normalizeEmail(str(body, "email"));
  const phone = email ? undefined : normalizePhone(str(body, "phone"));
  if (!type || !["signup", "email_change", "sms", "phone_change"].includes(type)) {
    throw fail.validation("Missing one of these types: signup, email_change, sms, phone_change");
  }
  const address = email ?? phone;
  if (!address) throw fail.validation("An email address or phone number is required");
  await spend(
    ctx,
    verificationLimiter(ctx.config),
    "verify",
    address,
    "over_email_send_rate_limit",
  );
  const redirectTo = redirectTarget(
    ctx,
    ctx.url.searchParams.get("redirect_to") ?? str(body, "redirect_to"),
  );
  if (type === "signup" && email) await resendEmailConfirmation(ctx, email, redirectTo);
  else if (type === "sms" && phone) await resendSmsConfirmation(ctx, phone);
  // Email / phone change resends need the signed-in user: they are re-issued by PUT /user.
  return ok({ message_id: null });
}

/** `POST /recover`: send a password-recovery link / code. */
export async function recover(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  await checkCaptcha(ctx, body);
  const email = normalizeEmail(str(body, "email"));
  if (!email) throw fail.validation("Password recovery requires an email");
  await spend(ctx, verificationLimiter(ctx.config), "verify", email, "over_email_send_rate_limit");
  const challenge = readChallengeFrom(body);
  const redirectTo = redirectTarget(
    ctx,
    ctx.url.searchParams.get("redirect_to") ?? str(body, "redirect_to"),
  );
  const user = await ctx.adapter.getUserByEmail(email);
  if (user) {
    const issued = await issueOtp(ctx, "recovery", email, {
      action: "recovery",
      userId: user.id,
      redirectTo,
      ...(challenge ? { codeChallenge: challenge } : {}),
    });
    await sendAuthEmail(ctx, { email, action: "recovery", issued, redirectTo, user });
  }
  // The same answer for an unknown address.
  return ok({});
}

// ── logout ───────────────────────────────────────────────────────────────────

/**
 * `POST /logout?scope=global|local|others`. A `local` / `global` logout of a session a SAML
 * assertion started answers `200 { url }` when SAML Single Logout is on: the session is
 * already ended, and the URL tells the IdP (see `routes-slo.ts`).
 */
export async function logout(ctx: GoTrueContext): Promise<Response> {
  const caller = await requireUser(ctx);
  const scope = ctx.url.searchParams.get("scope") ?? "local";
  const families = familiesOf(ctx.config);
  const slo = scope !== "others" && caller.sessionId
    ? await spLogoutUrl(ctx, caller.sessionId)
    : undefined;
  if (scope === "global") {
    await families.revokeNativeSessionsByUser(caller.user.id);
  } else if (scope === "others") {
    await families.revokeNativeSessionsByUser(caller.user.id, caller.sessionId);
  } else if (scope === "local") {
    if (caller.sessionId) await families.revokeNativeSession(caller.sessionId);
  } else {
    throw fail.validation("Unsupported logout scope");
  }
  if (slo) return ok({ url: slo });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
