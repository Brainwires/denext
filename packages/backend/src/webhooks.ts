// Database webhooks: Supabase's `supabase_functions.http_request` trigger, without pg_net. The
// trigger records each change (`{ type, table, schema, record, old_record }`, Supabase's payload)
// in `supabase_functions.webhook_events` and NOTIFYs; the app delivers it — an HTTP request to
// the hook's URL, signed with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`,
// `webhook-signature`), retried with exponential backoff until `maxAttempts`.
//
// Where a request may go is decided in the app's config, never by the database row: the
// trigger's first argument names a configured hook (`hooks: { "order-created": { url } }`) or is
// a URL that `allowUrls` admits; anything else is recorded as failed and never fetched. Redirects
// are not followed.
//
// Delivery is at least once: an event is leased (its next attempt pushed out) when a deliverer
// takes it, so several app instances share the work without sending one event twice at once,
// and a crash mid-delivery is retried after the lease. Receivers dedupe on `webhook-id`.
//
// Settled events are kept for `retention` (delivered: 7 days, failed: 30, from when the change
// happened), then deleted by the background deliverer (once an hour) or `purgeWebhookEvents()`
// (`webhookCleanupJob()` under `delivery: "manual"`), in batches.

import {
  bootMigrate,
  defineJob,
  type Job,
  type Migration,
  type SqlClient,
} from "@denext/denext/server";
import { db } from "./postgres.ts";
import { positiveOption } from "./options.ts";

/** One configured webhook target. */
export interface WebhookTarget {
  /** Where the event is sent. */
  url: string;
  /** The signing secret (`whsec_<base64>` or any string); default: `webhooks.secret`. */
  secret?: string;
  /** Headers added to every request (the trigger's own come first; signing headers win). */
  headers?: Record<string, string>;
  /** The request timeout in milliseconds (default: the trigger's, else 5000). */
  timeoutMs?: number;
}

/** `backend({ webhooks })`. */
export interface WebhooksOptions {
  /** Targets a trigger can name: `supabase_functions.http_request('order-created')`. */
  hooks?: Record<string, WebhookTarget>;
  /**
   * URLs a trigger may name directly (Supabase's `http_request('https://…')`): each entry is a
   * URL prefix (`"https://hooks.example.com/"`). Default: none — a URL in a trigger is refused.
   */
  allowUrls?: string[];
  /** The default signing secret (default `DENEXT_WEBHOOK_SECRET`). */
  secret?: string;
  /** Attempts before an event is marked failed (default 8). */
  maxAttempts?: number;
  /** The first retry's delay in ms, doubled per attempt (default 10 000). */
  backoffMs?: number;
  /** The longest retry delay in ms (default 3 600 000). */
  maxBackoffMs?: number;
  /** How often the deliverer looks for due events, in ms (default 5000; NOTIFY wakes it sooner). */
  pollIntervalMs?: number;
  /**
   * `"auto"` (default): `denext dev` / `denext start` deliver in the background. `"manual"`: only
   * `deliverWebhooks()` does (from a job, say).
   */
  delivery?: "auto" | "manual";
  /**
   * How long settled events are kept, in milliseconds from when the change happened: `delivered`
   * ones (default 7 days) and `failed` ones — given up on after `maxAttempts`, or never allowed
   * to go anywhere — (default 30 days). Older ones are deleted by the background deliverer (once
   * an hour) and by `purgeWebhookEvents()` / `webhookCleanupJob()`. `false` keeps every event.
   */
  retention?: false | { deliveredMs?: number; failedMs?: number };
  /** Apply the `backend_webhooks_*` migrations on first use (default `true`). */
  migrate?: boolean;
  /** The `fetch` deliveries use (tests). */
  fetch?: typeof fetch;
}

/** Validated options. */
export interface ResolvedWebhooks {
  hooks: Record<string, WebhookTarget>;
  allowUrls: string[];
  secret: string | undefined;
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
  pollIntervalMs: number;
  delivery: "auto" | "manual";
  retention: { deliveredMs: number; failedMs: number } | null;
  migrate: boolean;
  fetch: typeof fetch;
}

/** The default retention of a delivered event (7 days) and of a failed one (30 days). */
const DELIVERED_MS = 7 * 86_400_000;
const FAILED_MS = 30 * 86_400_000;

