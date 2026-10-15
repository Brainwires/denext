// The table operations of the `db-admin` child: the overview, a table's structure, a page of
// rows, one row, and the three row writes. A write without `confirm` builds its statement and
// returns it unrun — the preview the UI shows — and with `confirm` runs that same statement.

import type { SqlClient } from "../../server/postgres.ts";
import {
  DB_PAGE_ROWS,
  DB_STATEMENT_TIMEOUT_MS,
  DB_VALUE_MAX_CHARS,
  type DbActor,
  type DbFilter,
  type DbReplies,
  type DbStatement,
  type DbTableInfo,
} from "../../ui/database/protocol.ts";
import {
  cursorAfter,
  DbSqlError,
  deleteRow,
  insertRow,
  selectPage,
  selectRow,
  updateRow,
} from "../../ui/database/sql.ts";
import { authTables, listPolicies, listTables, tableInfo } from "./catalog.ts";
import { inTransaction } from "./connection.ts";

/** A request the child refuses before any SQL: a missing table, a write in read-only mode. */
export class AdminRefusal extends Error {
  /**
   * Build the refusal.
   *
   * @param code `not_found`, `read_only`, `bad_request` or `unsupported`.
   * @param message The reason.
   */
  constructor(
    readonly code: "not_found" | "read_only" | "bad_request" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "AdminRefusal";
  }
}

/** A read transaction: `READ ONLY`, the statement timeout, and optionally an actor. */
export function readTx<T>(
  sql: SqlClient,
  fn: (tx: SqlClient) => Promise<T>,
  actor?: DbActor,
): Promise<T> {
  return inTransaction(sql, { readOnly: true, timeoutMs: DB_STATEMENT_TIMEOUT_MS, actor }, fn);
}

/** A write transaction: the statement timeout, as the connecting role. */
export function writeTx<T>(sql: SqlClient, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
  return inTransaction(sql, { readOnly: false, timeoutMs: DB_STATEMENT_TIMEOUT_MS }, fn);
}

/** Refuse a write in read-only mode — the child's own gate, behind the UI server's. */
export function assertWritable(readOnly: boolean): void {
  if (readOnly) throw new AdminRefusal("read_only", "read-only: writes are refused");
}

/**
 * The table's catalog entry.
 *
 * @throws {AdminRefusal} `not_found`.
 */
async function requireTable(tx: SqlClient, schema: string, name: string): Promise<DbTableInfo> {
  const table = await tableInfo(tx, schema, name);
  if (!table) throw new AdminRefusal("not_found", `no table ${schema}.${name}`);
  return table;
}

/**
 * The overview's tables and the auth schema.
 *
 * @param sql The client.
 * @returns The tables, whether they were cut, and the auth schema.
 */
export function overview(
  sql: SqlClient,
): Promise<Pick<DbReplies["overview"], "tables" | "truncated" | "authSchema">> {
  return readTx(sql, async (tx) => {
    const { tables, truncated } = await listTables(tx);
    const auth = await authTables(tx);
    return { tables, truncated, authSchema: auth?.schema ?? null };
  });
}

/**
 * One table's structure.
 *
 * @param sql The client.
 * @param schema Its schema.
 * @param name Its name.
 * @returns The entry.
 */
export function describe(sql: SqlClient, schema: string, name: string): Promise<DbTableInfo> {
  return readTx(sql, (tx) => requireTable(tx, schema, name));
}

/** A row's values as text (the select list casts every column). */
type TextRow = Record<string, string | null>;

/** Rows as plain text records. */
function textRows(rows: Iterable<Record<string, unknown>>): TextRow[] {
  return [...rows].map((row) => {
    const out: TextRow = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = value === null || value === undefined ? null : String(value);
    }
    return out;
  });
}

/** What {@linkcode browse} is asked for. */
export interface BrowseRequest {
  readonly schema: string;
  readonly table: string;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
  readonly after?: readonly (string | null)[];
  readonly filter?: DbFilter;
  readonly actor?: DbActor;
}

