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

/** The Postgres NOTIFY channel broadcasts and presence changes travel on, between instances. */
export const REALTIME_BUS_CHANNEL = "denext_realtime_bus";

/** One table opted in to realtime. */
export interface RealtimeTableOptions {
  /** The changes to send (default all four: `["insert", "update", "delete", "truncate"]`). */
  events?: TableEvent[];
  /** The key column a change is identified by (default `"id"`). */
  key?: string;
  /** The table's schema (default: the connection's search path). */
  schema?: string;
  /**
   * What a change carries of the row as it was before an update or a delete (Supabase's
   * `old` record): `"key"` (the default) — the key column only, which is what Supabase sends for
   * a table under row-level security; `"full"` — the whole old row, carried in the
   * notification, so only when it fits (about 7.5 KB of JSON; a larger one arrives without it,
   * with `errors: ["Error 413: Payload Too Large"]`). The old row reaches only subscribers who
   * could see the row before the change.
   */
  old?: "key" | "full";
}

/** `backend({ realtime })`: realtime changes from Postgres tables. */
export interface RealtimeOptions {
  /**
   * The tables to send changes from, by name: `{ notes: { events: ["insert"], key: "id" } }`.
   * Optional when the {@linkcode publication} lists them.
   */
  tables?: Record<string, RealtimeTableOptions>;
  /**
   * Also send changes from the tables in this Postgres publication — Supabase's way to opt a
   * table in (`alter publication supabase_realtime add table notes`), so Supabase migrations work
   * unchanged. Default `"supabase_realtime"` (created, empty, if it does not exist); `false`
   * reads only {@linkcode tables}. A table there needs a one-column primary key; its old row is
   * the key, or the whole row when it has `REPLICA IDENTITY FULL` and no row-level security (as
   * Supabase sends it). Re-read every 10 seconds, so a table added or dropped while the app runs
   * follows.
   */
  publication?: string | false;
  /**
   * Where changes come from. `"notify"` (the default): a trigger per table sends the key with
   * `pg_notify`, which works everywhere but serializes committing transactions on the
   * notification queue. `"logical"`: logical decoding — a temporary `pgoutput` replication slot
   * per server instance, read over a reserved connection — no triggers, no NOTIFY, commit
   * timestamps from the WAL. It needs `wal_level = logical`, a connecting role with the
   * `REPLICATION` attribute and a client with `reserve()` (`Deno.SQL`, or postgres.js through
   * `fromPostgresJs`).
   */
  source?: "notify" | "logical";
  /** `source: "logical"`'s tuning. */
  logical?: RealtimeLogicalOptions;
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
  /**
   * Serve Supabase Realtime's protocol — `/realtime/v1/websocket` (Phoenix channels:
   * `postgres_changes`, broadcast, presence, private channels) and the REST broadcast
   * `/realtime/v1/api/broadcast` — so `@supabase/supabase-js`'s `supabase.channel(…)` works
   * against the app. On by default; `false` turns it off; an object sets its limits.
   */
  socket?: boolean | RealtimeSocketOptions;
}

/** `realtime({ logical })`: the logical-decoding source's tuning. */
export interface RealtimeLogicalOptions {
  /** How often the slot is read when it was empty, in milliseconds (default 50). */
  pollMs?: number;
  /** Changes read per round trip (default 10 000); a full batch is followed at once. */
  maxChanges?: number;
}

/** `realtime({ socket })`: the Supabase Realtime endpoint (`/realtime/v1/*`) and its limits. */
export interface RealtimeSocketOptions {
  /** Sockets held at once on one server instance (default 10 000). */
  maxConnections?: number;
  /**
   * Sockets from one client address (`clientIpForLimits()` — set `trustForwardedHeaders` behind
   * a proxy; default 100).
   */
  maxConnectionsPerAddress?: number;
  /** Channels one socket may join (default 100, as Supabase). */
  maxChannelsPerConnection?: number;
  /** Messages a socket may send per second, heartbeats included (default 100). */
  maxEventsPerSecond?: number;
  /** The largest broadcast payload, and tracked presence state, in bytes (default 256 KiB). */
  maxPayloadBytes?: number;
}

