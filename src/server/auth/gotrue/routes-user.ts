/**
 * The signed-in user's endpoints: `GET /user`, `PUT /user` (metadata, password, email and
 * phone changes — which is also how an anonymous user becomes a permanent one),
 * `GET /reauthenticate`, and identity unlinking.
 *
 * @module
 */

import { mfaLimiter, verificationLimiter } from "../rate-limit.ts";
import { hasVerifiedFactor } from "../factors.ts";
import {
  checkPassword,
  credentialFingerprint,
  hashPassword,
  linkIdentity,
  passwordMatches,
  revokeEverySession,
  updateAccount,
} from "./accounts.ts";
import type { AdapterUser } from "../adapter.ts";
import { isSsoUser } from "../sso-user.ts";
import {
  type CallerUser,
  type GoTrueContext,
  normalizeEmail,
  normalizePhone,
  obj,
  ok,
  readJson,
  redirectTarget,
  requireAal2WithFactor,
  requireUser,
  spend,
  str,
} from "./context.ts";
import { fail, GoTrueError } from "./errors.ts";
import { factorsJson } from "./factors.ts";
import { canSendSms, issueOtp, redeemOtp, sendAuthEmail, sendAuthSms } from "./otp.ts";
import { readChallenge } from "./pkce.ts";
import { identitiesOf, userJson } from "./user.ts";

/** `GET /user`. */
export async function getUser(ctx: GoTrueContext): Promise<Response> {
  const { user } = await requireUser(ctx, { allowOAuthClient: true, allowPending: true });
  return ok(await userJson(ctx.adapter, user, { factors: await factorsJson(ctx.config, user.id) }));
}

/** Whether a `PUT /user` body changes the password, the email or the phone. */
function changesCredentials(user: AdapterUser, body: Record<string, unknown>): boolean {
  if (typeof body.password === "string" && body.password !== "") return true;
  const email = normalizeEmail(str(body, "email"));
  if (email && email !== user.email?.toLowerCase()) return true;
  const phone = normalizePhone(str(body, "phone"));
  return !!phone && phone !== user.phone;
}

/**
 * GoTrue's `user_sso_managed` rule: an SSO user's password, email and phone belong to its
 * identity provider, so `PUT /user` refuses to set a password, change the email or phone, or
 * present a reauthentication nonce for one.
 */
function changesSsoManaged(user: AdapterUser, body: Record<string, unknown>): boolean {
  return isSsoUser(user) && (changesCredentials(user, body) || !!str(body, "nonce"));
}

/**
 * GoTrue's rule for `PUT /user`: once the user holds a verified factor, a password, email or
 * phone change needs an `aal2` session — else a password alone (exactly what MFA defends
 * against) could replace the password, move the email and sign the owner out everywhere. A
 * session that still owes its second factor is refused the same way.
 */
async function requireAalForCredentials(ctx: GoTrueContext, caller: CallerUser): Promise<void> {
  const owes = caller.pending ||
    (caller.claims.aal !== "aal2" && await hasVerifiedFactor(ctx.config, caller.user.id));
  if (!owes) return;
  throw new GoTrueError(
    401,
    "insufficient_aal",
    "AAL2 session is required to update email or password when MFA is enabled.",
  );
}

/** `PUT /user`. */
export async function putUser(ctx: GoTrueContext): Promise<Response> {
  const caller = await requireUser(ctx, { allowPending: true });
  const body = await readJson(ctx);
  let user = caller.user;
  if (changesCredentials(user, body)) await requireAalForCredentials(ctx, caller);
  if (
    user.isAnonymous && typeof body.password === "string" && body.password !== "" &&
    !str(body, "email") && !str(body, "phone")
  ) {
    throw new GoTrueError(
      422,
      "validation_failed",
      "Updating password of an anonymous user without an email or phone is not allowed",
    );
  }
  if (changesSsoManaged(user, body)) {
    throw new GoTrueError(
      422,
      "user_sso_managed",
      "Updating email, phone, password of a SSO account only possible via SSO",
    );
  }
  const data = obj(body, "data");
  if (data) {
    user = await updateAccount(ctx, {
      id: user.id,
      userMetadata: { ...(user.userMetadata ?? {}), ...data },
    });
  }
  if (typeof body.password === "string") {
    user = await changePassword(ctx, caller, user, body.password, str(body, "nonce"));
  }
  const newEmail = await changeEmail(ctx, user, body);
  await changePhone(ctx, user, normalizePhone(str(body, "phone")));
  const fresh = (await ctx.adapter.getUser(user.id)) ?? user;
  const json = await userJson(ctx.adapter, fresh, {
    factors: await factorsJson(ctx.config, fresh.id),
    newEmail,
  });
  if (newEmail) json.email_change_sent_at = new Date().toISOString();
  return ok(json);
}

