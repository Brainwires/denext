/**
 * The durable {@link ./adapter.ts | AuthAdapter}, on Deno's built-in `node:sqlite` (real
 * SQLite, zero npm):
 *
 * ```ts
 * import { denextAuth, sqliteAuthAdapter } from "denext/server";
 * denextAuth({ ..., adapter: sqliteAuthAdapter({ path: "auth.db" }) });
 * ```
 *
 * Six `auth_`-prefixed tables hold users, linked provider accounts, verification tokens,
 * password hashes, bearer API tokens and TOTP factors. The adapter also exposes
 * {@linkcode AuthAdapter.sessions} — a {@link ./sqlite-session-store.ts | sqliteSessionStore}
 * driven over the **same** handle, so one file holds everything and an app that already
 * had `sessionStore: sqliteSessionStore({ path })` can point the adapter at that same
 * path with no migration and no logout (the `sessions` DDL is byte-identical). Passing an
 * adapter still never *makes* sessions stateful on its own — that is
 * `session: { strategy: "database" }`.
 *
 * **Schema policy.** `CREATE TABLE IF NOT EXISTS` on every open, then each declared column
 * a table is missing is added with `ALTER TABLE … ADD COLUMN` (nullable — the only form
 * SQLite can add to a populated table), decided by `PRAGMA table_info`. Adding a derived
 * column also runs its backfill. There is no migration framework, no column is ever
 * dropped or retyped, and a denext upgrade never rewrites your rows: schema changes are
 * additive by construction.
 *
 * Single-node, like the session store: a local file suits one instance. Every replica must
 * see the same database, so for multi-replica either mount one shared volume or implement
 * {@link ./adapter.ts | AuthAdapter} over your shared database. TOTP secrets are stored in
 * plaintext by construction (a TOTP verifier needs the secret) — protect the file itself.
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqliteDb, SqlValue } from "../sqlite-cache.ts";
import type {
  AdapterAccount,
  AdapterUser,
  ApiTokenRecord,
  AuthAdapter,
  MfaRecord,
  VerificationTokenRecord,
} from "./adapter.ts";
import { sqliteSessionStore } from "./sqlite-session-store.ts";

/** Options for {@linkcode sqliteAuthAdapter}. */
export interface SqliteAuthAdapterOptions {
  /**
   * Path to the on-disk database file. Defaults to `auth.db` in the working directory —
   * user data, so deliberately NOT under `.denext/`, which the build owns. `":memory:"`
   * gives a private database that dies with the process (tests, demos).
   */
  path?: string;
  /** Advanced/test hook: open the handle yourself instead of node:sqlite. */
  openDb?: (path: string) => SqliteDb;
  /**
   * Clock override, in **epoch seconds** — what expiry is measured against. Defaults to
   * the system clock; tests pass their own to age a token without sleeping.
   */
  now?: () => number;
  /** Min ms between proactive sweeps of expired verification tokens (default 30000; `0` = every write). */
  sweepEvery?: number;
}

const DEFAULT_PATH = "auth.db";
const SWEEP_INTERVAL = 30_000;

// ---- schema ----------------------------------------------------------------

/** One table this adapter owns, in the form both the creator and the reconciler read. */
interface TableSpec {
  /** Table name (always `auth_`-prefixed, so it can share a file with anything else). */
  name: string;
  /** Columns in declaration order: `[name, SQL type + column constraints]`. */
  columns: Array<[name: string, decl: string]>;
  /** A table-level constraint clause (a composite PRIMARY KEY), when there is one. */
  constraints?: string;
  /** `CREATE … INDEX IF NOT EXISTS` statements, run once every declared column exists. */
  indexes?: string[];
  /** Repopulates derived columns after an older database gained one. */
  backfill?: string;
}

