/**
 * User records for `/auth/v1`: creating email, phone and anonymous users with their identity
 * rows, password policy, and the pre-account-hijacking rule for a password chosen before the
 * address was proven.
 *
 * @module
 */

import type { AdapterUser } from "../adapter.ts";
import { sha256Hex } from "../hash.ts";
import { resolveAuthOptions } from "../options.ts";
import { type GoTrueContext, nowSeconds } from "./context.ts";
import { GoTrueError } from "./errors.ts";

/** The minimum password length. */
function minPasswordLength(ctx: GoTrueContext): number {
  const value = ctx.options.minPasswordLength ?? 8;
  return Number.isFinite(value) ? Math.min(72, Math.max(6, Math.floor(value))) : 8;
}

/**
 * Check a new password against the policy.
 *
 * @param ctx The context.
 * @param password The password.
 * @throws {GoTrueError} `weak_password` (422) with `weak_password.reasons`.
 */
export function checkPassword(ctx: GoTrueContext, password: string): void {
  const min = minPasswordLength(ctx);
  if (password.length < min || password.length > 1024) {
    throw new GoTrueError(
      422,
      "weak_password",
      `Password should be at least ${min} characters.`,
      { weak_password: { reasons: ["length"] } },
    );
  }
}

/** Hash a password with the auth config's hasher. */
export function hashPassword(ctx: GoTrueContext, password: string): Promise<string> {
  return resolveAuthOptions(ctx.config).hasher.hash(password);
}

/**
 * Check a password in constant time — an unknown user costs the same as a wrong password.
 *
 * @param ctx The context.
 * @param user The user, if any.
 * @param password The presented password.
 * @returns Whether it matches.
 */
export async function passwordMatches(
  ctx: GoTrueContext,
  user: AdapterUser | undefined,
  password: string,
): Promise<boolean> {
  const stored = user ? await ctx.adapter.getCredential?.(user.id) : undefined;
  const ok = await resolveAuthOptions(ctx.config).hasher.verify(password, stored ?? "");
  return ok && !!user && !!stored;
}

/** A fingerprint of the stored password hash, bound into a sign-up confirmation. */
export async function credentialFingerprint(
  ctx: GoTrueContext,
  userId: string,
): Promise<string | undefined> {
  const stored = await ctx.adapter.getCredential?.(userId);
  return stored ? (await sha256Hex(stored)).slice(0, 32) : undefined;
}

/**
 * The first proof of an address: retire a password set by someone else before it — when the
 * stored password is not the one the confirmed sign-up chose, it is removed (the owner resets
 * it), so an attacker who registered the address first cannot keep a password on the account.
 *
 * @param ctx The context.
 * @param user The user.
 * @param bound The fingerprint the confirmation carried.
 */
export async function retireForeignPassword(
  ctx: GoTrueContext,
  user: AdapterUser,
  bound: string | undefined,
): Promise<void> {
  const current = await credentialFingerprint(ctx, user.id);
  if (current === undefined || current === bound) return;
  if (ctx.adapter.deleteCredential) await ctx.adapter.deleteCredential(user.id);
  else {
    const random = crypto.randomUUID() + crypto.randomUUID();
    await ctx.adapter.setCredential?.(user.id, await hashPassword(ctx, random));
  }
  await ctx.adapter.revokeNativeSessionsByUser?.(user.id);
}

/**
 * A repeated sign-up for an address (or number) nobody has confirmed yet. The same password
 * keeps the account's; a different one clears it — the newest sign-up's confirmation goes to the
 * same inbox, so binding its password would let whoever signed up last keep a password on the
 * owner's account. The owner confirms (which signs them in) and sets a password then.
 *
 * @param ctx The context.
 * @param userId The unconfirmed account.
 * @param password The password this sign-up chose.
 */
export async function contestPassword(
  ctx: GoTrueContext,
  userId: string,
  password: string,
): Promise<void> {
  const stored = await ctx.adapter.getCredential?.(userId);
  if (!stored || await resolveAuthOptions(ctx.config).hasher.verify(password, stored)) return;
  if (ctx.adapter.deleteCredential) await ctx.adapter.deleteCredential(userId);
  else {
    const random = crypto.randomUUID() + crypto.randomUUID();
    await ctx.adapter.setCredential?.(userId, await hashPassword(ctx, random));
  }
}

/** Link (or refresh) an identity row. */
export async function linkIdentity(
  ctx: GoTrueContext,
  user: AdapterUser,
  input: {
    provider: string;
    providerAccountId: string;
    identityData: Record<string, unknown>;
    email?: string;
    type?: "oauth" | "oidc" | "credentials" | "email";
  },
): Promise<void> {
  const at = nowSeconds();
  const existing = (await ctx.adapter.listAccounts?.(user.id) ?? []).find((account) =>
    account.provider === input.provider && account.providerAccountId === input.providerAccountId
  );
  await ctx.adapter.linkAccount({
    ...(existing ?? {}),
    userId: user.id,
    provider: input.provider,
    providerAccountId: input.providerAccountId,
    type: input.type ?? existing?.type,
    identityId: existing?.identityId ?? crypto.randomUUID(),
    identityData: input.identityData,
    ...(input.email ? { email: input.email } : {}),
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    lastSignInAt: at,
  });
}

