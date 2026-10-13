/**
 * The {@link ./adapter.ts | AuthAdapter} on Postgres — what multi-replica deployments share:
 *
 * ```ts
 * import { denextAuth, postgresAuthAdapter } from "denext/server";
 * denextAuth({ ..., adapter: postgresAuthAdapter({ url: Deno.env.get("DATABASE_URL") }) });
 * ```
 *
 * The same contract as `sqliteAuthAdapter`, method for method: the twelve `auth_`-prefixed
 * tables (users, linked accounts, verification tokens, password hashes, bearer API tokens,
 * TOTP factors, native-app grants and session families, passkeys and their challenges, plus
 * `auth_sessions` and `auth_rate_limits`) are created by migrations on first use, recorded in
 * `auth_migrations` (pass `migrate: false` to apply them out of band). The consume-once
 * methods are single statements (`DELETE … RETURNING`, a conditional `UPDATE … RETURNING`), so
 * they hold across every replica, not just within one process.
 *
 * `url` opens a client on `Deno.SQL`, the Postgres client built into denext's Deno runtime; on
 * stock Deno pass `sql` instead — any {@link ../postgres.ts | SqlClient}, such as the npm
 * `postgres` package through `fromPostgresJs`. A client you pass is never closed by the adapter.
 *
 * @module
 */

import type { AdapterUser, AuthAdapter } from "./adapter.ts";
import {
  ACCOUNT_MAP,
  API_TOKEN_MAP,
  factorPatchColumns,
  type FieldMap,
  fromRow,
  MFA_FACTOR_MAP,
  MFA_MAP,
  NATIVE_GRANT_MAP,
  NATIVE_SESSION_MAP,
  NATIVE_SESSION_RETENTION,
  pageWindow,
  PASSKEY_CHALLENGE_MAP,
  PASSKEY_MAP,
  patchUser,
  spendBackupCode,
  toRow,
  USER_MAP,
  VERIFICATION_MAP,
  withUserId,
} from "./adapter-rows.ts";
import { emailKey } from "./email-key.ts";
import { type AuthDb, authDb, type PostgresAuthStoreOptions } from "./postgres-schema.ts";
import { pgSessionStore } from "./postgres-session-store.ts";
import { type SqlClient, type SqlRow, toNumber } from "../postgres.ts";

/** Options for {@linkcode postgresAuthAdapter}. */
export interface PostgresAuthAdapterOptions extends PostgresAuthStoreOptions {
  /**
   * Clock override, in **epoch seconds** — what expiry is measured against. Defaults to the
   * system clock; tests pass their own to age a token without sleeping.
   */
  now?: () => number;
  /** Min ms between proactive sweeps of expired verification tokens (default 30000; `0` = every write). */
  sweepEvery?: number;
}

const SWEEP_INTERVAL = 30_000;

/** `$1, $2, …` for `n` parameters. */
const placeholders = (n: number): string =>
  Array.from({ length: n }, (_, i) => `$${i + 1}`).join(", ");

/**
 * One adapter's view of the database: every statement goes through these, with table names
 * from the handle (module constants, schema-qualified) and every value a bound parameter.
 */
interface Pg {
  /** A table's qualified name. */
  t(name: string): string;
  /** Epoch seconds. */
  now(): number;
  /** Run a statement for its effect. */
  run(text: string, params: unknown[]): Promise<void>;
  /** The rows a statement returns. */
  rows(text: string, params: unknown[]): Promise<SqlRow[]>;
  /** The first row as a record, or `undefined`. */
  record<T>(map: FieldMap<T>, text: string, params: unknown[]): Promise<T | undefined>;
  /** Every row as a record. */
  records<T>(map: FieldMap<T>, text: string, params: unknown[]): Promise<T[]>;
  /** Whether a conditional `UPDATE … RETURNING` / `INSERT … RETURNING` changed exactly one row. */
  one(text: string, params: unknown[]): Promise<boolean>;
  /**
   * Insert `values` (column → parameter), or rewrite the row whose `key` columns clash. Only
   * that constraint is absorbed: a violation of another unique index (the email one) raises.
   */
  upsert(table: string, values: Record<string, unknown>, key: string[]): Promise<void>;
  /** Run `fn` in one transaction. */
  begin(fn: (tx: SqlClient) => Promise<void>): Promise<void>;
  /** Reclaim expired verification tokens, throttled. */
  sweep(): Promise<void>;
}

