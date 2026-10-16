/**
 * An Auth.js database adapter (`@auth/prisma-adapter`, `@auth/drizzle-adapter`, any object with
 * Auth.js's `Adapter` methods) behind denext's {@link AuthAdapter} port, so `NextAuth({ adapter:
 * PrismaAdapter(prisma) })` keeps its tables: users, accounts, sessions and verification tokens.
 *
 * What Auth.js's schema has no column for — roles, a ban (`bannedUntil`) and
 * `sessionsValidAfter` — is kept through two optional adapter methods, `getUserExtension` and
 * `updateUserExtension` (an extension table beside the users table); an adapter without them
 * keeps working, and those fields are dropped on write (with a warning). A Credentials sign-in
 * links no account row (as in Auth.js: `authorize()` returns a user of the users table, looked
 * up by its id); a verification token is keyed `<purpose>:<email>` and stores the token's
 * SHA-256, never the token. Database sessions are the adapter's `Session` rows; they can't be
 * listed by user, so "sign out everywhere" ends them through `sessionsValidAfter` — only with
 * the extension methods (see KNOWN-LIMITATIONS).
 *
 * @module
 */

import type {
  AdapterAccount,
  AdapterAccountRef,
  AdapterUser,
  AuthAdapter,
  VerificationTokenRecord,
  VerificationTokenRef,
} from "../../server/auth/adapter.ts";
import type { SessionStore } from "../../server/auth/session-store.ts";
import type { AuthSession } from "../../server/auth/types.ts";

import type { Awaitable } from "./types.ts";

/** A user row as Auth.js adapters store it. */
export interface AuthJsAdapterUser {
  /** The user id. */
  id: string;
  /** Email address. */
  email?: string | null;
  /** When the address was verified. */
  emailVerified?: Date | null;
  /** Display name. */
  name?: string | null;
  /** Avatar URL. */
  image?: string | null;
}

/** An account row as Auth.js adapters store it. */
export interface AuthJsAdapterAccount {
  /** The user it belongs to. */
  userId: string;
  /** `"oauth"`, `"oidc"`, `"email"`, … */
  type: string;
  /** The provider id. */
  provider: string;
  /** The account's id at the provider. */
  providerAccountId: string;
  /** The provider access token. */
  access_token?: string;
  /** The provider refresh token. */
  refresh_token?: string;
  /** When the access token expires, epoch seconds. */
  expires_at?: number;
  /** The token type. */
  token_type?: string;
  /** The granted scope. */
  scope?: string;
  /** The OIDC id_token. */
  id_token?: string;
}

/** A session row as Auth.js adapters store it. */
export interface AuthJsAdapterSession {
  /** The session token (the cookie's id). */
  sessionToken: string;
  /** The user it belongs to. */
  userId: string;
  /** When it expires. */
  expires: Date;
}

/** A verification token row as Auth.js adapters store it. */
export interface AuthJsVerificationToken {
  /** What the token proves control of. */
  identifier: string;
  /** The token (denext stores its SHA-256). */
  token: string;
  /** When it expires. */
  expires: Date;
}

/**
 * The denext user fields an Auth.js schema has no column for, as the optional extension methods
 * store them. Times are epoch seconds; `null` clears a field.
 */
export interface AuthJsUserExtension {
  /** Authorization roles (`requireAuth({ role })`). */
  roles?: string[] | null;
  /** Banned until this time: no sign-in or session before it. */
  bannedUntil?: number | null;
  /** Sessions signed in before this time are ended (`revokeAllSessions`, a ban). */
  sessionsValidAfter?: number | null;
}

