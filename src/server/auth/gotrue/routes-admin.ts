/**
 * The admin API (`supabase.auth.admin.*`): users (list with pagination, create, read, update,
 * delete, ban), invites, generated links and MFA factor removal. Every route needs the service
 * role — the secret key (or the legacy `service_role` JWT) — which never belongs in a browser.
 *
 * @module
 */

import type { AdapterUser } from "../adapter.ts";
import { checkPassword, createAccount, hashPassword, updateAccount } from "./accounts.ts";
import {
  type GoTrueContext,
  normalizeEmail,
  normalizePhone,
  nowSeconds,
  obj,
  ok,
  readJson,
  redirectTarget,
  requireServiceRole,
  str,
} from "./context.ts";
import { fail, GoTrueError } from "./errors.ts";
import { factorAdapterOf, factorJson, factorsJson } from "./factors.ts";
import { issueOtp, sendAuthEmail, verifyLink } from "./otp.ts";
import { familiesOf } from "./session.ts";
import { userJson } from "./user.ts";

/**
 * Require the service role.
 *
 * @param ctx The context.
 */
export async function requireAdmin(ctx: GoTrueContext): Promise<void> {
  await requireServiceRole(ctx);
}

async function userById(ctx: GoTrueContext): Promise<AdapterUser> {
  const id = ctx.params.id;
  const user = /^[\w-]{1,128}$/.test(id) ? await ctx.adapter.getUser(id) : undefined;
  if (!user) throw fail.userNotFound();
  return user;
}

async function fullUser(ctx: GoTrueContext, user: AdapterUser): Promise<Record<string, unknown>> {
  return await userJson(ctx.adapter, user, { factors: await factorsJson(ctx.config, user.id) });
}

/**
 * A Go duration (`24h`, `1h30m`, `90s`) in seconds, or `"none"` → `0`.
 *
 * @param value The duration.
 * @returns Seconds.
 */
export function parseBanDuration(value: string): number {
  if (value === "none") return 0;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of value.matchAll(re)) {
    const n = Number(match[1]);
    total += match[2] === "h"
      ? n * 3600
      : match[2] === "m"
      ? n * 60
      : match[2] === "s"
      ? n
      : n / 1000;
    consumed += match[0].length;
  }
  if (consumed !== value.length || consumed === 0) {
    throw fail.validation("invalid format for ban duration");
  }
  return Math.floor(total);
}

/** `GET /admin/users?page=&per_page=`. */
export async function adminListUsers(ctx: GoTrueContext): Promise<Response> {
  if (!ctx.adapter.listUsers) {
    throw new GoTrueError(500, "unexpected_failure", "the adapter cannot list users");
  }
  const page = Math.max(1, Number(ctx.url.searchParams.get("page") ?? "1") | 0);
  const perPage = Math.min(
    1000,
    Math.max(1, Number(ctx.url.searchParams.get("per_page") ?? "50") | 0),
  );
  const { users, total } = await ctx.adapter.listUsers({ page, perPage });
  const last = Math.max(1, Math.ceil(total / perPage));
  const base = new URL(ctx.url.href);
  const link = (n: number, rel: string) => {
    base.searchParams.set("page", String(n));
    base.searchParams.set("per_page", String(perPage));
    return `<${base.pathname}${base.search}>; rel="${rel}"`;
  };
  const links = [...(page < last ? [link(page + 1, "next")] : []), link(last, "last")];
  return ok(
    { users: await Promise.all(users.map((user) => fullUser(ctx, user))), aud: "authenticated" },
    200,
    { "x-total-count": String(total), link: links.join(", ") },
  );
}

/** Apply the admin-writable fields to a user (create or update). */
async function applyAdminFields(
  ctx: GoTrueContext,
  user: AdapterUser,
  body: Record<string, unknown>,
): Promise<AdapterUser> {
  const patch: Partial<AdapterUser> & { id: string } = {
    id: user.id,
    ...metadataPatch(user, body),
    ...addressPatch(user, body),
  };
  const ban = str(body, "ban_duration");
  if (ban) {
    const seconds = parseBanDuration(ban);
    patch.bannedUntil = seconds === 0 ? 0 : nowSeconds() + seconds;
    if (seconds > 0) await familiesOf(ctx.config).revokeNativeSessionsByUser(user.id);
  }
  if (typeof body.password === "string") {
    checkPassword(ctx, body.password);
    await ctx.adapter.setCredential?.(user.id, await hashPassword(ctx, body.password));
  }
  return await updateAccount(ctx, patch);
}

