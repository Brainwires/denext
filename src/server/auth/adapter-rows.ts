// The row mapping both SQL auth adapters share (`sqliteAuthAdapter`, `postgresAuthAdapter`):
// which column each record field lives in, how a value crosses the SQL boundary in each
// direction, and the read-merge and compare-and-swap loops whose logic does not depend on the
// database. One definition, so the two adapters cannot drift apart on what a row means.

import type {
  AdapterAccount,
  AdapterUser,
  ApiTokenRecord,
  MaybePromise,
  MfaFactorRecord,
  MfaRecord,
  NativeGrantRecord,
  NativeSessionRecord,
  PasskeyChallengeRecord,
  PasskeyRecord,
  VerificationTokenRecord,
} from "./adapter.ts";
import { toNumber } from "../postgres.ts";

/** How one record field crosses the SQL boundary in both directions. */
export interface Codec {
  /** Column value → field value (`undefined` drops the field from the record). */
  from(value: unknown): unknown;
  /** Field value → bound parameter (`null` for an absent field). */
  to(value: unknown): unknown;
}

/** Which column (and codec) each field of a record lives in. */
export type FieldMap<T> = { [K in keyof T]?: readonly [column: string, codec: Codec] };

/** A text column holding an optional string. */
const TEXT: Codec = {
  from: (value) => typeof value === "string" ? value : undefined,
  to: (value) => typeof value === "string" ? value : null,
};

/** An integer column holding an optional number (Postgres `int8` arrives as a string). */
const INT: Codec = {
  from: toNumber,
  to: (value) => typeof value === "number" ? value : null,
};

/** A boolean column — SQLite's 0/1 or Postgres' `BOOLEAN` (absent → `false`). */
const BOOL: Codec = {
  from: (value) => value === true || value === 1 || value === "t" || value === "true",
  to: (value) => value === true,
};

/** Parse a JSON string array, tolerating a NULL or a value another writer corrupted. */
function parseList(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/** A text column holding a JSON array of strings — absent when the column is NULL. */
const LIST: Codec = {
  from: (value) => parseList(value),
  to: (value) => Array.isArray(value) ? JSON.stringify(value) : null,
};

/** A boolean column whose `false` reads as absent (an optional flag). */
const FLAG: Codec = {
  from: (value) => value === true || value === 1 || value === "t" || value === "true" || undefined,
  to: (value) => value === true ? true : null,
};

/** Parse a JSON object, tolerating a NULL or a corrupted value. */
function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** A text column holding a JSON object — absent when the column is NULL. */
const OBJECT: Codec = {
  from: (value) => parseObject(value),
  to: (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : null,
};

/** A text column holding a JSON array of strings that is never absent, only empty. */
const CODES: Codec = { from: (value) => parseList(value) ?? [], to: LIST.to };

/**
 * Build a record from a row — the one read path every table shares.
 *
 * @param map The table's field map.
 * @param row The row, keyed by column.
 * @returns The record, with absent fields left out (never `key: undefined`).
 */
export function fromRow<T>(map: FieldMap<T>, row: Record<string, unknown>): T {
  const record: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(map) as Array<[string, [string, Codec]]>) {
    const value = spec[1].from(row[spec[0]] ?? null);
    // An absent field, never `key: undefined`: a row must map to the shape a hand-written
    // record has, or the shared contract suite would mean two different things.
    if (value !== undefined) record[field] = value;
  }
  return record as T;
}

/**
 * Build a column → parameter object from a record — the one write path every table shares.
 * Booleans stay booleans; an adapter whose driver can't bind them converts them.
 *
 * @param map The table's field map.
 * @param record The record.
 * @returns The parameters, keyed by column.
 */
export function toRow<T extends object>(map: FieldMap<T>, record: T): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(map) as Array<[string, [string, Codec]]>) {
    row[spec[0]] = spec[1].to((record as Record<string, unknown>)[field]);
  }
  return row;
}

