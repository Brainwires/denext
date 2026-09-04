// The data layer, backed by **Postgres** through a Deno-native, zero-npm driver
// (`jsr:@db/postgres`). The whole point of this example is the thing DATABASE.md
// tells you to validate yourself: a *networked* database, a *bounded connection
// pool*, and how both behave when concurrent requests exceed the pool size.
//
// The pool is a module singleton (`getPool`). Every query borrows a client with
// `withClient` and ALWAYS releases it — that release is what lets a pool of, say,
// 10 connections serve 200 concurrent requests: excess requests queue for a free
// client instead of opening a 201st connection and exhausting Postgres.
//
// Config (see .env.example): DATABASE_URL (required), POOL_SIZE (default 10).

import { Pool, type PoolClient } from "@db/postgres";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const POOL_SIZE = Number(Deno.env.get("POOL_SIZE") ?? "10");

let pool: Pool | null = null;

/** The lazily-created connection pool (one per process). */
function getPool(): Pool {
  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set — start Postgres with `deno task db:up` and copy " +
        ".env.example to .env (the tasks load it).",
    );
  }
  // `lazy: true` — connections open on first use, up to POOL_SIZE, and are reused.
  pool ??= new Pool(DATABASE_URL, POOL_SIZE, true);
  return pool;
}

/**
 * Borrow a pooled client, run `fn`, and release the client no matter what. This
 * release-in-`finally` is the load-safety invariant: a leaked client permanently
 * shrinks the pool and eventually deadlocks it under load.
 *
 * @param fn Runs with a checked-out {@linkcode PoolClient}.
 * @returns Whatever `fn` returns.
 */
async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

let schema: Promise<void> | null = null;

/** Create the `visits` table once per process (idempotent, memoized). */
export function initDb(): Promise<void> {
  schema ??= withClient(async (c) => {
    await c.queryArray`
      CREATE TABLE IF NOT EXISTS visits (
        id   BIGSERIAL   PRIMARY KEY,
        path TEXT        NOT NULL,
        at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
  });
  return schema;
}

/** A recent visit row for the page's activity list. */
export interface Visit {
  /** The request path that was recorded. */
  path: string;
  /** The wall-clock time, formatted `HH:MM:SS`. */
  at: string;
}

/** The homepage's read model: the running total plus the last few visits. */
export interface Stats {
  /** Total rows in `visits`. */
  total: number;
  /** The 10 most recent visits, newest first. */
  recent: Visit[];
}

/**
 * Record one visit (a write) and return the new total. This is the unit of work
 * the load harness hammers: one INSERT + one COUNT inside a single borrowed
 * client, so each request holds a pool connection for the shortest possible time.
 *
 * @param path The path being recorded.
 * @returns The total number of visits after the insert.
 */
export function recordVisit(path: string): Promise<number> {
  return withClient(async (c) => {
    // Two statements: a data-modifying CTE's insert is NOT visible to a SELECT in
    // the same statement, so counting inline would undercount by one.
    await c.queryArray`INSERT INTO visits (path) VALUES (${path})`;
    const r = await c.queryObject<
      { count: number }
    >`SELECT count(*)::int AS count FROM visits`;
    return r.rows[0].count;
  });
}

/**
 * Read the homepage stats (the total and the 10 most recent visits).
 *
 * @returns The {@linkcode Stats} read model.
 */
export async function getStats(): Promise<Stats> {
  await initDb();
  return withClient(async (c) => {
    const total = await c.queryObject<{ count: number }>`
      SELECT count(*)::int AS count FROM visits`;
    const recent = await c.queryObject<Visit>`
      SELECT path, to_char(at, 'HH24:MI:SS') AS at
      FROM visits ORDER BY id DESC LIMIT 10`;
    return { total: total.rows[0].count, recent: recent.rows };
  });
}
