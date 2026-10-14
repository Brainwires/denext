// `denext db inspect <report>`: the Supabase CLI's `inspect db` reports (after pg-extras), read
// from the statistics views. `calls` and `outliers` need the pg_stat_statements extension.
// `--json` prints the rows; `report` runs every one.

import type { DbActionInput } from "./db-action.ts";

/** The schemas the reports leave out. */
const SYSTEM = `('pg_catalog', 'information_schema', 'pg_toast')`;

/** One report: its query and what it shows. */
interface Report {
  summary: string;
  sql: string;
  /** The extension it needs. */
  needs?: string;
}

/** Every report, by name. */
export const INSPECT_REPORTS: Record<string, Report> = {
  bloat: {
    summary: "Estimated dead space in tables and indexes",
    sql:
      `WITH constants AS (SELECT current_setting('block_size')::numeric AS bs, 23 AS hdr, 8 AS ma),
bloat_info AS (
  SELECT ma, bs, schemaname, tablename,
    (datawidth + (hdr + ma - (CASE WHEN hdr % ma = 0 THEN ma ELSE hdr % ma END)))::numeric AS datahdr,
    (maxfracsum * (nullhdr + ma - (CASE WHEN nullhdr % ma = 0 THEN ma ELSE nullhdr % ma END))) AS nullhdr2
  FROM (SELECT schemaname, tablename, hdr, ma, bs,
      SUM((1 - null_frac) * avg_width) AS datawidth, MAX(null_frac) AS maxfracsum,
      hdr + (SELECT 1 + count(*) / 8 FROM pg_stats s2
        WHERE null_frac <> 0 AND s2.schemaname = s.schemaname AND s2.tablename = s.tablename) AS nullhdr
    FROM pg_stats s, constants GROUP BY 1, 2, 3, 4, 5) AS foo),
table_bloat AS (
  SELECT schemaname, tablename, cc.relpages, bs,
    CEIL((cc.reltuples * ((datahdr + ma - (CASE WHEN datahdr % ma = 0 THEN ma ELSE datahdr % ma END))
      + nullhdr2 + 4)) / (bs - 20::float)) AS otta
  FROM bloat_info JOIN pg_class cc ON cc.relname = bloat_info.tablename
  JOIN pg_namespace nn ON cc.relnamespace = nn.oid AND nn.nspname = bloat_info.schemaname
    AND nn.nspname NOT IN ${SYSTEM}),
index_bloat AS (
  SELECT schemaname, tablename, bs, COALESCE(c2.relname, '?') AS iname,
    COALESCE(c2.reltuples, 0) AS ituples, COALESCE(c2.relpages, 0) AS ipages,
    COALESCE(CEIL((c2.reltuples * (datahdr - 12)) / (bs - 20::float)), 0) AS iotta
  FROM bloat_info JOIN pg_class cc ON cc.relname = bloat_info.tablename
  JOIN pg_namespace nn ON cc.relnamespace = nn.oid AND nn.nspname = bloat_info.schemaname
    AND nn.nspname NOT IN ${SYSTEM}
  JOIN pg_index i ON indrelid = cc.oid JOIN pg_class c2 ON c2.oid = i.indexrelid)
SELECT type, schemaname, object_name, bloat, pg_size_pretty(raw_waste) AS waste FROM (
  SELECT 'table' AS type, schemaname, tablename AS object_name,
    ROUND(CASE WHEN otta = 0 THEN 0.0 ELSE table_bloat.relpages / otta::numeric END, 1) AS bloat,
    CASE WHEN relpages < otta THEN '0' ELSE (bs * (table_bloat.relpages - otta)::bigint)::bigint END
      AS raw_waste
  FROM table_bloat
  UNION
  SELECT 'index' AS type, schemaname, tablename || '::' || iname AS object_name,
    ROUND(CASE WHEN iotta = 0 OR ipages = 0 THEN 0.0 ELSE ipages / iotta::numeric END, 1) AS bloat,
    CASE WHEN ipages < iotta THEN '0' ELSE (bs * (ipages - iotta))::bigint END AS raw_waste
  FROM index_bloat) bloat_summary
ORDER BY raw_waste DESC, bloat DESC`,
  },
  blocking: {
    summary: "Queries holding locks other queries wait on",
    sql: `SELECT bl.pid AS blocked_pid, ka.query AS blocking_statement,
  now() - ka.query_start AS blocking_duration, kl.pid AS blocking_pid,
  a.query AS blocked_statement, now() - a.query_start AS blocked_duration
FROM pg_catalog.pg_locks bl JOIN pg_catalog.pg_stat_activity a ON bl.pid = a.pid
JOIN pg_catalog.pg_locks kl JOIN pg_catalog.pg_stat_activity ka ON kl.pid = ka.pid
  ON bl.transactionid = kl.transactionid AND bl.pid <> kl.pid
WHERE NOT bl.granted`,
  },
  "cache-hit": {
    summary: "How often indexes and tables are read from the buffer cache",
    sql: `SELECT 'index hit rate' AS name,
  (sum(idx_blks_hit)) / nullif(sum(idx_blks_hit + idx_blks_read), 0) AS ratio
FROM pg_statio_user_indexes
UNION ALL
SELECT 'table hit rate' AS name,
  sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0) AS ratio
FROM pg_statio_user_tables`,
  },
  calls: {
    summary: "The queries run most often (pg_stat_statements)",
    needs: "pg_stat_statements",
    sql: `SELECT query, interval '1 millisecond' * total_exec_time AS total_exec_time,
  to_char((total_exec_time / sum(total_exec_time) OVER ()) * 100, 'FM90D0') || '%' AS prop_exec_time,
  to_char(calls, 'FM999G999G990') AS ncalls
FROM pg_stat_statements ORDER BY calls DESC LIMIT 10`,
  },
  "db-stats": {
    summary: "Database size, cache hit rates and WAL size",
    sql: `SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,
  (SELECT pg_size_pretty(sum(pg_indexes_size(c.oid))) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT IN ${SYSTEM}) AS total_index_size,
  (SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT IN ${SYSTEM}) AS total_table_size,
  (SELECT round(sum(idx_blks_hit) / nullif(sum(idx_blks_hit + idx_blks_read), 0), 2)
    FROM pg_statio_user_indexes) AS index_hit_rate,
  (SELECT round(sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2)
    FROM pg_statio_user_tables) AS table_hit_rate`,
  },
  "index-sizes": {
    summary: "Each index's size",
    sql:
      `SELECT n.nspname || '.' || c.relname AS name, pg_size_pretty(sum(c.relpages::bigint * 8192))
  AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ${SYSTEM} AND c.relkind = 'i'
GROUP BY n.nspname, c.relname ORDER BY sum(c.relpages) DESC`,
  },
  "index-usage": {
    summary: "How often each table's reads use an index",
    sql: `SELECT schemaname || '.' || relname AS name,
  CASE idx_scan WHEN 0 THEN 'Insufficient data'
    ELSE (100 * idx_scan / nullif(seq_scan + idx_scan, 0))::text END AS percent_of_times_index_used,
  n_live_tup AS rows_in_table
FROM pg_stat_user_tables ORDER BY n_live_tup DESC`,
  },
  locks: {
    summary: "Exclusive locks held now",
    sql: `SELECT pg_stat_activity.pid, COALESCE(pg_class.relname, 'null') AS relname,
  COALESCE(pg_locks.transactionid::text, 'null') AS transactionid, pg_locks.granted,
  pg_stat_activity.query, age(now(), pg_stat_activity.query_start) AS age
FROM pg_stat_activity, pg_locks LEFT OUTER JOIN pg_class ON (pg_locks.relation = pg_class.oid)
WHERE pg_stat_activity.query <> '<insufficient privilege>' AND pg_locks.pid = pg_stat_activity.pid
  AND pg_locks.mode = 'ExclusiveLock' AND pg_stat_activity.pid <> pg_backend_pid()
ORDER BY query_start`,
  },
  "long-running-queries": {
    summary: "Queries running for more than five minutes",
    sql: `SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE pg_stat_activity.query <> ''::text AND state <> 'idle'
  AND now() - pg_stat_activity.query_start > interval '5 minutes'
ORDER BY now() - pg_stat_activity.query_start DESC`,
  },
  outliers: {
    summary: "The queries with the most total execution time (pg_stat_statements)",
    needs: "pg_stat_statements",
    sql: `SELECT interval '1 millisecond' * total_exec_time AS total_exec_time,
  to_char((total_exec_time / sum(total_exec_time) OVER ()) * 100, 'FM90D0') || '%' AS prop_exec_time,
  to_char(calls, 'FM999G999G999G990') AS ncalls, query
FROM pg_stat_statements WHERE userid = (SELECT usesysid FROM pg_user WHERE usename = current_user LIMIT 1)
ORDER BY total_exec_time DESC LIMIT 10`,
  },
  "replication-slots": {
    summary: "Replication slots and how far behind they are",
    sql: `SELECT s.slot_name, s.active, COALESCE(r.state, 'N/A') AS state,
  CASE WHEN r.client_addr IS NULL THEN 'N/A' ELSE r.client_addr::text END AS replication_client_address,
  GREATEST(0, ROUND((redo_lsn - restart_lsn) / 1024 / 1024 / 1024, 2)) AS replication_lag_gb
FROM pg_control_checkpoint(), pg_replication_slots s
LEFT JOIN pg_stat_replication r ON (r.pid = s.active_pid)`,
  },
  "role-configs": {
    summary: "Roles with custom settings",
    sql: `SELECT rolname AS role_name, array_to_string(rolconfig, ',', '*') AS custom_config
FROM pg_roles WHERE rolconfig IS NOT NULL`,
  },
  "role-connections": {
    summary: "Open connections per role",
    sql: `SELECT rolname,
  (SELECT count(*) FROM pg_stat_activity WHERE pg_roles.rolname = pg_stat_activity.usename)
    AS active_connections,
  CASE WHEN rolconnlimit = -1 THEN current_setting('max_connections')::int8
    ELSE rolconnlimit END AS connection_limit
FROM pg_roles ORDER BY 2 DESC`,
  },
  "seq-scans": {
    summary: "Sequential scans per table",
    sql: `SELECT schemaname || '.' || relname AS name, seq_scan AS count
FROM pg_stat_user_tables ORDER BY seq_scan DESC`,
  },
  "table-index-sizes": {
    summary: "The size of each table's indexes",
    sql:
      `SELECT n.nspname || '.' || c.relname AS table, pg_size_pretty(pg_indexes_size(c.oid)) AS index_size
FROM pg_class c LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE n.nspname NOT IN ${SYSTEM} AND c.relkind = 'r'
ORDER BY pg_indexes_size(c.oid) DESC`,
  },
  "table-record-counts": {
    summary: "Estimated rows per table",
    sql: `SELECT schemaname, relname AS name, n_live_tup AS estimated_count
FROM pg_stat_user_tables ORDER BY n_live_tup DESC`,
  },
  "table-sizes": {
    summary: "Each table's size, without its indexes",
    sql:
      `SELECT n.nspname AS schema, c.relname AS name, pg_size_pretty(pg_table_size(c.oid)) AS size
FROM pg_class c LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE n.nspname NOT IN ${SYSTEM} AND c.relkind = 'r'
ORDER BY pg_table_size(c.oid) DESC`,
  },
  "total-index-size": {
    summary: "All indexes together",
    sql: `SELECT pg_size_pretty(sum(c.relpages::bigint * 8192)::bigint) AS size
FROM pg_class c LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE n.nspname NOT IN ${SYSTEM} AND c.relkind = 'i'`,
  },
  "total-table-sizes": {
    summary: "Each table's size with its indexes",
    sql: `SELECT n.nspname AS schema, c.relname AS name,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE n.nspname NOT IN ${SYSTEM} AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC`,
  },
  "unused-indexes": {
    summary: "Indexes scanned fewer than 50 times (candidates to drop)",
    sql: `SELECT schemaname || '.' || relname AS table, indexrelname AS index,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size, idx_scan AS index_scans
FROM pg_stat_user_indexes ui JOIN pg_index i ON ui.indexrelid = i.indexrelid
WHERE NOT indisunique AND idx_scan < 50 AND pg_relation_size(relid) > 5 * 8192
ORDER BY pg_relation_size(i.indexrelid) / nullif(idx_scan, 0) DESC NULLS FIRST,
  pg_relation_size(i.indexrelid) DESC`,
  },
  "vacuum-stats": {
    summary: "When each table was last vacuumed and analyzed, and its dead rows",
    sql: `SELECT psut.schemaname || '.' || psut.relname AS name,
  to_char(psut.last_vacuum, 'YYYY-MM-DD HH24:MI') AS last_vacuum,
  to_char(psut.last_autovacuum, 'YYYY-MM-DD HH24:MI') AS last_autovacuum,
  to_char(psut.last_analyze, 'YYYY-MM-DD HH24:MI') AS last_analyze,
  to_char(psut.last_autoanalyze, 'YYYY-MM-DD HH24:MI') AS last_autoanalyze,
  to_char(pg_class.reltuples, '9G999G999G999') AS rowcount,
  to_char(psut.n_dead_tup, '9G999G999G999') AS dead_rowcount,
  CASE WHEN psut.n_dead_tup > (current_setting('autovacuum_vacuum_threshold')::float8
      + current_setting('autovacuum_vacuum_scale_factor')::float8 * pg_class.reltuples)
    THEN 'yes' ELSE 'no' END AS expect_autovacuum
FROM pg_stat_user_tables psut INNER JOIN pg_class ON psut.relid = pg_class.oid
ORDER BY psut.n_dead_tup DESC`,
  },
};