/** `retention`, validated. */
function resolveRetention(o: WebhooksOptions["retention"]): ResolvedWebhooks["retention"] {
  if (o === false) return null;
  if (o !== undefined && (typeof o !== "object" || o === null)) {
    throw new TypeError("backend(): webhooks.retention must be false or { deliveredMs, failedMs }");
  }
  return {
    deliveredMs: positiveOption(
      o?.deliveredMs,
      DELIVERED_MS,
      "backend(): webhooks.retention.deliveredMs",
    ),
    failedMs: positiveOption(o?.failedMs, FAILED_MS, "backend(): webhooks.retention.failedMs"),
  };
}

/** The environment variable the default secret is read from. */
const WEBHOOK_SECRET_ENV = "DENEXT_WEBHOOK_SECRET";

/** The NOTIFY channel the trigger sends on. */
export const WEBHOOK_CHANNEL = "denext_webhooks";

function checkUrl(url: unknown, where: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new TypeError(`backend(): ${where} is not a URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(`backend(): ${where} must be an http(s) URL`);
  }
  return parsed.href;
}

/**
 * Validate `backend({ webhooks })` and apply the defaults.
 *
 * @param o The options.
 * @param env Reads an environment variable.
 * @returns The resolved options.
 * @throws {TypeError} For a bad URL, hook name or limit.
 */
export function resolveWebhooks(
  o: WebhooksOptions,
  env: (name: string) => string | undefined = () => undefined,
): ResolvedWebhooks {
  const hooks: Record<string, WebhookTarget> = {};
  for (const [name, target] of Object.entries(o.hooks ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) {
      throw new TypeError(`backend(): webhooks.hooks: ${JSON.stringify(name)} is not a hook name`);
    }
    hooks[name] = { ...target, url: checkUrl(target?.url, `webhooks.hooks.${name}.url`) };
  }
  const delivery = o.delivery ?? "auto";
  if (delivery !== "auto" && delivery !== "manual") {
    throw new TypeError(`backend(): webhooks.delivery must be "auto" or "manual"`);
  }
  return {
    hooks,
    allowUrls: (o.allowUrls ?? []).map((u, i) => checkUrl(u, `webhooks.allowUrls[${i}]`)),
    secret: o.secret ?? env(WEBHOOK_SECRET_ENV),
    maxAttempts: positiveOption(o.maxAttempts, 8, "backend(): webhooks.maxAttempts"),
    backoffMs: positiveOption(o.backoffMs, 10_000, "backend(): webhooks.backoffMs"),
    maxBackoffMs: positiveOption(o.maxBackoffMs, 3_600_000, "backend(): webhooks.maxBackoffMs"),
    pollIntervalMs: positiveOption(o.pollIntervalMs, 5000, "backend(): webhooks.pollIntervalMs"),
    delivery,
    retention: resolveRetention(o.retention),
    migrate: o.migrate !== false,
    fetch: o.fetch ?? ((input, init) => fetch(input, init)),
  };
}

// ── SQL ──────────────────────────────────────────────────────────────────────

/**
 * The webhooks migration, `backend_webhooks_0001`: the event table and the
 * `supabase_functions.http_request` trigger function (SECURITY DEFINER, so any role whose write
 * fires the trigger can record the event; nobody else can read the table).
 *
 * @returns The migrations.
 */
export function webhooksMigrations(): Migration[] {
  return [{
    name: "backend_webhooks_0001",
    sql: String.raw`CREATE SCHEMA IF NOT EXISTS supabase_functions;
CREATE TABLE IF NOT EXISTS supabase_functions.webhook_events (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  hook text NOT NULL,
  method text NOT NULL DEFAULT 'POST',
  headers jsonb NOT NULL DEFAULT '{}',
  params jsonb NOT NULL DEFAULT '{}',
  timeout_ms integer,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS webhook_events_due_idx
  ON supabase_functions.webhook_events (next_attempt_at) WHERE status = 'pending';
ALTER TABLE supabase_functions.webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON supabase_functions.webhook_events FROM PUBLIC;

CREATE OR REPLACE FUNCTION supabase_functions.http_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  payload jsonb;
BEGIN
  IF TG_NARGS < 1 OR coalesce(TG_ARGV[0], '') = '' THEN
    RAISE EXCEPTION 'supabase_functions.http_request: the first argument names the hook or URL';
  END IF;
  payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', CASE WHEN TG_LEVEL = 'ROW' AND TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_LEVEL = 'ROW' AND TG_OP <> 'INSERT' THEN to_jsonb(OLD) END
  );
  INSERT INTO supabase_functions.webhook_events (hook, method, headers, params, timeout_ms, payload)
  VALUES (
    TG_ARGV[0],
    upper(coalesce(nullif(TG_ARGV[1], ''), 'POST')),
    coalesce(nullif(TG_ARGV[2], '')::jsonb, '{}'),
    coalesce(nullif(TG_ARGV[3], '')::jsonb, '{}'),
    nullif(TG_ARGV[4], '')::integer,
    payload
  );
  PERFORM pg_notify('${WEBHOOK_CHANNEL}', '');
  IF TG_LEVEL = 'ROW' THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION supabase_functions.http_request() FROM PUBLIC;`,
  }, {
    // The retention cleanup's scan: settled events by age.
    name: "backend_webhooks_0002",
    sql: `CREATE INDEX IF NOT EXISTS webhook_events_settled_idx
  ON supabase_functions.webhook_events (created_at) WHERE status <> 'pending';`,
  }];
}

// ── Signing ──────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** A Standard Webhooks secret's key bytes: `whsec_<base64>` decoded, else the UTF-8 text. */
function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  if (secret.startsWith("whsec_")) {
    try {
      return Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0));
    } catch {
      // Not base64 after all: use it as text.
    }
  }
  return encoder.encode(secret);
}

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
}

/**
 * The Standard Webhooks headers for one delivery: `webhook-id`, `webhook-timestamp` and
 * `webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`.
 *
 * @param secret The signing secret.
 * @param id The event id.
 * @param timestamp Unix seconds.
 * @param body The request body.
 * @returns The headers.
 */
export async function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Promise<Record<string, string>> {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${await hmac(secret, `${id}.${timestamp}.${body}`)}`,
  };
}

