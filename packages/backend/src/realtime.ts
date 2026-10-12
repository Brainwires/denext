// Realtime from the database: the triggers (realtime-sql.ts) send `{ table, op, key }` on
// `denext_realtime`; ONE listening connection per server instance receives them, a 16 ms window
// coalesces a burst, and each subscriber gets the changed rows re-read AS THAT SUBSCRIBER through
// the RLS-scoped client — so a change reaches only the subscribers whose SELECT policies (and
// filter) let them see the row, and only what those policies return.
//
// Subscribers ("audiences") are keyed by the channel key the browser chose (table + a 128-bit
// nonce + an optional filter). The first `authorize` binds a key to the subscriber's identity
// (the user's id, or anon); a different identity presenting the same key is refused, so a key is
// never shared across users. Re-reads are batched per burst and per GROUP — audiences with the
// same claims, table and filter share one query (keys batched, 1 000 per statement) — so a
// burst costs (distinct identities × tables) queries, not subscribers × rows.
//
// Deletes carry no row and cannot be re-checked against a policy (the row is gone), so each
// audience tracks the keys it may know about: the rows it could see when it subscribed (one
// key-only query under its own policies) plus every row sent to it since. A delete — or an
// update that moves a row out of its policies or filter — is sent only for a tracked key.
//
// Subscriptions are bounded per identity (`maxSubscriptionsPerIdentity`: a signed-in user, or the
// signed-out visitors at one client address — one Live connection when the address is unknown
// or an untrusted proxy-looking peer)
// as well as per instance, and so are the subscribe-time seed queries
// (a few at once, and a refilling budget per identity). An unsubscribed key is forgotten at once;
// one whose connection closed is kept for a reconnect, but only while there is room — at a cap,
// the oldest such one goes first, and only live subscriptions refuse a new one.
//
// Re-reads compare keys and filters in the column's own type (read once from the catalog), so a
// primary-key or filter index serves them; each runs under a transaction-local
// `statement_timeout`, and flushes are single-flight: a burst arriving while one runs is
// delivered by the next.
//
// Everything shared runs in the root async context: the listener, the flush timer and the
// pacing timers serve every subscriber, not whichever request first started them.
//
// Every instance runs its own listener, so hooks and `revalidate` fire once per instance. With
// `revalidate: { owner: "one" }` only the holder of a session-level advisory lock (taken on a
// reserved connection, checked once per burst) revalidates; the lock goes with its connection,
// so when the owner stops or dies the next instance to see a burst takes it over.

import {
  clientIpForLimits,
  createChannel,
  migratePostgres,
  type Migration,
  revalidateTag,
  type SqlClient,
  type SqlListener,
} from "@denext/denext/server";
import type { DbIdentity, RlsScope } from "./rls.ts";
import { resolveScope, scopedFor } from "./postgres.ts";
import {
  decodeSubscriptionKey,
  type ParsedFilter,
  parseFilter,
  REALTIME_CHANNEL_ID,
  REALTIME_NOTIFY_CHANNEL,
  type TableChange,
  type TableChangesFrame,
  type TableEvent,
  type TableFilter,
} from "./realtime-shared.ts";
import {
  realtimeMigrations,
  type RealtimeOptions,
  type ResolvedRealtime,
  type ResolvedTable,
  resolveRealtime,
} from "./realtime-sql.ts";

/** A change as the database reported it — keys only, before any re-read. */
export interface TableChangeEvent {
  /** The table, as configured. */
  table: string;
  /**
   * `insert`, `update` or `delete`; `resync` when changes may have been missed (the listening
   * connection was lost and is back, a burst overflowed, a key too long to send).
   */
  op: TableEvent | "resync";
  /** The row's key, as text (absent on `resync`). */
  key?: string;
  /** The key before an update that changed it. */
  oldKey?: string;
  /** When the trigger ran, in epoch milliseconds (absent on `resync`). */
  ts?: number;
}

/** Why realtime cannot run: the Postgres client has no `listen`. */
export class RealtimeUnsupportedError extends Error {
  /** Always `"unsupported"`. */
  // fallow-ignore-next-line unused-class-member -- the public error contract (`code === "unsupported"`), read by apps
  readonly code = "unsupported" as const;

  /** Build the error. */
  constructor() {
    super(
      "backend({ realtime }): this Postgres client has no listen() — LISTEN/NOTIFY is needed. " +
        "Deno.SQL (denext's Deno runtime) has it; on stock Deno pass " +
        "`postgres: { sql: fromPostgresJs(postgres(url)) }` (the npm `postgres` package).",
    );
    this.name = "RealtimeUnsupportedError";
  }
}

/** Where an audience's frames go: the Live channel, or a server callback. */
type Sink = { channel: string } | { fn: (frame: TableChangesFrame) => void };

/** One subscription. */
interface Audience {
  key: string;
  table: ResolvedTable;
  filter?: ParsedFilter;
  /** `anon`, or `authenticated:<sub>`: the identity the key is bound to. */
  identity: string;
  /**
   * Whose quota it counts against: the identity, or `anon:<client address>` for a signed-out
   * Live subscriber (`anon:<peer id>` when there is no address to limit on); empty for a server-side
   * subscription (not counted).
   */
  owner: string;
  scope: RlsScope;
  /** Keys this subscriber may know about (see the module comment). */
  tracked: Set<string>;
  active: boolean;
  /** It has had a subscriber (a never-activated one is not evicted while it is being admitted). */
  everActive: boolean;
  idleSince: number;
  seq: number;
  sink: Sink;
  queue: TableChangesFrame[];
  pumping: boolean;
}

/** A coalesced change to one key within a burst. */
interface Pending {
  op: TableEvent;
  oldKey?: string;
}