/** Build the statement helpers over a migrated handle. */
function pg(handle: AuthDb, options: PostgresAuthAdapterOptions): Pg {
  const sweepEvery = options.sweepEvery ?? SWEEP_INTERVAL;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let lastSweep = 0;
  const rows = async (text: string, params: unknown[]) => [
    ...await (await handle.ready()).unsafe(text, params),
  ];
  const run = async (text: string, params: unknown[]) => void await rows(text, params);
  return {
    t: handle.table,
    now,
    run,
    rows,
    async record(map, text, params) {
      const [row] = await rows(text, params);
      return row && fromRow(map, row);
    },
    async records(map, text, params) {
      return (await rows(text, params)).map((row) => fromRow(map, row));
    },
    one: async (text, params) => (await rows(text, params)).length === 1,
    upsert(table, values, key) {
      const columns = Object.keys(values);
      const updates = columns.filter((c) => !key.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
      return run(
        `INSERT INTO ${handle.table(table)} (${columns.join(", ")}) ` +
          `VALUES (${placeholders(columns.length)}) ` +
          `ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${updates.join(", ")}`,
        Object.values(values),
      );
    },
    async begin(fn) {
      await (await handle.ready()).begin(fn);
    },
    async sweep() {
      const at = Date.now();
      if (at - lastSweep < sweepEvery) return;
      lastSweep = at;
      await run(`DELETE FROM ${handle.table("auth_verification_tokens")} WHERE expires <= $1`, [
        now(),
      ]);
    },
  };
}

// ---- method groups ---------------------------------------------------------

/**
 * Write a user row, keeping `created_at` and the derived email key in step: one
 * `INSERT … ON CONFLICT (id) DO UPDATE`, so the row is either the old one or the new one, and a
 * second user on one address fails on the unique email index instead of replacing anyone.
 */
async function saveUser(db: Pg, user: AdapterUser, createdAt: number): Promise<AdapterUser> {
  await db.upsert("auth_users", {
    ...toRow(USER_MAP, user),
    email_lc: user.email ? emailKey(user.email) : null,
    created_at: createdAt,
  }, ["id"]);
  return { ...user, createdAt };
}

/** The five required user methods. */
function userMethods(
  db: Pg,
): Pick<
  AuthAdapter,
  | "createUser"
  | "getUser"
  | "getUserByEmail"
  | "getUserByAccount"
  | "updateUser"
  | "getUserByPhone"
  | "listUsers"
> {
  const users = db.t("auth_users");
  return {
    createUser: (user) => saveUser(db, withUserId(user), db.now()),
    getUser: (id) => db.record(USER_MAP, `SELECT * FROM ${users} WHERE id = $1`, [id]),
    getUserByPhone: (phone) =>
      db.record(USER_MAP, `SELECT * FROM ${users} WHERE phone = $1`, [phone]),
    async listUsers({ page, perPage }) {
      const { size, offset } = pageWindow(page, perPage);
      const list = await db.records(
        USER_MAP,
        `SELECT * FROM ${users} ORDER BY created_at, id LIMIT $1 OFFSET $2`,
        [size, offset],
      );
      const [row] = await db.rows(`SELECT count(*) AS n FROM ${users}`, []);
      return { users: list, total: Number(row?.n ?? 0) };
    },
    getUserByEmail: (email) =>
      db.record(USER_MAP, `SELECT * FROM ${users} WHERE email_lc = $1`, [emailKey(email)]),
    getUserByAccount: (ref) =>
      db.record(
        USER_MAP,
        `SELECT u.* FROM ${users} u JOIN ${db.t("auth_accounts")} a ON a.user_id = u.id ` +
          "WHERE a.provider = $1 AND a.provider_account_id = $2",
        [ref.provider, ref.providerAccountId],
      ),
    async updateUser(patch) {
      const [row] = await db.rows(`SELECT * FROM ${users} WHERE id = $1`, [patch.id]);
      const next = patchUser(row, patch, "postgresAuthAdapter");
      return saveUser(db, next, toNumber(row.created_at) ?? db.now());
    },
  };
}

/** Link / unlink / list provider accounts, and store / redeem verification tokens. */
function accountAndTokenMethods(
  db: Pg,
): Pick<
  AuthAdapter,
  | "linkAccount"
  | "unlinkAccount"
  | "listAccounts"
  | "createVerificationToken"
  | "useVerificationToken"
> {
  const accounts = db.t("auth_accounts");
  const tokens = db.t("auth_verification_tokens");
  return {
    linkAccount: (account) =>
      db.upsert("auth_accounts", {
        ...toRow(ACCOUNT_MAP, account),
        created_at: account.createdAt ?? db.now(),
      }, ["provider", "provider_account_id"]),
    unlinkAccount: (ref) =>
      db.run(`DELETE FROM ${accounts} WHERE provider = $1 AND provider_account_id = $2`, [
        ref.provider,
        ref.providerAccountId,
      ]),
    listAccounts: (userId) =>
      db.records(
        ACCOUNT_MAP,
        `SELECT * FROM ${accounts} WHERE user_id = $1 ORDER BY provider, provider_account_id`,
        [userId],
      ),
    async createVerificationToken(token) {
      await db.upsert("auth_verification_tokens", toRow(VERIFICATION_MAP, token), [
        "identifier",
        "purpose",
      ]);
      await db.sweep();
    },
    async useVerificationToken(ref) {
      // One statement: read and delete together, so two concurrent redemptions — on any
      // replica — can never both see the row. An expired token is spent too, never resolved.
      const record = await db.record(
        VERIFICATION_MAP,
        `DELETE FROM ${tokens} WHERE identifier = $1 AND purpose = $2 AND token_hash = $3 ` +
          "RETURNING *",
        [ref.identifier, ref.purpose, ref.tokenHash],
      );
      return record && record.expires > db.now() ? record : undefined;
    },
  };
}

/** Password hashes for the Credentials provider, and bearer API tokens. */
function credentialAndApiTokenMethods(
  db: Pg,
): Pick<
  AuthAdapter,
  | "getCredential"
  | "setCredential"
  | "deleteCredential"
  | "createApiToken"
  | "getApiTokenByHash"
  | "touchApiToken"
  | "revokeApiToken"
  | "listApiTokens"
> {
  const credentials = db.t("auth_credentials");
  const tokens = db.t("auth_api_tokens");
  // Revoked and expired tokens are invisible to every read.
  const live = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)";
  return {
    async getCredential(userId) {
      const [row] = await db.rows(
        `SELECT password_hash FROM ${credentials} WHERE user_id = $1`,
        [userId],
      );
      return typeof row?.password_hash === "string" ? row.password_hash : undefined;
    },
    setCredential: (userId, hash) =>
      db.upsert("auth_credentials", { user_id: userId, password_hash: hash }, ["user_id"]),
    deleteCredential: (userId) => db.run(`DELETE FROM ${credentials} WHERE user_id = $1`, [userId]),
    createApiToken: (token) => db.upsert("auth_api_tokens", toRow(API_TOKEN_MAP, token), ["id"]),
    getApiTokenByHash: (tokenHash) =>
      db.record(API_TOKEN_MAP, `SELECT * FROM ${tokens} WHERE token_hash = $1 AND ${live}`, [
        tokenHash,
        db.now(),
      ]),
    touchApiToken: (id, lastUsedAt) =>
      db.run(`UPDATE ${tokens} SET last_used_at = $1 WHERE id = $2`, [lastUsedAt, id]),
    revokeApiToken: (id) =>
      db.one(
        `UPDATE ${tokens} SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL RETURNING id`,
        [db.now(), id],
      ),
    listApiTokens: (userId) =>
      db.records(
        API_TOKEN_MAP,
        `SELECT * FROM ${tokens} WHERE user_id = $1 AND ${live} ORDER BY created_at, id`,
        [userId, db.now()],
      ),
  };
}

