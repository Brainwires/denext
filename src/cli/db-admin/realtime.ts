// Realtime's state in the database, for the Database section's Realtime page: the publication
// tables opt in through (Supabase's `alter publication supabase_realtime add table …`), and each
// table's place in it and its `denext_realtime` triggers. The one write is that opt-in — adding a
// table to the publication or dropping it — which is what `realtime({ tables })` leaves to the
// database; the running app's engine re-reads the publication and creates or drops the table's
// triggers itself. Every identifier comes from the catalog; nothing from the request is
// interpolated.

import type { SqlClient } from "../../server/postgres.ts";
import type { DbRealtimeTable, DbReplies, DbStatement } from "../../ui/database/protocol.ts";
import { quoteIdent } from "../../ui/database/sql.ts";
import { USER_SCHEMAS } from "./catalog.ts";
import { AdminRefusal, assertWritable, readTx, writeTx } from "./tables.ts";

/** The slot `@denext/backend` installs its realtime engine in (packages/backend/src/realtime.ts). */
const ENGINE = Symbol.for("denext.backend.realtime");

/** The parts of the engine's resolved options this page reads. */
interface EngineConfig {
  readonly publication: string | null;
  readonly source: string;
  readonly tables: ReadonlyMap<string, unknown>;
}

/** Supabase's publication name — what an unconfigured project's tables would opt in through. */
const DEFAULT_PUBLICATION = "supabase_realtime";

/** The engine's options, when the project configures realtime. */
function engineConfig(): EngineConfig | null {
  const slot = (globalThis as { [ENGINE]?: { config?: EngineConfig } })[ENGINE];
  return slot?.config ?? null;
}

/** The events a `denext_realtime` row trigger's `tgtype` fires on, plus TRUNCATE. */
function triggerEvents(tgtype: number | null, truncate: boolean): string[] {
  const out: string[] = [];
  if (tgtype !== null) {
    if (tgtype & 4) out.push("insert");
    if (tgtype & 16) out.push("update");
    if (tgtype & 8) out.push("delete");
  }
  if (truncate) out.push("truncate");
  return out;
}

/** Every user table with its publication membership, triggers, key and RLS. */
const TABLES_SQL = `SELECT n.nspname AS schema, c.relname AS name,
  EXISTS (SELECT 1 FROM pg_publication_tables pt WHERE pt.pubname = $1
    AND pt.schemaname = n.nspname AND pt.tablename = c.relname) AS in_pub,
  (SELECT t.tgtype::int FROM pg_trigger t WHERE t.tgrelid = c.oid
    AND t.tgname = 'denext_realtime') AS tgtype,
  EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid
    AND t.tgname = 'denext_realtime_truncate') AS truncate,
  (SELECT coalesce(array_length(i.indkey::int2[], 1), 0) FROM pg_index i
    WHERE i.indrelid = c.oid AND i.indisprimary) AS pk_cols,
  c.relrowsecurity AS rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND ${USER_SCHEMAS} AND n.nspname <> 'realtime'
ORDER BY n.nspname, c.relname LIMIT 1000`;

/** A boolean column (a driver may hand back text). */
function bool(value: unknown): boolean {
  return value === true || value === "true" || value === "t";
}

/** The name `realtime({ tables })` keys a table by (`notes`, or `schema.notes`). */
function configName(schema: string, name: string): string {
  return schema === "public" ? name : `${schema}.${name}`;
}

/** Read the publication and the tables (one read transaction). */
function readState(sql: SqlClient, publication: string): Promise<{
  exists: boolean;
  rows: Record<string, unknown>[];
}> {
  return readTx(sql, async (tx) => {
    const [pub] = await tx.unsafe("SELECT 1 AS hit FROM pg_publication WHERE pubname = $1", [
      publication,
    ]);
    return { exists: !!pub, rows: [...await tx.unsafe(TABLES_SQL, [publication])] };
  });
}

/**
 * Realtime's publication and every table's opt-in and triggers.
 *
 * @param sql The client.
 * @returns The state.
 */
export async function realtimeTables(sql: SqlClient): Promise<DbReplies["realtimeTables"]> {
  const config = engineConfig();
  const publication = config ? config.publication : DEFAULT_PUBLICATION;
  const { exists, rows } = publication === null
    ? { exists: false, rows: [] as Record<string, unknown>[] }
    : await readState(sql, publication);
  const tables: DbRealtimeTable[] = rows.map((row) => {
    const schema = String(row.schema);
    const name = String(row.name);
    return {
      schema,
      name,
      configured: config?.tables.has(configName(schema, name)) === true,
      inPublication: bool(row.in_pub),
      triggerEvents: triggerEvents(
        row.tgtype === null || row.tgtype === undefined ? null : Number(row.tgtype),
        bool(row.truncate),
      ),
      primaryKeyColumns: Number(row.pk_cols ?? 0),
      rls: bool(row.rls),
    };
  });
  return {
    configured: config !== null,
    publication,
    publicationExists: exists,
    source: config?.source ?? null,
    tables,
  };
}

/** The statements opting `table` in or out of `publication`. */
function publicationStatements(
  publication: string,
  exists: boolean,
  table: DbRealtimeTable,
  action: "add" | "drop",
): DbStatement[] {
  const pub = quoteIdent(publication);
  const qualified = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
  if (action === "drop") {
    if (!table.inPublication) {
      throw new AdminRefusal(
        "bad_request",
        `${table.schema}.${table.name} is not in ${publication}`,
      );
    }
    return [{ text: `ALTER PUBLICATION ${pub} DROP TABLE ${qualified}`, params: [] }];
  }
  if (table.inPublication) {
    throw new AdminRefusal("bad_request", `${table.schema}.${table.name} is in ${publication}`);
  }
  if (table.primaryKeyColumns !== 1) {
    throw new AdminRefusal(
      "bad_request",
      `${table.schema}.${table.name} needs a one-column primary key for realtime`,
    );
  }
  return [
    ...(exists ? [] : [{ text: `CREATE PUBLICATION ${pub}`, params: [] }]),
    { text: `ALTER PUBLICATION ${pub} ADD TABLE ${qualified}`, params: [] },
  ];
}

/**
 * Preview or run opting one table in or out of realtime's publication.
 *
 * @param sql The client.
 * @param schema The table's schema.
 * @param name The table.
 * @param action `add` or `drop`.
 * @param confirm Run (otherwise only the statements are returned).
 * @param readOnly `--read-only`: refused.
 * @returns The statements, and whether they ran.
 */
export async function realtimePublication(
  sql: SqlClient,
  schema: string,
  name: string,
  action: "add" | "drop",
  confirm: boolean,
  readOnly: boolean,
): Promise<DbReplies["realtimePublication"]> {
  assertWritable(readOnly);
  const state = await realtimeTables(sql);
  if (state.publication === null) {
    throw new AdminRefusal(
      "unsupported",
      "realtime({ publication: false }): tables opt in through realtime({ tables }) only",
    );
  }
  const table = state.tables.find((t) => t.schema === schema && t.name === name);
  if (!table) throw new AdminRefusal("not_found", `no table ${schema}.${name}`);
  const statements = publicationStatements(
    state.publication,
    state.publicationExists,
    table,
    action,
  );
  if (!confirm) return { statements, applied: false };
  await writeTx(sql, async (tx) => {
    for (const statement of statements) await tx.unsafe(statement.text);
  });
  return { statements, applied: true };
}