/** Auth.js's `Adapter` interface — every method optional, as there. */
export interface AuthJsAdapter {
  /** Insert a user. */
  createUser?(user: AuthJsAdapterUser): Awaitable<AuthJsAdapterUser>;
  /** A user by id. */
  getUser?(id: string): Awaitable<AuthJsAdapterUser | null>;
  /** A user by email. */
  getUserByEmail?(email: string): Awaitable<AuthJsAdapterUser | null>;
  /** A user by a linked account. */
  getUserByAccount?(
    ref: { provider: string; providerAccountId: string },
  ): Awaitable<AuthJsAdapterUser | null>;
  /** Update a user. */
  updateUser?(user: Partial<AuthJsAdapterUser> & { id: string }): Awaitable<AuthJsAdapterUser>;
  /** Delete a user. */
  deleteUser?(id: string): Awaitable<unknown>;
  /** Link an account. */
  linkAccount?(account: AuthJsAdapterAccount): Awaitable<unknown>;
  /** Unlink an account. */
  unlinkAccount?(ref: { provider: string; providerAccountId: string }): Awaitable<unknown>;
  /** Insert a session. */
  createSession?(session: AuthJsAdapterSession): Awaitable<AuthJsAdapterSession>;
  /** A session and its user. */
  getSessionAndUser?(
    sessionToken: string,
  ): Awaitable<{ session: AuthJsAdapterSession; user: AuthJsAdapterUser } | null>;
  /** Update a session. */
  updateSession?(
    session: Partial<AuthJsAdapterSession> & { sessionToken: string },
  ): Awaitable<AuthJsAdapterSession | null | undefined>;
  /** Delete a session. */
  deleteSession?(sessionToken: string): Awaitable<unknown>;
  /** Insert a verification token. */
  createVerificationToken?(token: AuthJsVerificationToken): Awaitable<unknown>;
  /** Consume a verification token (delete and return it). */
  useVerificationToken?(
    ref: { identifier: string; token: string },
  ): Awaitable<AuthJsVerificationToken | null>;
  /**
   * denext-only: a user's {@linkcode AuthJsUserExtension} (roles, ban, `sessionsValidAfter`),
   * or `null` when none is stored. With {@linkcode updateUserExtension}, those features work
   * through an Auth.js adapter.
   */
  getUserExtension?(userId: string): Awaitable<AuthJsUserExtension | null>;
  /** denext-only: merge `patch` into a user's extension (creating it); `null` clears a field. */
  updateUserExtension?(userId: string, patch: AuthJsUserExtension): Awaitable<unknown>;
}

/** The extension fields of a denext user (what the users table can't hold). */
const EXTENSION_FIELDS = ["roles", "bannedUntil", "sessionsValidAfter"] as const;

/** The extension methods, when the adapter has both. */
interface Extension {
  read(userId: string): Promise<AuthJsUserExtension | null>;
  write(userId: string, patch: AuthJsUserExtension): Promise<void>;
}

/** The adapter's extension methods, bound; `null` unless it has both. */
function extensionOf(adapter: AuthJsAdapter): Extension | null {
  const get = adapter.getUserExtension?.bind(adapter);
  const update = adapter.updateUserExtension?.bind(adapter);
  if (!get || !update) return null;
  return {
    read: async (userId) => (await get(userId)) ?? null,
    write: async (userId, patch) => void await update(userId, patch),
  };
}

/** The extension part of a denext user patch (`null` for a field set to `undefined`). */
function extensionPatch(patch: Partial<AdapterUser>): AuthJsUserExtension | null {
  const out: AuthJsUserExtension = {};
  let any = false;
  for (const field of EXTENSION_FIELDS) {
    if (!(field in patch)) continue;
    (out as Record<string, unknown>)[field] = patch[field] ?? null;
    any = true;
  }
  return any ? out : null;
}

/** `user` with its stored extension fields. */
function withExtension(user: AdapterUser, stored: AuthJsUserExtension | null): AdapterUser {
  if (!stored) return user;
  if (Array.isArray(stored.roles)) user.roles = [...stored.roles];
  if (typeof stored.bannedUntil === "number") user.bannedUntil = stored.bannedUntil;
  if (typeof stored.sessionsValidAfter === "number") {
    user.sessionsValidAfter = stored.sessionsValidAfter;
  }
  return user;
}

/** Epoch seconds of a date (or a date-ish value a driver returned). */
function seconds(value: Date | string | number): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

/** An Auth.js user row as a denext adapter user. */
function fromRow(row: AuthJsAdapterUser): AdapterUser {
  const user: AdapterUser = { id: String(row.id) };
  if (row.email) user.email = row.email;
  if (row.emailVerified) user.emailVerified = seconds(row.emailVerified);
  if (row.name) user.name = row.name;
  if (row.image) user.image = row.image;
  return user;
}

/** The part of a denext user patch Auth.js's schema has columns for. */
function rowPatch(patch: Partial<AdapterUser>): Partial<AuthJsAdapterUser> {
  const row: Partial<AuthJsAdapterUser> = {};
  if ("email" in patch) row.email = patch.email ?? null;
  if ("name" in patch) row.name = patch.name ?? null;
  if ("image" in patch) row.image = patch.image ?? null;
  if ("emailVerified" in patch) {
    row.emailVerified = patch.emailVerified ? new Date(patch.emailVerified * 1000) : null;
  }
  return row;
}

