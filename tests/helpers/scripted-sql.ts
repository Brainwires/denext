// A scripted Postgres `SqlClient` for unit tests: every statement is recorded and answered by
// the test's own function (by matching the SQL text), so a module's TypeScript — the statements
// it builds, the parameters it binds, how it maps rows — is tested without a server. The SQL
// itself runs against a real Postgres in the integration suites.

import type { SqlClient, SqlQuery } from "../../src/server/postgres.ts";

/** One recorded statement. */
export interface ScriptedCall {
  text: string;
  params: unknown[];
}

/** The fake, with what it saw. */
export interface ScriptedSql extends SqlClient {
  readonly calls: ScriptedCall[];
  /** `listen(channel, fn)` subscribers, when `withListen` was set. */
  readonly listeners: Map<string, () => void>;
}

/**
 * Build the fake.
 *
 * @param answer Returns the rows for one statement (or throws).
 * @param options `withListen` adds a `listen()` like `Deno.SQL`'s.
 * @returns The client.
 */
export function scriptedSql(
  answer: (text: string, params: unknown[]) => unknown[] | Promise<unknown[]>,
  options: { withListen?: boolean } = {},
): ScriptedSql {
  const calls: ScriptedCall[] = [];
  const listeners = new Map<string, () => void>();
  const query = <T>(text: string, params: unknown[]): SqlQuery<T> => {
    let started: Promise<T[]> | undefined;
    const run = () =>
      started ??= Promise.resolve().then(() => {
        calls.push({ text, params });
        return answer(text, params) as T[];
      });
    return {
      then: (ok, fail) => run().then(ok, fail),
      simple: () => query<T>(text, params),
    };
  };
  const client =
    ((strings: TemplateStringsArray, ...values: unknown[]) =>
      query(strings.reduce((acc, s, i) => acc + `$${i}` + s), values)) as unknown as ScriptedSql;
  Object.assign(client, {
    calls,
    listeners,
    unsafe: <T>(text: string, params: unknown[] = []) => query<T>(text, params),
    // Like Deno.SQL and postgres.js: an array the callback returns is awaited as a whole.
    begin: async <T>(fn: (tx: SqlClient) => T | Promise<T>) => {
      const result = await fn(client);
      return Array.isArray(result) ? await Promise.all(result) : result;
    },
    close: () => Promise.resolve(),
  });
  if (options.withListen) {
    Object.assign(client, {
      listen: (channel: string, fn: () => void) => {
        listeners.set(channel, fn);
        return Promise.resolve({ unlisten: () => listeners.delete(channel) });
      },
    });
  }
  return client;
}