/** Resolved socket limits. */
export interface SocketLimits {
  /** See {@linkcode RealtimeSocketOptions}. */
  maxConnections: number;
  /** See {@linkcode RealtimeSocketOptions}. */
  maxConnectionsPerAddress: number;
  /** See {@linkcode RealtimeSocketOptions}. */
  maxChannelsPerConnection: number;
  /** See {@linkcode RealtimeSocketOptions}. */
  maxEventsPerSecond: number;
  /** See {@linkcode RealtimeSocketOptions}. */
  maxPayloadBytes: number;
}

/** The socket limits' defaults. */
export const DEFAULT_SOCKET_LIMITS: SocketLimits = {
  maxConnections: 10_000,
  maxConnectionsPerAddress: 100,
  maxChannelsPerConnection: 100,
  maxEventsPerSecond: 100,
  maxPayloadBytes: 256 * 1024,
};

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
  /**
   * The name it is configured (and subscribed) under: the config key, or — for a publication
   * table — the table's name in `public`, `schema.table` elsewhere.
   */
  name: string;
  /** The table's own name. */
  table: string;
  /** It came from the publication (not `realtime({ tables })`). */
  fromPublication?: true;
  /** The events sent. */
  events: TableEvent[];
  /** The key column. */
  key: string;
  /** The schema, if any. */
  schema?: string;
  /** `"schema"."table"` or `"table"`. */
  qualified: string;
  /** What a change carries of the old row. */
  old: "key" | "full";
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
  /** The Supabase Realtime endpoint's limits, or `null` when it is off. */
  socket: SocketLimits | null;
  /** The publication whose tables are read too, or `null`. */
  publication: string | null;
  /** Where changes come from. */
  source: "notify" | "logical";
  /** The logical source's tuning. */
  logical: Required<RealtimeLogicalOptions>;
}

const EVENTS: readonly TableEvent[] = ["insert", "update", "delete", "truncate"];

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
    throw new TypeError(
      `realtime(): table ${name}: events must list insert, update, delete or truncate`,
    );
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
  const old = options.old ?? "key";
  if (old !== "key" && old !== "full") {
    throw new TypeError(`realtime(): table ${name}: old must be "key" or "full"`);
  }
  return {
    name,
    table: name,
    events: EVENTS.filter((event) => events.includes(event)),
    key,
    ...(schema ? { schema } : {}),
    qualified: schema ? `"${schema}"."${name}"` : `"${name}"`,
    old,
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
  const publication = options?.publication === undefined
    ? "supabase_realtime"
    : options.publication === false
    ? null
    : identifier(options.publication, "publication");
  if (entries.length === 0 && !publication) {
    throw new TypeError("realtime(): `tables` names no table (and `publication` is off)");
  }
  const source = options.source ?? "notify";
  if (source !== "notify" && source !== "logical") {
    throw new TypeError(`realtime(): source must be "notify" or "logical"`);
  }
  return {
    publication,
    source,
    logical: {
      pollMs: positiveOption(options.logical?.pollMs, 50, "realtime(): logical.pollMs"),
      maxChanges: positiveOption(
        options.logical?.maxChanges,
        10_000,
        "realtime(): logical.maxChanges",
      ),
    },
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
    socket: resolveSocket(options.socket),
  };
}