export const USER_MAP: FieldMap<AdapterUser> = {
  id: ["id", TEXT],
  email: ["email", TEXT],
  emailVerified: ["email_verified", INT],
  name: ["name", TEXT],
  image: ["image", TEXT],
  roles: ["roles", LIST],
  phone: ["phone", TEXT],
  phoneVerified: ["phone_verified", INT],
  userMetadata: ["user_metadata", OBJECT],
  appMetadata: ["app_metadata", OBJECT],
  isAnonymous: ["is_anonymous", FLAG],
  createdAt: ["created_at", INT],
  updatedAt: ["updated_at", INT],
  lastSignInAt: ["last_sign_in_at", INT],
  bannedUntil: ["banned_until", INT],
};

export const ACCOUNT_MAP: FieldMap<AdapterAccount> = {
  userId: ["user_id", TEXT],
  provider: ["provider", TEXT],
  providerAccountId: ["provider_account_id", TEXT],
  type: ["type", TEXT],
  accessToken: ["access_token", TEXT],
  refreshToken: ["refresh_token", TEXT],
  expiresAt: ["expires_at", INT],
  tokenType: ["token_type", TEXT],
  scope: ["scope", TEXT],
  idToken: ["id_token", TEXT],
  identityId: ["identity_id", TEXT],
  identityData: ["identity_data", OBJECT],
  email: ["email", TEXT],
  createdAt: ["created_at", INT],
  updatedAt: ["updated_at", INT],
  lastSignInAt: ["last_sign_in_at", INT],
};

export const VERIFICATION_MAP: FieldMap<VerificationTokenRecord> = {
  identifier: ["identifier", TEXT],
  purpose: ["purpose", TEXT],
  tokenHash: ["token_hash", TEXT],
  expires: ["expires", INT],
  data: ["data", TEXT],
};

export const API_TOKEN_MAP: FieldMap<ApiTokenRecord> = {
  id: ["id", TEXT],
  userId: ["user_id", TEXT],
  name: ["name", TEXT],
  tokenHash: ["token_hash", TEXT],
  scopes: ["scopes", LIST],
  createdAt: ["created_at", INT],
  expiresAt: ["expires_at", INT],
  lastUsedAt: ["last_used_at", INT],
  revokedAt: ["revoked_at", INT],
};

export const MFA_MAP: FieldMap<MfaRecord> = {
  userId: ["user_id", TEXT],
  secret: ["secret", TEXT],
  confirmedAt: ["confirmed_at", INT],
  backupCodeHashes: ["backup_code_hashes", CODES],
  lastStep: ["last_step", INT],
};

export const MFA_FACTOR_MAP: FieldMap<MfaFactorRecord> = {
  id: ["id", TEXT],
  userId: ["user_id", TEXT],
  type: ["factor_type", TEXT],
  status: ["status", TEXT],
  friendlyName: ["friendly_name", TEXT],
  secret: ["secret", TEXT],
  phone: ["phone", TEXT],
  createdAt: ["created_at", INT],
  updatedAt: ["updated_at", INT],
  lastStep: ["last_step", INT],
  lastChallengedAt: ["last_challenged_at", INT],
};

/** The columns {@linkcode AuthAdapter.updateMfaFactor} may change, by field. */
const MFA_FACTOR_PATCHABLE = {
  status: "status",
  friendlyName: "friendly_name",
  updatedAt: "updated_at",
  lastChallengedAt: "last_challenged_at",
} as const;

export const NATIVE_GRANT_MAP: FieldMap<NativeGrantRecord> = {
  hash: ["hash", TEXT],
  kind: ["kind", TEXT],
  expiresAt: ["expires_at", INT],
  data: ["data", TEXT],
};

export const PASSKEY_MAP: FieldMap<PasskeyRecord> = {
  id: ["id", TEXT],
  userId: ["user_id", TEXT],
  publicKey: ["public_key", TEXT],
  alg: ["alg", INT],
  signCount: ["sign_count", INT],
  backupEligible: ["backup_eligible", BOOL],
  backedUp: ["backed_up", BOOL],
  transports: ["transports", LIST],
  aaguid: ["aaguid", TEXT],
  name: ["name", TEXT],
  createdAt: ["created_at", INT],
  lastUsedAt: ["last_used_at", INT],
};

export const PASSKEY_CHALLENGE_MAP: FieldMap<PasskeyChallengeRecord> = {
  hash: ["hash", TEXT],
  expiresAt: ["expires_at", INT],
  data: ["data", TEXT],
};

