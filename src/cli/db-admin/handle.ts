// One `db-admin` request in, one reply out. The child verb (src/cli/commands/db-admin.ts) reads
// the envelope from stdin, sets the project up, and hands it here; tests call it directly with a
// client of their own.

import { sqlState } from "../../server/postgres.ts";
import {
  DB_PAGE_ROWS,
  type DbActor,
  type DbEnvelope,
  type DbFailure,
  type DbFilter,
  type DbReplies,
  type DbReply,
  type DbRequest,
  type DbUserAction,
  maskSecrets,
} from "../../ui/database/protocol.ts";
import { DbSqlError } from "../../ui/database/sql.ts";
import { type AdminConnection, ConnectionError } from "./connection.ts";
import { migrate, migrationStatus } from "./migrations.ts";
import {
  downloadObject,
  hasStorage,
  listBuckets,
  listObjects,
  removeObject,
  uploadObject,
} from "./storage.ts";
import { AdminRefusal, browse, describe, overview, policies, readRow, write } from "./tables.ts";
import {
  createUser,
  type CreateUserInput,
  getUser,
  listUsers,
  userAction,
  type UserActionOptions,
} from "./users.ts";
import { runSql } from "./sql-editor.ts";

/** What a request is answered with besides itself. */
export interface HandleDeps {
  /** The project directory. */
  readonly projectDir: string;
  /** Opens the connection (called only by operations that need one). */
  readonly connect: () => AdminConnection;
}

/** A failure reply. */
function failure(code: DbFailure["code"], reason: string, sql?: string): DbFailure {
  return { ok: false, code, reason: maskSecrets(reason), ...(sql ? { sql } : {}) };
}

/** An error → the failure reply that explains it. */
export function failureOf(error: unknown): DbFailure {
  if (error instanceof AdminRefusal) return failure(error.code, error.message);
  if (error instanceof ConnectionError) return failure(error.code, error.message);
  if (error instanceof DbSqlError || error instanceof TypeError) {
    return failure("bad_request", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  const state = sqlState(error);
  return failure("query_failed", state ? `${message} (SQLSTATE ${state})` : message);
}

/** A string field, refused when absent. */
function str(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new AdminRefusal("bad_request", `missing ${name}`);
  }
  return value;
}

/** A `Record<string, string>` key, refused otherwise. */
function keyOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminRefusal("bad_request", "missing row key");
  }
  for (const v of Object.values(value)) {
    if (typeof v !== "string") throw new AdminRefusal("bad_request", "a key value must be text");
  }
  return value as Record<string, string>;
}

/** A `Record<string, string | null>` of values, refused otherwise. */
function valuesOf(value: unknown): Record<string, string | null> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminRefusal("bad_request", "bad values");
  }
  for (const v of Object.values(value)) {
    if (v !== null && typeof v !== "string") {
      throw new AdminRefusal("bad_request", "a value must be text or null");
    }
  }
  return value as Record<string, string | null>;
}

/** A page cursor: an array of text-or-null. */
function cursorOf(value: unknown): (string | null)[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => v !== null && typeof v !== "string")) {
    throw new AdminRefusal("bad_request", "bad page cursor");
  }
  return value;
}

/** A filter, or none. */
function filterOf(value: unknown): DbFilter | undefined {
  if (value === undefined) return undefined;
  const f = value as DbFilter;
  if (!f || typeof f.column !== "string" || (f.value !== null && typeof f.value !== "string")) {
    throw new AdminRefusal("bad_request", "bad filter");
  }
  return { column: f.column, value: f.value };
}

/** An actor, or none (the service role). */
function actorOf(value: unknown): DbActor | undefined {
  if (value === undefined) return undefined;
  const a = value as DbActor;
  if (a?.kind === "service" || a?.kind === "anon") return { kind: a.kind };
  if (a?.kind === "user" && typeof a.id === "string" && a.id !== "") {
    return { kind: "user", id: a.id, ...(typeof a.email === "string" ? { email: a.email } : {}) };
  }
  throw new AdminRefusal("bad_request", "bad actor");
}

/** The user actions the child knows. */
const USER_ACTIONS: readonly DbUserAction[] = ["revoke", "delete", "ban", "unban", "password"];

/** A user action, refused when unknown. */
function userActionOf(value: unknown): DbUserAction {
  if (!USER_ACTIONS.includes(value as DbUserAction)) {
    throw new AdminRefusal("bad_request", `unknown user action ${JSON.stringify(value)}`);
  }
  return value as DbUserAction;
}

/** The SQL editor's mode (`read` unless `write` is asked for). */
function sqlModeOf(value: unknown): "read" | "write" {
  return value === "write" ? "write" : "read";
}

/** A string field, or `undefined`. */
function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A user action's options: a ban's length, a new password. */
function userActionOptions(r: Record<string, unknown>): UserActionOptions {
  return {
    ...(typeof r.seconds === "number" ? { seconds: r.seconds } : {}),
    ...(typeof r.password === "string" ? { password: r.password } : {}),
  };
}

/** What creating a user is given (an empty password is none). */
function createUserInput(r: Record<string, unknown>): CreateUserInput {
  const password = optStr(r.password);
  return {
    email: str(r.email, "email"),
    ...(optStr(r.name) !== undefined ? { name: optStr(r.name) } : {}),
    ...(password ? { password } : {}),
    verified: r.verified === true,
  };
}