/**
 * One page of rows. The catalog is read as the connecting role, the page as `actor` (row-level
 * security then decides what comes back).
 *
 * @param sql The client.
 * @param request Table, sort, cursor, filter and actor.
 * @param limit Rows per page.
 * @returns The page, the next cursor, and the statement that read it.
 */
export async function browse(
  sql: SqlClient,
  request: BrowseRequest,
  limit?: number,
): Promise<DbReplies["rows"]> {
  const table = await describe(sql, request.schema, request.table);
  const statement = selectPage(table, {
    sort: request.sort,
    direction: request.direction,
    after: request.after,
    filter: request.filter,
    limit,
  });
  const read = await readTx(
    sql,
    async (tx) => textRows(await tx.unsafe(statement.text, [...statement.params])),
    request.actor,
  );
  const pageSize = limit ?? DB_PAGE_ROWS;
  const rows = read.slice(0, pageSize);
  const more = read.length > pageSize && table.primaryKey.length > 0;
  return {
    table,
    rows,
    ...(more ? { next: cursorAfter(table, rows[rows.length - 1], request.sort) } : {}),
    statement,
  };
}

/**
 * One row, by primary key.
 *
 * @param sql The client.
 * @param schema The table's schema.
 * @param name The table.
 * @param key The primary key's values.
 * @returns The table and the row (`null` when there is none).
 */
export async function readRow(
  sql: SqlClient,
  schema: string,
  name: string,
  key: Readonly<Record<string, string>>,
): Promise<DbReplies["row"]> {
  const table = await describe(sql, schema, name);
  const statement = selectRow(table, key);
  const [row] = await readTx(
    sql,
    async (tx) => textRows(await tx.unsafe(statement.text, [...statement.params])),
  );
  return { table, row: row ?? null };
}

/** What {@linkcode write} is asked for. */
export interface WriteRequest {
  readonly action: "update" | "insert" | "delete";
  readonly schema: string;
  readonly table: string;
  readonly key?: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, string | null>>;
  readonly confirm: boolean;
}

/** The statement a write would run. */
function writeStatement(table: DbTableInfo, request: WriteRequest): DbStatement {
  const values = request.values ?? {};
  switch (request.action) {
    case "update":
      return updateRow(table, request.key ?? {}, values, DB_VALUE_MAX_CHARS);
    case "insert":
      return insertRow(table, values, DB_VALUE_MAX_CHARS);
    case "delete":
      return deleteRow(table, request.key ?? {});
    default:
      throw new DbSqlError("unknown write");
  }
}

/**
 * Preview or run one row write. An update or delete must touch exactly one row: anything else
 * rolls the transaction back.
 *
 * @param sql The client.
 * @param request The write.
 * @param readOnly `--read-only`: refused.
 * @returns The statement, and (when run) how many rows it touched.
 */
export async function write(
  sql: SqlClient,
  request: WriteRequest,
  readOnly: boolean,
): Promise<DbReplies["write"]> {
  assertWritable(readOnly);
  const table = await describe(sql, request.schema, request.table);
  const statement = writeStatement(table, request);
  if (!request.confirm) return { statement, applied: false };
  const affected = await writeTx(sql, async (tx) => {
    const rows = [...await tx.unsafe(statement.text, [...statement.params])];
    if (request.action !== "insert" && rows.length !== 1) {
      throw new AdminRefusal(
        "not_found",
        `expected to ${request.action} one row, matched ${rows.length} — nothing was changed`,
      );
    }
    return rows.length;
  });
  return { statement, applied: true, affected };
}

/**
 * Every table's row-level security state and every policy.
 *
 * @param sql The client.
 * @returns The tables and policies.
 */
export function policies(sql: SqlClient): Promise<DbReplies["policies"]> {
  return readTx(sql, async (tx) => ({
    tables: (await listTables(tx)).tables.filter((t) =>
      t.kind === "table" || t.kind === "partitioned"
    ),
    policies: await listPolicies(tx),
  }));
}
