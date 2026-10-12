// The realtime options and the SQL that makes a table send changes: `backend_realtime_0001`
// (replaced by `backend_realtime_0002`) installs one trigger function, `denext_realtime_notify()`, and each opted-in table gets an
// AFTER … FOR EACH ROW trigger calling it with the table's name and key column. The function
// sends `pg_notify('denext_realtime', json)` with `{ table, op, key, old_key?, ts }` — the KEY
// only, never row data: a NOTIFY payload is capped at 8000 bytes, and the row is re-read for
// each subscriber under their own row-level security instead (so nothing a subscriber may not
// SELECT ever leaves the database on their behalf).

import type { Migration } from "@denext/denext/server";
import { positiveOption } from "./options.ts";
import { IDENTIFIER, REALTIME_NOTIFY_CHANNEL, type TableEvent } from "./realtime-shared.ts";

/** One table opted in to realtime. */
export interface RealtimeTableOptions {
  /** The changes to send (default all three: `["insert", "update", "delete"]`). */
  events?: TableEvent[];
  /** The key column a change is identified by (default `"id"`). */
  key?: string;
  /** The table's schema (default: the connection's search path). */
  schema?: string;
}

/** `backend({ realtime })`: realtime changes from Postgres tables. */
export interface RealtimeOptions {
  /** The tables to send changes from, by name: `{ notes: { events: ["insert"], key: "id" } }`. */
  tables: Record<string, RealtimeTableOptions>;
  /**
   * Also `revalidateTag("table:<name>")` once per burst of changes, so `<Live>`, `useLive`,
   * `useApi({ tags })` and `defineSubscription({ tags })` watchers of that tag are pushed
   * (default `false`). `true` is `{ owner: "every" }`.
   */
  revalidate?: boolean | RealtimeRevalidateOptions;
  /**
   * Install the triggers by migration (recorded in `backend_migrations`) the first time
   * realtime is used (default `true`). `false` when a database administrator applies
   * {@linkcode realtimeSetupSql} instead.
   */
  migrate?: boolean;
  /**
   * Subscriptions held at once on one server instance (default 10 000). A subscription whose
   * subscriber disconnected is kept for a reconnect only while there is room: at the cap the
   * oldest such one is dropped, and only live subscriptions refuse a new one.
   */
  maxSubscribers?: number;
  /**
   * Subscriptions one identity may hold on one server instance (default 64): a signed-in user
   * across all their connections, or the signed-out visitors at one client address
   * (`clientIpForLimits()`: one Live connection when the address is unknown or an untrusted
   * loopback/private peer — set `trustForwardedHeaders` behind a proxy). It also bounds the distinct
   * filters (re-read groups) an identity adds to a burst. Server-side `tableChanges`
   * subscriptions are not counted.
   */
  maxSubscriptionsPerIdentity?: number;
  /**
   * The `statement_timeout`, in milliseconds, of every re-read and subscribe-time query
   * (transaction-local; default 5 000). A re-read that times out becomes a `resync` for its
   * subscribers.
   */
  queryTimeoutMs?: number;
  /**
   * Keys tracked per subscription, so a delete reaches only subscribers who could see the row
   * (default 10 000); see the docs for what happens past it.
   */
  maxTrackedKeys?: number;
}

/** `realtime({ revalidate: { owner } })`: which server instances revalidate. */
export interface RealtimeRevalidateOptions {
  /**
   * `"every"` (the default): each instance revalidates for every burst its own listener
   * receives — right for an instance-local cache. `"one"`: one instance per database does,
   * elected with a session-level Postgres advisory lock held on a reserved connection; when that
   * connection closes (the instance stops or dies) the next instance to see a burst takes over.
   * Use `"one"` only when the cache is shared by every instance (a Postgres cache store);
   * it needs a client with `reserve()` (`Deno.SQL`, or postgres.js through `fromPostgresJs`),
   * and without one every instance revalidates.
   */
  owner?: "every" | "one";
}

/** A table's resolved options. */
export interface ResolvedTable {
  /** The name it is configured (and subscribed) under. */
  name: string;
  /** The events sent. */
  events: TableEvent[];
  /** The key column. */
  key: string;
  /** The schema, if any. */
  schema?: string;
  /** `"schema"."table"` or `"table"`. */
  qualified: string;
}

/** Validated realtime options. */
export interface ResolvedRealtime {
  /** The tables, by name. */
  tables: Map<string, ResolvedTable>;
  /** Revalidate `table:<name>` per burst. */
  revalidate: boolean;
  /** Which instances revalidate (see {@linkcode RealtimeRevalidateOptions.owner}). */
  revalidateOwner: "every" | "one";
  /** Migrate on first use. */
  migrate: boolean;
  /** The subscription cap per instance. */
  maxSubscribers: number;
  /** The subscription cap per identity. */
  maxSubscriptionsPerIdentity: number;
  /** The re-read / seed `statement_timeout`, in milliseconds. */
  queryTimeoutMs: number;
  /** The tracked-key cap per subscription. */
  maxTrackedKeys: number;
}

