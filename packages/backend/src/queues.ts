// Queues on the server: a typed client over the pgmq functions (`queues-sql.ts`), and
// `queueConsumer`, a `defineJob` that drains a queue — read a batch under a visibility timeout,
// run the handler on each message, archive (or delete) what succeeded; what failed reappears when
// its timeout lapses and is retried, until `maxAttempts` sends it to the archive as dead.

import {
  defineJob,
  type Job,
  type JobContext,
  migratePostgres,
  type SqlClient,
} from "@denext/denext/server";
import { db } from "./postgres.ts";
import type { DbIdentity } from "./rls.ts";
import { queuesMigrations } from "./queues-sql.ts";

/** `backend({ queues })`. */
export interface QueuesOptions {
  /** Apply the `backend_queues_0001` migration on first use (default `true`). */
  migrate?: boolean;
}

/** One message, as `read` and `pop` return it. */
export interface QueueMessage<T = unknown> {
  /** The message's id in its queue. */
  msgId: number;
  /** How many times it has been read (1 on its first read). */
  readCt: number;
  /** When it was sent. */
  enqueuedAt: Date;
  /** When it becomes visible again. */
  vt: Date;
  /** The payload. */
  message: T;
}

/** A queue's numbers, from `pgmq.metrics`. */
export interface QueueMetrics {
  /** The queue. */
  queueName: string;
  /** Messages in it. */
  queueLength: number;
  /** Messages visible now (not hidden by a visibility timeout). */
  queueVisibleLength: number;
  /** Age of the newest message, in seconds (`null` when empty). */
  newestMsgAgeSec: number | null;
  /** Age of the oldest message, in seconds (`null` when empty). */
  oldestMsgAgeSec: number | null;
  /** Messages ever sent. */
  totalMessages: number;
  /** When these numbers were read. */
  scrapeTime: Date;
}

/** One queue's client. */
export interface Queue<T = unknown> {
  /** The queue's name. */
  readonly name: string;
  /** Send a message, visible after `delay` seconds. Resolves its id. */
  send(message: T, options?: { delay?: number }): Promise<number>;
  /** Send several in one statement. Resolves their ids, in order. */
  sendBatch(messages: T[], options?: { delay?: number }): Promise<number[]>;
  /**
   * Read up to `qty` visible messages (default 1), hiding them for `vt` seconds (default 30);
   * with `pollSeconds`, wait up to that long for the first one to arrive.
   */
  read(options?: { vt?: number; qty?: number; pollSeconds?: number }): Promise<QueueMessage<T>[]>;
  /** Read one message and delete it at once. */
  pop(): Promise<QueueMessage<T> | null>;
  /** Move messages to the archive. Resolves the ids moved. */
  archive(ids: number | number[]): Promise<number[]>;
  /** Delete messages. Resolves the ids deleted. */
  delete(ids: number | number[]): Promise<number[]>;
  /** Make a message visible again in `seconds`. Resolves it, or `null` when it is gone. */
  setVt(id: number, seconds: number): Promise<QueueMessage<T> | null>;
  /** Delete every message. Resolves how many. */
  purge(): Promise<number>;
  /** The queue's numbers. */
  metrics(): Promise<QueueMetrics>;
}

