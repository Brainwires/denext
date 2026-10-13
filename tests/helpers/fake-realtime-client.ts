// A fake Postgres `SqlClient` for `@denext/backend` realtime unit tests: in-memory tables with a
// per-table SELECT policy (a function of the transaction's `request.jwt.claims`), the trigger
// simulated by `insert` / `update` / `remove` (each sends the notification the real trigger
// would, to the `listen` callback), and the three statements realtime runs answered from those
// tables: the RLS setup (records the claims for the transaction), the column-type lookup, the
// key-only seed query and the re-read query. Anything else (migrations, the statement timeout)
// is recorded and answered with no rows. `delay` slows the seed and re-read queries down, and
// `inFlight` records how many of each ran at once.
//
// Real semantics (policies in SQL, NOTIFY at commit, reconnects) are covered by
// tests/backend-realtime-integration.test.ts against a real server.

import type { SqlClient, SqlListener, SqlQuery } from "../../src/server/postgres.ts";

type Row = Record<string, unknown>;
type Claims = { role?: string; sub?: string };

/** One fake table. */
export interface FakeTableSpec {
  /** The key column (default `id`). */
  key?: string;
  /** May these claims SELECT the row? (Default: every row.) */
  policy?: (claims: Claims, row: Row) => boolean;
  /** The columns' types, as the catalog reports them (default: none known). */
  types?: Record<string, string>;
  /** The columns' type names (`int8`), as the catalog reports them (default: none). */
  udts?: Record<string, string>;
}

/** One trigger in the fake catalog (by its table as `regclass::text` spells it). */
export interface FakeTrigger {
  /** The arguments, as `encode(tgargs, 'escape')` spells them. */
  args: string;
  /** `O` enabled, `D` disabled. */
  enabled: string;
}

/** The fake's catalog extras: the publication's rows and the realtime triggers. */
export interface FakeCatalog {
  /** The rows `PUBLICATION_TABLES_SQL` answers (mutable: a test adds / removes tables). */
  publication: Row[];
  /** `rel → name → trigger` (rel: `notes`, `app.things`). */
  triggers: Map<string, Map<string, FakeTrigger>>;
}

/** Seed / re-read concurrency, now and at its highest. */
export interface InFlight {
  seed: number;
  reread: number;
  maxSeed: number;
  maxReread: number;
}

/** What a test can see and steer. */
export interface FakeRealtimeClient extends SqlClient {
  /** Every statement text sent through `unsafe`, in order. */
  readonly statements: string[];
  /** Each statement's parameters (parallel to `statements`). */
  readonly parameters: unknown[][];
  /** Insert a row (and notify, as the trigger would). */
  insert(table: string, row: Row): void;
  /** Merge `patch` into the row with `key` (and notify; a changed key sends `old_key`). */
  update(table: string, key: string, patch: Row): void;
  /** Delete the row with `key` (and notify). */
  remove(table: string, key: string): void;
  /** Send a raw notification payload to the listener. */
  notify(payload: string): void;
  /** Simulate a lost and re-established listening connection (`onlisten` runs again). */
  reconnect(): void;
  /** How many listeners are subscribed. */
  readonly listeners: number;
  /** The tables' rows. */
  readonly tables: Map<string, Map<string, Row>>;
  /** Milliseconds each seed / re-read query takes (default 0). */
  delay: { seed: number; reread: number };
  /** How many seed / re-read queries ran at once. */
  readonly inFlight: InFlight;
  /** The publication rows and the triggers, as the catalog would hold them. */
  readonly catalog: FakeCatalog;
}

/** `"app"."things"` / `"notes"` as `regclass::text` spells it (`app.things` / `notes`). */
function relOf(qualified: string): string {
  const parts = qualified.split(".").map((part) => part.replaceAll('"', ""));
  return parts.length === 2 && parts[0] === "public" ? parts[1] : parts.join(".");
}

/** A filter as the fake evaluates it: numbers compare as numbers, `in` takes a JSON list. */
function compare(value: unknown, op: string, param: unknown): boolean {
  if (op === "in" || op === "= any") {
    return (JSON.parse(String(param)) as string[]).includes(String(value));
  }
  const numeric = typeof value === "number";
  const a = numeric ? value : String(value);
  const b = numeric ? Number(param) : String(param);
  switch (op) {
    case "<>":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      return a === b;
  }
}

/**
 * Build the fake.
 *
 * @param specs The tables.
 * @param withListen Give it `listen` (default true; `false` models a client without LISTEN).
 * @returns The fake client.
 */
