// denext auth's users, read from its Postgres tables (`auth_users` and the `auth_*` tables keyed
// by `user_id`; see packages/auth/src/postgres-schema.ts): who they are, how many live sessions
// each has, whether a second factor is confirmed, whether a ban is in force. Revoking deletes
// the user's rows in the session store, marks their native-app sessions revoked and moves the
// user's "sessions valid after" mark to now (which ends a stateless cookie session too); deleting
// removes the user and every row keyed by them, as `postgresAuthAdapter().deleteUser` does — in
// one transaction. Banning sets `banned_until` (the column the `/auth/v1` admin API's
// `ban_duration` writes, which every sign-in and token check reads) and ends every session;
// setting a password stores a `hashPassword` hash and ends every session, as the admin API does.
// Creating a user writes the `auth_users` row (and a credential, given a password) the adapter's
// `createUser` + `setCredential` would.
//
// A password never leaves this module: it is hashed here, and every statement handed back for a
// preview shows its hash as a mask.

import type { SqlClient } from "../../server/postgres.ts";
import { hashPassword } from "../../server/password.ts";
import { emailKey } from "../../server/email-key.ts";
import {
  DB_BAN_DURATIONS,
  DB_MAX_PASSWORD,
  DB_MIN_PASSWORD,
  DB_PAGE_ROWS,
  type DbAuthUser,
  type DbReplies,
  type DbStatement,
  type DbUserAction,
} from "../../ui/database/protocol.ts";
import { quoteIdent } from "../../ui/database/sql.ts";
import { authTables } from "./catalog.ts";
import { AdminRefusal, assertWritable, readTx, writeTx } from "./tables.ts";

/** The tables keyed by `user_id` that deleting a user clears (the adapter's own list). */
const USER_TABLES = [
  "auth_accounts",
  "auth_credentials",
  "auth_api_tokens",
  "auth_mfa",
  "auth_native_sessions",
  "auth_passkeys",
  "auth_sessions",
];

/** The auth schema, its tables, and the columns `auth_users` has (older schemas lack some). */
interface AuthSchema {
  readonly schema: string;
  readonly tables: Set<string>;
  readonly columns: Set<string>;
}

/** What a preview shows in place of a password hash. */
const MASK = "•••";

/** The auth schema with the columns of its `auth_users`, or `null` without one. */
async function authSchema(tx: SqlClient): Promise<AuthSchema | null> {
  const auth = await authTables(tx);
  if (!auth) return null;
  const rows = await tx.unsafe(
    `SELECT a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = 'auth_users' AND a.attnum > 0 AND NOT a.attisdropped`,
    [auth.schema],
  );
  return { ...auth, columns: new Set([...rows].map((row) => String(row.name))) };
}

/** A qualified auth table. */
function t(auth: AuthSchema, name: string): string {
  return `${quoteIdent(auth.schema)}.${quoteIdent(name)}`;
}

/** Epoch seconds now, in SQL — the auth tables keep times as `BIGINT` epoch seconds. */
const NOW = "extract(epoch FROM now())::bigint";

/** The per-user columns, from whichever auth tables exist. */
function userColumns(auth: AuthSchema): string {
  const has = (name: string) => auth.tables.has(name);
  const sessions = [
    has("auth_sessions")
      ? `(SELECT count(*) FROM ${t(auth, "auth_sessions")} s
          WHERE s.user_id = u.id AND s.expires_at > ${NOW})`
      : "0",
    has("auth_native_sessions")
      ? `(SELECT count(*) FROM ${t(auth, "auth_native_sessions")} ns WHERE ns.user_id = u.id
          AND ns.revoked_at IS NULL AND (ns.expires_at IS NULL OR ns.expires_at > ${NOW}))`
      : "0",
  ].join(" + ");
  const mfa = has("auth_mfa")
    ? `EXISTS (SELECT 1 FROM ${t(auth, "auth_mfa")} m
        WHERE m.user_id = u.id AND m.confirmed_at IS NOT NULL)`
    : "false";
  const passkeys = has("auth_passkeys")
    ? `(SELECT count(*) FROM ${t(auth, "auth_passkeys")} p WHERE p.user_id = u.id)`
    : "0";
  const banned = auth.columns.has("banned_until") ? "u.banned_until::text" : "NULL";
  return `u.id::text AS id, u.email, u.name, u.roles, u.created_at::text AS created_at,
    (${sessions})::text AS sessions, (${mfa})::text AS mfa, (${passkeys})::text AS passkeys,
    ${banned} AS banned_until`;
}

