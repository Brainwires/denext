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
  type DbReply,
  type DbRequest,
  maskSecrets,
} from "../../ui/database/protocol.ts";
import { DbSqlError } from "../../ui/database/sql.ts";
import { type AdminConnection, ConnectionError } from "./connection.ts";
import { migrate, migrationStatus } from "./migrations.ts";
import { downloadObject, hasStorage, listBuckets, listObjects, removeObject } from "./storage.ts";
import { AdminRefusal, browse, describe, overview, policies, readRow, write } from "./tables.ts";
import { listUsers, userAction } from "./users.ts";

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
    case "users":
      return {
        ok: true,
        ...await listUsers(
          sql,
          typeof r.after === "string" ? r.after : undefined,
          typeof r.query === "string" ? r.query.slice(0, 200) : undefined,
        ),
      };
    case "userAction":
      return {
        ok: true,
        ...await userAction(
          sql,
          request.action === "delete" ? "delete" : "revoke",
          str(r.id, "id"),
          r.confirm === true,
          readOnly,
        ),
      };
    default:
      throw new AdminRefusal("bad_request", `unknown operation ${JSON.stringify(r.op)}`);
  }
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
