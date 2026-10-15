// The SQL editor of the Database section: run what an administrator typed, as the connecting
// role, and hand back the last statement's rows as text. It is the one path in the section that
// runs SQL the child did not build — admin-only by design: in `denext ui` the person at the
// keyboard owns the project, and the stack's dashboard is behind its password.
//
// Two modes. `read` runs ONE statement (the extended protocol refuses a second, so a `COMMIT;`
// cannot end the `READ ONLY` transaction and run what follows outside it) in a `READ ONLY`
// transaction. `write` runs a script (the simple protocol, several statements) in a transaction
// that commits. Both carry a statement timeout, and `--read-only` refuses `write` outright.

import type { SqlClient } from "../../server/postgres.ts";
import {
  DB_SQL_MAX_CHARS,
  DB_SQL_MAX_ROWS,
  DB_SQL_TIMEOUT_MS,
  type DbSqlResult,
} from "../../ui/database/protocol.ts";
import { inTransaction } from "./connection.ts";
import { AdminRefusal, assertWritable } from "./tables.ts";

/** The longest value one result cell carries back. */
const SQL_CELL_MAX_CHARS = 10_000;

/** A value as the result grid shows it. */
function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else if (value instanceof Date) text = value.toISOString();
  else if (value instanceof Uint8Array) {
    text = "\\x" + [...value].map((b) => b.toString(16).padStart(2, "0")).join("");
  } else if (typeof value === "object") {
    text = JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v);
  } else text = String(value);
  return text.length > SQL_CELL_MAX_CHARS ? `${text.slice(0, SQL_CELL_MAX_CHARS)}…` : text;
}

/** The last result of a run: a script answers one array of rows per statement. */
function lastResult(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result)) return [];
  if (result.length > 0 && result.every(Array.isArray)) {
    return result[result.length - 1] as Record<string, unknown>[];
  }
  return result as Record<string, unknown>[];
}

/** The rows as a grid: every column any row has, in first-seen order. */
function grid(rows: Record<string, unknown>[]): { columns: string[]; cells: (string | null)[][] } {
  const columns: string[] = [];
  const seen = new Set<string>();
  const kept = rows.slice(0, DB_SQL_MAX_ROWS);
  for (const row of kept) {
    for (const name of Object.keys(row ?? {})) {
      if (!seen.has(name)) {
        seen.add(name);
        columns.push(name);
      }
    }
  }
  return { columns, cells: kept.map((row) => columns.map((c) => cellText(row?.[c]))) };
}

/**
 * Run the editor's text.
 *
 * @param sql The client.
 * @param text The statement (`read`) or script (`write`).
 * @param mode `read` (one statement, `READ ONLY`) or `write` (a script that commits).
 * @param readOnly `--read-only`: `write` is refused.
 * @returns The last statement's rows, as text.
 */
export async function runSql(
  sql: SqlClient,
  text: string,
  mode: "read" | "write",
  readOnly: boolean,
): Promise<DbSqlResult> {
  if (typeof text !== "string" || text.trim() === "") {
    throw new AdminRefusal("bad_request", "type a statement to run");
  }
  if (text.length > DB_SQL_MAX_CHARS) {
    throw new AdminRefusal("bad_request", `at most ${DB_SQL_MAX_CHARS} characters`);
  }
  if (mode === "write") assertWritable(readOnly);
  const write = mode === "write";
  const started = performance.now();
  const result = await inTransaction(
    sql,
    { readOnly: !write, timeoutMs: DB_SQL_TIMEOUT_MS },
    async (tx) => {
      const query = tx.unsafe(text);
      return write && query.simple ? await query.simple() : await query;
    },
  );
  const rows = lastResult(result);
  return {
    mode: write ? "write" : "read",
    ...grid(rows),
    rowCount: rows.length,
    truncated: rows.length > DB_SQL_MAX_ROWS,
    ms: Math.round(performance.now() - started),
  };
}