/** `user_metadata` (or `data`) and `app_metadata`, merged into the stored values. */
function metadataPatch(user: AdapterUser, body: Record<string, unknown>): Partial<AdapterUser> {
  const patch: Partial<AdapterUser> = {};
  const userMeta = obj(body, "user_metadata") ?? obj(body, "data");
  if (userMeta) patch.userMetadata = { ...(user.userMetadata ?? {}), ...userMeta };
  const appMeta = obj(body, "app_metadata");
  if (appMeta) patch.appMetadata = { ...(user.appMetadata ?? {}), ...appMeta };
  return patch;
}

/** A new email / phone, and `email_confirm` / `phone_confirm`. */
function addressPatch(user: AdapterUser, body: Record<string, unknown>): Partial<AdapterUser> {
  const patch: Partial<AdapterUser> = {};
  const email = normalizeEmail(str(body, "email"));
  const phone = normalizePhone(str(body, "phone"));
  if (email && email !== user.email) patch.email = email;
  if (phone && phone !== user.phone) patch.phone = phone;
  if (body.email_confirm === true && (email ?? user.email)) patch.emailVerified = nowSeconds();
  if (body.phone_confirm === true && (phone ?? user.phone)) patch.phoneVerified = nowSeconds();
  return patch;
}

/** `POST /admin/users`. */
export async function adminCreateUser(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  const email = normalizeEmail(str(body, "email"));
  const phone = normalizePhone(str(body, "phone"));
  if (email && await ctx.adapter.getUserByEmail(email)) {
    throw new GoTrueError(
      422,
      "email_exists",
      "A user with this email address has already been registered",
    );
  }
  if (phone && await ctx.adapter.getUserByPhone?.(phone)) {
    throw new GoTrueError(
      422,
      "phone_exists",
      "A user with this phone number has already been registered",
    );
  }
  if (typeof body.password === "string") checkPassword(ctx, body.password);
  const user = await createAccount(ctx, {
    email,
    phone,
    anonymous: !email && !phone,
    password: typeof body.password === "string" ? body.password : undefined,
    userMetadata: obj(body, "user_metadata") ?? obj(body, "data"),
    appMetadata: obj(body, "app_metadata"),
    emailVerified: body.email_confirm === true,
    phoneVerified: body.phone_confirm === true,
  });
  const { password: _p, email: _e, phone: _ph, email_confirm: _ec, phone_confirm: _pc, ...rest } =
    body;
  const updated = await applyAdminFields(ctx, user, rest);
  return ok(await fullUser(ctx, updated));
}

/** `GET /admin/users/:id`. */
export async function adminGetUser(ctx: GoTrueContext): Promise<Response> {
  return ok(await fullUser(ctx, await userById(ctx)));
}

/** `PUT /admin/users/:id`. */
export async function adminUpdateUser(ctx: GoTrueContext): Promise<Response> {
  const user = await userById(ctx);
  const body = await readJson(ctx);
  const email = normalizeEmail(str(body, "email"));
  if (email && email !== user.email) {
    const taken = await ctx.adapter.getUserByEmail(email);
    if (taken && taken.id !== user.id) {
      throw new GoTrueError(
        422,
        "email_exists",
        "A user with this email address has already been registered",
      );
    }
  }
  return ok(await fullUser(ctx, await applyAdminFields(ctx, user, body)));
}

/** `DELETE /admin/users/:id`. */
export async function adminDeleteUser(ctx: GoTrueContext): Promise<Response> {
  const user = await userById(ctx);
  const json = await fullUser(ctx, user);
  if (!ctx.adapter.deleteUser) {
    throw new GoTrueError(500, "unexpected_failure", "the adapter cannot delete users");
  }
  await familiesOf(ctx.config).revokeNativeSessionsByUser(user.id);
  await ctx.adapter.deleteUser(user.id);
  return ok(json);
}

/** `GET /admin/users/:id/factors`. */
export async function adminListFactors(ctx: GoTrueContext): Promise<Response> {
  const user = await userById(ctx);
  return ok(await factorsJson(ctx.config, user.id));
}