/** `value` without its `undefined` fields (Prisma and Drizzle reject some of them). */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** The method `name` of `adapter`, or a config-time error naming it. */
function required<K extends keyof AuthJsAdapter>(
  adapter: AuthJsAdapter,
  name: K,
): NonNullable<AuthJsAdapter[K]> {
  const method = adapter[name];
  if (typeof method !== "function") {
    throw new Error(`next-auth: the adapter has no \`${String(name)}\`, which sign-in needs`);
  }
  return method.bind(adapter) as NonNullable<AuthJsAdapter[K]>;
}

/** The identifier a denext verification token is stored under. */
function tokenIdentifier(ref: { identifier: string; purpose: string }): string {
  return `${ref.purpose}:${ref.identifier}`;
}

/** The verification-token half of the bridge (only when the adapter has both methods). */
function verificationTokens(adapter: AuthJsAdapter): Partial<AuthAdapter> {
  const create = adapter.createVerificationToken?.bind(adapter);
  const use = adapter.useVerificationToken?.bind(adapter);
  if (!create || !use) return {};
  return {
    async createVerificationToken(record: VerificationTokenRecord) {
      if (record.data !== undefined) {
        throw new Error("next-auth: an Auth.js adapter can't store a verification token's data");
      }
      await create({
        identifier: tokenIdentifier(record),
        token: record.tokenHash,
        expires: new Date(record.expires * 1000),
      });
    },
    async useVerificationToken(ref: VerificationTokenRef) {
      const row = await use({ identifier: tokenIdentifier(ref), token: ref.tokenHash });
      if (!row) return undefined;
      return { ...ref, expires: seconds(row.expires) };
    },
  };
}

/** A user's session row as a denext session payload (no `authTime`: it never slides). */
function sessionPayload(
  row: AuthJsAdapterSession,
  user: AuthJsAdapterUser,
  extension: AuthJsUserExtension | null,
): AuthSession {
  const stored = withExtension(fromRow(user), extension);
  const session: AuthSession = {
    user: { id: stored.id, emailVerified: stored.emailVerified !== undefined },
    provider: "authjs",
    expiresAt: seconds(row.expires),
    v: 2,
  };
  for (const key of ["email", "name", "image"] as const) {
    if (stored[key]) session.user[key] = stored[key];
  }
  if (stored.roles) session.user.roles = stored.roles;
  return session;
}

/** The adapter's sessions as a denext {@link SessionStore}, when it has the session methods. */
function sessionStore(
  adapter: AuthJsAdapter,
  warn: (message: string) => void,
  extension: Extension | null,
): SessionStore | undefined {
  const { createSession, getSessionAndUser, deleteSession, updateSession } = adapter;
  if (!createSession || !getSessionAndUser || !deleteSession) return undefined;
  return {
    async create(id, session) {
      await createSession.call(adapter, {
        sessionToken: id,
        userId: session.user.id,
        expires: new Date(session.expiresAt * 1000),
      });
    },
    async get(id) {
      const found = await getSessionAndUser.call(adapter, id);
      if (!found || seconds(found.session.expires) * 1000 <= Date.now()) return undefined;
      const stored = extension ? await extension.read(String(found.user.id)) : null;
      return sessionPayload(found.session, found.user, stored);
    },
    async update(id, session) {
      if (!updateSession) return false;
      const row = await updateSession.call(adapter, {
        sessionToken: id,
        expires: new Date(session.expiresAt * 1000),
      });
      return !!row;
    },
    async delete(id) {
      try {
        await deleteSession.call(adapter, id);
      } catch {
        // Already gone (Prisma throws on a missing row): the session is ended either way.
      }
    },
    deleteByUser(userId) {
      // With the extension, revocation stamps the user's `sessionsValidAfter`, which ends every
      // session signed in before it — these rows included — on its next read.
      if (extension) return;
      warn(
        `next-auth: the Auth.js adapter can't list a user's sessions, so the database sessions ` +
          `of user ${JSON.stringify(userId)} were not ended — they expire on their own.`,
      );
    },
  };
}