/** The six tables, in creation order. */
const SCHEMA: TableSpec[] = [
  {
    name: "auth_users",
    columns: [
      ["id", "TEXT PRIMARY KEY"],
      ["email", "TEXT"],
      ["email_lc", "TEXT"],
      ["email_verified", "INTEGER"],
      ["name", "TEXT"],
      ["image", "TEXT"],
      ["roles", "TEXT"],
      ["created_at", "INTEGER"],
    ],
    // Unique WHERE NOT NULL: one account per address, any number of address-less users.
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email ON auth_users (email_lc) " +
      "WHERE email_lc IS NOT NULL",
    ],
    backfill: "UPDATE auth_users SET email_lc = lower(trim(email)) " +
      "WHERE email_lc IS NULL AND email IS NOT NULL",
  },
  {
    name: "auth_accounts",
    columns: [
      ["provider", "TEXT NOT NULL"],
      ["provider_account_id", "TEXT NOT NULL"],
      ["user_id", "TEXT NOT NULL"],
      ["type", "TEXT"],
      ["access_token", "TEXT"],
      ["refresh_token", "TEXT"],
      ["expires_at", "INTEGER"],
      ["token_type", "TEXT"],
      ["scope", "TEXT"],
      ["id_token", "TEXT"],
    ],
    constraints: "PRIMARY KEY (provider, provider_account_id)",
    indexes: ["CREATE INDEX IF NOT EXISTS auth_accounts_user ON auth_accounts (user_id)"],
  },
  {
    name: "auth_verification_tokens",
    columns: [
      ["identifier", "TEXT NOT NULL"],
      ["purpose", "TEXT NOT NULL"],
      ["token_hash", "TEXT NOT NULL"],
      ["expires", "INTEGER NOT NULL"],
      ["data", "TEXT"],
    ],
    // One live token per (identifier, purpose): re-sending a link invalidates the previous
    // one, so a mailbox can never hold two working password-reset links at once.
    constraints: "PRIMARY KEY (identifier, purpose)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS auth_verification_expiry ON auth_verification_tokens (expires)",
    ],
  },
  {
    name: "auth_credentials",
    columns: [["user_id", "TEXT PRIMARY KEY"], ["password_hash", "TEXT NOT NULL"]],
  },
  {
    name: "auth_api_tokens",
    columns: [
      ["id", "TEXT PRIMARY KEY"],
      ["user_id", "TEXT NOT NULL"],
      ["name", "TEXT"],
      ["token_hash", "TEXT NOT NULL"],
      ["scopes", "TEXT"],
      ["expires_at", "INTEGER"],
      ["last_used_at", "INTEGER"],
      ["revoked_at", "INTEGER"],
      ["created_at", "INTEGER"],
    ],
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS auth_api_tokens_hash ON auth_api_tokens (token_hash)",
      "CREATE INDEX IF NOT EXISTS auth_api_tokens_user ON auth_api_tokens (user_id)",
    ],
  },
  {
    name: "auth_mfa",
    columns: [
      ["user_id", "TEXT PRIMARY KEY"],
      ["secret", "TEXT NOT NULL"],
      ["confirmed_at", "INTEGER"],
      ["backup_code_hashes", "TEXT"],
      ["last_step", "INTEGER"],
    ],
  },
];

/** Open node:sqlite at `path` behind the {@link SqliteDb} interface this adapter drives. */
function openNodeSqlite(path: string): SqliteDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  return {
    exec: (sql: string, params?: SqlValue[]): void =>
      void (params?.length ? raw.prepare(sql).run(...params) : raw.exec(sql)),
    query: <T>(sql: string, params?: SqlValue[]): T[] =>
      raw.prepare(sql).all(...(params ?? [])) as T[],
    close: () => raw.close(),
  };
}

/** Create `spec`, then add any declared column the (older) table is missing. */
function reconcileTable(db: SqliteDb, spec: TableSpec): void {
  const cols = spec.columns.map(([name, decl]) => `${name} ${decl}`);
  if (spec.constraints) cols.push(spec.constraints);
  db.exec(`CREATE TABLE IF NOT EXISTS ${spec.name} (${cols.join(", ")})`);
  const present = new Set(
    db.query<{ name: string }>(`PRAGMA table_info(${spec.name})`).map((row) => row.name),
  );
  let added = 0;
  for (const [name, decl] of spec.columns) {
    if (present.has(name)) continue;
    // Only the bare type: SQLite cannot add a NOT NULL / UNIQUE / PRIMARY KEY column to a
    // populated table, so every additive column is nullable in a database that predates it.
    db.exec(`ALTER TABLE ${spec.name} ADD COLUMN ${name} ${decl.split(" ")[0]}`);
    added++;
  }
  if (added && spec.backfill) db.exec(spec.backfill);
  for (const index of spec.indexes ?? []) db.exec(index);
}