/** `DELETE /admin/users/:id/factors/:factor`. */
export async function adminDeleteFactor(ctx: GoTrueContext): Promise<Response> {
  const user = await userById(ctx);
  const store = factorAdapterOf(ctx.config);
  const factor = (await store?.listMfaFactors(user.id))?.find((f) => f.id === ctx.params.factor);
  if (!store || !factor) throw new GoTrueError(404, "mfa_factor_not_found", "Factor not found");
  await store.deleteMfaFactor(factor.id);
  return ok(factorJson(factor));
}

/** `POST /invite`: create (or find an unconfirmed) user and email an invite link. */
export async function adminInvite(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  const email = normalizeEmail(str(body, "email"));
  if (!email) throw fail.validation("An email address is required");
  const redirectTo = redirectTarget(
    ctx,
    ctx.url.searchParams.get("redirect_to") ?? str(body, "redirect_to"),
  );
  let user = await ctx.adapter.getUserByEmail(email);
  if (user && user.emailVerified !== undefined) {
    throw new GoTrueError(
      422,
      "email_exists",
      "A user with this email address has already been registered",
    );
  }
  user ??= await createAccount(ctx, { email, userMetadata: obj(body, "data") });
  const issued = await issueOtp(ctx, "email", email, {
    action: "invite",
    userId: user.id,
    redirectTo,
  });
  await sendAuthEmail(ctx, { email, action: "invite", issued, redirectTo, user });
  return ok({ ...(await fullUser(ctx, user)), invited_at: new Date().toISOString() });
}

/** `POST /admin/generate_link`: the link and code an email would carry, without sending it. */
export async function adminGenerateLink(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  const type = str(body, "type") ?? "";
  const email = normalizeEmail(str(body, "email"));
  if (!email) throw fail.validation("An email address is required");
  const redirectTo = redirectTarget(
    ctx,
    str(body, "redirect_to") ?? ctx.url.searchParams.get("redirect_to"),
  );
  const target = await linkTarget(ctx, type, email, body);
  const issued = await issueOtp(ctx, target.kind, target.address, {
    action: type,
    userId: target.user.id,
    redirectTo,
    ...(target.newValue ? { newValue: target.newValue } : {}),
  });
  return ok({
    ...(await fullUser(ctx, target.user)),
    action_link: verifyLink(ctx, issued.tokenHash, target.verificationType, redirectTo),
    email_otp: issued.otp,
    hashed_token: issued.tokenHash,
    redirect_to: redirectTo,
    verification_type: target.verificationType,
  });
}

/** Who a generated link is for, and which token space it lives in. */
async function linkTarget(
  ctx: GoTrueContext,
  type: string,
  email: string,
  body: Record<string, unknown>,
): Promise<{
  user: AdapterUser;
  kind: "email" | "recovery" | "email_change";
  address: string;
  verificationType: string;
  newValue?: string;
}> {
  const existing = await ctx.adapter.getUserByEmail(email);
  const unconfirmed = () => {
    if (existing && existing.emailVerified !== undefined) {
      throw new GoTrueError(
        422,
        "email_exists",
        "A user with this email address has already been registered",
      );
    }
  };
  const known = () => {
    if (!existing) throw fail.userNotFound();
    return existing;
  };
  switch (type) {
    case "signup": {
      unconfirmed();
      const password = typeof body.password === "string" ? body.password : undefined;
      if (password) checkPassword(ctx, password);
      const user = existing ??
        await createAccount(ctx, { email, password, userMetadata: obj(body, "data") });
      return { user, kind: "email", address: email, verificationType: type };
    }
    case "invite": {
      unconfirmed();
      const user = existing ??
        await createAccount(ctx, { email, userMetadata: obj(body, "data") });
      return { user, kind: "email", address: email, verificationType: type };
    }
    case "magiclink":
      return { user: known(), kind: "email", address: email, verificationType: type };
    case "recovery":
      return { user: known(), kind: "recovery", address: email, verificationType: type };
    case "email_change_current":
    case "email_change_new": {
      const user = known();
      const newEmail = normalizeEmail(str(body, "new_email"));
      if (!newEmail) throw fail.validation("new_email is required");
      return {
        user,
        kind: "email_change",
        address: newEmail,
        verificationType: "email_change",
        newValue: newEmail,
      };
    }
    default:
      throw fail.validation("Invalid link type");
  }
}