/** `socket`, validated. */
function resolveSocket(socket: RealtimeOptions["socket"]): SocketLimits | null {
  if (socket === false) return null;
  if (socket === undefined || socket === true) return { ...DEFAULT_SOCKET_LIMITS };
  if (typeof socket !== "object" || socket === null) {
    throw new TypeError("realtime(): socket must be a boolean or an object of limits");
  }
  const limits = { ...DEFAULT_SOCKET_LIMITS };
  for (const name of Object.keys(DEFAULT_SOCKET_LIMITS) as Array<keyof SocketLimits>) {
    limits[name] = positiveOption(
      socket[name],
      DEFAULT_SOCKET_LIMITS[name],
      `realtime(): socket.${name}`,
    );
  }
  return limits;
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

/**
 * `backend_realtime_0003`: the row trigger function a third time — `0002`'s, plus the old row
 * for a table configured `old: "full"` (its third argument), dropped with `old_overflow` when it
 * does not fit the notification — and the statement-level TRUNCATE trigger function.
 */
const NOTIFY_FUNCTION_OLD_ROWS =
  `CREATE OR REPLACE FUNCTION denext_realtime_notify() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  key_column text := TG_ARGV[1];
  full_old boolean := TG_NARGS > 2 AND TG_ARGV[2] = 'full';
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
  IF full_old AND TG_OP <> 'INSERT' THEN
    body := (payload || jsonb_build_object('old', to_jsonb(OLD)))::text;
    IF octet_length(body) > ${MAX_PAYLOAD} THEN
      body := (payload || jsonb_build_object('old_overflow', true))::text;
    END IF;
  ELSE
    body := payload::text;
  END IF;
  IF octet_length(body) > ${MAX_PAYLOAD} THEN
    body := jsonb_build_object('table', TG_ARGV[0], 'op', lower(TG_OP), 'overflow', true)::text;
  END IF;
  PERFORM pg_notify('${REALTIME_NOTIFY_CHANNEL}', body);
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION denext_realtime_truncate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('${REALTIME_NOTIFY_CHANNEL}', jsonb_build_object('table', TG_ARGV[0],
    'op', 'truncate', 'ts', floor(extract(epoch FROM clock_timestamp()) * 1000))::text);
  RETURN NULL;
END $fn$;`;

/**
 * `backend_realtime_0004`: Supabase's `realtime` schema surface — `realtime.messages` (row-level
 * security on: its policies authorize private channels, read as the joining user with
 * `realtime.topic()` set), `realtime.topic()`, `realtime.send()` and
 * `realtime.broadcast_changes()`. `send` stores the message and NOTIFYs the instances (inline when
 * it fits, else by id); like Supabase's it runs as the caller (so the caller's insert policy
 * applies) and turns a failure into a warning, never failing the caller's transaction.
 */
const REALTIME_SCHEMA = `CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  topic text NOT NULL,
  extension text NOT NULL,
  payload jsonb,
  event text,
  private boolean DEFAULT false,
  updated_at timestamp without time zone NOT NULL DEFAULT now(),
  inserted_at timestamp without time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_inserted_at_idx ON realtime.messages (inserted_at);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated;
GRANT SELECT, INSERT ON realtime.messages TO anon, authenticated;

CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text
LANGUAGE sql STABLE AS $fn$ SELECT nullif(current_setting('realtime.topic', true), '')::text $fn$;

CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text,
  private boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  message_id uuid;
  body text;
BEGIN
  INSERT INTO realtime.messages (payload, event, topic, private, extension)
    VALUES ($1, $2, $3, $4, 'broadcast') RETURNING id INTO message_id;
  body := jsonb_build_object('k', 'b', 't', $3, 'e', $2, 'p', $1, 'pr', $4)::text;
  IF octet_length(body) > ${MAX_PAYLOAD} THEN
    body := jsonb_build_object('k', 'm', 'id', message_id)::text;
  END IF;
  PERFORM pg_notify('${REALTIME_BUS_CHANNEL}', body);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ErrorSendingBroadcastMessage: %', SQLERRM;
END $fn$;

CREATE OR REPLACE FUNCTION realtime.broadcast_changes(topic_name text, event_name text,
  operation text, table_name text, table_schema text, new record, old record,
  level text DEFAULT 'ROW') RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  IF $8 = 'STATEMENT' THEN
    RAISE EXCEPTION 'function can only be triggered for each row, not for each statement';
  END IF;
  IF $3 IN ('INSERT', 'UPDATE', 'DELETE') THEN
    PERFORM realtime.send(jsonb_build_object('old_record', to_jsonb($7), 'record', to_jsonb($6),
      'operation', $3, 'table', $4, 'schema', $5), $2, $1);
  ELSE
    RAISE EXCEPTION 'Unexpected operation type: %', $3;
  END IF;
END $fn$;`;

/**
 * `backend_realtime_0006`: `realtime.send()` again, now carrying the stored message's id inline
 * (what a subscriber sees as `meta.id`, and what broadcast replay reads back).
 */
const SEND_WITH_ID =
  `CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text,
  private boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  message_id uuid;
  body text;
BEGIN
  INSERT INTO realtime.messages (payload, event, topic, private, extension)
    VALUES ($1, $2, $3, $4, 'broadcast') RETURNING id INTO message_id;
  body := jsonb_build_object('k', 'b', 't', $3, 'e', $2, 'p', $1, 'pr', $4, 'id', message_id)::text;
  IF octet_length(body) > ${MAX_PAYLOAD} THEN
    body := jsonb_build_object('k', 'm', 'id', message_id)::text;
  END IF;
  PERFORM pg_notify('${REALTIME_BUS_CHANNEL}', body);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ErrorSendingBroadcastMessage: %', SQLERRM;
END $fn$;
CREATE INDEX IF NOT EXISTS messages_topic_idx ON realtime.messages (topic, inserted_at);`;

/**
 * `backend_realtime_0005`: presence shared by every instance on the database — one row per
 * tracked presence, owned by the instance that holds its socket, and a heartbeat per instance
 * so the presences of an instance that died are swept (and their leaves broadcast). Only the
 * connecting role reads or writes them.
 */
const PRESENCE_TABLES = `CREATE TABLE IF NOT EXISTS realtime.denext_presences (
  ref text PRIMARY KEY,
  topic text NOT NULL,
  private boolean NOT NULL,
  key text NOT NULL,
  meta jsonb NOT NULL,
  instance uuid NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS denext_presences_topic_idx ON realtime.denext_presences (topic, private);
CREATE INDEX IF NOT EXISTS denext_presences_instance_idx ON realtime.denext_presences (instance);
CREATE TABLE IF NOT EXISTS realtime.denext_instances (
  id uuid PRIMARY KEY,
  seen_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON realtime.denext_presences, realtime.denext_instances FROM PUBLIC;`;

/**
 * `backend_realtime_pub_<name>`: the publication, created empty when it does not exist, so a
 * Supabase migration's `alter publication supabase_realtime add table …` finds it. Without the
 * privilege to create one it warns and goes on (an administrator creates it).
 */
function publicationSql(name: string): string {
  return `DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = '${name}') THEN
    CREATE PUBLICATION ${name};
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'realtime: cannot create publication ${name}: %', SQLERRM;
END $do$`;
}

/** A publication table as the catalog describes it (see `PUBLICATION_TABLES_SQL`). */
export interface PublicationRow {
  schema: string;
  table: string;
  /** The primary key's columns, comma-separated (`null`: none). */
  pk: string | null;
  /** `relreplident`: `d` default, `f` full, `i` index, `n` nothing. */
  ident: string;
  /** Row-level security is enabled. */
  rls: boolean;
}

/** The tables of the publication `$1`, with their key, replica identity and RLS flag. */
export const PUBLICATION_TABLES_SQL =
  "select n.nspname::text as schema, c.relname::text as table, " +
  "(select string_agg(a.attname::text, ',' order by a.attnum) from pg_index i join pg_attribute a " +
  "on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = c.oid and " +
  "i.indisprimary) as pk, c.relreplident::text as ident, c.relrowsecurity as rls " +
  "from pg_publication_tables pt join pg_namespace n on n.nspname = pt.schemaname " +
  "join pg_class c on c.relnamespace = n.oid and c.relname = pt.tablename where pt.pubname = $1";

/**
 * A publication table as a realtime table — `null` (with the reason) when it cannot be one:
 * a name that is not a plain identifier, or a primary key that is not exactly one column.
 *
 * @param row The catalog row.
 * @returns The table, or why not.
 */
export function publicationTable(row: PublicationRow): ResolvedTable | string {
  const where = `${row.schema}.${row.table}`;
  if (!IDENTIFIER.test(row.schema) || !IDENTIFIER.test(row.table)) {
    return `${where}: only plain (unquoted) identifiers are supported`;
  }
  const pk = (row.pk ?? "").split(",").filter(Boolean);
  if (pk.length !== 1 || !IDENTIFIER.test(pk[0])) {
    return `${where}: needs a one-column primary key (has ${pk.length || "none"})`;
  }
  return {
    name: row.schema === "public" ? row.table : `${row.schema}.${row.table}`,
    table: row.table,
    fromPublication: true,
    events: [...EVENTS],
    key: pk[0],
    schema: row.schema,
    qualified: `"${row.schema}"."${row.table}"`,
    old: row.ident === "f" && !row.rls ? "full" : "key",
  };
}

/**
 * The trigger arguments of a table (what `pg_trigger.tgargs` holds, NUL-separated).
 *
 * @param table The table.
 * @returns The arguments.
 */
export function triggerArgs(table: ResolvedTable): string[] {
  return table.old === "full" ? [table.name, table.key, "full"] : [table.name, table.key];
}

/** The SQL that drops one table's triggers. */
export function dropTriggersSql(table: ResolvedTable): string {
  return `DROP TRIGGER IF EXISTS denext_realtime ON ${table.qualified};\n` +
    `DROP TRIGGER IF EXISTS denext_realtime_truncate ON ${table.qualified};`;
}

/** The SQL that (re)creates one table's triggers: one per row, one per TRUNCATE statement. */
export function tableTrigger(table: ResolvedTable): string {
  const rowEvents = table.events.filter((event) => event !== "truncate");
  const lines = [
    `DROP TRIGGER IF EXISTS denext_realtime ON ${table.qualified};`,
    `DROP TRIGGER IF EXISTS denext_realtime_truncate ON ${table.qualified};`,
  ];
  if (rowEvents.length > 0) {
    const on = rowEvents.map((event) => event.toUpperCase()).join(" OR ");
    const args = triggerArgs(table).map((arg) => `'${arg}'`).join(", ");
    lines.push(
      `CREATE TRIGGER denext_realtime AFTER ${on} ON ${table.qualified}`,
      `  FOR EACH ROW EXECUTE FUNCTION denext_realtime_notify(${args});`,
    );
  }
  if (table.events.includes("truncate")) {
    lines.push(
      `CREATE TRIGGER denext_realtime_truncate AFTER TRUNCATE ON ${table.qualified}`,
      `  FOR EACH STATEMENT EXECUTE FUNCTION denext_realtime_truncate('${table.name}');`,
    );
  }
  return lines.join("\n");
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
 * The realtime migrations, as `migratePostgres` takes them: `backend_realtime_0001` to `0003`
 * (the trigger function, replaced twice, and the TRUNCATE trigger function), `0004` (the
 * `realtime` schema: `messages`, `topic()`, `send()`, `broadcast_changes()`), `0005` (the shared
 * presence tables), and one per table, named after the table and a hash of its triggers — so a
 * changed `events`, `key` or `old` installs a new migration that replaces them. Removing a table
 * from the options leaves its triggers in place (`DROP TRIGGER denext_realtime ON t`).
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
  return [...realtimeSchemaMigrations(options), ...tables];
}

/**
 * The realtime migrations that need none of the app's tables: `backend_realtime_0001` to `0006`
 * (the trigger functions, the `realtime` schema, the presence tables) and the publication,
 * created empty. `denext migration up` applies them before the app's own migrations, which may
 * refer to them (`alter publication supabase_realtime add table …`, a policy on
 * `realtime.messages`); the per-table triggers follow at the server's start, once the app's
 * tables exist. Both record them in `backend_migrations` under the same names.
 *
 * @param options The realtime options.
 * @returns The migrations, in order.
 * @throws {TypeError} For malformed options.
 */
export function realtimeSchemaMigrations(options: RealtimeOptions): Migration[] {
  const { publication } = resolveRealtime(options);
  return [
    { name: "backend_realtime_0001", sql: NOTIFY_FUNCTION },
    { name: "backend_realtime_0002", sql: NOTIFY_FUNCTION_UTC_KEYS },
    { name: "backend_realtime_0003", sql: NOTIFY_FUNCTION_OLD_ROWS },
    { name: "backend_realtime_0004", sql: REALTIME_SCHEMA },
    { name: "backend_realtime_0005", sql: PRESENCE_TABLES },
    { name: "backend_realtime_0006", sql: SEND_WITH_ID },
    ...(publication
      ? [{ name: `backend_realtime_pub_${publication}`, sql: publicationSql(publication) }]
      : []),
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
    "-- @denext/backend realtime: the trigger functions, the realtime schema, one trigger per table.",
    ...realtimeMigrations(options).map((migration) => migration.sql),
    "",
  ].join("\n");
}
