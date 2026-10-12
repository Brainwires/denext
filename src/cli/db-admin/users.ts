// denext auth's users, read from its Postgres tables (`auth_users` and the `auth_*` tables keyed
// by `user_id`; see src/server/auth/postgres-schema.ts): who they are, how many live sessions
// each has, whether a second factor is confirmed. Revoking deletes the user's rows in the
// session store and marks their native-app sessions revoked; deleting removes the user and
// every row keyed by them, as `postgresAuthAdapter().deleteUser` does — in one transaction.

import type { SqlClient } from "../../server/postgres.ts";
import {
  DB_PAGE_ROWS,
  type DbAuthUser,
  type DbReplies,
  type DbStatement,
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

/** The auth schema and its tables. */
interface AuthSchema {
  readonly schema: string;
  readonly tables: Set<string>;
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
  return `u.id::text AS id, u.email, u.name, u.roles, u.created_at::text AS created_at,
    (${sessions})::text AS sessions, (${mfa})::text AS mfa, (${passkeys})::text AS passkeys`;
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
    const auth = await authTables(tx);
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
    const users: DbAuthUser[] = rows.slice(0, DB_PAGE_ROWS).map((row) => ({
      id: String(row.id),
      email: str(row.email),
      name: str(row.name),
      roles: str(row.roles),
      createdAt: num(row.created_at),
      sessions: num(row.sessions) ?? 0,
      mfa: row.mfa === true || row.mfa === "true",
      passkeys: num(row.passkeys) ?? 0,
    }));
    return {
      schema: auth.schema,
      users,
      ...(rows.length > DB_PAGE_ROWS ? { next: users[users.length - 1].id } : {}),
    };
  });
}

/** The statements revoking a user's sessions. */
function revokeStatements(auth: AuthSchema, id: string): DbStatement[] {
  const out: DbStatement[] = [];
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

/**
 * Preview or run revoking a user's sessions, or deleting the user.
 *
 * @param sql The client.
 * @param action `revoke` or `delete`.
 * @param id The user's id.
 * @param confirm Run (otherwise only the statements are returned).
 * @param readOnly `--read-only`: refused.
 * @returns The statements, and whether they ran.
 */
export async function userAction(
  sql: SqlClient,
  action: "revoke" | "delete",
  id: string,
  confirm: boolean,
  readOnly: boolean,
): Promise<DbReplies["userAction"]> {
  assertWritable(readOnly);
  if (typeof id !== "string" || id === "") throw new AdminRefusal("bad_request", "no user id");
  const { auth, exists } = await readTx(sql, async (tx) => {
    const auth = await authTables(tx);
    if (!auth) return { auth, exists: false };
    const [row] = await tx.unsafe(`SELECT 1 AS hit FROM ${t(auth, "auth_users")} WHERE id = $1`, [
      id,
    ]);
    return { auth, exists: !!row };
  });
  if (!auth) throw new AdminRefusal("not_found", "this database has no auth_users table");
  if (!exists) throw new AdminRefusal("not_found", `no user ${JSON.stringify(id)}`);
  const statements = action === "delete" ? deleteStatements(auth, id) : revokeStatements(auth, id);
  if (!confirm) return { statements, applied: false };
  await writeTx(sql, async (tx) => {
    for (const statement of statements) await tx.unsafe(statement.text, [...statement.params]);
  });
  return { statements, applied: true };
}