/** Counters, for tests and diagnostics. */
export interface RealtimeStats {
  /** Notifications received. */
  notifications: number;
  /** Bursts flushed. */
  flushes: number;
  /** Re-read queries run (one per group per 1 000 keys). */
  rereads: number;
  /** Frames published or handed to a server callback. */
  frames: number;
  /** Times the listener (re)subscribed. */
  listens: number;
  /** `revalidateTag` calls this instance made (one per table per burst it owned). */
  revalidations: number;
}

/** The burst window: Live's own flush interval. */
const COALESCE_MS = 16;
/** Spacing between two frames to the same subscription: longer than the hub's coalescing. */
const PACE_MS = 24;
/** Frames waiting per subscription before they are replaced by one `resync`. */
const MAX_QUEUE = 32;
/** Changes held in one burst before the burst becomes a `resync`. */
const MAX_PENDING = 50_000;
/** Keys per re-read statement. */
const KEYS_PER_QUERY = 1_000;
/** A frame's target size; the channel's own cap (16 KiB by default) is the hard limit. */
const FRAME_BYTES = 12_000;
/** How long an audience with no subscriber is kept (a reconnect resumes it). */
const IDLE_GRACE_MS = 15_000;
/** Group re-reads run at once. */
const REREAD_CONCURRENCY = 4;
/** Subscribe-time seed queries run at once (more wait their turn). */
const SEED_CONCURRENCY = 4;
/** New subscriptions an identity may open in a burst… */
const SEED_BURST = 32;
/** …and per second after it. */
const SEED_PER_SECOND = 8;
/** How long a just-admitted subscription is safe from eviction before its subscriber arrives. */
const ADMIT_GRACE_MS = 1_000;

/** The type of each column of a table (`format_type`, no modifier), by `$1::regclass`. */
export const COLUMN_TYPES_SQL = "select a.attname::text as name, " +
  "format_type(a.atttypid, null) as type from pg_attribute a " +
  "where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped";

/** Sets the transaction's `statement_timeout` (`$1`: milliseconds, as text). */
const STATEMENT_TIMEOUT_SQL = "select set_config('statement_timeout', $1, true)";

/**
 * The advisory lock (two int4 keys: "denx", 1) whose holder revalidates for every instance on
 * the database (`revalidate: { owner: "one" }`). Advisory locks are per database.
 */
const OWNER_LOCK = [0x64656e78, 1] as const;

/**
 * Whether this connection holds the owner lock — taking it when it is free. Already holding it
 * is read from `pg_locks` (by this backend's pid) rather than taken again: a session-level lock
 * is reentrant, so a second `pg_try_advisory_lock` would stack another hold on every burst.
 */
export const REVALIDATE_OWNER_SQL = "select case when exists (select 1 from pg_locks where " +
  `locktype = 'advisory' and pid = pg_backend_pid() and classid = ${OWNER_LOCK[0]} and ` +
  `objid = ${OWNER_LOCK[1]} and objsubid = 2 and granted) then true else ` +
  `pg_try_advisory_lock(${OWNER_LOCK[0]}, ${OWNER_LOCK[1]}) end as owner`;

/** A reserved connection, as `SqlClient.reserve` hands it out. */
type Reserved = SqlClient & { release(): void | Promise<void> };

type RootBridge = { __denextInRootContext?: <R>(fn: () => R) => R };

/** Run `fn` in the root async context (see src/server/root-context.ts). */
function inRoot<T>(fn: () => T): T {
  const run = (globalThis as RootBridge).__denextInRootContext;
  return run ? run(fn) : fn();
}

/** The realtime engine of one server instance. */
export class RealtimeEngine {
  readonly config: ResolvedRealtime;
  readonly stats: RealtimeStats = {
    notifications: 0,
    flushes: 0,
    rereads: 0,
    frames: 0,
    listens: 0,
    revalidations: 0,
  };
  #client: () => SqlClient;
  #audiences = new Map<string, Audience>();
  #hooks = new Map<string, Set<(event: TableChangeEvent) => void>>();
  #pending = new Map<string, Map<string, Pending>>();
  #pendingCount = 0;
  #resyncTables = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #listening: Promise<void> | null = null;
  #listener: SqlListener | null = null;
  #migrated: Promise<void> | null = null;
  #publish: (key: string, frame: TableChangesFrame) => Promise<void>;
  #stopped = false;
  #warned = false;
  /** The reserved connection that holds (or tries for) the owner lock; `null` until needed. */
  #lockConn: Promise<Reserved> | null = null;
  #warnedReserve = false;
  /** The flush in progress, and whether another burst arrived while it ran. */
  #flushing: Promise<void> | null = null;
  #flushAgain = false;
  /** Each table's column types, read once (by table name). */
  #types = new Map<string, Promise<Map<string, string>>>();
  /** Seed queries running, and those waiting for a turn. */
  #seeding = 0;
  #seedWaiters: Array<() => void> = [];
  /** Each owner's seed budget: tokens left, as of `at`. */
  #budgets = new Map<string, { tokens: number; at: number }>();

  /**
   * @param options The realtime options.
   * @param client The connecting role's client (throws when Postgres is unavailable).
   * @param publish Publishes a frame on the realtime channel.
   */
  constructor(
    options: RealtimeOptions,
    client: () => SqlClient,
    publish: (key: string, frame: TableChangesFrame) => Promise<void>,
  ) {
    this.config = resolveRealtime(options);
    this.#client = client;
    this.#publish = publish;
  }