export function fakeRealtimeClient(
  specs: Record<string, FakeTableSpec>,
  withListen = true,
): FakeRealtimeClient {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const catalog: FakeCatalog = { publication: [], triggers: new Map() };

  /** The catalog statements: publication tables, trigger args, the toggle, trigger DDL. */
  const catalogAnswer = (text: string, params: unknown[]): Row[] | null => {
    if (/from pg_publication_tables pt/.test(text)) {
      return catalog.publication.map((r) => ({ ...r }));
    }
    if (/encode\(tgargs, 'escape'\)/.test(text)) {
      const triggers = catalog.triggers.get(relOf(String(params[0])));
      return [...(triggers ?? new Map())].map(([name, t]) => ({ name, args: t.args }));
    }
    if (/tgenabled::text as enabled/.test(text)) {
      return [...catalog.triggers].flatMap(([rel, map]) =>
        [...map].map(([name, t]) => ({ rel, name, enabled: t.enabled }))
      );
    }
    const create =
      /^CREATE TRIGGER (\w+) AFTER .* ON (\S+)\s+FOR EACH \w+ EXECUTE FUNCTION \w+\((.*)\)$/s
        .exec(text);
    if (create) {
      const args = create[3].split(",").map((a) => a.trim().replace(/^'|'$/g, "") + "\\000").join(
        "",
      );
      const rel = relOf(create[2]);
      if (!catalog.triggers.has(rel)) catalog.triggers.set(rel, new Map());
      catalog.triggers.get(rel)!.set(create[1], { args, enabled: "O" });
      return [];
    }
    const drop = /^DROP TRIGGER IF EXISTS (\w+) ON (\S+?);?$/.exec(text);
    if (drop) {
      catalog.triggers.get(relOf(drop[2]))?.delete(drop[1]);
      return [];
    }
    const toggle = /^ALTER TABLE (\S+) (ENABLE|DISABLE) TRIGGER (\w+)$/.exec(text);
    if (toggle) {
      const t = catalog.triggers.get(relOf(toggle[1]))?.get(toggle[3]);
      if (t) t.enabled = toggle[2] === "ENABLE" ? "O" : "D";
      return [];
    }
    return null;
  };
  const tables = new Map<string, Map<string, Row>>(
    Object.keys(specs).map((name) => [name, new Map()]),
  );
  const keyCol = (table: string) => specs[table]?.key ?? "id";
  const visible = (table: string, claims: Claims, row: Row) =>
    specs[table]?.policy ? specs[table].policy!(claims, row) : true;
  const subs = new Set<{ fn: (payload: string) => void; onlisten?: () => void }>();

  /** The column-type lookup: the spec's `types` of the table `$1` names. */
  const typesOf = (params: unknown[]): Row[] => {
    const table = /^(?:"\w+"\.)?"(\w+)"$/.exec(String(params[0]))?.[1] ?? "";
    return Object.entries(specs[table]?.types ?? {}).map(([name, type]) => ({
      name,
      type,
      ...(specs[table]?.udts?.[name] ? { udt: specs[table].udts![name] } : {}),
    }));
  };

  const answer = (text: string, params: unknown[], claims: Claims): Row[] => {
    statements.push(text);
    parameters.push(params);
    const fromCatalog = catalogAnswer(text, params);
    if (fromCatalog) return fromCatalog;
    const reread = /to_jsonb\(t\)::text as r from (?:"\w+"\.)?"(\w+)" t/.exec(text);
    const seed = /^select to_jsonb\(t\."(\w+)"\) #>> '\{\}' as k from (?:"\w+"\.)?"(\w+)" t/
      .exec(text);
    const filter =
      /t\."(\w+)"(?:::text)? (=|<>|<=|<|>=|>|in|= any)[ (]+(?:select jsonb_array_elements_text\()?\$2/
        .exec(text);
    if (/from pg_attribute a .*where a\.attrelid = \$1::regclass/s.test(text)) {
      return typesOf(params);
    }
    const filterOk = (row: Row) => !filter || compare(row[filter[1]], filter[2], params[1]);
    if (reread) {
      const table = reread[1];
      const keys = new Set(JSON.parse(String(params[0])) as string[]);
      return [...(tables.get(table)?.values() ?? [])]
        .filter((row) => keys.has(String(row[keyCol(table)])))
        .filter((row) => visible(table, claims, row) && filterOk(row))
        .map((row) => ({ k: String(row[keyCol(table)]), r: JSON.stringify(row) }));
    }
    if (seed && !reread) {
      const table = seed[2];
      return [...(tables.get(table)?.values() ?? [])]
        .filter((row) => visible(table, claims, row) && filterOk(row))
        .slice(0, Number(params[0]))
        .map((row) => ({ k: String(row[keyCol(table)]) }));
    }
    return [];
  };

  const delay = { seed: 0, reread: 0 };
  const inFlight: InFlight = { seed: 0, reread: 0, maxSeed: 0, maxReread: 0 };
  const query = <T>(rows: () => Row[], kind?: "seed" | "reread"): SqlQuery<T> => {
    let settled = Promise.resolve().then(rows) as Promise<T[]>;
    if (kind) {
      const max = kind === "seed" ? "maxSeed" : "maxReread";
      inFlight[kind]++;
      inFlight[max] = Math.max(inFlight[max], inFlight[kind]);
      settled = settled
        .then((value) =>
          new Promise<T[]>((resolve) => setTimeout(() => resolve(value), delay[kind]))
        )
        .finally(() => inFlight[kind]--);
    }
    settled.catch(() => {});
    return { then: (ok, fail) => settled.then(ok, fail), simple: () => settled };
  };
  const kindOf = (text: string) =>
    /to_jsonb\(t\)::text as r/.test(text)
      ? "reread"
      : /^select to_jsonb\(t\."\w+"\) #>> '\{\}' as k from/.test(text)
      ? "seed"
      : undefined;

  /** A client whose queries see `scope` (the transaction's claims once the setup ran). */
  const clientWith = (scope: { claims: Claims }): SqlClient => {
    const client =
      ((strings: TemplateStringsArray, ...values: unknown[]) =>
        query(() =>
          answer(strings.reduce((acc, s, i) => `${acc}$${i}${s}`), values, scope.claims)
        )) as SqlClient;
    client.unsafe = <T>(text: string, params: unknown[] = []) => {
      if (text.startsWith("select set_config('role'")) {
        statements.push(text);
        parameters.push(params);
        scope.claims = JSON.parse(String(params[1]));
        return query<T>(() => []);
      }
      // Evaluated now: a pipelined setup + query arrive in call order, as on one connection.
      let rows: Row[];
      try {
        rows = answer(text, params, scope.claims);
      } catch (error) {
        return query<T>(() => {
          throw error;
        });
      }
      return query<T>(() => rows, kindOf(text));
    };
    client.begin = async <T>(fn: (tx: SqlClient) => T | Promise<T>): Promise<T> => {
      statements.push("BEGIN");
      parameters.push([]);
      // An array of queries is awaited as a whole, as Deno.SQL and postgres.js do.
      const returned = fn(clientWith({ claims: {} }));
      const result = (Array.isArray(returned) ? await Promise.all(returned) : await returned) as T;
      statements.push("COMMIT");
      parameters.push([]);
      return result;
    };
    client.close = () => Promise.resolve();
    return client;
  };

  const client = clientWith({ claims: {} }) as FakeRealtimeClient;
  const send = (payload: Record<string, unknown>) => {
    const text = JSON.stringify({ ...payload, ts: Date.now() });
    for (const sub of subs) sub.fn(text);
  };
  if (withListen) {
    client.listen = (channel, fn, onlisten): Promise<SqlListener> => {
      statements.push(`LISTEN ${channel}`);
      parameters.push([]);
      const sub = { fn, onlisten };
      subs.add(sub);
      queueMicrotask(() => onlisten?.());
      return Promise.resolve({
        unlisten() {
          subs.delete(sub);
          return Promise.resolve();
        },
      });
    };
  }
  Object.assign(client, {
    catalog,
    statements,
    parameters,
    tables,
    delay,
    inFlight,
    insert(table: string, row: Row) {
      const key = String(row[keyCol(table)]);
      tables.get(table)!.set(key, { ...row });
      send({ table, op: "insert", key });
    },
    update(table: string, key: string, patch: Row) {
      const rows = tables.get(table)!;
      const next = { ...rows.get(key)!, ...patch };
      const newKey = String(next[keyCol(table)]);
      rows.delete(key);
      rows.set(newKey, next);
      send({ table, op: "update", key: newKey, ...(newKey !== key ? { old_key: key } : {}) });
    },
    remove(table: string, key: string) {
      tables.get(table)!.delete(key);
      send({ table, op: "delete", key });
    },
    notify(payload: string) {
      for (const sub of subs) sub.fn(payload);
    },
    reconnect() {
      for (const sub of subs) sub.onlisten?.();
    },
  });
  Object.defineProperty(client, "listeners", { get: () => subs.size });
  return client;
}