/** Bring a handle up to the current schema (idempotent) and set the usual WAL pragmas. */
function initSchema(db: SqliteDb): void {
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
  } catch { /* a handle that refuses pragmas keeps its defaults */ }
  for (const spec of SCHEMA) reconcileTable(db, spec);
}

// ---- rows ------------------------------------------------------------------

/** How one record field crosses the SQL boundary in both directions. */
interface Codec {
  /** Column value → field value (`undefined` drops the field from the record). */
  from(value: SqlValue): unknown;
  /** Field value → bound parameter (`null` for an absent field). */
  to(value: unknown): SqlValue;
}

/** Which column (and codec) each field of a record lives in. */
type FieldMap<T> = { [K in keyof T]?: readonly [column: string, codec: Codec] };

/** A `TEXT` column holding an optional string. */
const TEXT: Codec = {
  from: (value) => typeof value === "string" ? value : undefined,
  to: (value) => typeof value === "string" ? value : null,
};

/** An `INTEGER` column holding an optional number (epoch seconds, a TOTP step). */
const INT: Codec = {
  from: (value) => typeof value === "number" ? value : undefined,
  to: (value) => typeof value === "number" ? value : null,
};

/** A `TEXT` column holding a JSON array of strings — absent when the column is NULL. */
const LIST: Codec = {
  from: (value) => parseList(value),
  to: (value) => Array.isArray(value) ? JSON.stringify(value) : null,
};

/** A `TEXT` column holding a JSON array of strings that is never absent, only empty. */
const CODES: Codec = { from: (value) => parseList(value) ?? [], to: LIST.to };

/** Parse a JSON string array, tolerating a NULL or a value another writer corrupted. */
function parseList(value: SqlValue): string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/** Build a record from a row — the one read path every table shares. */
function fromRow<T>(map: FieldMap<T>, row: Record<string, SqlValue>): T {
  const record: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(map) as Array<[string, [string, Codec]]>) {
    const value = spec[1].from(row[spec[0]] ?? null);
    // An absent field, never `key: undefined`: a row must map to the shape a hand-written
    // record has, or the shared contract suite would mean two different things.
    if (value !== undefined) record[field] = value;
  }
  return record as T;
}

/** Build a column → parameter object from a record — the one write path every table shares. */
function toRow<T extends object>(map: FieldMap<T>, record: T): Record<string, SqlValue> {
  const row: Record<string, SqlValue> = {};
  for (const [field, spec] of Object.entries(map) as Array<[string, [string, Codec]]>) {
    row[spec[0]] = spec[1].to((record as Record<string, unknown>)[field]);
  }
  return row;
}

const USER_MAP: FieldMap<AdapterUser> = {
  id: ["id", TEXT],
  email: ["email", TEXT],
  emailVerified: ["email_verified", INT],
  name: ["name", TEXT],
  image: ["image", TEXT],
  roles: ["roles", LIST],
};

const ACCOUNT_MAP: FieldMap<AdapterAccount> = {
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
};

const VERIFICATION_MAP: FieldMap<VerificationTokenRecord> = {
  identifier: ["identifier", TEXT],
  purpose: ["purpose", TEXT],
  tokenHash: ["token_hash", TEXT],
  expires: ["expires", INT],
  data: ["data", TEXT],
};