/** Thrown for a malformed queue name, or queues that are not configured. */
export class QueueError extends Error {
  /** `invalid_name` or `not_configured`. */
  readonly code: string;
  /**
   * Build the error.
   *
   * @param code The error code.
   * @param message The message.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

const QUEUE_NAME = /^[a-z0-9_]{1,47}$/;

const SLOT = Symbol.for("denext.backend.queues");
type Holder = { [SLOT]?: QueuesOptions };

/**
 * Install the queues (plugin setup), or clear them with `undefined` (tests).
 *
 * @param options The options.
 */
export function installQueues(options: QueuesOptions | undefined): void {
  (globalThis as Holder)[SLOT] = options;
}

function options(): QueuesOptions {
  const found = (globalThis as Holder)[SLOT];
  if (!found) {
    throw new QueueError(
      "not_configured",
      "queues: not configured — add backend({ postgres: {}, queues: {} }) to denext.config.ts",
    );
  }
  return found;
}

const migrated = new WeakMap<SqlClient, Promise<void>>();

/** Apply the queues migration once on the connecting role's client. */
export function ensureQueuesMigrated(sql: SqlClient): Promise<void> {
  let pending = migrated.get(sql);
  if (!pending) {
    pending = migratePostgres(sql, { migrations: queuesMigrations(), table: "backend_migrations" })
      .then(() => undefined);
    pending.catch(() => migrated.delete(sql));
    migrated.set(sql, pending);
  }
  return pending;
}

/** The client a queue call runs on: `db.service()` by default, else `db({ as })`. */
async function clientFor(as: DbIdentity): Promise<SqlClient> {
  const opts = options();
  const service = db.service();
  if (opts.migrate !== false) await ensureQueuesMigrated(service);
  return as === "service" ? service : db({ as });
}

function checkName(name: string): string {
  if (typeof name !== "string" || !QUEUE_NAME.test(name)) {
    throw new QueueError(
      "invalid_name",
      `queue name ${JSON.stringify(name)} is invalid: use 1 to 47 lowercase letters, digits or _`,
    );
  }
  return name;
}

function seconds(value: number | undefined, fallback: number, what: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`queue: ${what} must be a non-negative integer`);
  }
  return n;
}

interface MessageRow {
  msg_id: unknown;
  read_ct: unknown;
  enqueued_at: Date | string;
  vt: Date | string;
  message: unknown;
}

function messageOf<T>(row: MessageRow): QueueMessage<T> {
  return {
    msgId: Number(row.msg_id),
    readCt: Number(row.read_ct),
    enqueuedAt: new Date(row.enqueued_at),
    vt: new Date(row.vt),
    message: (typeof row.message === "string" ? JSON.parse(row.message) : row.message) as T,
  };
}

const MESSAGE = "msg_id::text AS msg_id, read_ct, enqueued_at, vt, message";

function ids(value: number | number[]): string[] {
  const list = Array.isArray(value) ? value : [value];
  for (const id of list) {
    if (!Number.isSafeInteger(id)) throw new TypeError("queue: message ids are integers");
  }
  return list.map(String);
}

function numbers(rows: Iterable<Record<string, unknown>>, column: string): number[] {
  return [...rows].map((row) => Number(row[column]));
}

/**
 * A typed client for one queue, over the pgmq functions — as the server's own database user by
 * default, or `{ as }` to act as a user (or `"anon"`), whose grants and policies on the queue's
 * table then apply.
 *
 * ```ts
 * import { queue, queues } from "@denext/backend/server";
 * await queues.create("emails");
 * const emails = queue<{ to: string }>("emails");
 * await emails.send({ to: "a@example.com" }, { delay: 10 });
 * const batch = await emails.read({ vt: 60, qty: 10 });
 * ```
 *
 * @param name The queue's name.
 * @param opts `as`: the identity to act as (default `"service"`).
 * @returns The client.
 */