/** A new password: the policy, reauthentication when required, then other sessions end. */
async function changePassword(
  ctx: GoTrueContext,
  caller: CallerUser,
  user: AdapterUser,
  password: string,
  nonce: string | undefined,
): Promise<AdapterUser> {
  checkPassword(ctx, password);
  if (ctx.options.requireReauthentication && (await ctx.adapter.getCredential?.(user.id))) {
    if (!nonce) {
      throw new GoTrueError(
        400,
        "reauthentication_needed",
        "Password update requires reauthentication",
      );
    }
    const attempt = await spend(ctx, mfaLimiter(ctx.config), "mfa", `reauth:${user.id}`);
    if (!(await redeemOtp(ctx, "reauth", user.id, nonce))) {
      throw new GoTrueError(
        400,
        "reauthentication_not_valid",
        "Requires a valid reauthentication nonce",
      );
    }
    await attempt.settle();
  }
  if (await passwordMatches(ctx, user, password)) {
    throw new GoTrueError(
      422,
      "same_password",
      "New password should be different from the old password.",
    );
  }
  await ctx.adapter.setCredential?.(user.id, await hashPassword(ctx, password));
  // Every other session ends — token sessions and denextAuth cookie sessions alike: a changed
  // password must evict whoever else holds one.
  await revokeEverySession(ctx, user.id, caller.sessionId);
  return await updateAccount(ctx, { id: user.id });
}

/** A new email: set at once under autoconfirm, else confirmed by a code sent to it. */
async function changeEmail(
  ctx: GoTrueContext,
  user: AdapterUser,
  body: Record<string, unknown>,
): Promise<string | undefined> {
  const email = normalizeEmail(str(body, "email"));
  if (!email || email === user.email?.toLowerCase()) return undefined;
  const taken = await ctx.adapter.getUserByEmail(email);
  if (taken && taken.id !== user.id) {
    throw new GoTrueError(
      422,
      "email_exists",
      "A user with this email address has already been registered",
    );
  }
  if (ctx.options.autoconfirm) {
    await updateAccount(ctx, { id: user.id, email, emailVerified: Math.floor(Date.now() / 1000) });
    await promoteAnonymous(ctx, user.id);
    return undefined;
  }
  const challenge = readChallenge(str(body, "code_challenge"), str(body, "code_challenge_method"));
  const redirectTo = redirectTarget(
    ctx,
    ctx.url.searchParams.get("redirect_to") ?? str(body, "email_redirect_to"),
  );
  await spend(ctx, verificationLimiter(ctx.config), "verify", email, "over_email_send_rate_limit");
  const issued = await issueOtp(ctx, "email_change", email, {
    action: "email_change",
    userId: user.id,
    newValue: email,
    redirectTo,
    ...(challenge ? { codeChallenge: challenge } : {}),
    pw: await firstAddressBinding(ctx, user),
  });
  await sendAuthEmail(ctx, { email, action: "email_change", issued, redirectTo, user });
  return email;
}

/**
 * For an account with no verified address yet (an anonymous user), the fingerprint of the
 * password it holds now: the change code carries it, so a password set by someone else before
 * the code is redeemed is retired then (see `retireChangedPassword`).
 */
async function firstAddressBinding(
  ctx: GoTrueContext,
  user: AdapterUser,
): Promise<string | undefined> {
  if (user.emailVerified !== undefined || user.phoneVerified !== undefined) return undefined;
  return await credentialFingerprint(ctx, user.id);
}

/** A new phone: set at once under phone autoconfirm, else confirmed by an SMS code. */
async function changePhone(
  ctx: GoTrueContext,
  user: AdapterUser,
  phone: string | undefined,
): Promise<void> {
  if (!phone || phone === user.phone) return;
  const taken = await ctx.adapter.getUserByPhone?.(phone);
  if (taken && taken.id !== user.id) {
    throw new GoTrueError(
      422,
      "phone_exists",
      "A user with this phone number has already been registered",
    );
  }
  if (ctx.options.phoneAutoconfirm) {
    await updateAccount(ctx, { id: user.id, phone, phoneVerified: Math.floor(Date.now() / 1000) });
    await promoteAnonymous(ctx, user.id);
    return;
  }
  if (!canSendSms(ctx)) {
    throw new GoTrueError(400, "phone_provider_disabled", "Phone logins are disabled");
  }
  await spend(ctx, verificationLimiter(ctx.config), "verify", phone, "over_sms_send_rate_limit");
  const issued = await issueOtp(ctx, "phone_change", phone, {
    action: "phone_change",
    userId: user.id,
    newValue: phone,
    pw: await firstAddressBinding(ctx, user),
  });
  await sendAuthSms(ctx, { phone, otp: issued.otp, type: "phone_change", user });
}