/** A number column, or `null`. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A text column, or `null`. */
function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** One row of the user query as a {@linkcode DbAuthUser}. */
function userOf(row: Record<string, unknown>): DbAuthUser {
  return {
    id: String(row.id),
    email: str(row.email),
    name: str(row.name),
    roles: str(row.roles),
    createdAt: num(row.created_at),
    sessions: num(row.sessions) ?? 0,
    mfa: row.mfa === true || row.mfa === "true",
    passkeys: num(row.passkeys) ?? 0,
    bannedUntil: num(row.banned_until),
  };
}

/**
 * One page of users in id order, optionally those whose email or name contains `query`.
 *
 * @param sql The client.
 * @param after The last id of the previous page.
 * @param query A case-insensitive substring of the email or name.
 * @returns The users and the next page's cursor.
 */
export function listUsers(
  sql: SqlClient,
  after?: string,
  query?: string,
): Promise<DbReplies["users"]> {
  return readTx(sql, async (tx) => {
    const auth = await authSchema(tx);
    if (!auth) return { schema: null, users: [] };
    const params: unknown[] = [];
    const where: string[] = [];
    if (after) {
      params.push(after);
      where.push(`u.id > $${params.length}`);
    }
    if (query) {
      params.push(`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
    }
    const rows = [
      ...await tx.unsafe(
        `SELECT ${userColumns(auth)} FROM ${t(auth, "auth_users")} u` +
          (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
          ` ORDER BY u.id LIMIT ${DB_PAGE_ROWS + 1}`,
        params,
      ),
    ];
    const users = rows.slice(0, DB_PAGE_ROWS).map(userOf);
    return {
      schema: auth.schema,
      users,
      ...(rows.length > DB_PAGE_ROWS ? { next: users[users.length - 1].id } : {}),
    };
  });
}

/**
 * One user, by id.
 *
 * @param sql The client.
 * @param id The user's id.
 * @returns The user, or `null` when there is none.
 */
export function getUser(sql: SqlClient, id: string): Promise<DbReplies["user"]> {
  return readTx(sql, async (tx) => {
    const auth = await authSchema(tx);
    if (!auth) return { schema: null, user: null };
    const [row] = await tx.unsafe(
      `SELECT ${userColumns(auth)} FROM ${t(auth, "auth_users")} u WHERE u.id = $1`,
      [id],
    );
    return { schema: auth.schema, user: row ? userOf(row) : null };
  });
}

/** The statements revoking a user's sessions: stored, native-app, and stateless cookies. */
function revokeStatements(auth: AuthSchema, id: string): DbStatement[] {
  const out: DbStatement[] = [];
  if (auth.columns.has("sessions_valid_after")) {
    out.push({
      text: `UPDATE ${t(auth, "auth_users")} SET sessions_valid_after = ${NOW} WHERE id = $1`,
      params: [id],
    });
  }
  if (auth.tables.has("auth_sessions")) {
    out.push({ text: `DELETE FROM ${t(auth, "auth_sessions")} WHERE user_id = $1`, params: [id] });
  }
  if (auth.tables.has("auth_native_sessions")) {
    out.push({
      text: `UPDATE ${t(auth, "auth_native_sessions")} SET revoked_at = ${NOW} ` +
        "WHERE user_id = $1 AND revoked_at IS NULL",
      params: [id],
    });
  }
  return out;
}

/** The statements deleting a user and every row keyed by them. */
function deleteStatements(auth: AuthSchema, id: string): DbStatement[] {
  const out: DbStatement[] = [];
  if (auth.tables.has("auth_verification_tokens")) {
    out.push({
      text: `DELETE FROM ${t(auth, "auth_verification_tokens")} WHERE identifier = ` +
        `(SELECT email_lc FROM ${t(auth, "auth_users")} WHERE id = $1)`,
      params: [id],
    });
  }
  for (const table of USER_TABLES) {
    if (!auth.tables.has(table)) continue;
    out.push({ text: `DELETE FROM ${t(auth, table)} WHERE user_id = $1`, params: [id] });
  }
  out.push({ text: `DELETE FROM ${t(auth, "auth_users")} WHERE id = $1`, params: [id] });
  return out;
}

/** `, updated_at = <now>` when the column exists. */
function touched(auth: AuthSchema): string {
  return auth.columns.has("updated_at") ? `, updated_at = ${NOW}` : "";
}

/** The statements banning a user for `seconds`, then ending every session. */
function banStatements(auth: AuthSchema, id: string, seconds: number | undefined): DbStatement[] {
  if (!DB_BAN_DURATIONS.some((d) => d.seconds === seconds)) {
    throw new AdminRefusal("bad_request", "pick a ban length from the list");
  }
  requireColumn(auth, "banned_until");
  return [
    {
      text: `UPDATE ${t(auth, "auth_users")} SET banned_until = ${NOW} + $2::bigint${
        touched(auth)
      } WHERE id = $1`,
      params: [id, String(seconds)],
    },
    ...revokeStatements(auth, id),
  ];
}

/** The statement lifting a ban. */
function unbanStatements(auth: AuthSchema, id: string): DbStatement[] {
  requireColumn(auth, "banned_until");
  return [{
    text: `UPDATE ${t(auth, "auth_users")} SET banned_until = NULL${touched(auth)} WHERE id = $1`,
    params: [id],
  }];
}

/** Refuse an action whose column this (older) auth schema does not have yet. */
function requireColumn(auth: AuthSchema, column: string): void {
  if (!auth.columns.has(column)) {
    throw new AdminRefusal(
      "unsupported",
      `auth_users has no ${column} column yet: it is added when the app's auth migrations run`,
    );
  }
}

/** A password the Users page may set, refused otherwise. */
function checkPassword(password: unknown): string {
  if (
    typeof password !== "string" || password.length < DB_MIN_PASSWORD ||
    password.length > DB_MAX_PASSWORD
  ) {
    throw new AdminRefusal(
      "bad_request",
      `a password needs ${DB_MIN_PASSWORD} to ${DB_MAX_PASSWORD} characters`,
    );
  }
  return password;
}

/** The statement storing a credential (`hash` is the mask in a preview). */
function credentialStatement(auth: AuthSchema, id: string, hash: string): DbStatement {
  if (!auth.tables.has("auth_credentials")) {
    throw new AdminRefusal("unsupported", "this database has no auth_credentials table");
  }
  return {
    text: `INSERT INTO ${t(auth, "auth_credentials")} (user_id, password_hash) VALUES ($1, $2) ` +
      "ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash",
    params: [id, hash],
  };
}

/** Each statement as a preview shows it: a password hash masked. */
function masked(statements: DbStatement[], hash: string | undefined): DbStatement[] {
  if (hash === undefined) return statements;
  return statements.map((s) => ({ ...s, params: s.params.map((p) => p === hash ? MASK : p) }));
}

/** What one action runs (`hash`: the new password's, or the mask while previewing). */
function actionStatements(
  auth: AuthSchema,
  action: DbUserAction,
  id: string,
  options: { seconds?: number; hash?: string },
): DbStatement[] {
  switch (action) {
    case "delete":
      return deleteStatements(auth, id);
    case "ban":
      return banStatements(auth, id, options.seconds);
    case "unban":
      return unbanStatements(auth, id);
    case "password":
      return [credentialStatement(auth, id, options.hash ?? MASK), ...revokeStatements(auth, id)];
    default:
      return revokeStatements(auth, id);
  }
}

/** The options of one user action. */
export interface UserActionOptions {
  /** `ban`: how long, in seconds. */
  readonly seconds?: number;
  /** `password`: the new password. */
  readonly password?: string;
}

/**
 * Preview or run an action on one user: revoke their sessions, delete them, ban or unban them,
 * or set their password.
 *
 * @param sql The client.
 * @param action What to do.
 * @param id The user's id.
 * @param confirm Run (otherwise only the statements are returned).
 * @param readOnly `--read-only`: refused.
 * @param options The ban length, or the new password.
 * @returns The statements (a password hash masked), and whether they ran.
 */
export async function userAction(
  sql: SqlClient,
  action: DbUserAction,
  id: string,
  confirm: boolean,
  readOnly: boolean,
  options: UserActionOptions = {},
): Promise<DbReplies["userAction"]> {
  assertWritable(readOnly);
  if (typeof id !== "string" || id === "") throw new AdminRefusal("bad_request", "no user id");
  const password = action === "password" ? checkPassword(options.password) : undefined;
  const { auth, exists } = await readTx(sql, async (tx) => {
    const auth = await authSchema(tx);
    if (!auth) return { auth, exists: false };
    const [row] = await tx.unsafe(`SELECT 1 AS hit FROM ${t(auth, "auth_users")} WHERE id = $1`, [
      id,
    ]);
    return { auth, exists: !!row };
  });
  if (!auth) throw new AdminRefusal("not_found", "this database has no auth_users table");
  if (!exists) throw new AdminRefusal("not_found", `no user ${JSON.stringify(id)}`);
  const preview = actionStatements(auth, action, id, { seconds: options.seconds });
  if (!confirm) return { statements: preview, applied: false };
  const hash = password === undefined ? undefined : await hashPassword(password);
  const statements = actionStatements(auth, action, id, { seconds: options.seconds, hash });
  await writeTx(sql, async (tx) => {
    for (const statement of statements) await tx.unsafe(statement.text, [...statement.params]);
  });
  return { statements: masked(statements, hash), applied: true };
}

/** A loose check that `email` is one address (the auth layer does the real one at sign-in). */
function checkEmail(email: unknown): string {
  const value = typeof email === "string" ? email.trim() : "";
  if (value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AdminRefusal("bad_request", "enter one email address");
  }
  return value;
}

/** What creating a user is given. */
export interface CreateUserInput {
  /** The address. */
  readonly email: string;
  /** A display name. */
  readonly name?: string;
  /** A password to sign in with. */
  readonly password?: string;
  /** Mark the address verified. */
  readonly verified: boolean;
}

/**
 * Create a user: the `auth_users` row, and a credential when a password is given — in one
 * transaction, refused when the address is taken.
 *
 * @param sql The client.
 * @param input The address, name, password and whether the address counts as verified.
 * @param readOnly `--read-only`: refused.
 * @returns The new id and the statements that ran (the password hash masked).
 */
export async function createUser(
  sql: SqlClient,
  input: CreateUserInput,
  readOnly: boolean,
): Promise<DbReplies["createUser"]> {
  assertWritable(readOnly);
  const email = checkEmail(input.email);
  const password = input.password ? checkPassword(input.password) : undefined;
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
  if (name !== null && name.length > 200) throw new AdminRefusal("bad_request", "name too long");
  const key = emailKey(email);
  const id = crypto.randomUUID();
  const hash = password === undefined ? undefined : await hashPassword(password);
  const statements = await writeTx(sql, async (tx) => {
    const auth = await authSchema(tx);
    if (!auth) throw new AdminRefusal("not_found", "this database has no auth_users table");
    const users = t(auth, "auth_users");
    const [taken] = await tx.unsafe(`SELECT 1 AS hit FROM ${users} WHERE email_lc = $1`, [key]);
    if (taken) throw new AdminRefusal("bad_request", "a user with that email already exists");
    const extra = auth.columns.has("updated_at") ? ", updated_at" : "";
    const out: DbStatement[] = [{
      text:
        `INSERT INTO ${users} (id, email, email_lc, email_verified, name, created_at${extra}) ` +
        `VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN ${NOW} END, $5, ${NOW}${
          extra ? `, ${NOW}` : ""
        })`,
      params: [id, email, key, String(input.verified === true), name],
    }];
    if (hash !== undefined) out.push(credentialStatement(auth, id, hash));
    for (const statement of out) await tx.unsafe(statement.text, [...statement.params]);
    return out;
  });
  return { id, statements: masked(statements, hash) };
}