  /** The client, checked for `listen`. */
  #listenable(): SqlClient {
    const sql = this.#client();
    if (typeof sql.listen !== "function") throw new RealtimeUnsupportedError();
    return sql;
  }

  /** The table's resolved options, or a TypeError naming the configured tables. */
  table(name: string): ResolvedTable {
    const table = this.config.tables.get(name);
    if (!table) {
      throw new TypeError(
        `realtime: table ${JSON.stringify(name)} is not in realtime({ tables }) ` +
          `(configured: ${[...this.config.tables.keys()].join(", ")})`,
      );
    }
    return table;
  }

  /** Apply the trigger migrations once (a failure is retried on the next call). */
  #migrate(sql: SqlClient): Promise<void> {
    if (!this.config.migrate) return Promise.resolve();
    const migrations: Migration[] = realtimeMigrations({
      tables: Object.fromEntries(
        [...this.config.tables.values()].map((
          t,
        ) => [t.name, { events: t.events, key: t.key, schema: t.schema }]),
      ),
    });
    this.#migrated ??= inRoot(() =>
      migratePostgres(sql, { migrations, table: "backend_migrations" })
    ).then(() => undefined, (error) => {
      this.#migrated = null;
      throw error;
    });
    return this.#migrated;
  }

  /**
   * Start the one listener (memoized; a failure is retried on the next call): migrate, then
   * LISTEN. Resolves once subscribed.
   *
   * @returns When the listener is up.
   */
  start(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("realtime: the server is shutting down"));
    if (this.#listening) return this.#listening;
    let sql: SqlClient;
    try {
      sql = this.#listenable();
    } catch (error) {
      return Promise.reject(error);
    }
    this.#listening = inRoot(async () => {
      await this.#migrate(sql);
      const listener = await sql.listen!(
        REALTIME_NOTIFY_CHANNEL,
        (payload) => inRoot(() => this.receive(payload)),
        () => inRoot(() => this.#onListen()),
      );
      if (this.#stopped) return void await listener.unlisten().catch(() => {});
      this.#listener = listener;
    }).catch((error) => {
      this.#listening = null;
      throw error;
    });
    return this.#listening;
  }

  /** The listener subscribed — again, after a lost connection: changes may have been missed. */
  #onListen(): void {
    this.stats.listens++;
    if (this.stats.listens === 1) return;
    for (const name of this.config.tables.keys()) this.#resyncTables.add(name);
    this.#schedule();
  }

  /**
   * Take one notification payload (from the listener).
   *
   * @param payload The trigger's JSON.
   */
  receive(payload: string): void {
    this.stats.notifications++;
    const event = parseNotification(payload);
    if (!event || !this.config.tables.has(event.table)) return;
    if (event.op === "resync" || this.#pendingCount >= MAX_PENDING) {
      this.#resyncTables.add(event.table);
    } else {
      this.#coalesce(event.table, event.key!, event.op, event.oldKey);
    }
    this.#schedule();
  }

  /** Fold one change into the burst: the latest op per key wins (an insert stays an insert). */
  #coalesce(table: string, key: string, op: TableEvent, oldKey?: string): void {
    let byKey = this.#pending.get(table);
    if (!byKey) this.#pending.set(table, byKey = new Map());
    const previous = byKey.get(key);
    if (previous) byKey.delete(key); // re-inserted below: commit order of the LAST change
    else this.#pendingCount++;
    const merged: Pending = {
      op: previous?.op === "insert" && op === "update" ? "insert" : op,
    };
    const old = previous?.oldKey ?? oldKey;
    if (old !== undefined && op !== "delete") merged.oldKey = old;
    byKey.set(key, merged);
  }

  #schedule(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#timer = inRoot(() => setTimeout(() => void this.flush(), COALESCE_MS));
  }

  /**
   * Deliver the current burst now (the timer calls it; tests may too). Single-flight: while a
   * flush runs, a further call only marks that another burst is waiting, and the running flush
   * delivers it next — so a slow re-read never has bursts piling up behind it in parallel.
   *
   * @returns When every subscriber's re-read has run and its frames are queued (including a
   *   burst that arrived meanwhile).
   */
  flush(): Promise<void> {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#flushing) {
      this.#flushAgain = true;
      return this.#flushing;
    }
    const run = async () => {
      try {
        do {
          this.#flushAgain = false;
          await this.#flushOnce();
        } while (this.#flushAgain && !this.#stopped);
      } finally {
        this.#flushing = null;
      }
    };
    this.#flushing = run();
    return this.#flushing;
  }

  /** Deliver the burst gathered so far. */
  async #flushOnce(): Promise<void> {
    const pending = this.#pending;
    const resync = this.#resyncTables;
    this.#pending = new Map();
    this.#resyncTables = new Set();
    this.#pendingCount = 0;
    if (pending.size === 0 && resync.size === 0) return;
    this.stats.flushes++;
    this.#sweep();
    const work: Array<() => Promise<void>> = [];
    for (const name of resync) work.push(...this.#resyncTable(name));
    for (const [name, changes] of pending) {
      if (resync.has(name)) continue;
      work.push(...this.#deliverTable(name, changes));
    }
    this.#revalidate([...new Set([...resync, ...pending.keys()])]);
    await runLimited(work, REREAD_CONCURRENCY);
  }

  /** A table whose changes were lost: tell its hooks and subscribers to re-read. */
  #resyncTable(name: string): Array<() => Promise<void>> {
    this.#runHooks({ table: name, op: "resync" });
    for (const audience of this.#audiences.values()) {
      if (audience.table.name === name && audience.active) {
        this.#enqueue(audience, { resync: true });
      }
    }
    return [];
  }

  /** Hooks, revalidation, then one re-read task per group of the table's active audiences. */
  #deliverTable(name: string, changes: Map<string, Pending>): Array<() => Promise<void>> {
    for (const [key, change] of changes) {
      const event: TableChangeEvent = { table: name, op: change.op, key };
      if (change.oldKey !== undefined) event.oldKey = change.oldKey;
      this.#runHooks(event);
    }
    const groups = new Map<string, Audience[]>();
    for (const audience of this.#audiences.values()) {
      if (audience.table.name !== name || !audience.active) continue;
      const id = groupId(audience);
      const group = groups.get(id);
      if (group) group.push(audience);
      else groups.set(id, [audience]);
    }
    return [...groups.values()].map((group) => () => this.#deliverGroup(group, changes));
  }

  #runHooks(event: TableChangeEvent): void {
    for (const fn of this.#hooks.get(event.table) ?? []) {
      try {
        fn({ ...event });
      } catch (error) {
        console.error(`[@denext/backend] onTableChange(${event.table}) threw`, error);
      }
    }
  }

  /** `revalidateTag("table:<name>")` for a burst's tables — here, or only on the owner. */
  #revalidate(tables: string[]): void {
    if (!this.config.revalidate) return;
    const run = () => {
      for (const table of tables) {
        this.stats.revalidations++;
        revalidateTag(`table:${table}`).catch((error) =>
          console.error(`[@denext/backend] revalidateTag(table:${table}) failed`, error)
        );
      }
    };
    if (this.config.revalidateOwner === "every") return run();
    void this.#ownsRevalidation().then((owner) => {
      if (owner && !this.#stopped) run();
    });
  }

  /**
   * Whether this instance holds the owner lock (taking it when free), on its reserved
   * connection. A failed check — the connection (and with it the lock) is gone — answers `false`
   * for this burst and reserves a fresh connection next time. A client without `reserve()`
   * cannot hold the lock: every instance revalidates (warned once), never none.
   */
  async #ownsRevalidation(): Promise<boolean> {
    const sql = this.#client();
    if (typeof sql.reserve !== "function") {
      if (!this.#warnedReserve) {
        this.#warnedReserve = true;
        console.warn(
          '[@denext/backend] realtime revalidate.owner "one" needs a client with reserve() ' +
            "(Deno.SQL, or postgres.js via fromPostgresJs); every instance revalidates instead",
        );
      }
      return true;
    }
    const pending = this.#lockConn ??= inRoot(() => sql.reserve!());
    try {
      const [row] = await (await pending).unsafe<{ owner: boolean }>(REVALIDATE_OWNER_SQL);
      return row?.owner === true;
    } catch {
      if (this.#lockConn === pending) this.#lockConn = null;
      void pending.then((conn) => conn.release()).catch(() => {});
      return false;
    }
  }

  /** Give the owner lock up and return its connection to the pool (it must not keep the lock). */
  async #releaseLock(): Promise<void> {
    const pending = this.#lockConn;
    this.#lockConn = null;
    if (!pending) return;
    try {
      const conn = await pending;
      await conn.unsafe(`select pg_advisory_unlock(${OWNER_LOCK[0]}, ${OWNER_LOCK[1]})`)
        .then(() => {}, () => {});
      await conn.release();
    } catch { /* never reserved, or already gone: nothing is held */ }
  }

  /** Re-read the burst's rows once for the group, then work out each audience's changes. */
  async #deliverGroup(group: Audience[], changes: Map<string, Pending>): Promise<void> {
    const [first] = group;
    const keys = [...changes].filter(([, c]) => c.op !== "delete").map(([key]) => key);
    let rows: Map<string, unknown>;
    try {
      rows = await this.#reread(first, keys);
    } catch (error) {
      this.#types.delete(first.table.name); // the table may have changed: read its types again
      console.error(`[@denext/backend] realtime re-read of ${first.table.name} failed`, error);
      for (const audience of group) this.#enqueue(audience, { resync: true });
      return;
    }
    for (const audience of group) {
      const out = audienceChanges(audience, changes, rows, this.config.maxTrackedKeys);
      for (const frame of toFrames(out)) this.#enqueue(audience, frame);
    }
  }

  /** The rows among `keys` the audience's scope (and filter) can SELECT, as parsed JSON. */
  async #reread(audience: Audience, keys: string[]): Promise<Map<string, unknown>> {
    const rows = new Map<string, unknown>();
    const types = await this.#columnTypes(audience.table);
    for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
      const chunk = keys.slice(i, i + KEYS_PER_QUERY);
      const { text, params } = rereadQuery(audience.table, audience.filter, chunk, types);
      this.stats.rereads++;
      const result = await this.#timed<{ k: string; r: string }>(audience.scope, text, params);
      for (const row of result) rows.set(String(row.k), JSON.parse(String(row.r)));
    }
    return rows;
  }

  /**
   * One query as `scope`, in a transaction of its own under the `statement_timeout`: the RLS
   * setup, the timeout and the query are pipelined on the transaction's connection.
   */
  #timed<T>(scope: RlsScope, text: string, params: unknown[]): Promise<T[]> {
    const timeout = String(this.config.queryTimeoutMs);
    return scopedFor(scope).begin((tx) =>
      Promise.all([tx.unsafe(STATEMENT_TIMEOUT_SQL, [timeout]), tx.unsafe<T>(text, params)])
        .then(([, rows]) => rows)
    );
  }

  /**
   * The table's column types (read once, in the root context, as the connecting role: the
   * catalog holds no user data), so keys and filters are compared in the column's own type.
   */
  #columnTypes(table: ResolvedTable): Promise<Map<string, string>> {
    const known = this.#types.get(table.name);
    if (known) return known;
    const read = inRoot(() =>
      Promise.resolve().then(() =>
        this.#client().unsafe<{ name: string; type: string }>(COLUMN_TYPES_SQL, [table.qualified])
      )
    ).then((rows) => new Map(rows.map((row) => [String(row.name), String(row.type)])));
    this.#types.set(table.name, read);
    read.catch(() => {
      if (this.#types.get(table.name) === read) this.#types.delete(table.name);
    });
    return read;
  }

  /** Queue a frame and make sure the audience's pump runs. */
  #enqueue(audience: Audience, frame: Omit<TableChangesFrame, "seq">): void {
    if (audience.queue.length >= MAX_QUEUE) {
      audience.queue.length = 0;
      audience.queue.push({ seq: 0, resync: true });
    } else {
      audience.queue.push({ seq: 0, ...frame });
    }
    if (!audience.pumping) void this.#pump(audience);
  }

  /** Send queued frames one by one, spaced so the Live hub never merges two of them. */
  async #pump(audience: Audience): Promise<void> {
    audience.pumping = true;
    try {
      while (audience.queue.length > 0 && !this.#stopped) {
        const frame = audience.queue.shift()!;
        frame.seq = ++audience.seq;
        if (!(await this.#send(audience, frame))) continue;
        if ("channel" in audience.sink && audience.queue.length > 0) await sleep(PACE_MS);
      }
    } finally {
      audience.pumping = false;
    }
  }

  /** Deliver one frame; a frame over the channel's cap is split (and requeued) instead. */
  async #send(audience: Audience, frame: TableChangesFrame): Promise<boolean> {
    this.stats.frames++;
    if ("fn" in audience.sink) {
      try {
        audience.sink.fn(frame);
      } catch (error) {
        console.error(
          `[@denext/backend] tableChanges(${audience.table.name}) callback threw`,
          error,
        );
      }
      return true;
    }
    try {
      await this.#publish(audience.key, frame);
      return true;
    } catch (error) {
      if (!(error instanceof RangeError)) {
        console.error("[@denext/backend] realtime publish failed", error);
        return false;
      }
      audience.seq--; // the frame was not sent: its parts take its number
      this.stats.frames--;
      audience.queue.unshift(...splitFrame(frame));
      return false;
    }
  }

  /** Drop audiences that have had no subscriber for the grace period, and full budgets. */
  #sweep(): void {
    const now = Date.now();
    const cutoff = now - IDLE_GRACE_MS;
    for (const [key, audience] of this.#audiences) {
      if (!audience.active && audience.idleSince < cutoff) this.#audiences.delete(key);
    }
    for (const [owner, budget] of this.#budgets) {
      if (refilled(budget, now) >= SEED_BURST) this.#budgets.delete(owner);
    }
  }

  /**
   * Whether one more audience fits `among` under `cap` — dropping the oldest one kept only for a
   * reconnect when it does not.
   */
  #room(among: Iterable<Audience>, cap: number, except?: Audience): boolean {
    const now = Date.now();
    let count = 0;
    let oldest: Audience | undefined;
    for (const audience of among) {
      if (audience === except) continue;
      count++;
      const evictable = !audience.active &&
        (audience.everActive || audience.idleSince < now - ADMIT_GRACE_MS);
      if (evictable && (!oldest || audience.idleSince < oldest.idleSince)) oldest = audience;
    }
    if (count < cap) return true;
    if (!oldest) return false;
    this.#audiences.delete(oldest.key);
    return true;
  }

  /** Room for one more audience of `owner`: under its own cap, then the instance's. */
  #roomFor(owner: string, except?: Audience): boolean {
    if (owner) {
      const owned = [...this.#audiences.values()].filter((audience) => audience.owner === owner);
      if (!this.#room(owned, this.config.maxSubscriptionsPerIdentity, except)) return false;
    }
    if (this.#room(this.#audiences.values(), this.config.maxSubscribers, except)) return true;
    console.warn(
      `[@denext/backend] realtime: ${this.config.maxSubscribers} subscriptions held; refusing more`,
    );
    return false;
  }

  /** Spend one of the owner's seed budget (refilling at {@linkcode SEED_PER_SECOND}). */
  #spend(owner: string): boolean {
    if (!owner) return true;
    const now = Date.now();
    const budget = this.#budgets.get(owner) ?? { tokens: SEED_BURST, at: now };
    budget.tokens = refilled(budget, now);
    budget.at = now;
    this.#budgets.set(owner, budget);
    if (budget.tokens < 1) return false;
    budget.tokens--;
    return true;
  }

  /** Run a seed query when one of the {@linkcode SEED_CONCURRENCY} slots is free. */
  async #seedSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.#seeding >= SEED_CONCURRENCY) {
      await new Promise<void>((resolve) => this.#seedWaiters.push(resolve));
    }
    this.#seeding++;
    try {
      return await fn();
    } finally {
      this.#seeding--;
      this.#seedWaiters.shift()?.();
    }
  }

  /**
   * Admit a subscription key for the current identity (the Live channel's `authorize`, run in
   * the subscriber's session). Binds a new key to the identity, seeding its tracked keys.
   *
   * @param key The subscription key.
   * @param peer Whose quota a signed-out subscriber counts against: its client address, or its
   *   Live connection's id when the address is unknown.
   * @returns Whether the subscriber may receive it.
   */
  async authorize(key: string, peer = ""): Promise<boolean> {
    const parts = decodeSubscriptionKey(key);
    const table = parts && this.config.tables.get(parts.table);
    if (!parts || !table) return false;
    try {
      const scope = await resolveScope();
      const owner = scope.role === "anon" ? `anon:${peer}` : identityOf(scope);
      const existing = this.#audiences.get(key);
      if (existing) return this.#rebind(existing, scope, owner);
      const sink = { channel: key };
      return await this.#admit({ key, table, filter: parts.filter, scope, sink }, owner);
    } catch (error) {
      this.#warnOnce(error);
      return false;
    }
  }

  /**
   * Re-authorization of a known key: same identity only; the claims are refreshed. A signed-out
   * subscriber back on a new connection takes the subscription into that connection's quota.
   */
  #rebind(audience: Audience, scope: RlsScope, owner: string): boolean {
    if (identityOf(scope) !== audience.identity) return false;
    if (owner !== audience.owner) {
      if (!this.#roomFor(owner, audience)) return false;
      audience.owner = owner;
    }
    audience.scope = scope;
    return true;
  }

  /**
   * Create an audience: room and budget first (a refused subscribe costs no query), the listener
   * up next (no change slips between seed and listen), then the seed — and room again, since
   * other subscribes may have been admitted while it ran.
   */
  async #admit(init: {
    key: string;
    table: ResolvedTable;
    filter?: ParsedFilter;
    scope: RlsScope;
    sink: Sink;
  }, owner: string): Promise<boolean> {
    this.#sweep();
    if (!this.#roomFor(owner) || !this.#spend(owner)) return false;
    await this.start();
    const tracked = await this.#seedSlot(() => this.#seed(init.table, init.filter, init.scope));
    const identity = identityOf(init.scope);
    const raced = this.#audiences.get(init.key);
    if (raced) return raced.identity === identity; // a concurrent subscribe of the same key
    if (!this.#roomFor(owner)) return false;
    const server = "fn" in init.sink;
    this.#audiences.set(init.key, {
      ...init,
      identity,
      owner,
      tracked,
      active: server,
      everActive: server,
      idleSince: Date.now(),
      seq: 0,
      queue: [],
      pumping: false,
    });
    return true;
  }

  /** The keys the scope can see now (bounded): what a later delete may be sent for. */
  async #seed(
    table: ResolvedTable,
    filter: ParsedFilter | undefined,
    scope: RlsScope,
  ): Promise<Set<string>> {
    const types = await this.#columnTypes(table);
    const { text, params } = seedQuery(table, filter, this.config.maxTrackedKeys, types);
    const rows = await this.#timed<{ k: string }>(scope, text, params);
    return new Set(rows.map((row) => String(row.k)));
  }

  #warnOnce(error: unknown): void {
    if (this.#warned) return;
    this.#warned = true;
    console.error(
      "[@denext/backend] realtime subscription refused:",
      (error as Error)?.message ?? error,
    );
  }

  /** A key's first subscriber arrived (the channel's `onActive`). */
  activate(key: string): void {
    const audience = this.#audiences.get(key);
    if (audience) audience.active = audience.everActive = true;
  }

  /**
   * A key's last subscriber left (the channel's `onIdle`). Unsubscribed (or revoked): forgotten
   * at once. Disconnected: kept for a reconnect of the same identity — swept after
   * {@linkcode IDLE_GRACE_MS}, or sooner when a cap needs the room.
   *
   * @param key The subscription key.
   * @param reason Why it went idle (an older hub passes none: kept, as for a disconnect).
   */
  deactivate(key: string, reason?: "unsubscribe" | "disconnect"): void {
    const audience = this.#audiences.get(key);
    if (!audience) return;
    if (reason === "unsubscribe") {
      audience.queue.length = 0;
      this.#audiences.delete(key);
      return;
    }
    audience.active = false;
    audience.idleSince = Date.now();
    audience.queue.length = 0;
  }

  /**
   * A server-side, RLS-scoped subscription (`tableChanges`).
   *
   * @param table The table.
   * @param options Who to act as, the filter, the callback.
   * @returns An unsubscribe.
   */
  async subscribe(
    table: string,
    options: TableChangesOptions,
  ): Promise<() => void> {
    const resolved = this.table(table);
    const filter = parseFilter(options.filter);
    const scope = await resolveScope(options.as);
    const key = `server|${crypto.randomUUID()}`;
    const ok = await this.#admit({
      key,
      table: resolved,
      filter,
      scope,
      sink: { fn: options.onChange },
    }, "");
    if (!ok) {
      throw new Error(`tableChanges(${table}): ${this.config.maxSubscribers} subscriptions held`);
    }
    return () => void this.#audiences.delete(key);
  }

  /**
   * Run `fn` for every change to `table` (service context: keys only, no RLS).
   *
   * @param table The table.
   * @param fn The callback.
   * @returns An unsubscribe.
   */
  hook(table: string, fn: (event: TableChangeEvent) => void): () => void {
    this.table(table);
    this.#listenable();
    let set = this.#hooks.get(table);
    if (!set) this.#hooks.set(table, set = new Set());
    set.add(fn);
    this.start().catch((error) =>
      console.error("[@denext/backend] realtime listener failed to start", error)
    );
    return () => void set.delete(fn);
  }

  /** How many subscriptions are held (active or in their reconnect grace). */
  get size(): number {
    return this.#audiences.size;
  }

  /** Stop: UNLISTEN, cancel the burst, forget every subscription and hook. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#audiences.clear();
    this.#hooks.clear();
    this.#pending.clear();
    await this.#listening?.catch(() => {});
    const listener = this.#listener;
    this.#listener = null;
    await listener?.unlisten().catch(() => {});
    await this.#releaseLock();
  }
}

/** Options for {@linkcode tableChanges}. */
export interface TableChangesOptions {
  /** Who to read rows as (default: the current request's user, or anon outside a request). */
  as?: Exclude<DbIdentity, "service">;
  /** A one-column equality filter: `{ list_id: 42 }` or `"list_id=eq.42"`. */
  filter?: TableFilter;
  /** Called with each frame: the changes this identity may see, or `resync`. */
  onChange: (frame: TableChangesFrame) => void;
}