/**
 * An anonymous user who now has a verified email or phone becomes a permanent user, with the
 * matching identity row.
 *
 * @param ctx The context.
 * @param userId The user.
 */
export async function promoteAnonymous(ctx: GoTrueContext, userId: string): Promise<void> {
  const user = await ctx.adapter.getUser(userId);
  if (!user?.isAnonymous) return;
  const verifiedEmail = user.email && user.emailVerified !== undefined;
  const verifiedPhone = user.phone && user.phoneVerified !== undefined;
  if (!verifiedEmail && !verifiedPhone) return;
  const provider = verifiedEmail ? "email" : "phone";
  await updateAccount(ctx, {
    id: user.id,
    isAnonymous: false,
    appMetadata: { ...(user.appMetadata ?? {}), provider, providers: [provider] },
  });
  await linkIdentity(ctx, user, {
    provider,
    providerAccountId: user.id,
    ...(verifiedEmail ? { email: user.email } : {}),
    identityData: verifiedEmail
      ? { sub: user.id, email: user.email, email_verified: true, phone_verified: false }
      : { sub: user.id, phone: user.phone, email_verified: false, phone_verified: true },
  });
}

/**
 * `GET /reauthenticate`: send a nonce to the user's email (or phone). An SSO user is refused
 * (`user_sso_managed`) with nothing sent: `PUT /user` would refuse its nonce anyway.
 */
export async function reauthenticate(ctx: GoTrueContext): Promise<Response> {
  const { user } = await requireUser(ctx, { allowPending: true });
  // An SSO user's credentials belong to its identity provider, and `PUT /user` refuses its nonce
  // (`user_sso_managed`): a code it could never use is not sent. (GoTrue sends one.)
  if (isSsoUser(user)) {
    throw new GoTrueError(
      422,
      "user_sso_managed",
      "Reauthentication of a SSO account is only possible via SSO",
    );
  }
  if (!user.email && !user.phone) {
    throw fail.validation("Reauthentication requires the user to have an email or a phone number");
  }
  await spend(ctx, verificationLimiter(ctx.config), "verify", `reauth:${user.id}`);
  const issued = await issueOtp(ctx, "reauth", user.id, {
    action: "reauthentication",
    userId: user.id,
  });
  if (user.email) {
    await sendAuthEmail(ctx, {
      email: user.email,
      action: "reauthentication",
      issued,
      redirectTo: ctx.siteUrl,
      user,
    });
  } else {
    await sendAuthSms(ctx, { phone: user.phone!, otp: issued.otp, type: "reauthentication", user });
  }
  return ok({});
}

/** `DELETE /user/identities/:id`: unlink one identity (never the last one). */
export async function unlinkIdentity(ctx: GoTrueContext): Promise<Response> {
  const caller = await requireUser(ctx);
  await requireAal2WithFactor(ctx, caller, "unlink an identity");
  const { user } = caller;
  if (ctx.options.manualLinking === false) {
    throw new GoTrueError(404, "manual_linking_disabled", "Manual linking is disabled");
  }
  const identities = await identitiesOf(ctx.adapter, user);
  const target = identities.find((identity) => identity.identity_id === ctx.params.id);
  if (!target) throw new GoTrueError(404, "identity_not_found", "Identity doesn't exist");
  if (identities.length <= 1) {
    throw new GoTrueError(
      422,
      "single_identity_not_deletable",
      "User must have at least 1 identity after unlinking",
    );
  }
  if (target.provider === "email" || target.provider === "phone") {
    // The address identity IS the account's address: change the address instead.
    throw fail.validation(
      `The ${target.provider} identity cannot be unlinked; change the ${target.provider} instead`,
    );
  }
  await ctx.adapter.unlinkAccount?.({ provider: target.provider, providerAccountId: target.id });
  const remaining = await identitiesOf(ctx.adapter, (await ctx.adapter.getUser(user.id)) ?? user);
  const providers = [...new Set(remaining.map((identity) => identity.provider))];
  // The provider the account signed up with decides what kind of user it is: an SSO user's
  // stays `sso:` (GoTrue's `is_sso_user` never changes), and any other account keeps its own
  // while it is still linked, else takes a remaining non-SSO one — never an `sso:` one.
  const stored = user.appMetadata?.provider;
  const provider = isSsoUser(user) || (typeof stored === "string" && providers.includes(stored))
    ? stored
    : providers.find((name) => !name.startsWith("sso:")) ?? stored;
  await updateAccount(ctx, {
    id: user.id,
    appMetadata: { ...(user.appMetadata ?? {}), provider, providers },
  });
  return ok({});
}
