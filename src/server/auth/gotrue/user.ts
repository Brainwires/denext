/**
 * Users and identities in GoTrue's JSON shape — the `user` object `supabase-js` reads — built
 * from the one adapter record denext auth keeps for both cookie and token sessions.
 *
 * @module
 */

import type { AdapterAccount, AdapterUser, AuthAdapter } from "../adapter.ts";
import { derivedId } from "../factors.ts";

/** An ISO-8601 timestamp for epoch seconds, or `undefined`. */
export function iso(seconds: number | undefined): string | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : undefined;
}

/** One identity in GoTrue's shape. */
export interface GoTrueIdentity {
  identity_id: string;
  id: string;
  user_id: string;
  identity_data: Record<string, unknown>;
  provider: string;
  email?: string;
  created_at?: string;
  updated_at?: string;
  last_sign_in_at?: string;
}

/** A stored provider account → its GoTrue identity. */
async function identityOf(account: AdapterAccount): Promise<GoTrueIdentity> {
  const data = account.identityData ?? { sub: account.providerAccountId };
  return {
    identity_id: account.identityId ??
      await derivedId(`identity:${account.provider}:${account.providerAccountId}`),
    id: account.providerAccountId,
    user_id: account.userId,
    identity_data: { ...data, sub: data.sub ?? account.providerAccountId },
    provider: account.provider,
    ...(account.email ? { email: account.email } : {}),
    ...(iso(account.createdAt) ? { created_at: iso(account.createdAt) } : {}),
    ...(iso(account.updatedAt ?? account.createdAt)
      ? { updated_at: iso(account.updatedAt ?? account.createdAt) }
      : {}),
    ...(iso(account.lastSignInAt) ? { last_sign_in_at: iso(account.lastSignInAt) } : {}),
  };
}

/**
 * A user's identities: the linked accounts, plus the `email` / `phone` identity a password or
 * one-time-code user has even when no account row records it (a user created by denext auth's
 * own credentials flow).
 */
export async function identitiesOf(
  adapter: AuthAdapter,
  user: AdapterUser,
): Promise<GoTrueIdentity[]> {
  const accounts = await adapter.listAccounts?.(user.id) ?? [];
  const out = await Promise.all(accounts.map(identityOf));
  const has = (provider: string) => out.some((identity) => identity.provider === provider);
  if (user.email && !has("email") && !user.isAnonymous) {
    out.push(
      await identityOf({
        userId: user.id,
        provider: "email",
        providerAccountId: user.id,
        email: user.email,
        identityData: {
          sub: user.id,
          email: user.email,
          email_verified: user.emailVerified !== undefined,
          phone_verified: false,
        },
        createdAt: user.createdAt,
      }),
    );
  }
  if (user.phone && !has("phone") && !user.isAnonymous) {
    out.push(
      await identityOf({
        userId: user.id,
        provider: "phone",
        providerAccountId: user.id,
        identityData: {
          sub: user.id,
          phone: user.phone,
          email_verified: false,
          phone_verified: user.phoneVerified !== undefined,
        },
        createdAt: user.createdAt,
      }),
    );
  }
  return out;
}

/** One MFA factor in GoTrue's shape. */
export interface GoTrueFactor {
  id: string;
  friendly_name?: string;
  factor_type: "totp" | "phone" | "webauthn" | "recovery_code";
  status: "verified" | "unverified";
  created_at: string;
  updated_at: string;
  phone?: string;
  last_challenged_at?: string;
}

/**
 * The `app_metadata` a token and the user object carry: the stored server-side metadata, with
 * `provider` / `providers` derived from the identities (GoTrue keeps them in step the same way).
 */
export function appMetadataOf(
  user: AdapterUser,
  identities: GoTrueIdentity[],
): Record<string, unknown> {
  const providers = [...new Set(identities.map((identity) => identity.provider))];
  const stored = user.appMetadata ?? {};
  const meta: Record<string, unknown> = { ...stored };
  if (user.roles?.length && meta.roles === undefined) meta.roles = [...user.roles];
  const provider = typeof stored.provider === "string"
    ? stored.provider
    : providers[0] ?? (user.isAnonymous ? undefined : "email");
  if (provider !== undefined) meta.provider = provider;
  meta.providers = providers.length ? providers : provider ? [provider] : [];
  return meta;
}

/** The `user_metadata` a token and the user object carry. */
export function userMetadataOf(user: AdapterUser): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...(user.userMetadata ?? {}) };
  if (user.name !== undefined && meta.name === undefined) meta.name = user.name;
  if (user.image !== undefined && meta.avatar_url === undefined) meta.avatar_url = user.image;
  if (user.email !== undefined && meta.email === undefined) meta.email = user.email;
  if (meta.email_verified === undefined && user.email !== undefined) {
    meta.email_verified = user.emailVerified !== undefined;
  }
  if (user.phone !== undefined && meta.phone_verified === undefined) {
    meta.phone_verified = user.phoneVerified !== undefined;
  }
  if (meta.sub === undefined) meta.sub = user.id;
  return meta;
}

/** Options for {@linkcode userJson}. */
export interface UserJsonOptions {
  /** The user's MFA factors. */
  factors?: GoTrueFactor[];
  /** Pending email change. */
  newEmail?: string;
}

/**
 * The GoTrue `user` object.
 *
 * @param adapter The adapter (for the identities).
 * @param user The stored user.
 * @param options Factors.
 * @returns The JSON object.
 */
export async function userJson(
  adapter: AuthAdapter,
  user: AdapterUser,
  options: UserJsonOptions = {},
): Promise<Record<string, unknown>> {
  const identities = await identitiesOf(adapter, user);
  const created = iso(user.createdAt) ?? new Date(0).toISOString();
  const confirmed = iso(
    [user.emailVerified, user.phoneVerified].filter((t): t is number => typeof t === "number")
      .sort((a, b) => a - b)[0],
  );
  const out: Record<string, unknown> = {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email ?? "",
    phone: user.phone ?? "",
    app_metadata: appMetadataOf(user, identities),
    user_metadata: userMetadataOf(user),
    identities,
    created_at: created,
    updated_at: iso(user.updatedAt) ?? created,
    is_anonymous: user.isAnonymous === true,
  };
  if (iso(user.emailVerified)) out.email_confirmed_at = iso(user.emailVerified);
  if (iso(user.phoneVerified)) out.phone_confirmed_at = iso(user.phoneVerified);
  if (confirmed) out.confirmed_at = confirmed;
  if (iso(user.lastSignInAt)) out.last_sign_in_at = iso(user.lastSignInAt);
  if (user.bannedUntil && user.bannedUntil * 1000 > Date.now()) {
    out.banned_until = iso(user.bannedUntil);
  }
  if (options.factors?.length) out.factors = options.factors;
  if (options.newEmail) out.new_email = options.newEmail;
  return out;
}