/** The TOTP factor group, including the two consume-once guards. */
function mfaMethods(
  db: Pg,
): Pick<
  AuthAdapter,
  "getMfa" | "setMfa" | "deleteMfa" | "replaceMfaSecret" | "consumeBackupCode" | "claimTotpStep"
> {
  const mfa = db.t("auth_mfa");
  const read = (userId: string) =>
    db.record(MFA_MAP, `SELECT * FROM ${mfa} WHERE user_id = $1`, [userId]);
  return {
    getMfa: read,
    setMfa: (record) => db.upsert("auth_mfa", toRow(MFA_MAP, record), ["user_id"]),
    deleteMfa: (userId) => db.run(`DELETE FROM ${mfa} WHERE user_id = $1`, [userId]),
    replaceMfaSecret: (userId, expected, next) =>
      // One conditional UPDATE of the one column: it lands only while the stored secret is
      // still the one that was read, and leaves `last_step` / the backup codes alone.
      db.one(
        `UPDATE ${mfa} SET secret = $1 WHERE user_id = $2 AND secret = $3 RETURNING user_id`,
        [next, userId, expected],
      ),
    consumeBackupCode: (userId, matches) =>
      spendBackupCode(
        () => read(userId),
        (next, before) =>
          db.one(
            `UPDATE ${mfa} SET backup_code_hashes = $1 ` +
              "WHERE user_id = $2 AND backup_code_hashes = $3 RETURNING user_id",
            [next, userId, before],
          ),
        matches,
      ),
    claimTotpStep: (userId, step) =>
      // Strictly monotonic, decided by the WHERE clause: the step a code verified against is
      // spent, and so is every older one.
      db.one(
        `UPDATE ${mfa} SET last_step = $1 WHERE user_id = $2 ` +
          "AND (last_step IS NULL OR last_step < $1) RETURNING user_id",
        [step, userId],
      ),
  };
}