/** A cell as text. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Rows as an aligned text table.
 *
 * @param rows The rows.
 * @returns The lines.
 */
export function formatTable(rows: Record<string, unknown>[]): string[] {
  if (!rows.length) return ["  (no rows)"];
  const columns = Object.keys(rows[0]);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => cell(row[column]).length))
  );
  const line = (values: string[]) =>
    `  ${values.map((value, i) => value.padEnd(widths[i])).join(" | ")}`.trimEnd();
  return [
    line(columns),
    `  ${widths.map((width) => "-".repeat(width)).join("-|-")}`,
    ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ];
}

/** Run one report. */
async function runReport(input: DbActionInput, name: string): Promise<Record<string, unknown>[]> {
  const report = INSPECT_REPORTS[name];
  if (report.needs) {
    const found = await input.sql.unsafe<{ found: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS found",
      [report.needs],
    );
    if (!found[0]?.found) {
      throw new Error(
        `${name} needs the ${report.needs} extension: CREATE EXTENSION ${report.needs} ` +
          "(and shared_preload_libraries = 'pg_stat_statements' in postgresql.conf)",
      );
    }
  }
  // JSON round trip: bigint / numeric / interval cells become plain JSON values.
  const rows = await input.sql.unsafe<{ row: string }>(
    `SELECT row_to_json(r)::text AS row FROM (${report.sql}) r`,
  );
  return rows.map((row) => JSON.parse(row.row) as Record<string, unknown>);
}