/** The identity a scope binds: `anon` or `authenticated:<sub>`. */
function identityOf(scope: RlsScope): string {
  if (scope.role === "anon") return "anon";
  const claims = JSON.parse(scope.claims) as { sub?: unknown };
  return `authenticated:${String(claims.sub)}`;
}

/** Audiences that see exactly the same rows share a re-read. */
function groupId(audience: Audience): string {
  const f = audience.filter;
  return JSON.stringify([
    audience.scope.role,
    audience.scope.claims,
    f?.column ?? null,
    f?.value ?? null,
  ]);
}

/** A notification payload, validated (malformed → `null`; overflow or no key → `resync`). */
export function parseNotification(payload: string): TableChangeEvent | null {
  if (typeof payload !== "string" || payload.length > 8_000) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || typeof value.table !== "string") return null;
  const op = value.op;
  if (op !== "insert" && op !== "update" && op !== "delete") return null;
  if (value.overflow === true || typeof value.key !== "string") {
    return { table: value.table, op: "resync" };
  }
  const event: TableChangeEvent = { table: value.table, op, key: value.key };
  if (typeof value.old_key === "string") event.oldKey = value.old_key;
  if (typeof value.ts === "number") event.ts = value.ts;
  return event;
}

/**
 * `t."column" = $n` in the column's own type (`$n::text::<type>`), so an index on the column
 * serves it; compared as text only when the type is unknown.
 */