export function queue<T = unknown>(name: string, opts: { as?: DbIdentity } = {}): Queue<T> {
  checkName(name);
  const as = opts.as ?? "service";
  const run = async <R>(
    text: string,
    params: unknown[],
  ): Promise<R[]> => [...await (await clientFor(as)).unsafe<R>(text, params)];
  return {
    name,
    async send(message, o = {}) {
      const [row] = await run<{ id: string }>(
        "SELECT pgmq.send($1, $2::jsonb, $3)::text AS id",
        [name, JSON.stringify(message), seconds(o.delay, 0, "delay")],
      );
      return Number(row.id);
    },
    async sendBatch(messages, o = {}) {
      const rows = await run<{ id: string }>(
        "SELECT id::text AS id FROM pgmq.send_batch($1, (SELECT coalesce(array_agg(m ORDER BY i), '{}') " +
          "FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(m, i)), $3) AS id",
        [name, JSON.stringify(messages), seconds(o.delay, 0, "delay")],
      );
      return numbers(rows, "id");
    },
    async read(o = {}) {
      const vt = seconds(o.vt, 30, "vt");
      const qty = seconds(o.qty, 1, "qty");
      const rows = o.pollSeconds === undefined
        ? await run<MessageRow>(`SELECT ${MESSAGE} FROM pgmq.read($1, $2, $3)`, [name, vt, qty])
        : await run<MessageRow>(
          `SELECT ${MESSAGE} FROM pgmq.read_with_poll($1, $2, $3, $4)`,
          [name, vt, qty, seconds(o.pollSeconds, 0, "pollSeconds")],
        );
      return rows.map((row) => messageOf<T>(row));
    },
    async pop() {
      const [row] = await run<MessageRow>(`SELECT ${MESSAGE} FROM pgmq.pop($1)`, [name]);
      return row ? messageOf<T>(row) : null;
    },
    async archive(value) {
      const rows = await run<{ id: string }>(
        "SELECT id::text AS id FROM pgmq.archive($1, $2::bigint[]) AS id",
        [name, ids(value)],
      );
      return numbers(rows, "id");
    },
    async delete(value) {
      const rows = await run<{ id: string }>(
        "SELECT id::text AS id FROM pgmq.delete($1, $2::bigint[]) AS id",
        [name, ids(value)],
      );
      return numbers(rows, "id");
    },
    async setVt(id, secs) {
      const [row] = await run<MessageRow>(
        `SELECT ${MESSAGE} FROM pgmq.set_vt($1, $2::bigint, $3)`,
        [name, ids(id)[0], seconds(secs, 0, "seconds")],
      );
      return row ? messageOf<T>(row) : null;
    },
    async purge() {
      const [row] = await run<{ n: string }>("SELECT pgmq.purge_queue($1)::text AS n", [name]);
      return Number(row.n);
    },
    async metrics() {
      const [row] = await run<Record<string, unknown>>(
        "SELECT queue_name, queue_length::text AS queue_length, " +
          "queue_visible_length::text AS queue_visible_length, newest_msg_age_sec, " +
          "oldest_msg_age_sec, total_messages::text AS total_messages, scrape_time " +
          "FROM pgmq.metrics($1)",
        [name],
      );
      return metricsOf(row);
    },
  };
}

function metricsOf(row: Record<string, unknown>): QueueMetrics {
  const maybe = (v: unknown) => v === null || v === undefined ? null : Number(v);
  return {
    queueName: String(row.queue_name),
    queueLength: Number(row.queue_length),
    queueVisibleLength: Number(row.queue_visible_length ?? row.queue_length),
    newestMsgAgeSec: maybe(row.newest_msg_age_sec),
    oldestMsgAgeSec: maybe(row.oldest_msg_age_sec),
    totalMessages: Number(row.total_messages),
    scrapeTime: new Date(row.scrape_time as string),
  };
}

/** Queue administration, as the server's own database user. */
export interface Queues {
  /** Create a queue (and its archive). Idempotent. */
  create(name: string, options?: { unlogged?: boolean }): Promise<void>;
  /** Drop a queue and its archive. Resolves whether it existed. */
  drop(name: string): Promise<boolean>;
  /** Every queue. */
  list(): Promise<{ queueName: string; isUnlogged: boolean; createdAt: Date }[]>;
}