const EVENTS: readonly TableEvent[] = ["insert", "update", "delete"];

/** `revalidate`'s owner, validated. */
function revalidateOwner(revalidate: RealtimeOptions["revalidate"]): "every" | "one" {
  if (revalidate === undefined || typeof revalidate === "boolean") return "every";
  if (typeof revalidate !== "object" || revalidate === null) {
    throw new TypeError("realtime(): revalidate must be a boolean or { owner }");
  }
  const owner = revalidate.owner ?? "every";
  if (owner !== "every" && owner !== "one") {
    throw new TypeError(`realtime(): revalidate.owner must be "every" or "one"`);
  }
  return owner;
}

function identifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new TypeError(
      `realtime(): ${what} ${JSON.stringify(value)} is not a plain identifier ` +
        "(letters, digits and underscores, not starting with a digit)",
    );
  }
  return value;
}

function resolveTable(name: string, options: RealtimeTableOptions): ResolvedTable {
  identifier(name, "table");
  const events = options.events ?? [...EVENTS];
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError(`realtime(): table ${name}: events must list insert, update or delete`);
  }
  for (const event of events) {
    if (!EVENTS.includes(event)) {
      throw new TypeError(`realtime(): table ${name}: unknown event ${JSON.stringify(event)}`);
    }
  }
  const key = identifier(options.key ?? "id", `table ${name}: key`);
  const schema = options.schema === undefined
    ? undefined
    : identifier(options.schema, `table ${name}: schema`);
  return {
    name,
    events: EVENTS.filter((event) => events.includes(event)),
    key,
    ...(schema ? { schema } : {}),
    qualified: schema ? `"${schema}"."${name}"` : `"${name}"`,
  };
}

/**
 * Validate realtime options and apply the defaults.
 *
 * @param options The options.
 * @returns The resolved options.
 * @throws {TypeError} For a malformed table, event, key or limit.
 */
export function resolveRealtime(options: RealtimeOptions): ResolvedRealtime {
  const entries = Object.entries(options?.tables ?? {});
  if (entries.length === 0) throw new TypeError("realtime(): `tables` names no table");
  return {
    tables: new Map(entries.map(([name, table]) => [name, resolveTable(name, table ?? {})])),
    revalidate: options.revalidate === true ||
      (typeof options.revalidate === "object" && options.revalidate !== null),
    revalidateOwner: revalidateOwner(options.revalidate),
    migrate: options.migrate !== false,
    maxSubscribers: positiveOption(options.maxSubscribers, 10_000, "realtime(): maxSubscribers"),
    maxSubscriptionsPerIdentity: positiveOption(
      options.maxSubscriptionsPerIdentity,
      64,
      "realtime(): maxSubscriptionsPerIdentity",
    ),
    queryTimeoutMs: positiveOption(options.queryTimeoutMs, 5_000, "realtime(): queryTimeoutMs"),
    maxTrackedKeys: positiveOption(options.maxTrackedKeys, 10_000, "realtime(): maxTrackedKeys"),
  };
}

/**
 * Declare realtime tables for `backend({ realtime })`. Validates the options at config time.
 *
 * ```ts
 * backend({
 *   postgres: {},
 *   realtime: realtime({ tables: { notes: { events: ["insert", "update", "delete"], key: "id" } } }),
 * });
 * ```
 *
 * @param options The tables, and `revalidate` / `migrate` / the limits.
 * @returns The same options, validated.
 * @throws {TypeError} For a malformed table, event, key or limit.
 */
export function realtime(options: RealtimeOptions): RealtimeOptions {
  resolveRealtime(options);
  return options;
}

/** The notify payload's longest text: pg_notify refuses 8000 bytes or more. */
const MAX_PAYLOAD = 7900;

/** `backend_realtime_0001`: the trigger function every realtime table calls. */
const NOTIFY_FUNCTION = `CREATE OR REPLACE FUNCTION denext_realtime_notify() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  key_column text := TG_ARGV[1];
  payload jsonb;
  body text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    payload := jsonb_build_object('op', 'delete', 'key', to_jsonb(OLD) ->> key_column);
  ELSIF TG_OP = 'INSERT' THEN
    payload := jsonb_build_object('op', 'insert', 'key', to_jsonb(NEW) ->> key_column);
  ELSE
    payload := jsonb_build_object('op', 'update', 'key', to_jsonb(NEW) ->> key_column);
    IF (to_jsonb(OLD) ->> key_column) IS DISTINCT FROM (to_jsonb(NEW) ->> key_column) THEN
      payload := payload || jsonb_build_object('old_key', to_jsonb(OLD) ->> key_column);
    END IF;
  END IF;
  payload := payload || jsonb_build_object('table', TG_ARGV[0],
    'ts', floor(extract(epoch FROM clock_timestamp()) * 1000));
  body := payload::text;
  IF octet_length(body) > ${MAX_PAYLOAD} THEN
    -- A key too long to send: tell subscribers to re-read rather than fail the write.
    body := jsonb_build_object('table', TG_ARGV[0], 'op', lower(TG_OP), 'overflow', true)::text;
  END IF;
  PERFORM pg_notify('${REALTIME_NOTIFY_CHANNEL}', body);
  RETURN NULL;
END $fn$;`;