/** The native-app session group: single-use grants plus refresh-token families. */
function nativeMethods(
  db: Pg,
): Pick<
  AuthAdapter,
  | "createNativeGrant"
  | "useNativeGrant"
  | "createNativeSession"
  | "getNativeSession"
  | "rotateNativeSession"
  | "revokeNativeSession"
  | "revokeNativeSessionsByUser"
> {
  const grants = db.t("auth_native_grants");
  const families = db.t("auth_native_sessions");
  const revoke = (where: string, key: string) =>
    db.run(`UPDATE ${families} SET revoked_at = $1 WHERE ${where} = $2 AND revoked_at IS NULL`, [
      db.now(),
      key,
    ]);
  return {
    async createNativeGrant(grant) {
      await db.upsert("auth_native_grants", toRow(NATIVE_GRANT_MAP, grant), ["kind", "hash"]);
      // Grants a minute past their expiry are reclaimed on every write (an indexed delete).
      await db.run(`DELETE FROM ${grants} WHERE expires_at <= $1`, [db.now() - 60]);
    },
    async useNativeGrant(hash, kind) {
      const record = await db.record(
        NATIVE_GRANT_MAP,
        `DELETE FROM ${grants} WHERE kind = $1 AND hash = $2 RETURNING *`,
        [kind, hash],
      );
      return record && record.expiresAt > db.now() ? record : undefined;
    },
    async createNativeSession(session) {
      await db.upsert("auth_native_sessions", toRow(NATIVE_SESSION_MAP, session), ["id"]);
      // Families dead for NATIVE_SESSION_RETENTION (expired, or revoked) are reclaimed on every
      // sign-in, so the table stays bounded.
      await db.run(`DELETE FROM ${families} WHERE expires_at <= $1 OR revoked_at <= $1`, [
        db.now() - NATIVE_SESSION_RETENTION,
      ]);
    },
    getNativeSession: (id) =>
      db.record(NATIVE_SESSION_MAP, `SELECT * FROM ${families} WHERE id = $1`, [id]),
    rotateNativeSession: (id, fromGeneration, expiresAt, rotation) =>
      // The WHERE clause is the compare-and-swap: one refresh with a generation wins.
      db.one(
        `UPDATE ${families} SET generation = $1, expires_at = $2, ` +
          "rotated_at = COALESCE($3, rotated_at) " +
          "WHERE id = $4 AND generation = $5 AND revoked_at IS NULL RETURNING id",
        [fromGeneration + 1, expiresAt, rotation?.rotatedAt ?? null, id, fromGeneration],
      ),
    revokeNativeSession: (id) => revoke("id", id),
    revokeNativeSessionsByUser: (userId, exceptId) =>
      exceptId === undefined ? revoke("user_id", userId) : db.run(
        `UPDATE ${families} SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL ` +
          "AND id <> $3",
        [db.now(), userId, exceptId],
      ),
  };
}

