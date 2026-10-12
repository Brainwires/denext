// A fake Postgres `SqlClient` over an in-memory node:sqlite database, for unit tests of
// denext's Postgres stores on any Deno (no server, no Deno.SQL). It speaks just enough of the
// dialect those stores use: `$n` parameters become SQLite's `?n`, Postgres-only statements
// (the advisory lock, CREATE SCHEMA) are answered without running, booleans and dates are
// bound the way SQLite can take them, and SQLite's errors carry the SQLSTATE a Postgres
// server would send (`42P01` no such table, `23505` unique violation).
//
// Real Postgres semantics (concurrency across connections, types) are covered by the
// integration tests in tests/postgres-integration.test.ts against a real server.

import { DatabaseSync } from "node:sqlite";
import type { SqlClient, SqlQuery, SqlRow } from "../../src/server/postgres.ts";

/** What a test can see and steer. */
export interface FakeSqlClient extends SqlClient {
  /** Every statement sent, in order (after `$n` → `?n`). */
  readonly statements: string[];
  /** How many times `close()` ran. */
  readonly closes: number;
  /** Make the next statement matching `pattern` throw `error` (once). */
  failNext(pattern: RegExp, error: Error & { code?: string }): void;
  /** The underlying database, for direct reads. */
  readonly raw: DatabaseSync;
}

type Bindable = null | number | bigint | string | Uint8Array;

/** A value as node:sqlite can bind it. */
function bindable(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "number" || typeof value === "bigint" || typeof value === "string" ||
    value instanceof Uint8Array
  ) return value;
  return JSON.stringify(value);
}

/** SQLite's error, with the SQLSTATE Postgres would have sent. */
function translate(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message;
  const code = /no such table/i.test(message)
    ? "42P01"
    : /UNIQUE constraint failed/i.test(message)
    ? "23505"
    : undefined;
  if (code) Object.defineProperty(error, "code", { value: code, configurable: true });
  return error;
}

/** Statements the fake answers without running (Postgres-only, no SQLite equivalent). */
const SKIP = /^\s*(SELECT pg_advisory_xact_lock|CREATE SCHEMA)/i;

/**
 * Build the fake.
 *
 * @returns A fresh, empty fake client.
 */
export function fakeSqlClient(): FakeSqlClient {
  const raw = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const failures: Array<{ pattern: RegExp; error: Error }> = [];
  let closes = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const run = (text: string, params: unknown[] = [], simple = false): SqlRow[] => {
    const sql = text.replace(/\$(\d+)/g, "?$1");
    statements.push(sql);
    const failure = failures.findIndex((f) => f.pattern.test(sql));
    if (failure >= 0) throw failures.splice(failure, 1)[0].error;
    if (SKIP.test(sql)) return [];
    try {
      if (simple) {
        raw.exec(sql);
        return [];
      }
      return raw.prepare(sql).all(...params.map(bindable)) as SqlRow[];
    } catch (error) {
      throw translate(error);
    }
  };

  const query = <T>(text: string, params?: unknown[]): SqlQuery<T> => {
    const settle = () => Promise.resolve().then(() => run(text, params) as T[]);
    return {
      then: (ok, fail) => settle().then(ok, fail),
      simple: () => Promise.resolve().then(() => run(text, params, true) as T[]),
    };
  };

  const client =
    (<T>(strings: TemplateStringsArray, ...values: unknown[]) =>
      query<T>(strings.reduce((acc, s, i) => `${acc}$${i}${s}`), values)) as FakeSqlClient;
  Object.assign(client, {
    statements,
    raw,
    unsafe: query,
    failNext(pattern: RegExp, error: Error) {
      failures.push({ pattern, error });
    },
    begin<T>(fn: (tx: SqlClient) => T | Promise<T>): Promise<T> {
      // One connection: transactions take turns, as they would each hold a pooled one.
      const next = queue.then(async () => {
        run("BEGIN");
        try {
          const result = await fn(client);
          run("COMMIT");
          return result;
        } catch (error) {
          run("ROLLBACK");
          throw error;
        }
      });
      queue = next.catch(() => {});
      return next;
    },
    close() {
      closes++;
      return Promise.resolve();
    },
  });
  Object.defineProperty(client, "closes", { get: () => closes });
  return client;
}