export const NATIVE_SESSION_MAP: FieldMap<NativeSessionRecord> = {
  id: ["id", TEXT],
  userId: ["user_id", TEXT],
  generation: ["generation", INT],
  salt: ["salt", TEXT],
  session: ["session", TEXT],
  createdAt: ["created_at", INT],
  expiresAt: ["expires_at", INT],
  revokedAt: ["revoked_at", INT],
  rotatedAt: ["rotated_at", INT],
};

/**
 * The record `createUser` stores: the caller's id, or a fresh UUID.
 *
 * @param user The profile to store.
 * @returns The user with its final id.
 */
export function withUserId(user: Omit<AdapterUser, "id"> & { id?: string }): AdapterUser {
  const { id, ...rest } = user;
  return { ...rest, id: id ?? crypto.randomUUID() };
}

/**
 * Merge `patch` into the stored user row: an absent (or `undefined`) field is unchanged.
 *
 * @param row The stored row, or `undefined` when there is none.
 * @param patch The id plus the fields to change.
 * @param adapter The adapter, named in the error.
 * @returns The merged record.
 * @throws {Error} When no user has that id.
 */
export function patchUser(
  row: Record<string, unknown> | undefined,
  patch: Partial<AdapterUser> & { id: string },
  adapter: string,
): AdapterUser {
  if (!row) throw new Error(`${adapter}: no user with id ${JSON.stringify(patch.id)}`);
  const next = fromRow(USER_MAP, row);
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) Reflect.set(next, key, value);
  }
  return next;
}

/**
 * How long (seconds) a native session family is kept after it expired or was revoked: 30
 * days, then the next sign-in deletes it.
 */
export const NATIVE_SESSION_RETENTION = 30 * 24 * 60 * 60;

/** How many times a losing compare-and-swap re-reads before giving up. */
const SWAP_ATTEMPTS = 4;

/**
 * Spend one backup code by compare-and-swap. The comparison is the caller's (scrypt), so the
 * read-match-write cannot be one statement; instead the write lands only while the stored list
 * is still the one that was matched, so a concurrent redemption — in this process or another —
 * loses the swap and retries against the rewritten list. Racing on ONE code yields exactly one
 * `true`; racing on two different codes spends both.
 *
 * @param read Reads the factor (fresh on every attempt).
 * @param swap Writes `next` only while the stored list still serializes to `before`.
 * @param matches Constant-time comparison of the presented code against one stored hash.
 * @returns `true` when a code was matched AND removed.
 */
export async function spendBackupCode(
  read: () => MaybePromise<MfaRecord | undefined>,
  swap: (next: string, before: string) => MaybePromise<boolean>,
  matches: (hash: string) => MaybePromise<boolean>,
): Promise<boolean> {
  for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt++) {
    const record = await read();
    if (!record) return false;
    let index = -1;
    for (const [at, hash] of record.backupCodeHashes.entries()) {
      if (await matches(hash)) {
        index = at;
        break;
      }
    }
    if (index < 0) return false;
    const rest = record.backupCodeHashes.filter((_, at) => at !== index);
    if (await swap(JSON.stringify(rest), JSON.stringify(record.backupCodeHashes))) return true;
  }
  return false;
}

/**
 * The `LIMIT` / `OFFSET` of a 1-based page (both clamped to at least 1).
 *
 * @param page The page.
 * @param perPage Its size.
 * @returns The size and the offset.
 */
export function pageWindow(page: number, perPage: number): { size: number; offset: number } {
  const size = Math.max(1, Math.floor(perPage));
  return { size, offset: (Math.max(1, Math.floor(page)) - 1) * size };
}

/**
 * The `column = value` pairs an `updateMfaFactor` patch sets (undefined fields skipped).
 *
 * @param patch The patch.
 * @returns The pairs, in field order.
 */
export function factorPatchColumns(patch: object): Array<[column: string, value: unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [field, column] of Object.entries(MFA_FACTOR_PATCHABLE)) {
    const value = (patch as Record<string, unknown>)[field];
    if (value !== undefined) out.push([column, value]);
  }
  return out;
}