/** The passkey group: credential records and single-use challenges. */
function passkeyMethods(
  db: Pg,
): Pick<
  AuthAdapter,
  | "createPasskey"
  | "getPasskey"
  | "listPasskeys"
  | "updatePasskey"
  | "deletePasskey"
  | "createPasskeyChallenge"
  | "usePasskeyChallenge"
> {
  const passkeys = db.t("auth_passkeys");
  const challenges = db.t("auth_passkey_challenges");
  return {
    createPasskey(record) {
      // ON CONFLICT DO NOTHING: a credential ID registered once can't be taken over.
      const row = toRow(PASSKEY_MAP, record);
      const columns = Object.keys(row);
      return db.one(
        `INSERT INTO ${passkeys} (${columns.join(", ")}) VALUES (${
          placeholders(columns.length)
        }) ` +
          "ON CONFLICT (id) DO NOTHING RETURNING id",
        Object.values(row),
      );
    },
    getPasskey: (id) => db.record(PASSKEY_MAP, `SELECT * FROM ${passkeys} WHERE id = $1`, [id]),
    listPasskeys: (userId) =>
      db.records(
        PASSKEY_MAP,
        `SELECT * FROM ${passkeys} WHERE user_id = $1 ORDER BY created_at, id`,
        [userId],
      ),
    updatePasskey: (id, fromSignCount, update) =>
      // The WHERE clause is the compare-and-swap on the counter.
      db.one(
        `UPDATE ${passkeys} SET sign_count = $1, backed_up = $2, last_used_at = $3 ` +
          "WHERE id = $4 AND sign_count = $5 RETURNING id",
        [update.signCount, update.backedUp, update.lastUsedAt, id, fromSignCount],
      ),
    deletePasskey: (id) => db.run(`DELETE FROM ${passkeys} WHERE id = $1`, [id]),
    async createPasskeyChallenge(record) {
      await db.upsert("auth_passkey_challenges", toRow(PASSKEY_CHALLENGE_MAP, record), ["hash"]);
      await db.run(`DELETE FROM ${challenges} WHERE expires_at <= $1`, [db.now() - 60]);
    },
    async usePasskeyChallenge(hash) {
      const record = await db.record(
        PASSKEY_CHALLENGE_MAP,
        `DELETE FROM ${challenges} WHERE hash = $1 RETURNING *`,
        [hash],
      );
      return record && record.expiresAt > db.now() ? record : undefined;
    },
  };
}

/** The tables keyed by `user_id` that a user's deletion clears (store-backed sessions too). */
const USER_TABLES = [
  "auth_accounts",
  "auth_credentials",
  "auth_api_tokens",
  "auth_mfa",
  "auth_mfa_factors",
  "auth_native_sessions",
  "auth_passkeys",
  "auth_sessions",
];