function equals(column: string, param: string, types: Map<string, string>): string {
  const type = types.get(column);
  return type ? `t."${column}" = ${param}::text::${type}` : `t."${column}"::text = ${param}`;
}

/**
 * The key column of `t` as text, spelled as the trigger spells it (`to_jsonb(row) ->> key`), so a
 * re-read row and a seeded key match the notification's key in every type — `t."key"::text`
 * differs for a timestamp (`2026-01-02 03:04:05` against JSON's `2026-01-02T03:04:05`). The
 * column alone goes through JSON (`#>> '{}'` unwraps it to the same text), not the whole row, so
 * a seed over many rows does not build a document per row. A `timestamptz` key is spelled in UTC
 * (`k AT TIME ZONE 'UTC'`), as the trigger spells it, so the reading session's `TimeZone` does not
 * matter.
 */
function keyText(column: string, type: string | undefined): string {
  const value = type === "timestamp with time zone"
    ? `t."${column}" AT TIME ZONE 'UTC'`
    : `t."${column}"`;
  return `to_jsonb(${value}) #>> '{}'`;
}

/**
 * `select key, row` for the given keys, under the caller's scope (and the filter). The keys
 * travel as one JSON array and are cast to the key column's type, so the match is
 * `key = any(<array of that type>)` — an index scan on the key.
 */