/** Create, drop and list queues (server-only; the app's own database user). */
export const queues: Queues = {
  async create(name, o = {}) {
    const sql = await clientFor("service");
    await sql.unsafe(o.unlogged ? "SELECT pgmq.create_unlogged($1)" : "SELECT pgmq.create($1)", [
      checkName(name),
    ]);
  },
  async drop(name) {
    const sql = await clientFor("service");
    const [row] = await sql.unsafe<{ dropped: boolean }>(
      "SELECT pgmq.drop_queue($1) AS dropped",
      [checkName(name)],
    );
    return row?.dropped === true;
  },
  async list() {
    const sql = await clientFor("service");
    const rows = await sql.unsafe<{ queue_name: string; is_unlogged: boolean; created_at: string }>(
      "SELECT queue_name, is_unlogged, created_at FROM pgmq.list_queues()",
    );
    return [...rows].map((r) => ({
      queueName: r.queue_name,
      isUnlogged: r.is_unlogged,
      createdAt: new Date(r.created_at),
    }));
  },
};

/** Options for {@linkcode queueConsumer}. */
export interface QueueConsumerOptions<T> {
  /** The queue to drain. */
  queue: string;
  /** Runs once per message; a throw leaves the message to be retried after `vt`. */
  handler: (message: QueueMessage<T>, ctx: JobContext) => unknown | Promise<unknown>;
  /** Seconds a read message stays hidden while it is handled (default 30). */
  vt?: number;
  /** Messages read per batch (default 10). */
  batchSize?: number;
  /** Batches per run: keep reading while batches come back full (default 10). */
  maxBatches?: number;
  /** A message read this many times without success goes to the archive unhandled (default 5). */
  maxAttempts?: number;
  /** What happens to a handled message: `"archive"` (default) or `"delete"`. */
  onSuccess?: "archive" | "delete";
  /** A cron schedule for the job (e.g. `"* * * * *"`). */
  schedule?: string | string[];
  /** The job's description. */
  description?: string;
}

/** What one consumer run did. */
export interface QueueConsumerResult {
  /** Messages the handler took. */
  handled: number;
  /** Messages whose handler threw (left for a retry). */
  failed: number;
  /** Messages archived unhandled after `maxAttempts`. */
  dead: number;
}

/**
 * A job that drains a queue: put it in `jobs/<name>.ts` with a `schedule`, or run it with
 * `runJob(name)`.
 *
 * ```ts
 * // jobs/send-emails.ts
 * import { queueConsumer } from "@denext/backend/server";
 * export default queueConsumer<{ to: string }>({
 *   queue: "emails",
 *   schedule: "* * * * *",
 *   handler: async ({ message }) => await sendEmail(message.to),
 * });
 * ```
 *
 * @param o The queue, the handler, and the batch settings.
 * @returns The job.
 */
export function queueConsumer<T = unknown>(o: QueueConsumerOptions<T>): Job<QueueConsumerResult> {
  checkName(o.queue);
  const vt = seconds(o.vt, 30, "vt");
  const batchSize = Math.max(1, seconds(o.batchSize, 10, "batchSize"));
  const maxBatches = Math.max(1, seconds(o.maxBatches, 10, "maxBatches"));
  const maxAttempts = Math.max(1, seconds(o.maxAttempts, 5, "maxAttempts"));
  const settle = o.onSuccess === "delete" ? "delete" : "archive";
  return defineJob({
    description: o.description ?? `drain the ${o.queue} queue`,
    schedule: o.schedule,
    handler: async (ctx) => {
      const q = queue<T>(o.queue);
      const result: QueueConsumerResult = { handled: 0, failed: 0, dead: 0 };
      for (let batch = 0; batch < maxBatches && !ctx.signal.aborted; batch++) {
        const messages = await q.read({ vt, qty: batchSize });
        for (const message of messages) {
          if (message.readCt > maxAttempts) {
            console.error(
              `[@denext/backend] queue ${o.queue}: message ${message.msgId} failed ${maxAttempts} times; archived`,
            );
            await q.archive(message.msgId);
            result.dead++;
            continue;
          }
          try {
            await o.handler(message, ctx);
          } catch (error) {
            console.error(`[@denext/backend] queue ${o.queue}: message ${message.msgId}:`, error);
            result.failed++;
            continue;
          }
          await q[settle](message.msgId);
          result.handled++;
        }
        if (messages.length < batchSize) break;
      }
      return result;
    },
  });
}