/** What a new user starts with. */
export interface NewUser {
  email?: string;
  phone?: string;
  password?: string;
  userMetadata?: Record<string, unknown>;
  appMetadata?: Record<string, unknown>;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  anonymous?: boolean;
}

/**
 * Create a user with its `email` / `phone` identity and its password.
 *
 * @param ctx The context.
 * @param input The user.
 * @returns The stored user.
 * @throws {GoTrueError} `email_exists` / `phone_exists` when the store refuses a duplicate.
 */
export async function createAccount(ctx: GoTrueContext, input: NewUser): Promise<AdapterUser> {
  let user: AdapterUser;
  try {
    user = await ctx.adapter.createUser(newRecord(input));
  } catch {
    throw input.email
      ? new GoTrueError(
        422,
        "email_exists",
        "A user with this email address has already been registered",
      )
      : new GoTrueError(
        422,
        "phone_exists",
        "A user with this phone number has already been registered",
      );
  }
  if (input.password) {
    await ctx.adapter.setCredential?.(user.id, await hashPassword(ctx, input.password));
  }
  const address = addressIdentity(user.id, input);
  if (address) await linkIdentity(ctx, user, address);
  return (await ctx.adapter.getUser(user.id)) ?? user;
}

/** The stored record for a new user. */
function newRecord(input: NewUser): Omit<AdapterUser, "id"> {
  const at = nowSeconds();
  const provider = input.anonymous ? undefined : input.email ? "email" : "phone";
  const record: Omit<AdapterUser, "id"> = {
    userMetadata: input.userMetadata ?? {},
    appMetadata: { ...(provider ? { provider, providers: [provider] } : {}), ...input.appMetadata },
    createdAt: at,
    updatedAt: at,
  };
  if (input.email) record.email = input.email;
  if (input.phone) record.phone = input.phone;
  if (input.emailVerified) record.emailVerified = at;
  if (input.phoneVerified) record.phoneVerified = at;
  if (input.anonymous) record.isAnonymous = true;
  return record;
}

/** The `email` / `phone` identity row a new user starts with, if any. */
function addressIdentity(
  userId: string,
  input: NewUser,
): Parameters<typeof linkIdentity>[2] | null {
  if (input.email) {
    return {
      provider: "email",
      providerAccountId: userId,
      email: input.email,
      type: "email",
      identityData: {
        sub: userId,
        email: input.email,
        email_verified: !!input.emailVerified,
        phone_verified: false,
      },
    };
  }
  if (!input.phone) return null;
  return {
    provider: "phone",
    providerAccountId: userId,
    identityData: {
      sub: userId,
      phone: input.phone,
      email_verified: false,
      phone_verified: !!input.phoneVerified,
    },
  };
}

/**
 * Update a user, stamping `updatedAt`; a duplicate email / phone is a 422.
 *
 * @param ctx The context.
 * @param patch The changes.
 * @returns The updated user.
 */
export async function updateAccount(
  ctx: GoTrueContext,
  patch: Partial<AdapterUser> & { id: string },
): Promise<AdapterUser> {
  try {
    return await ctx.adapter.updateUser({ ...patch, updatedAt: nowSeconds() });
  } catch {
    throw patch.phone !== undefined && patch.email === undefined
      ? new GoTrueError(
        422,
        "phone_exists",
        "A user with this phone number has already been registered",
      )
      : new GoTrueError(
        422,
        "email_exists",
        "A user with this email address has already been registered",
      );
  }
}

/** Mark an identity's verified flag in its identity data. */
export async function markIdentityVerified(
  ctx: GoTrueContext,
  user: AdapterUser,
  provider: "email" | "phone",
): Promise<void> {
  const account = (await ctx.adapter.listAccounts?.(user.id) ?? []).find((a) =>
    a.provider === provider
  );
  if (!account) return;
  await ctx.adapter.linkAccount({
    ...account,
    identityData: {
      ...account.identityData,
      [provider === "email" ? "email_verified" : "phone_verified"]: true,
    },
    updatedAt: nowSeconds(),
  });
}

/**
 * The user GoTrue answers a sign-up for an address that already has a confirmed account with,
 * while confirmations are on: a plausible user with a random id and no identities, so the
 * response does not reveal that the address is registered.
 */
export function obfuscatedUser(email?: string, phone?: string): Record<string, unknown> {
  const at = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    aud: "authenticated",
    role: "authenticated",
    email: email ?? "",
    phone: phone ?? "",
    confirmation_sent_at: at,
    app_metadata: { provider: email ? "email" : "phone", providers: [email ? "email" : "phone"] },
    user_metadata: {},
    identities: [],
    created_at: at,
    updated_at: at,
    is_anonymous: false,
  };
}