export function rereadQuery(
  table: ResolvedTable,
  filter: ParsedFilter | undefined,
  keys: string[],
  types: Map<string, string>,
): { text: string; params: unknown[] } {
  const params: unknown[] = [JSON.stringify(keys)];
  const type = types.get(table.key);
  const match = type
    ? `t."${table.key}" = any(array(select jsonb_array_elements_text($1::jsonb)::${type}))`
    : `t."${table.key}"::text in (select jsonb_array_elements_text($1::jsonb))`;
  let text = `select ${keyText(table.key, type)} as k, to_jsonb(t)::text as r ` +
    `from ${table.qualified} t where ${match}`;
  if (filter) {
    params.push(filter.value);
    text += ` and ${equals(filter.column, "$2", types)}`;
  }
  return { text, params };
}

/** `select key` of every visible row (bounded), under the caller's scope (and the filter). */
export function seedQuery(
  table: ResolvedTable,
  filter: ParsedFilter | undefined,
  limit: number,
  types: Map<string, string>,
): { text: string; params: unknown[] } {
  const params: unknown[] = [limit];
  let text = `select ${keyText(table.key, types.get(table.key))} as k from ${table.qualified} t`;
  if (filter) {
    params.push(filter.value);
    text += ` where ${equals(filter.column, "$2", types)}`;
  }
  return { text: `${text} limit $1`, params };
}