/** One operation on users or the SQL editor. */
type AdminOp = (
  r: Record<string, unknown>,
  readOnly: boolean,
  sql: AdminConnection["sql"],
) => Promise<object>;

/** The operations on users and the SQL editor (split out of {@linkcode dispatch}). */
const ADMIN_OPS: Partial<Record<DbRequest["op"], AdminOp>> = {
  users: (r, _readOnly, sql) => listUsers(sql, optStr(r.after), optStr(r.query)?.slice(0, 200)),
  user: (r, _readOnly, sql) => getUser(sql, str(r.id, "id")),
  userAction: (r, readOnly, sql) =>
    userAction(
      sql,
      userActionOf(r.action),
      str(r.id, "id"),
      r.confirm === true,
      readOnly,
      userActionOptions(r),
    ),
  createUser: (r, readOnly, sql) => createUser(sql, createUserInput(r), readOnly),
  sql: (r, readOnly, sql) => runSql(sql, str(r.text, "text"), sqlModeOf(r.mode), readOnly),
};

/** Run the request against an open connection. */
async function dispatch(
  request: DbRequest,
  readOnly: boolean,
  connection: AdminConnection,
  deps: HandleDeps,
): Promise<DbReply> {
  const sql = connection.sql;
  const r = request as unknown as Record<string, unknown>;
  switch (request.op) {
    case "overview":
      return {
        ok: true,
        connection: connection.display,
        source: connection.source,
        storage: hasStorage(),
        ...await overview(sql),
      };
    case "table":
      return {
        ok: true,
        table: await describe(sql, str(r.schema, "schema"), str(r.table, "table")),
      };
    case "rows":
      return {
        ok: true,
        ...await browse(sql, {
          schema: str(r.schema, "schema"),
          table: str(r.table, "table"),
          sort: typeof r.sort === "string" && r.sort !== "" ? r.sort : undefined,
          direction: r.direction === "desc" ? "desc" : "asc",
          after: cursorOf(r.after),
          filter: filterOf(r.filter),
          actor: actorOf(r.actor),
        }, DB_PAGE_ROWS),
      };
    case "row":
      return {
        ok: true,
        ...await readRow(sql, str(r.schema, "schema"), str(r.table, "table"), keyOf(r.key)),
      };
    case "write":
      return {
        ok: true,
        ...await write(sql, {
          action: request.action,
          schema: str(r.schema, "schema"),
          table: str(r.table, "table"),
          key: r.key === undefined ? undefined : keyOf(r.key),
          values: valuesOf(r.values),
          confirm: r.confirm === true,
        }, readOnly),
      };
    case "policies":
      return { ok: true, ...await policies(sql) };
    case "migrations":
      return { ok: true, ...await migrationStatus(sql, deps.projectDir) };
    case "migrate":
      return { ok: true, ...await migrate(sql, deps.projectDir, r.confirm === true, readOnly) };
    default: {
      const admin = ADMIN_OPS[request.op];
      if (admin) return { ok: true, ...await admin(r, readOnly, sql) } as DbReply;
      throw new AdminRefusal("bad_request", `unknown operation ${JSON.stringify(r.op)}`);
    }
  }
}

/** An upload's fields, handed to the plugin's own operation. */
function uploadFrom(r: Record<string, unknown>, readOnly: boolean): Promise<DbReplies["upload"]> {
  const contentType = optStr(r.contentType);
  return uploadObject(
    str(r.bucket, "bucket"),
    str(r.key, "key"),
    optStr(r.base64) ?? "",
    { ...(contentType ? { contentType } : {}), upsert: r.upsert === true },
    readOnly,
  );
}

/** The storage operations, which need no database. */
async function storageOp(request: DbRequest, readOnly: boolean): Promise<DbReply | null> {
  const r = request as unknown as Record<string, unknown>;
  switch (request.op) {
    case "buckets":
      return { ok: true, ...await listBuckets() };
    case "objects":
      return {
        ok: true,
        ...await listObjects(
          str(r.bucket, "bucket"),
          typeof r.prefix === "string" ? r.prefix : "",
          typeof r.cursor === "string" ? r.cursor : undefined,
        ),
      };
    case "download":
      return { ok: true, ...await downloadObject(str(r.bucket, "bucket"), str(r.key, "key")) };
    case "removeObject":
      return {
        ok: true,
        ...await removeObject(
          str(r.bucket, "bucket"),
          str(r.key, "key"),
          r.confirm === true,
          readOnly,
        ),
      };
    case "upload":
      return { ok: true, ...await uploadFrom(r, readOnly) };
    default:
      return null;
  }
}

/**
 * Answer one envelope. Never throws: every failure is a {@linkcode DbFailure} reply, with any
 * connection-string password masked.
 *
 * @param envelope The request and the read-only flag.
 * @param deps The project and how to connect.
 * @returns The reply.
 */
export async function handleDbRequest(envelope: DbEnvelope, deps: HandleDeps): Promise<DbReply> {
  const request = envelope?.request;
  if (!request || typeof request !== "object" || typeof request.op !== "string") {
    return failure("bad_request", "no request");
  }
  const readOnly = envelope.readOnly !== false;
  let connection: AdminConnection | undefined;
  try {
    const stored = await storageOp(request, readOnly);
    if (stored) return stored;
    connection = deps.connect();
    return await dispatch(request, readOnly, connection, deps);
  } catch (error) {
    return failureOf(error);
  } finally {
    await connection?.close().catch(() => {});
  }
}
