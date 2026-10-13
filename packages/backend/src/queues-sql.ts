// Queues with pgmq's API, as plain SQL: no extension. The `pgmq` schema holds one table per
// queue (`pgmq.q_<name>`) and its archive (`pgmq.a_<name>`), a `pgmq.meta` row per queue, and
// pgmq's functions with pgmq 1.4's signatures — `create`, `send`, `send_batch`, `read` with a
// visibility timeout, `read_with_poll`, `pop`, `archive`, `delete`, `set_vt`, `metrics`,
// `metrics_all`, `purge_queue`, `drop_queue`, `list_queues` — so SQL written for Supabase Queues
// runs unchanged. `pgmq_public` carries Supabase's wrappers (`send`, `send_batch`, `read`, `pop`,
// `archive`, `delete`) for the REST API's `/rpc` (`supabase.schema("pgmq_public").rpc("send", …)`).
//
// Every function is SECURITY INVOKER, as in pgmq: a caller reaches a queue only through its own
// privileges on `pgmq.q_<name>` (and that table's row-level security policies). `anon` and
// `authenticated` get USAGE on both schemas and EXECUTE on the wrappers, and nothing on any queue
// table until the app grants it. A database that already has the pgmq extension keeps it: the
// migration then creates only `pgmq_public`.
//
// Queue names are validated in SQL (`pgmq.validate_queue_name`): lowercase letters, digits and
// `_`, at most 47 characters — every table name is then built with `format('%I', …)`.

import type { Migration } from "@denext/denext/server";