/** A seed budget's tokens as of `now`. */
function refilled(budget: { tokens: number; at: number }, now: number): number {
  return Math.min(SEED_BURST, budget.tokens + ((now - budget.at) / 1000) * SEED_PER_SECOND);
}

/**
 * One audience's changes for a burst: a visible row is sent (and tracked); a row that left its
 * view — deleted, or updated out of its policies or filter — is sent as a delete only when it
 * was tracked.
 */
function audienceChanges(
  audience: { tracked: Set<string> },
  changes: Map<string, Pending>,
  rows: Map<string, unknown>,
  maxTracked: number,
): TableChange[] {
  const out: TableChange[] = [];
  const untrack = (key: string | undefined) => {
    if (key !== undefined && audience.tracked.delete(key)) out.push({ op: "delete", key });
  };
  for (const [key, change] of changes) {
    const row = change.op === "delete" ? undefined : rows.get(key);
    if (row === undefined) {
      untrack(key);
      untrack(change.oldKey);
    } else {
      out.push(visibleChange(audience.tracked, key, change.oldKey, row, maxTracked));
    }
  }
  return out;
}

/**
 * A row the audience can see: `update` when it knew the row (under this key or the old one),
 * `insert` when the row entered its view. Tracks the key (up to `maxTracked`).
 */
function visibleChange(
  tracked: Set<string>,
  key: string,
  oldKey: string | undefined,
  row: unknown,
  maxTracked: number,
): TableChange {
  const renamed = oldKey !== undefined && oldKey !== key && tracked.delete(oldKey);
  const known = renamed || tracked.has(key);
  if (!tracked.has(key) && tracked.size < maxTracked) tracked.add(key);
  const value = row as Record<string, unknown>;
  if (!known) return { op: "insert", key, row: value };
  return renamed ? { op: "update", key, oldKey, row: value } : { op: "update", key, row: value };
}

const encoder = new TextEncoder();

/** Split changes into frames of about {@linkcode FRAME_BYTES}; an oversized row is truncated. */
export function toFrames(changes: TableChange[]): Array<Omit<TableChangesFrame, "seq">> {
  const frames: Array<Omit<TableChangesFrame, "seq">> = [];
  let current: TableChange[] = [];
  let size = 0;
  for (let change of changes) {
    let bytes = encoder.encode(JSON.stringify(change)).byteLength;
    if (bytes > FRAME_BYTES) {
      change = truncate(change);
      bytes = encoder.encode(JSON.stringify(change)).byteLength;
    }
    if (current.length > 0 && size + bytes > FRAME_BYTES) {
      frames.push({ changes: current });
      current = [];
      size = 0;
    }
    current.push(change);
    size += bytes + 1;
  }
  if (current.length > 0) frames.push({ changes: current });
  return frames;
}