/** The reports `name` asks for (`report`: every one). */
function reportNames(name: string): string[] {
  if (name === "report") return Object.keys(INSPECT_REPORTS);
  if (INSPECT_REPORTS[name]) return [name];
  throw new Error(
    `${name ? `unknown report "${name}"` : "name a report"}: ${
      Object.keys(INSPECT_REPORTS).join(" | ")
    } | report`,
  );
}

/** One report's rows; when several run, a failing one is recorded instead of thrown. */
async function rowsOrError(
  input: DbActionInput,
  name: string,
  several: boolean,
): Promise<Record<string, unknown>[] | { error: string }> {
  try {
    return await runReport(input, name);
  } catch (error) {
    if (!several) throw error;
    return { error: (error as Error).message };
  }
}

/** Print one report's rows (with its heading when several run). */
function printReport(
  input: DbActionInput,
  name: string,
  rows: Record<string, unknown>[] | { error: string },
  several: boolean,
): void {
  if (several) input.io.log(`\n${name}: ${INSPECT_REPORTS[name].summary}`);
  if (Array.isArray(rows)) { for (const line of formatTable(rows)) input.io.log(line); }
  else input.io.log(`  (skipped: ${rows.error})`);
}

/**
 * `denext db inspect <report>` (`report`: all of them).
 *
 * @param input The action's input.
 */
export async function inspectAction(input: DbActionInput): Promise<void> {
  const names = reportNames(input.ctx.positionals[1] ?? "");
  const several = names.length > 1;
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const rows = await rowsOrError(input, name, several);
    out[name] = rows;
    if (!input.ctx.global.json) printReport(input, name, rows, several);
  }
  if (input.ctx.global.json) {
    input.io.log(JSON.stringify(several ? out : out[names[0]], null, 2));
  }
}