/** Options for {@linkcode fromAuthJsAdapter}. */
export interface FromAuthJsAdapterOptions {
  /** The Credentials provider ids: their sign-ins link no account row. */
  credentialsProviders: ReadonlySet<string>;
  /** Where a limitation is reported. */
  warn: (message: string) => void;
  /** Told about every user row the bridge updated (Auth.js's `updateUser` event). */
  onUpdateUser?: (user: AuthJsAdapterUser) => void | Promise<void>;
}

/**
 * Put an Auth.js adapter behind denext's adapter port.
 *
 * @param adapter The Auth.js adapter.
 * @param options The Credentials provider ids and a warning sink.
 * @returns The denext adapter (with `sessions` when the adapter stores sessions).
 * @throws {Error} When a method sign-in needs is missing.
 */
export function fromAuthJsAdapter(
  adapter: AuthJsAdapter,
  options: FromAuthJsAdapterOptions,
): AuthAdapter {
  const createUser = required(adapter, "createUser");
  const getUser = required(adapter, "getUser");
  const getUserByEmail = required(adapter, "getUserByEmail");
  const getUserByAccount = required(adapter, "getUserByAccount");
  const updateUser = required(adapter, "updateUser");
  const linkAccount = required(adapter, "linkAccount");
  const extension = extensionOf(adapter);
  /** A row as a denext user, with its extension fields. */
  const userOf = async (row: AuthJsAdapterUser): Promise<AdapterUser> =>
    withExtension(fromRow(row), extension ? await extension.read(String(row.id)) : null);
  /** Store a patch's extension fields, or report that they can't be stored. */
  const writeExtension = async (userId: string, patch: AuthJsUserExtension | null) => {
    if (!patch) return;
    if (extension) return await extension.write(userId, patch);
    options.warn(
      `next-auth: the Auth.js adapter has no getUserExtension / updateUserExtension, so ` +
        `${Object.keys(patch).join(", ")} of user ${JSON.stringify(userId)} were not stored`,
    );
  };
  const bridged: AuthAdapter = {
    async createUser(user) {
      const row = await createUser(defined({
        id: user.id ?? crypto.randomUUID(),
        email: user.email ?? null,
        emailVerified: user.emailVerified ? new Date(user.emailVerified * 1000) : null,
        name: user.name ?? null,
        image: user.image ?? null,
      }));
      // Only the fields the new user actually has (an absent role list is not a write).
      await writeExtension(String(row.id), extensionPatch(defined(user)));
      return await userOf(row);
    },
    async getUser(id) {
      const row = await getUser(id);
      return row ? await userOf(row) : undefined;
    },
    async getUserByEmail(email) {
      const row = await getUserByEmail(email);
      return row ? await userOf(row) : undefined;
    },
    async getUserByAccount(ref: AdapterAccountRef) {
      // A Credentials "account" is the user itself: `authorize()` returned the user row's id.
      const row = options.credentialsProviders.has(ref.provider)
        ? await getUser(ref.providerAccountId)
        : await getUserByAccount({
          provider: ref.provider,
          providerAccountId: ref.providerAccountId,
        });
      return row ? await userOf(row) : undefined;
    },
    async updateUser(patch) {
      const row = rowPatch(patch);
      await writeExtension(patch.id, extensionPatch(patch));
      if (Object.keys(row).length === 0) {
        const current = await getUser(patch.id);
        if (!current) throw new Error(`next-auth: no user ${JSON.stringify(patch.id)}`);
        return await userOf(current);
      }
      const updated = await updateUser({ ...row, id: patch.id });
      await options.onUpdateUser?.(updated);
      return await userOf(updated);
    },
    async linkAccount(account: AdapterAccount) {
      if (account.type === "credentials") return;
      await linkAccount(defined({
        userId: account.userId,
        type: account.type ?? "oauth",
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        expires_at: account.expiresAt,
        token_type: account.tokenType,
        scope: account.scope,
        id_token: account.idToken,
      }));
    },
    ...verificationTokens(adapter),
  };
  if (adapter.unlinkAccount) {
    const unlink = adapter.unlinkAccount.bind(adapter);
    bridged.unlinkAccount = async (ref) => {
      await unlink({ provider: ref.provider, providerAccountId: ref.providerAccountId });
    };
  }
  const sessions = sessionStore(adapter, options.warn, extension);
  if (sessions) bridged.sessions = sessions;
  return bridged;
}