/** A change without its row (too large to send). */
function truncate(change: TableChange): TableChange {
  if (change.op === "delete") return change;
  const { row: _row, ...rest } = change;
  return { ...rest, truncated: true } as TableChange;
}

/** Halve a frame the channel refused as too large (one change: drop its row). */
export function splitFrame(frame: TableChangesFrame): TableChangesFrame[] {
  const changes = frame.changes ?? [];
  if (changes.length <= 1) {
    return changes.length === 1 && changes[0].op !== "delete" && !("truncated" in changes[0])
      ? [{ seq: 0, changes: [truncate(changes[0])] }]
      : [{ seq: 0, resync: true }];
  }
  const half = Math.ceil(changes.length / 2);
  return [{ seq: 0, changes: changes.slice(0, half) }, { seq: 0, changes: changes.slice(half) }];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run tasks with at most `limit` in flight. */
async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

// ── The installed engine (process-global, like the Postgres slot) ────────────────────────────

const SLOT = Symbol.for("denext.backend.realtime");
type Holder = { [SLOT]?: RealtimeEngine | { error: Error } };

/**
 * Install the engine (plugin setup), or clear it with `undefined` (tests).
 *
 * @param engine The engine, or the error the server API should throw.
 */
export function installRealtime(engine: RealtimeEngine | { error: Error } | undefined): void {
  (globalThis as Holder)[SLOT] = engine;
}

/** The installed engine, or why there is none. */
export function realtimeEngine(): RealtimeEngine {
  const slot = (globalThis as Holder)[SLOT];
  if (!slot) {
    throw new Error(
      "realtime is not configured: add backend({ postgres, realtime: realtime({ tables }) }) to denext.config.ts plugins",
    );
  }
  if ("error" in slot) throw slot.error;
  return slot;
}

/**
 * The signed-out subscriber's client address to key its quota on — `clientIpForLimits()` in the
 * Live connection's context (a public socket peer, or the trusted proxy's hop), as its limit
 * bucket (an IPv6 address's /64, so rotating within it does not mint a fresh quota) — or
 * `undefined` when it is not known, or is an untrusted loopback/private peer (a proxy every
 * visitor shares).
 */
function subscriberAddress(): string | undefined {
  try {
    return clientIpForLimits({ bucket: true });
  } catch {
    return undefined; // outside a request context: no address to key on
  }
}

/**
 * Create the realtime channel. The engine is looked up on every call, so a reinstall (a dev
 * reload) takes over the same channel id.
 */
export function createRealtimeChannel(): {
  publish(key: string, frame: TableChangesFrame): Promise<void>;
} {
  const engine = (): RealtimeEngine | undefined => {
    const slot = (globalThis as Holder)[SLOT];
    return slot && !("error" in slot) ? slot : undefined;
  };
  return createChannel<TableChangesFrame>({
    id: REALTIME_CHANNEL_ID,
    key: (key) => decodeSubscriptionKey(key) !== null,
    authorize: (ctx, key) => {
      const current: RealtimeEngine | undefined = engine();
      return current ? current.authorize(key, subscriberAddress() ?? ctx.peerId) : false;
    },
    authTtlSeconds: 60,
    onActive: (key) => {
      const current: RealtimeEngine | undefined = engine();
      if (current) current.activate(key);
    },
    onIdle: (key, reason) => {
      const current: RealtimeEngine | undefined = engine();
      if (current) current.deactivate(key, reason);
    },
  });
}

/**
 * React to every change of a realtime table on the server — keys only, in the service context
 * (no row-level security, no row data): invalidate a cache, enqueue a job, notify another
 * system. `fn` runs once per changed key per burst (the latest change per key), in the root
 * context, on EVERY server instance that has the listener up.
 *
 * ```ts
 * // instrumentation.ts (or any server module loaded at startup)
 * import { onTableChange } from "@denext/backend/server";
 * import { revalidateTag } from "denext/server";
 * onTableChange("notes", ({ op, key }) => void revalidateTag(`note:${key}`));
 * ```
 *
 * @param table A table from `realtime({ tables })`.
 * @param fn Called with `{ table, op, key, oldKey?, ts? }`; `op: "resync"` when changes may
 *   have been missed.
 * @returns An unsubscribe.
 * @throws {RealtimeUnsupportedError} When the Postgres client has no `listen`.
 * @throws {TypeError} For a table that is not configured.
 */
export function onTableChange(table: string, fn: (event: TableChangeEvent) => void): () => void {
  return realtimeEngine().hook(table, fn);
}

/**
 * Subscribe on the server to a realtime table's changes AS an identity — the same rows, under
 * the same row-level security, that `useTableChanges` delivers to a browser: for a server-sent
 * events stream, a GraphQL subscription, a worker acting for a user.
 *
 * ```ts
 * const stop = await tableChanges("notes", {
 *   as: { id: userId }, // default: the request's user (anon outside a request)
 *   onChange: ({ changes, resync }) => send(changes ?? "resync"),
 * });
 * ```
 *
 * @param table A table from `realtime({ tables })`.
 * @param options `as`, `filter` and the `onChange` callback.
 * @returns An unsubscribe.
 * @throws {RealtimeUnsupportedError} When the Postgres client has no `listen`.
 */
export function tableChanges(table: string, options: TableChangesOptions): Promise<() => void> {
  try {
    return realtimeEngine().subscribe(table, options);
  } catch (error) {
    return Promise.reject(error);
  }
}
