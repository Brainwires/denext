/**
 * User records for `/auth/v1`: creating email, phone and anonymous users with their identity
 * rows, password policy, and the pre-account-hijacking rule for a password chosen before the
 * address was proven.
 *
 * @module
 */

import { endUserSessions } from "../session.ts";
import type { AdapterUser } from "../adapter.ts";
import { evictUnprovenAccess } from "../email.ts";
import { emitAuthEvent } from "../events.ts";
import { sha256Hex } from "@denext/denext/auth-kit";
import { nativeAdapterOf } from "../native.ts";
import { resolveAuthOptions } from "../options.ts";
import { type GoTrueContext, nowSeconds } from "./context.ts";
import { GoTrueError } from "./errors.ts";

/**
 * The part of the `/auth/v1` context the account helpers read — so a sign-in on denextAuth's own
 * endpoints (a SAML provider) can share them.
 */
export type AccountContext = Pick<GoTrueContext, "adapter" | "config">;

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
export function hashPassword(ctx: AccountContext, password: string): Promise<string> {
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
  ctx: AccountContext,
  userId: string,
): Promise<string | undefined> {
  const stored = await ctx.adapter.getCredential?.(userId);
  return stored ? (await sha256Hex(stored)).slice(0, 32) : undefined;
}

/**
 * The first proof of an account's address (its email or phone confirmed while the account had
 * NO verified address yet) by any channel other than the account's own sign-up confirmation —
 * a magic link, an email / SMS one-time code, a recovery link, an invite. Whoever set the
 * account up before that proof may be an attacker who registered the victim's address and is
 * waiting for the victim to make it theirs, so everything set up without the proof goes:
 * the password, every second factor and passkey, every bearer API token, every session (token
 * and cookie). The one exception is the sign-up confirmation itself: when the code carries the
 * fingerprint of the password that sign-up chose (`bound`) and the stored password still
 * matches it, the person confirming chose that password, and the account is kept as it is.
 *
 * @param ctx The context.
 * @param user The user.
 * @param bound The password fingerprint a sign-up confirmation carried (`undefined` for every
 *   other code).
 */
export async function retireForeignPassword(
  ctx: AccountContext,
  user: AdapterUser,
  bound: string | undefined,
): Promise<void> {
  const current = await credentialFingerprint(ctx, user.id);
  if (bound !== undefined && current === bound) return;
  const options = resolveAuthOptions(ctx.config);
  await evictUnprovenAccess(ctx.config, options, ctx.adapter, user.id);
}

/**
 * An address change confirmed on an account that had no verified address (an anonymous user
 * becoming permanent): the password goes unless it is the one the account held when the change
 * was requested (`bound`) — a password set by someone else in between is not kept.
 *
 * @param ctx The context.
 * @param userId The user.
 * @param bound The password fingerprint the change code carried.
 */
export async function retireChangedPassword(
  ctx: GoTrueContext,
  userId: string,
  bound: string | undefined,
): Promise<void> {
  const current = await credentialFingerprint(ctx, userId);
  if (current === undefined || current === bound) return;
  await deletePassword(ctx, userId);
  await revokeEverySession(ctx, userId);
}

/**
 * Remove a password — or replace it with one nobody holds: without `deleteCredential`, and with
 * `unusable` (a contested sign-up's marker: the account still has a password, so no later sign-up
 * claims it).
 */
async function deletePassword(
  ctx: GoTrueContext,
  userId: string,
  options: { unusable?: boolean } = {},
): Promise<void> {
  if (ctx.adapter.deleteCredential && !options.unusable) await ctx.adapter.deleteCredential(userId);
  else {
    const random = crypto.randomUUID() + crypto.randomUUID();
    await ctx.adapter.setCredential?.(userId, await hashPassword(ctx, random));
  }
}

/**
 * End a user's sessions of both kinds: the `/auth/v1` (and native) session families — all but
 * `keepFamily` — and every denextAuth cookie session: the session store's records, and through
 * the user's `sessionsValidAfter` every cookie signed in before now, stateless ones included. A
 * changed password, a ban, a deletion and a retired password reach a stolen cookie as well as a
 * stolen refresh token. Fires `sessionRevoked` when a store was cleared.
 *
 * @param ctx The context.
 * @param userId The user.
 * @param keepFamily The caller's own session family, kept (a password change keeps it).
 */
export async function revokeEverySession(
  ctx: GoTrueContext,
  userId: string,
  keepFamily?: string,
): Promise<void> {
  await nativeAdapterOf(ctx.adapter)?.revokeNativeSessionsByUser(userId, keepFamily);
  await endUserSessions(ctx.adapter, userId);
  const options = resolveAuthOptions(ctx.config);
  if (!options.sessionStore) return;
  await options.sessionStore.deleteByUser(userId);
  await emitAuthEvent(options, "sessionRevoked", { userId });
}

/**
 * A sign-up for an address (or number) on an existing account nobody has confirmed yet. Answers
 * the password fingerprint the sign-up's confirmation code binds (see
 * {@linkcode retireForeignPassword}), or `undefined` for none.
 *
 * - An account with a verified address is left as it is, and nothing is bound: its owner's
 *   password is not a stranger's to replace or clear.
 * - An account with no password yet (created by a one-time code or an invite) takes this
 *   sign-up's password, like a new sign-up — after everything set up on it without a proof
 *   is retired, so the binding keeps only what this sign-up chose.
 * - The same password as the account's keeps it, and binds it.
 * - A different password contests the account: everything set up without a proof is retired
 *   and the password is replaced with one nobody holds, so a later sign-up can't claim it —
 *   the newest sign-up's confirmation goes to the same inbox, so binding its password would let
 *   whoever signed up last keep a password on the owner's account. Nothing is bound; the owner
 *   confirms (which signs them in) and sets a password then.
 *
 * @param ctx The context.
 * @param user The unconfirmed account.
 * @param password The password this sign-up chose.
 * @returns The fingerprint to bind, or `undefined`.
 */
export async function signUpExisting(
  ctx: GoTrueContext,
  user: AdapterUser,
  password: string,
): Promise<string | undefined> {
  if (user.emailVerified !== undefined || user.phoneVerified !== undefined) return undefined;
  const options = resolveAuthOptions(ctx.config);
  const stored = await ctx.adapter.getCredential?.(user.id);
  if (stored && await options.hasher.verify(password, stored)) {
    return await credentialFingerprint(ctx, user.id);
  }
  await evictUnprovenAccess(ctx.config, options, ctx.adapter, user.id, "revoked");
  if (stored) {
    await deletePassword(ctx, user.id, { unusable: true });
    return undefined;
  }
  await ctx.adapter.setCredential?.(user.id, await hashPassword(ctx, password));
  return await credentialFingerprint(ctx, user.id);
}

/** Link (or refresh) an identity row. */
export async function linkIdentity(
  ctx: AccountContext,
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
  /** Attach the `email` / `phone` identity row (default `true`; an SSO user has none). */
  addressIdentity?: boolean;
}

/**
 * Create a user with its `email` / `phone` identity and its password.
 *
 * @param ctx The context.
 * @param input The user.
 * @returns The stored user.
 * @throws {GoTrueError} `email_exists` / `phone_exists` when the store refuses a duplicate.
 */
export async function createAccount(ctx: AccountContext, input: NewUser): Promise<AdapterUser> {
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
  const address = input.addressIdentity === false ? null : addressIdentity(user.id, input);
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
  ctx: AccountContext,
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
  ctx: AccountContext,
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