/** pgmq's own objects, created unless the pgmq extension is installed. */
const PGMQ_CORE = String.raw`
CREATE SCHEMA IF NOT EXISTS pgmq;

CREATE TABLE IF NOT EXISTS pgmq.meta (
  queue_name varchar UNIQUE NOT NULL,
  is_partitioned boolean NOT NULL DEFAULT false,
  is_unlogged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $types$
BEGIN
  IF to_regtype('pgmq.message_record') IS NULL THEN
    CREATE TYPE pgmq.message_record AS (
      msg_id bigint,
      read_ct integer,
      enqueued_at timestamptz,
      vt timestamptz,
      message jsonb
    );
  END IF;
  IF to_regtype('pgmq.queue_record') IS NULL THEN
    CREATE TYPE pgmq.queue_record AS (
      queue_name varchar,
      is_partitioned boolean,
      is_unlogged boolean,
      created_at timestamptz
    );
  END IF;
  IF to_regtype('pgmq.metrics_result') IS NULL THEN
    CREATE TYPE pgmq.metrics_result AS (
      queue_name text,
      queue_length bigint,
      newest_msg_age_sec integer,
      oldest_msg_age_sec integer,
      total_messages bigint,
      scrape_time timestamptz,
      queue_visible_length bigint
    );
  END IF;
END $types$;

CREATE OR REPLACE FUNCTION pgmq.validate_queue_name(queue_name text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  IF queue_name IS NULL OR queue_name !~ '^[a-z0-9_]{1,47}$' THEN
    RAISE EXCEPTION 'queue name % is invalid: use 1 to 47 lowercase letters, digits or _',
      quote_literal(coalesce(queue_name, 'NULL')) USING ERRCODE = '22023';
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq._q(queue_name text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  PERFORM pgmq.validate_queue_name(queue_name);
  RETURN format('pgmq.%I', 'q_' || queue_name);
END $fn$;

CREATE OR REPLACE FUNCTION pgmq._a(queue_name text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  PERFORM pgmq.validate_queue_name(queue_name);
  RETURN format('pgmq.%I', 'a_' || queue_name);
END $fn$;

CREATE OR REPLACE FUNCTION pgmq._create(queue_name text, unlogged boolean) RETURNS void
LANGUAGE plpgsql AS $fn$
#variable_conflict use_variable
DECLARE
  kind text := CASE WHEN unlogged THEN 'UNLOGGED ' ELSE '' END;
BEGIN
  EXECUTE format(
    'CREATE %sTABLE IF NOT EXISTS %s (
       msg_id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
       read_ct integer NOT NULL DEFAULT 0,
       enqueued_at timestamptz NOT NULL DEFAULT now(),
       vt timestamptz NOT NULL,
       message jsonb
     )', kind, pgmq._q(queue_name));
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %s (
       msg_id bigint PRIMARY KEY,
       read_ct integer NOT NULL DEFAULT 0,
       enqueued_at timestamptz NOT NULL DEFAULT now(),
       archived_at timestamptz NOT NULL DEFAULT now(),
       vt timestamptz NOT NULL,
       message jsonb
     )', pgmq._a(queue_name));
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (vt ASC)', 'q_' || queue_name || '_vt_idx',
    pgmq._q(queue_name));
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (archived_at)',
    'archived_at_idx_' || queue_name, pgmq._a(queue_name));
  INSERT INTO pgmq.meta (queue_name, is_partitioned, is_unlogged)
    VALUES (queue_name, false, unlogged) ON CONFLICT ON CONSTRAINT meta_queue_name_key DO NOTHING;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.create(queue_name text) RETURNS void
LANGUAGE sql AS $fn$ SELECT pgmq._create(queue_name, false) $fn$;

CREATE OR REPLACE FUNCTION pgmq.create_unlogged(queue_name text) RETURNS void
LANGUAGE sql AS $fn$ SELECT pgmq._create(queue_name, true) $fn$;

CREATE OR REPLACE FUNCTION pgmq.drop_queue(queue_name text) RETURNS boolean
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('DROP TABLE IF EXISTS %s', pgmq._q(queue_name));
  EXECUTE format('DROP TABLE IF EXISTS %s', pgmq._a(queue_name));
  DELETE FROM pgmq.meta WHERE meta.queue_name = drop_queue.queue_name;
  RETURN FOUND;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.list_queues() RETURNS SETOF pgmq.queue_record
LANGUAGE sql STABLE AS $fn$
  SELECT queue_name, is_partitioned, is_unlogged, created_at FROM pgmq.meta ORDER BY queue_name
$fn$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb, delay integer DEFAULT 0)
RETURNS SETOF bigint LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN QUERY EXECUTE format(
    'INSERT INTO %s (vt, message) VALUES (now() + make_interval(secs => $1), $2) RETURNING msg_id',
    pgmq._q(queue_name)) USING greatest(delay, 0), msg;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.send_batch(queue_name text, msgs jsonb[], delay integer DEFAULT 0)
RETURNS SETOF bigint LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN QUERY EXECUTE format(
    'INSERT INTO %s (vt, message)
       SELECT now() + make_interval(secs => $1), m FROM unnest($2) WITH ORDINALITY AS t(m, i)
       ORDER BY i RETURNING msg_id',
    pgmq._q(queue_name)) USING greatest(delay, 0), msgs;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.read(queue_name text, vt integer, qty integer)
RETURNS SETOF pgmq.message_record LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN QUERY EXECUTE format(
    'WITH cte AS (
       SELECT msg_id FROM %1$s WHERE vt <= clock_timestamp() ORDER BY msg_id ASC
       LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE %1$s m SET vt = clock_timestamp() + make_interval(secs => $2), read_ct = read_ct + 1
     FROM cte WHERE m.msg_id = cte.msg_id
     RETURNING m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message',
    pgmq._q(queue_name)) USING greatest(qty, 0), greatest(vt, 0);
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.read_with_poll(
  queue_name text, vt integer, qty integer,
  max_poll_seconds integer DEFAULT 5, poll_interval_ms integer DEFAULT 100
) RETURNS SETOF pgmq.message_record LANGUAGE plpgsql AS $fn$
DECLARE
  stop_at timestamptz := clock_timestamp() + make_interval(secs => least(greatest(max_poll_seconds, 0), 60));
  got bigint;
BEGIN
  LOOP
    RETURN QUERY SELECT * FROM pgmq.read(queue_name, vt, qty);
    GET DIAGNOSTICS got = ROW_COUNT;
    EXIT WHEN got > 0 OR clock_timestamp() >= stop_at;
    PERFORM pg_sleep(greatest(poll_interval_ms, 10) / 1000.0);
  END LOOP;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.pop(queue_name text)
RETURNS SETOF pgmq.message_record LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN QUERY EXECUTE format(
    'WITH cte AS (
       SELECT msg_id FROM %1$s WHERE vt <= clock_timestamp() ORDER BY msg_id ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     DELETE FROM %1$s m USING cte WHERE m.msg_id = cte.msg_id
     RETURNING m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message',
    pgmq._q(queue_name));
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.archive(queue_name text, msg_ids bigint[])
RETURNS SETOF bigint LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN QUERY EXECUTE format(
    'WITH archived AS (
       DELETE FROM %s WHERE msg_id = ANY($1) RETURNING msg_id, vt, read_ct, enqueued_at, message
     )
     INSERT INTO %s (msg_id, vt, read_ct, enqueued_at, message)
       SELECT msg_id, vt, read_ct, enqueued_at, message FROM archived
     RETURNING msg_id',
    pgmq._q(queue_name), pgmq._a(queue_name)) USING msg_ids;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.archive(queue_name text, msg_id bigint)
RETURNS boolean LANGUAGE sql AS $fn$
  SELECT EXISTS (SELECT 1 FROM pgmq.archive(queue_name, ARRAY[msg_id]))
$fn$;

CREATE OR REPLACE FUNCTION pgmq.delete(queue_name text, msg_ids bigint[])
RETURNS SETOF bigint LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN QUERY EXECUTE format('DELETE FROM %s WHERE msg_id = ANY($1) RETURNING msg_id',
    pgmq._q(queue_name)) USING msg_ids;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.delete(queue_name text, msg_id bigint)
RETURNS boolean LANGUAGE sql AS $fn$
  SELECT EXISTS (SELECT 1 FROM pgmq.delete(queue_name, ARRAY[msg_id]))
$fn$;

CREATE OR REPLACE FUNCTION pgmq.set_vt(queue_name text, msg_id bigint, vt_offset integer)
RETURNS SETOF pgmq.message_record LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN QUERY EXECUTE format(
    'UPDATE %s SET vt = clock_timestamp() + make_interval(secs => $2) WHERE msg_id = $1
     RETURNING msg_id, read_ct, enqueued_at, vt, message',
    pgmq._q(queue_name)) USING msg_id, vt_offset;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.purge_queue(queue_name text) RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE
  deleted bigint;
BEGIN
  EXECUTE format('DELETE FROM %s', pgmq._q(queue_name));
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.metrics(queue_name text) RETURNS pgmq.metrics_result
LANGUAGE plpgsql AS $fn$
DECLARE
  result pgmq.metrics_result;
BEGIN
  EXECUTE format(
    'SELECT $1::text,
       count(*)::bigint,
       extract(epoch FROM now() - max(enqueued_at))::integer,
       extract(epoch FROM now() - min(enqueued_at))::integer,
       coalesce((SELECT last_value FROM pg_sequences
                 WHERE schemaname = ''pgmq'' AND sequencename = %L), 0)::bigint,
       now(),
       count(*) FILTER (WHERE vt <= now())::bigint
     FROM %s',
    'q_' || queue_name || '_msg_id_seq', pgmq._q(queue_name))
  INTO result USING queue_name;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION pgmq.metrics_all() RETURNS SETOF pgmq.metrics_result
LANGUAGE plpgsql AS $fn$
DECLARE
  name text;
BEGIN
  FOR name IN SELECT queue_name FROM pgmq.meta ORDER BY queue_name LOOP
    RETURN NEXT pgmq.metrics(name);
  END LOOP;
END $fn$;
`;