const API_TOKEN_MAP: FieldMap<ApiTokenRecord> = {
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

const MFA_MAP: FieldMap<MfaRecord> = {
  userId: ["user_id", TEXT],
  secret: ["secret", TEXT],
  confirmedAt: ["confirmed_at", INT],
  backupCodeHashes: ["backup_code_hashes", CODES],
  lastStep: ["last_step", INT],
};

// ---- statements ------------------------------------------------------------

/**
 * Insert `values` (column name → bound parameter). Table and column names are module
 * constants; every value the caller supplies is a parameter, never interpolated.
 */
function put(
  db: SqliteDb,
  table: string,
  values: Record<string, SqlValue>,
  replace = true,
): void {
  const columns = Object.keys(values);
  db.exec(
    `INSERT${replace ? " OR REPLACE" : ""} INTO ${table} (${columns.join(", ")}) ` +
      `VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => values[column]),
  );
}

/** The first row `sql` yields, or `undefined`. */
function one(
  db: SqliteDb,
  sql: string,
  params: SqlValue[],
): Record<string, SqlValue> | undefined {
  return db.query<Record<string, SqlValue>>(sql, params)[0];
}

/** Case-insensitive, whitespace-trimmed email key — what `auth_users.email_lc` holds. */
function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Everything one adapter instance owns: the lazy handle, the clock and the sweep. */
interface SqliteState {
  /** The shared handle, opened (and schema-reconciled) on first use. */
  db(): SqliteDb;
  /** Epoch seconds. */
  now(): number;
  /** Reclaim expired verification tokens, throttled. */
  sweep(): void;
}

// ---- method groups ---------------------------------------------------------

/** Write a user row, keeping `created_at` and the derived email index in step. */
function saveUser(state: SqliteState, user: AdapterUser, createdAt: number): AdapterUser {
  const db = state.db();
  // Delete-then-insert rather than INSERT OR REPLACE: REPLACE would resolve a clash on the
  // unique email index by deleting the OTHER user. A second user on one address must fail.
  db.exec("DELETE FROM auth_users WHERE id = ?", [user.id]);
  put(db, "auth_users", {
    ...toRow(USER_MAP, user),
    email_lc: user.email ? emailKey(user.email) : null,
    created_at: createdAt,
  }, false);
  return { ...user };
}

/** The five required user methods. */
function userMethods(
  state: SqliteState,
): Pick<
  AuthAdapter,
  "createUser" | "getUser" | "getUserByEmail" | "getUserByAccount" | "updateUser"
> {
  const read = (sql: string, params: SqlValue[]): AdapterUser | undefined => {
    const row = one(state.db(), sql, params);
    return row && fromRow(USER_MAP, row);
  };
  return {
    createUser(user) {
      const { id, ...rest } = user;
      return saveUser(state, { ...rest, id: id ?? crypto.randomUUID() }, state.now());
    },
    getUser: (id) => read("SELECT * FROM auth_users WHERE id = ?", [id]),
    getUserByEmail: (email) =>
      read("SELECT * FROM auth_users WHERE email_lc = ?", [emailKey(email)]),
    getUserByAccount: (ref) =>
      read(
        "SELECT u.* FROM auth_users u JOIN auth_accounts a ON a.user_id = u.id " +
          "WHERE a.provider = ? AND a.provider_account_id = ?",
        [ref.provider, ref.providerAccountId],
      ),
    updateUser(patch) {
      const row = one(state.db(), "SELECT * FROM auth_users WHERE id = ?", [patch.id]);
      if (!row) {
        throw new Error(`sqliteAuthAdapter: no user with id ${JSON.stringify(patch.id)}`);
      }
      const next = fromRow(USER_MAP, row);
      // An absent field means "unchanged", so `undefined` never clears a stored value.
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) Reflect.set(next, key, value);
      }
      return saveUser(
        state,
        next,
        typeof row.created_at === "number" ? row.created_at : state.now(),
      );
    },
  };
}

/** Link / unlink / list provider accounts. */
function accountMethods(
  state: SqliteState,
): Pick<AuthAdapter, "linkAccount" | "unlinkAccount" | "listAccounts"> {
  return {
    linkAccount(account) {
      put(state.db(), "auth_accounts", toRow(ACCOUNT_MAP, account));
    },
    unlinkAccount(ref) {
      state.db().exec(
        "DELETE FROM auth_accounts WHERE provider = ? AND provider_account_id = ?",
        [ref.provider, ref.providerAccountId],
      );
    },
    listAccounts: (userId) =>
      state.db()
        .query<Record<string, SqlValue>>(
          "SELECT * FROM auth_accounts WHERE user_id = ? ORDER BY provider, provider_account_id",
          [userId],
        )
        .map((row) => fromRow(ACCOUNT_MAP, row)),
  };
}

/** Issue and redeem single-use verification tokens. */
function verificationMethods(
  state: SqliteState,
): Pick<AuthAdapter, "createVerificationToken" | "useVerificationToken"> {
  return {
    createVerificationToken(token) {
      put(state.db(), "auth_verification_tokens", toRow(VERIFICATION_MAP, token));
      state.sweep();
    },
    useVerificationToken(ref) {
      // One statement: the row is read and deleted together, so two concurrent redemptions
      // of a token can never both see it.
      const row = state.db().query<Record<string, SqlValue>>(
        "DELETE FROM auth_verification_tokens " +
          "WHERE identifier = ? AND purpose = ? AND token_hash = ? RETURNING *",
        [ref.identifier, ref.purpose, ref.tokenHash],
      )[0];
      if (!row) return undefined;
      const record = fromRow(VERIFICATION_MAP, row);
      // Consume first, answer second: an expired token is spent too (it is never worth
      // retrying), but it never resolves — a stale link fails closed.
      return record.expires <= state.now() ? undefined : record;
    },
  };
}

/** Password-hash storage for the Credentials provider. */
function credentialMethods(
  state: SqliteState,
): Pick<AuthAdapter, "getCredential" | "setCredential"> {
  return {
    getCredential(userId) {
      const row = one(
        state.db(),
        "SELECT password_hash FROM auth_credentials WHERE user_id = ?",
        [userId],
      );
      return typeof row?.password_hash === "string" ? row.password_hash : undefined;
    },
    setCredential(userId, hash) {
      put(state.db(), "auth_credentials", { user_id: userId, password_hash: hash });
    },
  };
}

/** The SQL condition (and its parameter) that hides revoked and expired bearer tokens. */
const TOKEN_LIVE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

/** The bearer API-token group. Revoked and expired tokens are invisible to every read. */
function apiTokenMethods(
  state: SqliteState,
): Pick<
  AuthAdapter,
  "createApiToken" | "getApiTokenByHash" | "touchApiToken" | "revokeApiToken" | "listApiTokens"
> {
  return {
    createApiToken(token) {
      put(state.db(), "auth_api_tokens", toRow(API_TOKEN_MAP, token));
    },
    getApiTokenByHash(tokenHash) {
      const row = one(
        state.db(),
        `SELECT * FROM auth_api_tokens WHERE token_hash = ? AND ${TOKEN_LIVE}`,
        [tokenHash, state.now()],
      );
      return row && fromRow(API_TOKEN_MAP, row);
    },
    touchApiToken(id, lastUsedAt) {
      state.db().exec("UPDATE auth_api_tokens SET last_used_at = ? WHERE id = ?", [lastUsedAt, id]);
    },
    revokeApiToken(id) {
      state.db().exec(
        "UPDATE auth_api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        [state.now(), id],
      );
    },
    listApiTokens: (userId) =>
      state.db()
        .query<Record<string, SqlValue>>(
          `SELECT * FROM auth_api_tokens WHERE user_id = ? AND ${TOKEN_LIVE} ORDER BY created_at, id`,
          [userId, state.now()],
        )
        .map((row) => fromRow(API_TOKEN_MAP, row)),
  };
}

/** How many times a losing compare-and-swap re-reads before giving up. */
const SWAP_ATTEMPTS = 4;

/**
 * The index of the first hash the caller's comparison accepts, or `-1`.
 *
 * @param hashes The stored backup-code hashes, in order.
 * @param matches Constant-time comparison of the presented code against one stored hash.
 * @returns The matching index, or `-1` when none matched.
 */
async function firstMatch(
  hashes: string[],
  matches: (hash: string) => boolean | Promise<boolean>,
): Promise<number> {
  for (const [index, hash] of hashes.entries()) {
    if (await matches(hash)) return index;
  }
  return -1;
}

/** The TOTP factor group, including the two consume-once guards. */
function mfaMethods(
  state: SqliteState,
): Pick<AuthAdapter, "getMfa" | "setMfa" | "consumeBackupCode" | "claimTotpStep"> {
  const read = (userId: string): MfaRecord | undefined => {
    const row = one(state.db(), "SELECT * FROM auth_mfa WHERE user_id = ?", [userId]);
    return row && fromRow(MFA_MAP, row);
  };
  return {
    getMfa: read,
    setMfa(record) {
      put(state.db(), "auth_mfa", toRow(MFA_MAP, record));
    },
    async consumeBackupCode(userId, matches) {
      // The comparison is the caller's (scrypt), so the read-match-write cannot be one
      // statement. Compare-and-swap instead of a lock: the write lands only while the
      // stored list is still the one that was matched, so a concurrent redemption — in
      // this process or in another one on the same file — loses the swap and retries
      // against the rewritten list. Racing on ONE code therefore yields exactly one
      // `true`, and racing on two different codes still spends both.
      for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt++) {
        const record = read(userId);
        if (!record) return false;
        const before = JSON.stringify(record.backupCodeHashes);
        const index = await firstMatch(record.backupCodeHashes, matches);
        if (index < 0) return false;
        const rest = record.backupCodeHashes.filter((_, at) => at !== index);
        const swapped = state.db().query(
          "UPDATE auth_mfa SET backup_code_hashes = ? " +
            "WHERE user_id = ? AND backup_code_hashes = ? RETURNING user_id",
          [JSON.stringify(rest), userId, before],
        );
        if (swapped.length === 1) return true;
      }
      return false;
    },
    claimTotpStep(userId, step) {
      // Strictly monotonic, decided by the WHERE clause: the step a code verified against
      // is spent, and so is every older one. The row is claimed or it is not.
      const claimed = state.db().query(
        "UPDATE auth_mfa SET last_step = ? WHERE user_id = ? " +
          "AND (last_step IS NULL OR last_step < ?) RETURNING user_id",
        [step, userId, step],
      );
      return claimed.length === 1;
    },
  };
}

/** The lazy handle and the throttled sweep for one adapter. */
function createState(
  options: SqliteAuthAdapterOptions,
): SqliteState & { close(): void; facade: SqliteDb } {
  const path = options.path ?? DEFAULT_PATH;
  const open = options.openDb ?? openNodeSqlite;
  const sweepEvery = options.sweepEvery ?? SWEEP_INTERVAL;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let db: SqliteDb | undefined;
  let lastSweep = 0;

  // Memoize only after a clean open + init; a throw leaves `db` unset so the next access
  // retries instead of permanently disabling sign-in.
  const getDb = (): SqliteDb => {
    if (db) return db;
    const opened = open(path);
    initSchema(opened);
    db = opened;
    return db;
  };
  const close = (): void => {
    db?.close();
    db = undefined;
  };
  return {
    db: getDb,
    now,
    close,
    // The handle the session store is given: stable, so it survives that store's own
    // close/reopen, and idempotent on close, so neither owner can double-close SQLite.
    facade: {
      exec: (sql: string, params?: SqlValue[]) => getDb().exec(sql, params),
      query: <T>(sql: string, params?: SqlValue[]): T[] => getDb().query<T>(sql, params),
      close,
    },
    sweep() {
      const at = Date.now();
      if (at - lastSweep < sweepEvery) return;
      lastSweep = at;
      getDb().exec("DELETE FROM auth_verification_tokens WHERE expires <= ?", [now()]);
    },
  };
}

/**
 * Build the durable {@link ./adapter.ts | AuthAdapter} on Deno's built-in `node:sqlite`:
 * every method group (users, accounts, verification tokens, credentials, API tokens, MFA)
 * plus a `sessions` store over the **same** database handle and an idempotent `close()`.
 *
 * Ids are `crypto.randomUUID()` unless the caller supplies one; emails are matched
 * case-insensitively and whitespace-trimmed, and a unique index refuses a second user on
 * one address. The schema is created on first use and evolved additively on every open
 * (see the module doc). Single-node, and TOTP secrets are at rest in plaintext.
 *
 * @param options Database path (or an `openDb` hook), clock override, sweep interval.
 * @returns The adapter, ready to pass as `denextAuth({ adapter })`.
 */
export function sqliteAuthAdapter(options: SqliteAuthAdapterOptions = {}): AuthAdapter {
  const state = createState(options);
  // Identical `sessions` DDL over the shared handle: a database written by
  // sqliteSessionStore({ path }) is this adapter's, and vice versa — no migration step.
  const sessions = sqliteSessionStore({
    path: options.path ?? DEFAULT_PATH,
    openDb: () => state.facade,
  });
  return {
    ...userMethods(state),
    ...accountMethods(state),
    ...verificationMethods(state),
    ...credentialMethods(state),
    ...apiTokenMethods(state),
    ...mfaMethods(state),
    sessions,
    close() {
      sessions.close?.(); // drops that store's memo; the facade's close is the same one
      state.close();
    },
  };
}