/**
 * Delete a user and every row keyed by them, in ONE transaction: the user row, the tables in
 * {@link USER_TABLES}, and the verification tokens issued to their address.
 */
function deleteUserRows(db: Pg, id: string): Promise<void> {
  return db.begin(async (tx) => {
    const [row] = await tx.unsafe(`SELECT email_lc FROM ${db.t("auth_users")} WHERE id = $1`, [
      id,
    ]);
    if (typeof row?.email_lc === "string") {
      await tx.unsafe(`DELETE FROM ${db.t("auth_verification_tokens")} WHERE identifier = $1`, [
        row.email_lc,
      ]);
    }
    for (const table of [...USER_TABLES, "auth_users"]) {
      await tx.unsafe(
        `DELETE FROM ${db.t(table)} WHERE ${table === "auth_users" ? "id" : "user_id"} = $1`,
        [id],
      );
    }
  });
}

/** The `/auth/v1` MFA factors. */
function factorMethods(
  db: Pg,
): Pick<
  AuthAdapter,
  | "createMfaFactor"
  | "listMfaFactors"
  | "updateMfaFactor"
  | "claimMfaFactorStep"
  | "deleteMfaFactor"
> {
  const factors = db.t("auth_mfa_factors");
  return {
    createMfaFactor: (record) =>
      db.upsert("auth_mfa_factors", toRow(MFA_FACTOR_MAP, record), ["id"]),
    listMfaFactors: (userId) =>
      db.records(
        MFA_FACTOR_MAP,
        `SELECT * FROM ${factors} WHERE user_id = $1 ORDER BY created_at, id`,
        [userId],
      ),
    async updateMfaFactor(id, patch) {
      const sets = factorPatchColumns(patch);
      if (!sets.length) return;
      const assignments = sets.map(([column], i) => `${column} = $${i + 1}`).join(", ");
      await db.run(`UPDATE ${factors} SET ${assignments} WHERE id = $${sets.length + 1}`, [
        ...sets.map(([, value]) => value),
        id,
      ]);
    },
    claimMfaFactorStep: (id, step) =>
      db.one(
        `UPDATE ${factors} SET last_step = $1 WHERE id = $2 ` +
          "AND (last_step IS NULL OR last_step < $1) RETURNING id",
        [step, id],
      ),
    deleteMfaFactor: (id) => db.run(`DELETE FROM ${factors} WHERE id = $1`, [id]),
  };
}

/** Every method group, in the order the contract lists them. */
const GROUPS = [
  userMethods,
  accountAndTokenMethods,
  credentialAndApiTokenMethods,
  mfaMethods,
  factorMethods,
  nativeMethods,
  passkeyMethods,
];

/**
 * Build the {@link ./adapter.ts | AuthAdapter} on Postgres: every method group (users,
 * accounts, verification tokens, credentials, API tokens, MFA, native app sessions, passkeys,
 * account deletion) plus a `sessions` store over the **same** client and an idempotent
 * `close()`.
 *
 * Ids are `crypto.randomUUID()` unless the caller supplies one; emails are matched
 * case-insensitively and whitespace-trimmed, and a unique index refuses a second user on one
 * address. The tables are created by migrations on first use (see the module doc).
 *
 * @param options `sql` (a client) or `url` (opened with `Deno.SQL`), an optional `schema`,
 *   `migrate`, a clock override and the sweep interval.
 * @returns The adapter, ready to pass as `denextAuth({ adapter })`.
 * @throws {PostgresUnsupportedError} For `url` on a Deno without `Deno.SQL` (pass `sql`).
 */
export function postgresAuthAdapter(options: PostgresAuthAdapterOptions): AuthAdapter {
  const handle = authDb(options, "postgresAuthAdapter");
  const db = pg(handle, options);
  return Object.assign({}, ...GROUPS.map((group) => group(db)), {
    deleteUser: (id: string) => deleteUserRows(db, id),
    sessions: pgSessionStore(handle),
    close: () => handle.close(),
  }) as AuthAdapter;
}