/**
 * `backend_realtime_0002`: the trigger function again (`CREATE OR REPLACE`, so it replaces
 * `backend_realtime_0001`'s on a database that has it), spelling a `timestamptz` key in UTC.
 * `to_jsonb(row) ->> key` formats a `timestamptz` in the writing session's `TimeZone`, so a
 * writer and a reader with different settings spelled one instant differently and a change was
 * never matched to its re-read row. The key column's type comes from the catalog on each call,
 * so a column altered to or from `timestamptz` is spelled right at once; the re-read and seed
 * queries spell such a key the same way (`to_jsonb(k AT TIME ZONE 'UTC') #>> '{}'`).
 */
const NOTIFY_FUNCTION_UTC_KEYS =
  `CREATE OR REPLACE FUNCTION denext_realtime_notify() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  key_column text := TG_ARGV[1];
  in_utc boolean;
  old_key text;
  new_key text;
  payload jsonb;
  body text;
BEGIN
  SELECT a.atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype INTO in_utc
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = TG_RELID AND a.attname = key_column AND NOT a.attisdropped;
  IF TG_OP <> 'INSERT' THEN old_key := to_jsonb(OLD) ->> key_column; END IF;
  IF TG_OP <> 'DELETE' THEN new_key := to_jsonb(NEW) ->> key_column; END IF;
  IF in_utc THEN
    -- The JSON text carries its offset, so it parses back to the same instant in any TimeZone.
    old_key := to_jsonb(old_key::timestamptz AT TIME ZONE 'UTC') #>> '{}';
    new_key := to_jsonb(new_key::timestamptz AT TIME ZONE 'UTC') #>> '{}';
  END IF;
  IF TG_OP = 'DELETE' THEN
    payload := jsonb_build_object('op', 'delete', 'key', old_key);
  ELSIF TG_OP = 'INSERT' THEN
    payload := jsonb_build_object('op', 'insert', 'key', new_key);
  ELSE
    payload := jsonb_build_object('op', 'update', 'key', new_key);
    IF old_key IS DISTINCT FROM new_key THEN
      payload := payload || jsonb_build_object('old_key', old_key);
    END IF;
  END IF;
  payload := payload || jsonb_build_object('table', TG_ARGV[0],
    'ts', floor(extract(epoch FROM clock_timestamp()) * 1000));
  body := payload::text;
  IF octet_length(body) > ${MAX_PAYLOAD} THEN
    -- A key too long to send: tell subscribers to re-read rather than fail the write.
    body := jsonb_build_object('table', TG_ARGV[0], 'op', lower(TG_OP), 'overflow', true)::text;
  END IF;
  PERFORM pg_notify('${REALTIME_NOTIFY_CHANNEL}', body);
  RETURN NULL;
END $fn$;`;

/** The SQL that (re)creates one table's trigger. */
function tableTrigger(table: ResolvedTable): string {
  const on = table.events.map((event) => event.toUpperCase()).join(" OR ");
  return `DROP TRIGGER IF EXISTS denext_realtime ON ${table.qualified};
CREATE TRIGGER denext_realtime AFTER ${on} ON ${table.qualified}
  FOR EACH ROW EXECUTE FUNCTION denext_realtime_notify('${table.name}', '${table.key}');`;
}

/** FNV-1a, 32-bit, as 8 hex digits: names a table's migration after its SQL. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The realtime migrations, as `migratePostgres` takes them: `backend_realtime_0001` and
 * `backend_realtime_0002` (the trigger function, then its replacement) and one per table, named after the table and a hash of its trigger — so a
 * changed `events` or `key` installs a new migration that replaces the trigger. Removing a
 * table from the options leaves its trigger in place (`DROP TRIGGER denext_realtime ON t`).
 *
 * @param options The realtime options.
 * @returns The migrations, in order.
 * @throws {TypeError} For malformed options.
 */
export function realtimeMigrations(options: RealtimeOptions): Migration[] {
  const resolved = resolveRealtime(options);
  const tables = [...resolved.tables.values()].map((table) => {
    const sql = tableTrigger(table);
    return { name: `backend_realtime_t_${table.name}_${shortHash(sql)}`, sql };
  });
  return [
    { name: "backend_realtime_0001", sql: NOTIFY_FUNCTION },
    { name: "backend_realtime_0002", sql: NOTIFY_FUNCTION_UTC_KEYS },
    ...tables,
  ];
}

/**
 * The same setup as SQL, for a database administrator to run once when the app's database user
 * may not create triggers on its tables (then set `migrate: false`).
 *
 * @param options The realtime options.
 * @returns The SQL.
 */
export function realtimeSetupSql(options: RealtimeOptions): string {
  return [
    "-- @denext/backend realtime: the trigger function and one trigger per table.",
    ...realtimeMigrations(options).map((migration) => migration.sql),
    "",
  ].join("\n");
}
