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
  PasskeyChallengeRecord,
  PasskeyRecord,
  VerificationTokenRecord,
  VerificationTokenRef,
} from "../../server/auth/adapter.ts";
import { decodeCbor } from "../../server/auth/cbor.ts";
import { type CacheStore, getCacheStore } from "../../server/cache.ts";
import { base64UrlDecode } from "../../server/auth/oauth.ts";
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

/** An authenticator row as Auth.js adapters store it (WebAuthn / passkey credentials). */
export interface AuthJsAdapterAuthenticator {
  /** The credential ID, base64. */
  credentialID: string;
  /** The user it belongs to. */
  userId: string;
  /** The account row it hangs off (the credential ID too). */
  providerAccountId: string;
  /** The credential public key (a COSE_Key), base64. */
  credentialPublicKey: string;
  /** The signature counter. */
  counter: number;
  /** `"multiDevice"` for a credential that may be synced (backup eligible), else `"singleDevice"`. */
  credentialDeviceType: string;
  /** Whether it is backed up. */
  credentialBackedUp: boolean;
  /** The transports, comma-separated. */
  transports?: string | null;
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
  /** A WebAuthn authenticator by credential ID. */
  getAuthenticator?(credentialID: string): Awaitable<AuthJsAdapterAuthenticator | null>;
  /** Insert a WebAuthn authenticator. */
  createAuthenticator?(
    authenticator: AuthJsAdapterAuthenticator,
  ): Awaitable<AuthJsAdapterAuthenticator>;
  /** A user's WebAuthn authenticators. */
  listAuthenticatorsByUserId?(userId: string): Awaitable<AuthJsAdapterAuthenticator[]>;
  /** Set an authenticator's signature counter. */
  updateAuthenticatorCounter?(
    credentialID: string,
    newCounter: number,
  ): Awaitable<AuthJsAdapterAuthenticator>;
  /**
   * denext-only: delete a WebAuthn authenticator (Auth.js's adapters have no such method; without
   * it, denext's `DELETE {basePath}/passkeys/:id` fails).
   */
  deleteAuthenticator?(credentialID: string): Awaitable<unknown>;
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

/** Standard base64 (Auth.js's encoding of credential IDs and keys) as base64url. */
function base64ToUrl(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url as standard, padded base64. */
function urlToBase64(value: string): string {
  const std = value.replace(/-/g, "+").replace(/_/g, "/");
  return std + "=".repeat((4 - std.length % 4) % 4);
}

/** The COSE algorithm (label 3) of a stored public key; `0` when it has none. */
function coseAlgorithm(publicKey: string): number {
  try {
    const map = decodeCbor(base64UrlDecode(publicKey));
    const alg = map instanceof Map ? map.get(3) : undefined;
    return typeof alg === "number" ? alg : 0;
  } catch {
    return 0;
  }
}

/** An Auth.js authenticator row as a denext passkey record. */
function passkeyOf(row: AuthJsAdapterAuthenticator): PasskeyRecord {
  const publicKey = base64ToUrl(row.credentialPublicKey);
  const record: PasskeyRecord = {
    id: base64ToUrl(row.credentialID),
    userId: String(row.userId),
    publicKey,
    alg: coseAlgorithm(publicKey),
    signCount: Number(row.counter) || 0,
    backupEligible: row.credentialDeviceType === "multiDevice",
    backedUp: !!row.credentialBackedUp,
    // Auth.js's schema keeps no registration time.
    createdAt: 0,
  };
  if (row.transports) record.transports = row.transports.split(",").filter(Boolean);
  return record;
}

/** How long an unredeemed in-memory passkey challenge is kept at most, in seconds. */
const CHALLENGE_CAP_SECONDS = 15 * 60;
/** The most in-memory passkey challenges kept at once (the oldest go first). */
const MAX_CHALLENGES = 10_000;

/** The cache-store key a challenge's record lives under (its hash names it). */
const CHALLENGE_KEY = "denext:passkey-challenge:";

/** The port's challenge pair. */
type ChallengeGroup = Pick<
  Required<AuthAdapter>,
  "createPasskeyChallenge" | "usePasskeyChallenge"
>;

/** A record read back from a store, when it is one this bridge wrote. */
function challengeRecord(value: unknown): PasskeyChallengeRecord | undefined {
  const record = value as Partial<PasskeyChallengeRecord> | null | undefined;
  if (
    typeof record?.hash !== "string" || typeof record.data !== "string" ||
    typeof record.expiresAt !== "number"
  ) {
    return undefined;
  }
  return record as PasskeyChallengeRecord;
}

/**
 * Passkey challenges in the app's cache store when it can take an entry atomically
 * (`takeData`): an Auth.js schema has no table for them (Auth.js keeps its challenge in a
 * cookie), and a shared store lets any instance finish a ceremony another began. Each is
 * single-use (an atomic take), expires with the ceremony (15 minutes at most) and carries no
 * tag a revalidation could reach. A store without `takeData` falls back to `memory`.
 */
function storeChallenges(store: () => CacheStore, memory: ChallengeGroup): ChallengeGroup {
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  return {
    async createPasskeyChallenge(record) {
      const cache = store();
      if (!cache.takeData) return await memory.createPasskeyChallenge(record);
      const expiresAt = Math.min(record.expiresAt, nowSeconds() + CHALLENGE_CAP_SECONDS);
      await cache.setData(`${CHALLENGE_KEY}${record.hash}`, {
        value: { ...record, expiresAt },
        expiresAt: expiresAt * 1000,
        tags: [],
      });
    },
    async usePasskeyChallenge(hash) {
      const cache = store();
      if (!cache.takeData) return await memory.usePasskeyChallenge(hash);
      const record = challengeRecord((await cache.takeData(`${CHALLENGE_KEY}${hash}`))?.value);
      if (!record || record.hash !== hash || record.expiresAt <= nowSeconds()) return undefined;
      return record;
    },
  };
}

/**
 * Passkey challenges in this instance's memory, for a cache store that can't take an entry
 * atomically. Single-use and expiring, as the adapter port requires.
 */
function memoryChallenges(): ChallengeGroup {
  const challenges = new Map<string, PasskeyChallengeRecord>();
  return {
    createPasskeyChallenge(record) {
      const now = Math.floor(Date.now() / 1000);
      for (const [hash, stored] of challenges) {
        if (stored.expiresAt <= now) challenges.delete(hash);
      }
      while (challenges.size >= MAX_CHALLENGES) {
        challenges.delete(challenges.keys().next().value!);
      }
      const expiresAt = Math.min(record.expiresAt, now + CHALLENGE_CAP_SECONDS);
      challenges.set(record.hash, { ...record, expiresAt });
    },
    usePasskeyChallenge(hash) {
      const record = challenges.get(hash);
      challenges.delete(hash);
      if (!record || record.expiresAt <= Math.floor(Date.now() / 1000)) return undefined;
      return record;
    },
  };
}

/**
 * The passkey group on Auth.js's authenticator methods (`getAuthenticator`,
 * `createAuthenticator`, `listAuthenticatorsByUserId`, `updateAuthenticatorCounter`), when the
 * adapter has all four: a registration links a `webauthn` account (provider `providerId`, the
 * credential ID) and stores the authenticator, as Auth.js does, so the rows stay Auth.js's.
 */
function passkeyGroup(
  adapter: AuthJsAdapter,
  providerId: string,
  linkAccount: NonNullable<AuthJsAdapter["linkAccount"]>,
  challengeStore: () => CacheStore,
): Partial<AuthAdapter> {
  const get = adapter.getAuthenticator?.bind(adapter);
  const create = adapter.createAuthenticator?.bind(adapter);
  const list = adapter.listAuthenticatorsByUserId?.bind(adapter);
  const update = adapter.updateAuthenticatorCounter?.bind(adapter);
  if (!get || !create || !list || !update) return {};
  const remove = adapter.deleteAuthenticator?.bind(adapter);
  return {
    async createPasskey(record) {
      const credentialID = urlToBase64(record.id);
      if (await get(credentialID)) return false;
      await linkAccount({
        userId: record.userId,
        type: "webauthn",
        provider: providerId,
        providerAccountId: credentialID,
      });
      try {
        await create(defined({
          credentialID,
          userId: record.userId,
          providerAccountId: credentialID,
          credentialPublicKey: urlToBase64(record.publicKey),
          counter: record.signCount,
          credentialDeviceType: record.backupEligible ? "multiDevice" : "singleDevice",
          credentialBackedUp: record.backedUp,
          transports: record.transports?.join(","),
        }));
      } catch {
        // The credential ID is unique in Auth.js's schema: a racing registration took it.
        return false;
      }
      return true;
    },
    async getPasskey(id) {
      const row = await get(urlToBase64(id));
      return row ? passkeyOf(row) : undefined;
    },
    async listPasskeys(userId) {
      return (await list(userId)).map(passkeyOf);
    },
    async updatePasskey(id, fromSignCount, next) {
      // Auth.js's port has no compare-and-swap: read, check, write.
      const credentialID = urlToBase64(id);
      const row = await get(credentialID);
      if (!row || (Number(row.counter) || 0) !== fromSignCount) return false;
      await update(credentialID, next.signCount);
      return true;
    },
    async deletePasskey(id) {
      if (!remove) {
        throw new Error(
          "next-auth: the Auth.js adapter has no deleteAuthenticator, so a passkey can't be removed",
        );
      }
      await remove(urlToBase64(id));
    },
    ...storeChallenges(challengeStore, memoryChallenges()),
  };
}

/**
 * A user's session row as a denext session payload (no `authTime`: it never slides). With the
 * session `maxAge`, its sign-in time to the millisecond (`authTimeMs`): the row's expiry less
 * `maxAge`, the expiry having been written with the sign-in's milliseconds ({@link rowExpires}),
 * so "sign out everywhere" tells a sign-in in the same second, but after it, from one before.
 */
function sessionPayload(
  row: AuthJsAdapterSession,
  user: AuthJsAdapterUser,
  extension: AuthJsUserExtension | null,
  maxAge: number | undefined,
): AuthSession {
  const stored = withExtension(fromRow(user), extension);
  const session: AuthSession = {
    user: { id: stored.id, emailVerified: stored.emailVerified !== undefined },
    provider: "authjs",
    expiresAt: seconds(row.expires),
    v: 2,
  };
  if (maxAge !== undefined) session.authTimeMs = new Date(row.expires).getTime() - maxAge * 1000;
  for (const key of ["email", "name", "image"] as const) {
    if (stored[key]) session.user[key] = stored[key];
  }
  if (stored.roles) session.user.roles = stored.roles;
  return session;
}

/**
 * A session row's expiry: the payload's (whole seconds) plus the sub-second part of its sign-in,
 * so the row keeps the sign-in's milliseconds ({@link sessionPayload} reads them back).
 */
function rowExpires(session: AuthSession): Date {
  const fraction = typeof session.authTimeMs === "number" ? session.authTimeMs % 1000 : 0;
  return new Date(session.expiresAt * 1000 + fraction);
}

/** The adapter's sessions as a denext {@link SessionStore}, when it has the session methods. */
function sessionStore(
  adapter: AuthJsAdapter,
  warn: (message: string) => void,
  extension: Extension | null,
  maxAge: number | undefined,
): SessionStore | undefined {
  const { createSession, getSessionAndUser, deleteSession, updateSession } = adapter;
  if (!createSession || !getSessionAndUser || !deleteSession) return undefined;
  return {
    async create(id, session) {
      await createSession.call(adapter, {
        sessionToken: id,
        userId: session.user.id,
        expires: rowExpires(session),
      });
    },
    async get(id) {
      const found = await getSessionAndUser.call(adapter, id);
      if (!found || seconds(found.session.expires) * 1000 <= Date.now()) return undefined;
      const stored = extension ? await extension.read(String(found.user.id)) : null;
      return sessionPayload(found.session, found.user, stored, maxAge);
    },
    async update(id, session) {
      if (!updateSession) return false;
      const row = await updateSession.call(adapter, {
        sessionToken: id,
        expires: rowExpires(session),
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
  /** The session `maxAge` (seconds): a session row's sign-in is its expiry less this. */
  maxAge?: number;
  /** Told about every user row the bridge updated (Auth.js's `updateUser` event). */
  onUpdateUser?: (user: AuthJsAdapterUser) => void | Promise<void>;
  /** The WebAuthn provider's id (`"passkey"`), when the app has one: its accounts' provider. */
  webAuthnProvider?: string;
  /**
   * Where passkey ceremony challenges live: the app's cache store (`cache.store` /
   * `setCacheStore`) by default, read on every call. A store with `takeData` (SQLite, Postgres,
   * Redis, Deno KV) holds them, so every instance sharing it can finish a ceremony; one without
   * (the in-memory store) leaves them in this instance's memory.
   */
  challengeStore?: () => CacheStore;
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
    ...(options.webAuthnProvider
      ? passkeyGroup(
        adapter,
        options.webAuthnProvider,
        linkAccount,
        options.challengeStore ?? getCacheStore,
      )
      : {}),
  };
  if (adapter.unlinkAccount) {
    const unlink = adapter.unlinkAccount.bind(adapter);
    bridged.unlinkAccount = async (ref) => {
      await unlink({ provider: ref.provider, providerAccountId: ref.providerAccountId });
    };
  }
  const sessions = sessionStore(adapter, options.warn, extension, options.maxAge);
  if (sessions) bridged.sessions = sessions;
  return bridged;
}