/** Supabase's `pgmq_public` wrappers, verbatim in shape (SECURITY INVOKER, empty search path). */
const PGMQ_PUBLIC = String.raw`
CREATE SCHEMA IF NOT EXISTS pgmq_public;

CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)
RETURNS SETOF pgmq.message_record LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.pop(queue_name := queue_name);
END $fn$;

CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.send(queue_name := queue_name, msg := message, delay := sleep_seconds);
END $fn$;

CREATE OR REPLACE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
RETURNS SETOF bigint LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.send_batch(queue_name := queue_name, msgs := messages, delay := sleep_seconds);
END $fn$;

CREATE OR REPLACE FUNCTION pgmq_public.archive(queue_name text, message_id bigint)
RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RETURN pgmq.archive(queue_name := queue_name, msg_id := message_id);
END $fn$;

CREATE OR REPLACE FUNCTION pgmq_public.delete(queue_name text, message_id bigint)
RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RETURN pgmq.delete(queue_name := queue_name, msg_id := message_id);
END $fn$;

CREATE OR REPLACE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
RETURNS SETOF pgmq.message_record LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RETURN QUERY SELECT * FROM pgmq.read(queue_name := queue_name, vt := sleep_seconds, qty := n);
END $fn$;

DO $grants$
DECLARE
  grantee text;
BEGIN
  FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA pgmq TO %I', grantee);
      EXECUTE format('GRANT USAGE ON SCHEMA pgmq_public TO %I', grantee);
      EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO %I', grantee);
    END IF;
  END LOOP;
END $grants$;
`;

/**
 * The queues migration, `backend_queues_0001`: pgmq's schema and functions (skipped when the
 * pgmq extension is installed) and Supabase's `pgmq_public` wrappers.
 *
 * @returns The migrations, in order.
 */
export function queuesMigrations(): Migration[] {
  return [{
    name: "backend_queues_0001",
    sql: `DO $core$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgmq') THEN
    EXECUTE ${dollarQuote(PGMQ_CORE)};
  END IF;
END $core$;
${PGMQ_PUBLIC}`,
  }];
}

/** `text` as a dollar-quoted literal whose tag does not occur inside it. */
function dollarQuote(text: string): string {
  let tag = "pgmq";
  while (text.includes(`$${tag}$`)) tag += "_";
  return `$${tag}$${text}$${tag}$`;
}

/**
 * The same SQL for a database administrator to apply by hand (with `queues: { migrate: false }`).
 *
 * @returns The SQL.
 */
export function queuesSetupSql(): string {
  return queuesMigrations().map((m) => `-- ${m.name}\n${m.sql}\n`).join("\n");
}