/**
 * Verify a Standard Webhooks request (for the receiving end — a route handler or an Edge
 * Function): the signature over its id, timestamp and body, and a timestamp within `toleranceSec`
 * of now. Compares in constant time.
 *
 * @param request The request (its body is read from a clone).
 * @param secret The signing secret.
 * @param toleranceSec The largest clock difference accepted (default 300).
 * @returns The parsed JSON body when it verifies, else `null`.
 */
export async function verifyWebhook<T = unknown>(
  request: Request,
  secret: string,
  toleranceSec = 300,
): Promise<T | null> {
  const id = request.headers.get("webhook-id");
  const timestamp = Number(request.headers.get("webhook-timestamp"));
  const signatures = request.headers.get("webhook-signature");
  if (!id || !signatures || !Number.isInteger(timestamp)) return null;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return null;
  const body = await request.clone().text();
  const expected = `v1,${await hmac(secret, `${id}.${timestamp}.${body}`)}`;
  const match = signatures.split(" ").some((candidate) => constantTimeEqual(candidate, expected));
  if (!match) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/** One event row, as the deliverer leases it. */
interface EventRow {
  id: string;
  hook: string;
  method: string;
  headers: unknown;
  params: unknown;
  timeout_ms: number | null;
  payload: unknown;
  attempts: number;
}

/** Where an event goes, resolved from the config; `null` when it may not go anywhere. */
export function targetFor(
  config: ResolvedWebhooks,
  hook: string,
): (WebhookTarget & { secret?: string }) | null {
  const named = config.hooks[hook];
  if (named) return { ...named, secret: named.secret ?? config.secret };
  let url: URL;
  try {
    url = new URL(hook);
  } catch {
    return null;
  }
  const href = url.href;
  if (!config.allowUrls.some((prefix) => href.startsWith(prefix))) return null;
  return { url: href, secret: config.secret };
}

function objectOf(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

/** The retry delay after `attempts` failed attempts. */
export function backoffDelay(config: ResolvedWebhooks, attempts: number): number {
  return Math.min(config.backoffMs * 2 ** Math.max(0, attempts - 1), config.maxBackoffMs);
}

/** The outcome of one delivery attempt. */
interface Outcome {
  ok: boolean;
  status: number | null;
  error: string | null;
  /** Never retry (no allowed target). */
  final?: boolean;
}

/** The refusal for an event whose target is not configured (never fetched, never retried). */
function notConfigured(hook: string): Outcome {
  return {
    ok: false,
    status: null,
    error: `webhook target ${JSON.stringify(hook.slice(0, 200))} is not configured ` +
      "(name it in webhooks.hooks, or admit the URL with webhooks.allowUrls)",
    final: true,
  };
}

/** Whether a method sends no body. */
function bodiless(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/** The request headers: the trigger's, then the hook's, then content type and signing. */
async function headersFor(
  target: WebhookTarget & { secret?: string },
  event: EventRow,
  body: string,
): Promise<Headers> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(objectOf(event.headers))) headers.set(k, String(v));
  for (const [k, v] of Object.entries(target.headers ?? {})) headers.set(k, v);
  if (!bodiless(event.method) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const id = `evt_${event.id}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signed: Record<string, string> = target.secret
    ? await signWebhook(target.secret, id, timestamp, body)
    : { "webhook-id": id, "webhook-timestamp": String(timestamp) };
  for (const [k, v] of Object.entries(signed)) headers.set(k, v);
  return headers;
}

/** Make the request; any 2xx is a delivery, anything else (a redirect too) a failure. */
async function attempt(
  config: ResolvedWebhooks,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Outcome> {
  try {
    const response = await config.fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, error: ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: String((error as Error)?.message ?? error).slice(0, 500),
    };
  }
}

/** Send one event. */
async function send(config: ResolvedWebhooks, event: EventRow): Promise<Outcome> {
  const target = targetFor(config, event.hook);
  if (!target) return notConfigured(event.hook);
  const payload = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
  const body = bodiless(event.method) ? "" : payload;
  const url = new URL(target.url);
  for (const [k, v] of Object.entries(objectOf(event.params))) url.searchParams.set(k, String(v));
  const headers = await headersFor(target, event, body);
  const init = { method: event.method, headers, body: body === "" ? undefined : body };
  return await attempt(config, url, init, target.timeoutMs ?? event.timeout_ms ?? 5000);
}

/** How long a leased event is hidden from other deliverers (longer than any request). */
const LEASE_SECONDS = 300;

/**
 * Lease up to `limit` due events: their next attempt moves past the lease and their attempt
 * count goes up, in one statement, so concurrent deliverers never take the same event.
 */
async function lease(sql: SqlClient, limit: number): Promise<EventRow[]> {
  const rows = await sql.unsafe<EventRow>(
    `WITH due AS (
       SELECT id FROM supabase_functions.webhook_events
       WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE supabase_functions.webhook_events e
     SET attempts = e.attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
     FROM due WHERE e.id = due.id
     RETURNING e.id::text AS id, e.hook, e.method, e.headers, e.params, e.timeout_ms, e.payload,
       e.attempts`,
    [limit, LEASE_SECONDS],
  );
  return [...rows];
}

async function record(
  sql: SqlClient,
  config: ResolvedWebhooks,
  event: EventRow,
  outcome: Outcome,
): Promise<void> {
  if (outcome.ok) {
    await sql.unsafe(
      "UPDATE supabase_functions.webhook_events SET status = 'delivered', delivered_at = now(), " +
        "last_status = $2, last_error = NULL WHERE id = $1::bigint",
      [event.id, outcome.status],
    );
    return;
  }
  const failed = outcome.final || event.attempts >= config.maxAttempts;
  await sql.unsafe(
    "UPDATE supabase_functions.webhook_events SET status = $2, last_status = $3, last_error = $4, " +
      "next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1::bigint",
    [
      event.id,
      failed ? "failed" : "pending",
      outcome.status,
      outcome.error,
      backoffDelay(config, event.attempts) / 1000,
    ],
  );
}

/** What a delivery pass did. */
export interface DeliveryResult {
  /** Events delivered (a 2xx answer). */
  delivered: number;
  /** Events that failed this time and will be retried. */
  retrying: number;
  /** Events given up on (`maxAttempts`, or a target that is not configured). */
  failed: number;
}

const SLOT = Symbol.for("denext.backend.webhooks");
type Holder = { [SLOT]?: ResolvedWebhooks };

/**
 * Install the webhooks config (plugin setup), or clear it with `undefined` (tests).
 *
 * @param config The resolved options.
 */
export function installWebhooks(config: ResolvedWebhooks | undefined): void {
  (globalThis as Holder)[SLOT] = config;
}

function installed(): ResolvedWebhooks {
  const config = (globalThis as Holder)[SLOT];
  if (!config) {
    throw new Error(
      "webhooks: not configured — add backend({ postgres: {}, webhooks: { hooks } }) to denext.config.ts",
    );
  }
  return config;
}

const migrated = new WeakMap<SqlClient, Promise<void>>();

/** Apply the webhooks migration once on `sql`. */
export function ensureWebhooksMigrated(sql: SqlClient): Promise<void> {
  let pending = migrated.get(sql);
  if (!pending) {
    pending = bootMigrate(sql, {
      migrations: webhooksMigrations(),
      table: "backend_migrations",
      feature: "backend({ webhooks })",
    });
    pending.catch(() => migrated.delete(sql));
    migrated.set(sql, pending);
  }
  return pending;
}

/**
 * Deliver the due webhook events now: up to `limit` per pass, passes repeated while full. With
 * `delivery: "manual"`, call this from a job; under `"auto"` the server already does.
 *
 * @param limit Events per pass (default 50).
 * @returns The counts.
 */
export async function deliverWebhooks(limit = 50): Promise<DeliveryResult> {
  const config = installed();
  const sql = db.service();
  if (config.migrate) await ensureWebhooksMigrated(sql);
  const result: DeliveryResult = { delivered: 0, retrying: 0, failed: 0 };
  for (let pass = 0; pass < 20; pass++) {
    const events = await lease(sql, limit);
    await Promise.all(events.map(async (event) => {
      const outcome = await send(config, event);
      await record(sql, config, event, outcome);
      if (outcome.ok) result.delivered++;
      else if (outcome.final || event.attempts >= config.maxAttempts) result.failed++;
      else result.retrying++;
    }));
    if (events.length < limit) break;
  }
  return result;
}

/** Events one cleanup statement deletes at most. */
const PURGE_BATCH = 1000;

/** How often the background deliverer runs the retention cleanup. */
const CLEANUP_EVERY_MS = 3_600_000;

/**
 * Delete the settled events older than `retention` on `sql`, in batches; the number deleted.
 *
 * @param sql The client.
 * @param retention The resolved retention.
 * @returns How many events were deleted.
 */
async function purge(
  sql: SqlClient,
  retention: NonNullable<ResolvedWebhooks["retention"]>,
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < 100; batch++) {
    const rows = await sql.unsafe(
      `WITH doomed AS (
         SELECT id FROM supabase_functions.webhook_events
         WHERE (status = 'delivered' AND created_at < now() - make_interval(secs => $1))
            OR (status = 'failed' AND created_at < now() - make_interval(secs => $2))
         ORDER BY created_at LIMIT $3
       )
       DELETE FROM supabase_functions.webhook_events e USING doomed WHERE e.id = doomed.id
       RETURNING e.id`,
      [retention.deliveredMs / 1000, retention.failedMs / 1000, PURGE_BATCH],
    );
    deleted += rows.length;
    if (rows.length < PURGE_BATCH) break;
  }
  return deleted;
}

/**
 * Delete the settled webhook events older than `webhooks.retention` (delivered: 7 days, failed:
 * 30 by default) now. The background deliverer already does once an hour; under
 * `delivery: "manual"` schedule {@linkcode webhookCleanupJob} instead.
 *
 * @returns How many events were deleted (none with `retention: false`).
 */
export async function purgeWebhookEvents(): Promise<{ deleted: number }> {
  const config = installed();
  if (!config.retention) return { deleted: 0 };
  const sql = db.service();
  if (config.migrate) await ensureWebhooksMigrated(sql);
  return { deleted: await purge(sql, config.retention) };
}

/**
 * A job that runs {@linkcode purgeWebhookEvents}: put it in `jobs/<name>.ts` with a `schedule`
 * when deliveries are `"manual"` (the background deliverer cleans up on its own otherwise).
 *
 * ```ts
 * // jobs/webhook-cleanup.ts
 * import { webhookCleanupJob } from "@denext/backend/server";
 * export default webhookCleanupJob({ schedule: "17 * * * *" });
 * ```
 *
 * @param o A cron `schedule` and a `description`.
 * @returns The job.
 */
export function webhookCleanupJob(
  o: { schedule?: string | string[]; description?: string } = {},
): Job<{ deleted: number }> {
  return defineJob({
    description: o.description ?? "delete settled webhook events past their retention",
    schedule: o.schedule,
    handler: () => purgeWebhookEvents(),
  });
}

/** One event, as {@linkcode webhookEvents} lists it. */
export interface WebhookEvent {
  /** The event's id (`webhook-id` is `evt_<id>`). */
  id: number;
  /** The hook name or URL the trigger named. */
  hook: string;
  /** Where it stands. */
  status: "pending" | "delivered" | "failed";
  /** Attempts so far. */
  attempts: number;
  /** The last answer's HTTP status. */
  lastStatus: number | null;
  /** Why the last attempt failed. */
  lastError: string | null;
  /** `{ type, table, schema, record, old_record }`. */
  payload: unknown;
  /** When the change happened. */
  createdAt: Date;
  /** When it was delivered. */
  deliveredAt: Date | null;
}

/**
 * The most recent webhook events, newest first (for an admin page or a test).
 *
 * @param o `status` filter and `limit` (default 50).
 * @returns The events.
 */
export async function webhookEvents(
  o: { status?: WebhookEvent["status"]; limit?: number } = {},
): Promise<WebhookEvent[]> {
  const config = installed();
  const sql = db.service();
  if (config.migrate) await ensureWebhooksMigrated(sql);
  const rows = await sql.unsafe<Record<string, unknown>>(
    "SELECT id::text AS id, hook, status, attempts, last_status, last_error, payload, created_at, " +
      "delivered_at FROM supabase_functions.webhook_events WHERE ($1::text IS NULL OR status = $1) " +
      "ORDER BY id DESC LIMIT $2",
    [o.status ?? null, o.limit ?? 50],
  );
  return [...rows].map((r) => ({
    id: Number(r.id),
    hook: String(r.hook),
    status: r.status as WebhookEvent["status"],
    attempts: Number(r.attempts),
    lastStatus: r.last_status === null ? null : Number(r.last_status),
    lastError: (r.last_error as string | null) ?? null,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    createdAt: new Date(r.created_at as string),
    deliveredAt: r.delivered_at ? new Date(r.delivered_at as string) : null,
  }));
}

/**
 * The background deliverer (`delivery: "auto"`): a pass every `pollIntervalMs`, and one at once
 * on the trigger's NOTIFY when the client can LISTEN. Passes never overlap.
 *
 * @param config The resolved options.
 * @returns A stop function.
 */
export function startWebhookDelivery(config: ResolvedWebhooks): () => Promise<void> {
  let running: Promise<unknown> | undefined;
  let again = false;
  let stopped = false;
  let cleanedAt = -Infinity;
  /** The retention cleanup, at most once an hour, after a pass (a failure is retried next pass). */
  const cleanup = async () => {
    if (!config.retention || Date.now() - cleanedAt < CLEANUP_EVERY_MS) return;
    try {
      await purge(db.service(), config.retention);
      cleanedAt = Date.now();
    } catch (error) {
      console.warn(
        `[@denext/backend] webhooks: retention cleanup failed: ${
          (error as Error)?.message ?? error
        }`,
      );
    }
  };
  const pass = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = deliverWebhooks().then(cleanup).catch((error) => {
      console.warn(
        `[@denext/backend] webhooks: delivery pass failed: ${(error as Error)?.message ?? error}`,
      );
    }).finally(() => {
      running = undefined;
      if (again) {
        again = false;
        pass();
      }
    });
  };
  const timer = setInterval(pass, config.pollIntervalMs);
  let unlisten: (() => unknown) | undefined;
  try {
    const sql = db.service() as SqlClient & {
      listen?: (channel: string, fn: () => void) => Promise<{ unlisten?: () => unknown }>;
    };
    sql.listen?.(WEBHOOK_CHANNEL, pass).then((sub) => {
      unlisten = sub?.unlisten?.bind(sub);
      if (stopped) unlisten?.();
    }).catch(() => {});
  } catch {
    // No client yet: the timer still runs passes (each reports why it failed).
  }
  pass();
  return async () => {
    stopped = true;
    clearInterval(timer);
    try {
      await unlisten?.();
    } catch {
      // Already closed.
    }
    await running;
  };
}
