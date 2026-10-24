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
// A subscription whose connection closed is resumed when it comes back (replay, on by default):
// the engine journals every change it receives (realtime-journal.ts) and each subscription the
// position it was delivered up to; a reactivated one is first sent `resumed`, then — in the next
// flush, on its own — the journaled changes after its position, re-read as its subscriber and run
// through the same tracked-key rules as live changes. Frames still queued at the drop are kept
// and sent first. A gap the journal no longer covers (dropped for age or count, or a lost
// listener's resync) is a `resync` frame. A reconnect that finds no subscription (swept, or on
// another instance) is answered by neither, and the browser re-reads.
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

import { inRoot } from "./root-context.ts";
import {
  BOOT_DDL_ENV,
  bootDdlEnabled,
  bootMigrate,
  BootSchemaError,
  clientIpForLimits,
  createChannel,
  type Migration,
  revalidateTag,
  type SqlClient,
  type SqlListener,
  withMigrationLock,
} from "@denext/denext/server";
import { type DbIdentity, ensureRlsMigrated, type RlsScope } from "./rls.ts";
import { resolveScope, rlsReady, scopedFor } from "./postgres.ts";
import {
  decodeSubscriptionKey,
  type ParsedFilter,
  parseFilter,
  qualifiedTableName,
  REALTIME_CHANNEL_ID,
  REALTIME_NOTIFY_CHANNEL,
  type TableChange,
  type TableChangesFrame,
  type TableEvent,
  type TableFilter,
} from "./realtime-shared.ts";
import {
  dropTriggersSql,
  PUBLICATION_TABLES_SQL,
  type PublicationRow,
  publicationTable,
  realtimeMigrations,
  type RealtimeOptions,
  type ResolvedRealtime,
  type ResolvedTable,
  resolveRealtime,
  tableTrigger,
  triggerArgs,
} from "./realtime-sql.ts";
import { LogicalSource, releaseReserved, type Reserved } from "./realtime-logical.ts";
import { ChangeJournal } from "./realtime-journal.ts";

/** A change as the database reported it — keys only, before any re-read. */
export interface TableChangeEvent {
  /** The table, as configured. */
  table: string;
  /**
   * `insert`, `update`, `delete` or `truncate`; `resync` when changes may have been missed (the
   * listening connection was lost and is back, a burst overflowed, a key too long to send).
   */
  op: TableEvent | "resync";
  /** The row's key, as text (absent on `truncate` and `resync`). */
  key?: string;
  /** The key before an update that changed it. */
  oldKey?: string;
  /** When the trigger ran, in epoch milliseconds (absent on `resync`). */
  ts?: number;
}

/** A notification as parsed: a {@linkcode TableChangeEvent} plus the old row it may carry. */
export interface TableNotification extends TableChangeEvent {
  /** The row before an update or delete (a table configured `old: "full"`). */
  old?: Record<string, unknown>;
  /** The old row did not fit the notification. */
  oldOverflow?: true;
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

/**
 * How an audience's changes are worked out: `view` (`useTableChanges`, `tableChanges`) — `insert`
 * when a row enters the subscriber's view, `delete` when it leaves it; `raw` (Supabase's
 * `postgres_changes`) — the operation the database ran, sent only when the subscriber can see
 * the row (a delete: when they could see it before), filtered by `events`.
 */
type AudienceMode = "view" | "raw";

/** One subscription. */
interface Audience {
  key: string;
  table: ResolvedTable;
  filter?: ParsedFilter;
  mode: AudienceMode;
  /** The operations a `raw` audience is sent. */
  events?: ReadonlySet<TableEvent>;
  /** A frame's target size for this audience. */
  frameBytes: number;
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
  /** The journal position this subscription was delivered up to. */
  position: number;
  /** It came back after a disconnect: the next flush replays what it missed. */
  resume: boolean;
  /**
   * It was re-authorized while disconnected with other claims than it was read under: its kept
   * frames and journal position are not the new grant's, so its return is a `resync`.
   */
  regranted: boolean;
  /** When its last frame was published (epoch ms; 0: none yet). */
  sentAt: number;
}

/** The burst's change to a key after one more notification (`previous`: the burst's so far). */
function merge(
  previous: Pending | undefined,
  op: Pending["op"],
  event: TableNotification,
): Pending {
  const step: Step = { op };
  if (event.oldKey !== undefined) step.oldKey = event.oldKey;
  if (event.ts !== undefined) step.ts = event.ts;
  if (event.old) step.old = event.old;
  else if (event.oldOverflow) step.oldOverflow = true;
  const merged: Pending = {
    op: previous?.op === "insert" && op === "update" ? "insert" : op,
    steps: [...(previous?.steps ?? []), step].slice(-MAX_STEPS),
  };
  const oldKey = previous?.oldKey ?? event.oldKey;
  if (oldKey !== undefined && op !== "delete") merged.oldKey = oldKey;
  if (event.ts !== undefined) merged.ts = event.ts;
  // The image from before the burst: the first change's old row.
  const first = previous ?? event;
  if (first.old) merged.old = first.old;
  else if (first.oldOverflow) merged.oldOverflow = true;
  return merged;
}

/** A coalesced change to one key within a burst. */
interface Pending {
  op: Exclude<TableEvent, "truncate">;
  oldKey?: string;
  /** When the latest change was written (epoch ms). */
  ts?: number;
  /** The row as it was before the burst's first change to it (`old: "full"` tables). */
  old?: Record<string, unknown>;
  /** The old row was too large to carry. */
  oldOverflow?: true;
  /**
   * Every change to the key in the burst, in commit order (the last {@linkcode MAX_STEPS}):
   * a `raw` audience is sent each of them, as Supabase sends each WAL change.
   */
  steps: Step[];
}

/** One change to a key, as a `raw` audience is sent it. */
type Step = Omit<Pending, "steps">;

/** Changes to one key kept per burst for `raw` audiences. */
const MAX_STEPS = 64;

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
  /** Reconnected subscriptions resumed from the journal. */
  replays: number;
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
/** A `raw` audience's frame size (a server callback: no channel cap); larger rows are truncated. */
export const RAW_FRAME_BYTES = 1024 * 1024;
/** How long an audience with no subscriber is kept with replay off (a reconnect resyncs it). */
const IDLE_GRACE_MS = 15_000;
/** How often the publication's tables are read again. */
const PUBLICATION_POLL_MS = 10_000;
/** The publication `source: "logical"` keeps the configured tables in. */
const DENEXT_PUBLICATION = "denext_realtime";
/** Distinct filters one combined re-read statement evaluates (more go in further statements). */
const FILTERS_PER_QUERY = 64;
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

/**
 * The type of each column of a table (`format_type`, no modifier) and its type's name (`udt`:
 * `int8`, `timestamptz` — what Supabase's `columns` carry), by `$1::regclass`, in column order.
 */
export const COLUMN_TYPES_SQL = "select a.attname::text as name, " +
  "format_type(a.atttypid, null) as type, t.typname::text as udt, c.relrowsecurity as rls " +
  "from pg_attribute a join pg_type t on t.oid = a.atttypid join pg_class c on c.oid = a.attrelid " +
  "where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum";

/** A table's columns as Supabase's `postgres_changes` payload lists them. */
export interface ColumnInfo {
  /** The column. */
  name: string;
  /** Its type's name (`int8`, `text`, `uuid`, `timestamptz`, `_int4` …). */
  type: string;
}

/** A table's catalog, read once. */
interface Catalog {
  types: Map<string, string>;
  columns: ColumnInfo[];
  /**
   * Row-level security is off (the catalog says so): every subscriber may see every row, so an
   * old row may go to all of them, as Supabase sends it. Unknown counts as on.
   */
  open: boolean;
  /** When it was read (epoch ms): re-read after {@linkcode CATALOG_TTL_MS}. */
  at: number;
}

/** How long a table's catalog facts are trusted (a policy switched on is seen within this). */
const CATALOG_TTL_MS = 10_000;

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

/**
 * Gives up every session-level advisory lock the connection holds. A failed owner check can't
 * tell whether the lock was taken before the failure, so it releases them all — the reserved
 * connection is this engine's alone — before the connection goes back to the pool.
 */
const UNLOCK_ALL_SQL = "select pg_advisory_unlock_all()";

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
    replays: 0,
  };
  #client: () => SqlClient;
  #audiences = new Map<string, Audience>();
  #hooks = new Map<string, Set<(event: TableChangeEvent) => void>>();
  #pending = new Map<string, Map<string, Pending>>();
  #pendingCount = 0;
  #resyncTables = new Set<string>();
  /** Tables truncated in this burst (delivered before the burst's later changes), with when. */
  #truncated = new Map<string, number | undefined>();
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
  /** Each table's catalog, read once (by table name). */
  #types = new Map<string, Promise<Catalog>>();
  /** The logical-decoding source, when `source: "logical"`. */
  #logical: LogicalSource | null = null;
  /** The publication re-read timer, and the re-read in flight. */
  #publicationTimer: ReturnType<typeof setInterval> | null = null;
  #discovering: Promise<void> | null = null;
  #warnedTables = new Set<string>();
  /** Seed queries running, and those waiting for a turn. */
  #seeding = 0;
  #seedWaiters: Array<() => void> = [];
  /** Each owner's seed budget: tokens left, as of `at`. */
  #budgets = new Map<string, { tokens: number; at: number }>();
  /** The reconnect journal (`null`: replay is off). */
  #journal: ChangeJournal<TableNotification> | null;
  /** Subscriptions being replayed by the flush in progress (live delivery skips them). */
  #replaying = new Set<Audience>();

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
    const replay = this.config.replay;
    this.#journal = replay
      ? new ChangeJournal(replay.retentionSeconds * 1000, replay.maxChangesPerTable)
      : null;
  }

  /** The client, checked for `listen`. */
  #listenable(): SqlClient {
    const sql = this.#client();
    if (typeof sql.listen !== "function") throw new RealtimeUnsupportedError();
    return sql;
  }

  /**
   * A realtime table by the name it is subscribed under: the configured name, `table` (in
   * `public`), or `schema.table`.
   *
   * @param name The name.
   * @returns The table, or `undefined`.
   */
  lookup(name: string): ResolvedTable | undefined {
    const direct = this.config.tables.get(name);
    if (direct) return direct;
    const dot = name.indexOf(".");
    const schema = dot < 0 ? "public" : name.slice(0, dot);
    const table = dot < 0 ? name : name.slice(dot + 1);
    for (const t of this.config.tables.values()) {
      if (t.table === table && (t.schema ?? "public") === schema) return t;
    }
    return undefined;
  }

  /** The table, after the publication was read if it is not known yet. */
  async #resolve(name: string): Promise<ResolvedTable | undefined> {
    const known = this.lookup(name);
    if (known || !this.config.publication) return known;
    await this.start();
    return this.lookup(name);
  }

  /** The table's resolved options, or a TypeError naming the configured tables. */
  table(name: string): ResolvedTable {
    const table = this.lookup(name);
    if (!table) {
      throw new TypeError(
        `realtime: table ${JSON.stringify(name)} is not in realtime({ tables }) ` +
          `(configured: ${[...this.config.tables.keys()].join(", ")})`,
      );
    }
    return table;
  }

  /**
   * The migrations this engine applies on start: the realtime schema and the configured tables'
   * triggers (none of the triggers for the logical source).
   */
  migrations(): Migration[] {
    const configured = [...this.config.tables.values()].filter((t) => !t.fromPublication);
    const all: Migration[] = realtimeMigrations({
      tables: Object.fromEntries(
        configured.map((
          t,
        ) => [t.name, { events: t.events, key: t.key, schema: t.schema, old: t.old }]),
      ),
      publication: this.config.publication ?? false,
    });
    // The logical source needs no triggers.
    return this.config.source === "logical"
      ? all.filter((m) => !m.name.startsWith("backend_realtime_t_"))
      : all;
  }

  /** Apply the trigger migrations once (a failure is retried on the next call). */
  #migrate(sql: SqlClient): Promise<void> {
    if (!this.config.migrate) return Promise.resolve();
    const migrations = this.migrations();
    // The `anon` / `authenticated` roles first: the realtime schema grants to them. (An engine
    // built on its own client, with no `backend({ postgres })` installed, migrates that client.)
    this.#migrated ??= inRoot(() =>
      rlsReady().catch(() => ensureRlsMigrated(sql)).then(() =>
        bootMigrate(sql, {
          migrations,
          table: BACKEND_MIGRATIONS,
          feature: "backend({ realtime })",
        })
      )
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
      await this.#discover(sql);
      await this.#toggleTriggers(sql);
      this.#armDiscovery();
      if (this.config.source === "logical") return await this.#startLogical(sql);
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

  /** Re-read the publication every {@linkcode PUBLICATION_POLL_MS} (once). */
  #armDiscovery(): void {
    if (!this.config.publication || this.#publicationTimer !== null || this.#stopped) return;
    this.#publicationTimer = inRoot(() =>
      setInterval(() => {
        this.#discover(this.#client()).catch((error) =>
          console.error("[@denext/backend] realtime: reading the publication failed", error)
        );
      }, PUBLICATION_POLL_MS)
    );
    Deno.unrefTimer?.(this.#publicationTimer as unknown as number);
  }

  /**
   * Read the publication's tables: new ones join the registry (with their triggers, under the
   * notify source), dropped ones leave it (and lose their triggers). Single-flight.
   */
  #discover(sql: SqlClient): Promise<void> {
    if (!this.config.publication) return Promise.resolve();
    this.#discovering ??= this.#discoverOnce(sql).finally(() => {
      this.#discovering = null;
    });
    return this.#discovering;
  }

  async #discoverOnce(sql: SqlClient): Promise<void> {
    const rows = await sql.unsafe<PublicationRow>(PUBLICATION_TABLES_SQL, [
      this.config.publication,
    ]);
    const seen = new Set<string>();
    for (const row of rows) {
      const table = this.#publicationTableOf(row);
      if (!table) continue;
      seen.add(table.name);
      const known = this.config.tables.get(table.name);
      if (known && sameTable(known, table)) continue;
      if (this.config.source === "notify" && !(await this.#ensureTriggers(sql, table))) continue;
      this.config.tables.set(table.name, table);
      this.#types.delete(table.name);
    }
    for (const [name, table] of this.config.tables) {
      if (!table.fromPublication || seen.has(name)) continue;
      this.config.tables.delete(name);
      if (this.config.source === "notify") await dropTriggers(sql, table);
    }
  }

  /** A publication row as a table — `null` (warned once) when it cannot be one or is configured. */
  #publicationTableOf(row: PublicationRow): ResolvedTable | null {
    const table = publicationTable(row);
    if (typeof table === "string") {
      this.#warnTable(table);
      return null;
    }
    const configured = this.lookup(table.name);
    return configured && !configured.fromPublication ? null : table;
  }

  /**
   * Create a publication table's triggers unless they are there with the same arguments; `false`
   * (warned once) when they cannot be (the app's role does not own the table).
   */
  async #ensureTriggers(sql: SqlClient, table: ResolvedTable): Promise<boolean> {
    try {
      await this.#installTriggers(sql, table);
      return true;
    } catch (error) {
      this.#warnTable(`${table.name}: cannot install its trigger (${(error as Error).message})`);
      return false;
    }
  }

  #warnTable(message: string): void {
    if (this.#warnedTables.has(message)) return;
    this.#warnedTables.add(message);
    console.warn(`[@denext/backend] realtime: skipping publication table ${message}`);
  }

  /**
   * Create a table's triggers unless they are there with the same arguments — under the
   * migration lock, re-checked once it is held, so instances starting together create them
   * once and never race a migration run.
   */
  async #installTriggers(sql: SqlClient, table: ResolvedTable): Promise<void> {
    if (await triggersCurrent(sql, table)) return;
    if (!bootDdlEnabled()) {
      throw new BootSchemaError(`${BOOT_DDL_ENV}=off and its triggers are missing or out of date`);
    }
    await underMigrationLock(sql, async (tx) => {
      if (!(await triggersCurrent(tx, table))) await runStatements(tx, tableTrigger(table));
    });
  }

  /**
   * Turn the triggers of every realtime table on (notify source) or off (logical source: the WAL
   * carries the changes, and a trigger's NOTIFY would only cost commits).
   */
  async #toggleTriggers(sql: SqlClient): Promise<void> {
    const want = this.config.source === "notify" ? "O" : "D";
    const rows = await sql.unsafe<{ rel: string; name: string; enabled: string }>(
      "select tgrelid::regclass::text as rel, tgname::text as name, tgenabled::text as enabled " +
        "from pg_trigger where tgname in ('denext_realtime', 'denext_realtime_truncate')",
    );
    const ours = new Set(
      [...this.config.tables.values()].map((t) => t.qualified.replaceAll('"', "")),
    );
    for (const row of rows) {
      const rel = String(row.rel).replaceAll('"', "");
      const mine = ours.has(rel) || ours.has(`public.${rel}`);
      if (!mine || String(row.enabled) === want) continue;
      const verb = want === "O" ? "ENABLE" : "DISABLE";
      try {
        if (!bootDdlEnabled()) throw new Error(`${BOOT_DDL_ENV}=off`);
        await underMigrationLock(
          sql,
          async (tx) => void await tx.unsafe(`ALTER TABLE ${row.rel} ${verb} TRIGGER ${row.name}`),
        );
      } catch (error) {
        console.warn(
          `[@denext/backend] realtime: cannot ${verb.toLowerCase()} the trigger on ${row.rel}: ` +
            (error as Error).message,
        );
      }
    }
  }

  /** `source: "logical"`: keep the configured tables in `denext_realtime`, then open the slot. */
  async #startLogical(sql: SqlClient): Promise<void> {
    const configured = [...this.config.tables.values()].filter((t) => !t.fromPublication);
    if (configured.length > 0) await ensurePublication(sql, configured);
    const publications = [
      ...(configured.length > 0 ? [DENEXT_PUBLICATION] : []),
      ...(this.config.publication ? [this.config.publication] : []),
    ];
    const source = new LogicalSource({
      client: this.#client,
      publications: () => publications,
      tableOf: (schema, table) => this.lookup(`${schema}.${table}`) ?? null,
      emit: (event) => this.ingest(event),
      resync: () => this.#resyncAll(),
      pollMs: this.config.logical.pollMs,
      maxChanges: this.config.logical.maxChanges,
    });
    await source.start();
    if (this.#stopped) return void await source.stop();
    this.#logical = source;
  }

  /** Every table: changes may have been missed (journaled, so a replay over it resyncs too). */
  #resyncAll(): void {
    for (const name of this.config.tables.keys()) {
      this.#resyncTables.add(name);
      this.#journal?.append({ table: name, op: "resync" });
    }
    this.#schedule();
  }

  /** The listener subscribed — again, after a lost connection: changes may have been missed. */
  #onListen(): void {
    this.stats.listens++;
    if (this.stats.listens === 1) return;
    this.#resyncAll();
  }

  /**
   * Take one notification payload (from the listener).
   *
   * @param payload The trigger's JSON.
   */
  receive(payload: string): void {
    this.stats.notifications++;
    const event = parseNotification(payload);
    if (event) this.ingest(event);
  }

  /**
   * Take one change (a parsed notification, or one the logical source decoded).
   *
   * @param event The change.
   */
  ingest(event: TableNotification): void {
    const table = this.config.tables.get(event.table);
    if (!table) return;
    // The triggers fire only for the table's `events`; the WAL carries every change, so a kind
    // the table does not send is dropped here (a resync always passes).
    if (event.op !== "resync" && !table.events.includes(event.op)) return;
    this.#journal?.append(journaled(event));
    if (event.op === "truncate") {
      // Changes earlier in the burst are moot (the rows are gone); later ones follow it.
      const dropped = this.#pending.get(event.table)?.size ?? 0;
      this.#pending.delete(event.table);
      this.#pendingCount -= dropped;
      this.#truncated.set(event.table, event.ts);
    } else if (event.op === "resync" || this.#pendingCount >= MAX_PENDING) {
      this.#resyncTables.add(event.table);
    } else {
      this.#coalesce(event.table, event.key!, event);
    }
    this.#schedule();
  }

  /** Fold one change into the burst: the latest op per key wins (an insert stays an insert). */
  #coalesce(table: string, key: string, event: TableNotification): void {
    let byKey = this.#pending.get(table);
    if (!byKey) this.#pending.set(table, byKey = new Map());
    if (coalesceInto(byKey, key, event)) this.#pendingCount++;
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

  /** Deliver the burst gathered so far, and replay what reconnected subscriptions missed. */
  async #flushOnce(): Promise<void> {
    const pending = this.#pending;
    const resync = this.#resyncTables;
    const truncated = this.#truncated;
    // Every change of this burst is journaled at or before `head`.
    const head = this.#journal?.head ?? 0;
    this.#pending = new Map();
    this.#resyncTables = new Set();
    this.#truncated = new Map();
    this.#pendingCount = 0;
    const resuming = this.#takeResuming(head);
    if (pending.size === 0 && resync.size === 0 && truncated.size === 0 && !resuming.length) {
      return;
    }
    this.stats.flushes++;
    this.#sweep();
    const work: Array<() => Promise<void>> = resuming.map((audience) => () =>
      this.#replay(audience, head).finally(() => this.#replaying.delete(audience))
    );
    for (const [name, ts] of truncated) this.#truncateTable(name, ts);
    for (const name of resync) work.push(...this.#resyncTable(name));
    for (const [name, changes] of pending) {
      if (resync.has(name)) continue;
      work.push(...this.#deliverTable(name, changes));
    }
    this.#revalidate([...new Set([...resync, ...truncated.keys(), ...pending.keys()])]);
    await runLimited(work, REREAD_CONCURRENCY);
  }

  /**
   * The reconnected subscriptions this flush replays (marked as replaying, so live delivery skips
   * them); every other live one is current as of `head` once this burst is delivered.
   */
  #takeResuming(head: number): Audience[] {
    const resuming: Audience[] = [];
    for (const audience of this.#audiences.values()) {
      if (!audience.active) continue;
      if (audience.resume) {
        audience.resume = false;
        this.#replaying.add(audience);
        resuming.push(audience);
      } else if (!this.#replaying.has(audience)) {
        audience.position = head;
      }
    }
    return resuming;
  }

  /** Whether live delivery reaches the audience now (live, and not resuming or replaying). */
  #live(audience: Audience): boolean {
    return audience.active && !audience.resume && !this.#replaying.has(audience);
  }

  /**
   * Replay what a reconnected subscription missed: the journal's changes of its table after its
   * position (up to `head`), coalesced as one burst and re-read as its subscriber — or a `resync`
   * when the journal no longer covers the gap, or it holds a lost listener's resync.
   */
  async #replay(audience: Audience, head: number): Promise<void> {
    const entries = this.#journal?.since(audience.table.name, audience.position, head) ?? null;
    audience.position = head;
    if (!entries || entries.some((entry) => entry.event.op === "resync")) {
      return this.#enqueue(audience, { resync: true });
    }
    this.stats.replays++;
    let changes = new Map<string, Pending>();
    let truncated = false;
    for (const { event } of entries) {
      if (event.op === "truncate") {
        changes = new Map(); // the rows are gone: only what follows the truncate matters
        truncated = true;
      } else {
        coalesceInto(changes, event.key!, event);
      }
    }
    if (truncated && audience.tracked.size > 0) {
      audience.tracked.clear();
      this.#enqueue(audience, { changes: [{ op: "truncate" }] });
    }
    if (changes.size > 0) await this.#deliverGroup([audience], changes);
  }

  /** A table whose changes were lost: tell its hooks and subscribers to re-read. */
  #resyncTable(name: string): Array<() => Promise<void>> {
    this.#runHooks({ table: name, op: "resync" });
    for (const audience of this.#audiences.values()) {
      if (audience.table.name === name && this.#live(audience)) {
        this.#enqueue(audience, { resync: true });
      }
    }
    return [];
  }

  /**
   * A truncated table: its hooks, then every subscriber that could see rows of it forgets them
   * and is told.
   */
  #truncateTable(name: string, ts: number | undefined): void {
    this.#runHooks(
      ts === undefined ? { table: name, op: "truncate" } : { table: name, op: "truncate", ts },
    );
    for (const audience of this.#audiences.values()) {
      // Only a subscriber who could see rows hears of it: there is nothing to clear otherwise.
      if (audience.table.name !== name || !this.#live(audience) || audience.tracked.size === 0) {
        continue;
      }
      audience.tracked.clear();
      if (audience.mode === "raw" && !audience.events?.has("truncate")) continue;
      const change: TableChange = audience.mode === "raw" && ts !== undefined
        ? { op: "truncate", ts } as TableChange
        : { op: "truncate" };
      this.#enqueue(audience, { changes: [change] });
    }
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
      if (audience.table.name !== name || !this.#live(audience)) continue;
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
    // Stopped: the lock connection was (or is being) given back; reserving another would leave
    // it out of the pool with nobody to return it.
    if (this.#stopped) return false;
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
      // The connection may be dead (its lock went with it) or alive with the lock held (a
      // statement timeout, a cancel): release every advisory lock before it returns to the pool.
      if (this.#lockConn === pending) this.#lockConn = null;
      void pending.then((conn) => releaseReserved(conn, [[UNLOCK_ALL_SQL]])).catch(() => {});
      return false;
    }
  }

  /** Give the owner lock up and return its connection to the pool (it must not keep the lock). */
  async #releaseLock(): Promise<void> {
    const pending = this.#lockConn;
    this.#lockConn = null;
    if (!pending) return;
    try {
      await releaseReserved(await pending, [
        [`select pg_advisory_unlock(${OWNER_LOCK[0]}, ${OWNER_LOCK[1]})`],
      ]);
    } catch { /* never reserved: nothing is held */ }
  }

  /**
   * Re-read the burst's rows once for the group — one identity's subscriptions to one table,
   * whatever their filters — then work out each audience's changes. A failure with several
   * filters is retried filter by filter, so one bad filter value costs only its own audiences.
   */
  async #deliverGroup(group: Audience[], changes: Map<string, Pending>): Promise<void> {
    const [first] = group;
    const keys = [...changes].filter(([, c]) => c.op !== "delete").map(([key]) => key);
    const byFilter = byFilterOf(group);
    let rows: Map<string, Map<string, unknown>>;
    let open = false;
    try {
      rows = await this.#reread(first, [...byFilter.values()].map(([a]) => a.filter), keys);
      open = (await this.#catalog(first.table)).open;
    } catch (error) {
      return await this.#rereadFailed(group, byFilter, changes, error);
    }
    for (const audience of group) {
      const seen = rows.get(filterId(audience.filter))!;
      const out = audience.mode === "raw"
        ? rawChanges(audience, changes, seen, this.config.maxTrackedKeys, open)
        : audienceChanges(audience, changes, seen, this.config.maxTrackedKeys);
      for (const frame of toFrames(out, audience.frameBytes)) this.#enqueue(audience, frame);
    }
  }

  /**
   * A group's re-read failed: with several filters, each is retried on its own (one bad filter
   * value then costs only its own audiences); otherwise the group is told to re-read.
   */
  async #rereadFailed(
    group: Audience[],
    byFilter: Map<string, Audience[]>,
    changes: Map<string, Pending>,
    error: unknown,
  ): Promise<void> {
    if (byFilter.size > 1) {
      for (const same of byFilter.values()) await this.#deliverGroup(same, changes);
      return;
    }
    const { table } = group[0];
    this.#types.delete(table.name); // the table may have changed: read its types again
    console.error(`[@denext/backend] realtime re-read of ${table.name} failed`, error);
    for (const audience of group) this.#enqueue(audience, { resync: true });
  }

  /**
   * The rows among `keys` the audience's scope can SELECT, as parsed JSON, for each of `filters`
   * (by {@linkcode filterId}). One filter is one query (the filter in its WHERE); several share
   * one, each matched by a boolean column — so an identity's burst is one re-read per 1 000 keys
   * however many filters its subscriptions use.
   */
  async #reread(
    audience: Audience,
    filters: Array<ParsedFilter | undefined>,
    keys: string[],
  ): Promise<Map<string, Map<string, unknown>>> {
    const out = new Map(filters.map((filter) => [filterId(filter), new Map<string, unknown>()]));
    const { types } = await this.#catalog(audience.table);
    // One filter: its WHERE. Several: up to FILTERS_PER_QUERY boolean columns per statement.
    const batches = filters.length === 1 ? [filters] : Array.from(
      { length: Math.ceil(filters.length / FILTERS_PER_QUERY) },
      (_, n) => filters.slice(n * FILTERS_PER_QUERY, (n + 1) * FILTERS_PER_QUERY),
    );
    for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
      const chunk = keys.slice(i, i + KEYS_PER_QUERY);
      for (const batch of batches) {
        const { text, params } = batch.length === 1
          ? rereadQuery(audience.table, batch[0], chunk, types)
          : groupRereadQuery(audience.table, batch, chunk, types);
        this.stats.rereads++;
        const result = await this.#timed<Record<string, unknown>>(audience.scope, text, params);
        for (const row of result) sortRow(row, batch, out);
      }
    }
    return out;
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
  async #catalog(table: ResolvedTable): Promise<Catalog> {
    const known = this.#types.get(table.name);
    if (known) {
      const catalog = await known.catch(() => undefined);
      if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog;
      if (this.#types.get(table.name) === known) this.#types.delete(table.name);
      const again = this.#types.get(table.name);
      if (again) return await again;
    }
    const read = inRoot(() =>
      Promise.resolve().then(() =>
        this.#client().unsafe<{ name: string; type: string; udt?: string; rls?: boolean }>(
          COLUMN_TYPES_SQL,
          [table.qualified],
        )
      )
    ).then((rows) => ({
      types: new Map(rows.map((row) => [String(row.name), String(row.type)])),
      columns: rows.map((row) => ({ name: String(row.name), type: String(row.udt ?? row.type) })),
      open: rows.length > 0 && rows.every((row) => row.rls === false),
      at: Date.now(),
    }));
    this.#types.set(table.name, read);
    read.catch(() => {
      if (this.#types.get(table.name) === read) this.#types.delete(table.name);
    });
    return await read;
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

  /**
   * Send queued frames one by one, spaced so the Live hub never merges two of them — also a frame
   * queued just after the pump went idle (a truncate and the burst's re-read rows, a `resumed`
   * and its replay). A Live subscription whose subscriber is gone keeps the rest queued for its
   * reconnect.
   */
  async #pump(audience: Audience): Promise<void> {
    audience.pumping = true;
    const channel = "channel" in audience.sink;
    try {
      while (audience.queue.length > 0 && !this.#stopped) {
        if (channel && !audience.active) break;
        const wait = audience.sentAt + PACE_MS - Date.now();
        if (channel && wait > 0) {
          await sleep(wait);
          continue; // the subscriber may have left meanwhile
        }
        const frame = audience.queue.shift()!;
        frame.seq = ++audience.seq;
        if (await this.#send(audience, frame)) audience.sentAt = Date.now();
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
    this.#journal?.prune();
    const now = Date.now();
    const grace = this.config.replay ? this.config.replay.retentionSeconds * 1000 : IDLE_GRACE_MS;
    const cutoff = now - grace;
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
    if (!parts) return false;
    try {
      const table = await this.#resolve(parts.table);
      if (!table) return false;
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
    // A reconnect under other claims (a role, a tenant, a group changed): what was read and kept
    // for it was read under the old ones, so it is dropped and the return is a resync.
    if (audience.everActive && !audience.active && grantOf(scope) !== grantOf(audience.scope)) {
      audience.queue.length = 0;
      audience.regranted = true;
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
    mode?: AudienceMode;
    events?: ReadonlySet<TableEvent>;
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
    const mode = init.mode ?? "view";
    this.#audiences.set(init.key, {
      ...init,
      mode,
      frameBytes: mode === "raw" ? RAW_FRAME_BYTES : FRAME_BYTES,
      identity,
      owner,
      tracked,
      active: server,
      everActive: server,
      idleSince: Date.now(),
      seq: 0,
      queue: [],
      pumping: false,
      position: this.#journal?.head ?? 0,
      resume: false,
      regranted: false,
      sentAt: 0,
    });
    return true;
  }

  /** The keys the scope can see now (bounded): what a later delete may be sent for. */
  async #seed(
    table: ResolvedTable,
    filter: ParsedFilter | undefined,
    scope: RlsScope,
  ): Promise<Set<string>> {
    const { types } = await this.#catalog(table);
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

  /**
   * A key's first subscriber arrived (the channel's `onActive`). One coming back after a
   * disconnect is told `resumed` — and what it missed is replayed by the next flush — or, when
   * the journal no longer covers its gap (or replay is off), `resync`.
   */
  activate(key: string): void {
    const audience = this.#audiences.get(key);
    if (!audience) return;
    const again = audience.everActive && !audience.active;
    audience.active = audience.everActive = true;
    if (!again) return;
    const regranted = audience.regranted;
    audience.regranted = false;
    if (regranted || !this.#journal?.covers(audience.table.name, audience.position)) {
      audience.queue.length = 0; // superseded: the subscriber re-reads everything
      audience.position = this.#journal?.head ?? 0;
      return this.#enqueue(audience, { resync: true });
    }
    this.#enqueue(audience, { resumed: true });
    audience.resume = true;
    this.#schedule();
  }

  /**
   * A key's last subscriber left (the channel's `onIdle`). Unsubscribed (or revoked): forgotten
   * at once. Disconnected: kept for a reconnect of the same identity — swept after the replay
   * retention ({@linkcode IDLE_GRACE_MS} with replay off), or sooner when a cap needs the room.
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
    // With replay the frames not yet sent wait for the reconnect; without, it resyncs anyway.
    if (!this.#journal) audience.queue.length = 0;
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
    const name = options.schema ? qualifiedTableName(table, options.schema) : table;
    const resolved = (await this.#resolve(name)) ?? this.table(name);
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
   * A Supabase `postgres_changes` binding (the Phoenix socket's): `raw` changes of one table as
   * `scope`, filtered by `events`, counted against `owner`'s quota.
   *
   * @param init The table, filter, scope, events, quota owner and frame callback.
   * @returns The binding's handle, or `null` when a cap refused it.
   */
  async bind(init: {
    table: ResolvedTable;
    filter?: ParsedFilter;
    scope: RlsScope;
    owner: string;
    events: ReadonlySet<TableEvent>;
    onFrame: (frame: TableChangesFrame) => void;
  }): Promise<RealtimeBinding | null> {
    const key = `phx|${crypto.randomUUID()}`;
    const ok = await this.#admit({
      key,
      table: init.table,
      filter: init.filter,
      scope: init.scope,
      sink: { fn: init.onFrame },
      mode: "raw",
      events: init.events,
    }, init.owner);
    if (!ok) return null;
    return {
      stop: () => void this.#audiences.delete(key),
      rescope: (scope: RlsScope) => {
        const audience = this.#audiences.get(key);
        if (!audience || identityOf(scope) !== audience.identity) return false;
        audience.scope = scope;
        return true;
      },
    };
  }

  /**
   * A table's columns (name and type name), for Supabase's `columns` payload field.
   *
   * @param table The table.
   * @returns The columns, in order.
   */
  async columns(table: ResolvedTable): Promise<ColumnInfo[]> {
    return (await this.#catalog(table)).columns;
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

  /** How many changes the reconnect journal holds (0 when replay is off). */
  get journalSize(): number {
    return this.#journal?.size ?? 0;
  }

  /** Stop: UNLISTEN, cancel the burst, forget every subscription and hook. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#audiences.clear();
    this.#hooks.clear();
    this.#pending.clear();
    this.#journal?.clear();
    if (this.#publicationTimer !== null) clearInterval(this.#publicationTimer);
    this.#publicationTimer = null;
    await this.#listening?.catch(() => {});
    await this.#logical?.stop();
    this.#logical = null;
    const listener = this.#listener;
    this.#listener = null;
    await listener?.unlisten().catch(() => {});
    await this.#releaseLock();
  }
}

/** A `postgres_changes` binding held by {@linkcode RealtimeEngine.bind}. */
export interface RealtimeBinding {
  /** Drop it. */
  stop(): void;
  /** Take a refreshed scope of the same identity; `false` (unchanged) for another identity. */
  rescope(scope: RlsScope): boolean;
}

/** Options for {@linkcode tableChanges}. */
export interface TableChangesOptions {
  /** Who to read rows as (default: the current request's user, or anon outside a request). */
  as?: Exclude<DbIdentity, "service">;
  /** A one-column filter: `{ list_id: 42 }`, `{ n: { gte: 3 } }`, `"list_id=eq.42"`. */
  filter?: TableFilter;
  /** The table's schema (default `public`), for a table outside it. */
  schema?: string;
  /** Called with each frame: the changes this identity may see, or `resync`. */
  onChange: (frame: TableChangesFrame) => void;
}

/**
 * The identity a subscription key is bound to: `anon`, `authenticated:<sub>`, or — a token with
 * no subject — its whole grant ({@linkcode grantOf}).
 *
 * @param scope The subscriber's scope.
 * @returns The identity.
 */
export function identityOf(scope: RlsScope): string {
  if (scope.role === "anon") return "anon";
  const claims = JSON.parse(scope.claims) as { sub?: unknown };
  if (typeof claims.sub === "string" && claims.sub !== "") return `authenticated:${claims.sub}`;
  // No subject (a custom token): the grant itself is the identity, so two such callers with
  // different claims never share a subscription.
  return `authenticated?${grantOf(scope)}`;
}

/** Claims that change with every token refresh or session slide, not with what it may read. */
const VOLATILE_CLAIMS = new Set(["exp", "iat", "nbf", "jti"]);

/**
 * What a scope may read: its role and claims, canonical (keys sorted at every depth) and without
 * the claims a token refresh changes ({@linkcode VOLATILE_CLAIMS}). Two scopes with the same
 * grant see the same rows under any policy that does not read the time.
 *
 * @param scope The scope.
 * @returns The grant, as text.
 */
export function grantOf(scope: RlsScope): string {
  const claims = JSON.parse(scope.claims) as Record<string, unknown>;
  const kept = Object.fromEntries(
    Object.entries(claims ?? {}).filter(([name]) => !VOLATILE_CLAIMS.has(name)),
  );
  return `${scope.role}:${canonical(kept)}`;
}

/** JSON with every object's keys sorted. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether a re-read of the publication changed nothing about a table. */
function sameTable(a: ResolvedTable, b: ResolvedTable): boolean {
  return a.key === b.key && a.old === b.old && a.qualified === b.qualified;
}

/** The tracking table of the backend's migrations, whose runner's lock realtime DDL takes. */
const BACKEND_MIGRATIONS = "backend_migrations";

/**
 * Run realtime's DDL in a transaction holding the backend's migration lock (the one every boot
 * migration takes), with the server's notices silenced.
 */
function underMigrationLock<T>(sql: SqlClient, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
  return withMigrationLock(sql, { table: BACKEND_MIGRATIONS, quiet: true }, fn);
}

/**
 * Drop a table's realtime triggers (it left the publication), under the migration lock. With boot
 * DDL off they stay: they notify for a table no longer listened to.
 */
async function dropTriggers(sql: SqlClient, table: ResolvedTable): Promise<void> {
  if (!bootDdlEnabled()) return;
  await underMigrationLock(sql, (tx) => runStatements(tx, dropTriggersSql(table)));
}

/** Whether a table's two triggers are there with the arguments it needs now. */
async function triggersCurrent(sql: SqlClient, table: ResolvedTable): Promise<boolean> {
  const rows = await sql.unsafe<{ name: string; args: string }>(
    "select tgname::text as name, encode(tgargs, 'escape') as args from pg_trigger " +
      "where tgrelid = $1::regclass and tgname in ('denext_realtime', 'denext_realtime_truncate')",
    [table.qualified],
  );
  const expected = triggerArgs(table).map((arg) => `${arg}\\000`).join("");
  const row = rows.find((r) => r.name === "denext_realtime");
  return row?.args === expected && rows.length === 2;
}

/**
 * `source: "logical"`: the `denext_realtime` publication holds exactly the configured tables —
 * made so under the migration lock, or, with boot DDL off, checked (a {@linkcode BootSchemaError}
 * names what is missing).
 */
async function ensurePublication(sql: SqlClient, configured: ResolvedTable[]): Promise<void> {
  if (!bootDdlEnabled()) {
    const rows = await sql.unsafe<{ name: string }>(
      "select schemaname || '.' || tablename as name from pg_catalog.pg_publication_tables " +
        "where pubname = $1",
      [DENEXT_PUBLICATION],
    );
    const have = new Set(rows.map((r) => r.name));
    const missing = configured.map((t) => t.qualified.replaceAll('"', ""))
      .map((name) => name.includes(".") ? name : `public.${name}`)
      .filter((name) => !have.has(name));
    if (missing.length === 0) return;
    throw new BootSchemaError(
      `backend({ realtime }): ${BOOT_DDL_ENV}=off and the ${DENEXT_PUBLICATION} publication ` +
        `does not hold ${missing.join(", ")}: create it out of band ` +
        `(CREATE PUBLICATION ${DENEXT_PUBLICATION} FOR TABLE …)`,
      missing.map((name) => `publication:${DENEXT_PUBLICATION}:${name}`),
    );
  }
  const list = configured.map((t) => t.qualified).join(", ");
  await underMigrationLock(sql, async (tx) => {
    await tx.unsafe(
      `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = ` +
        `'${DENEXT_PUBLICATION}') THEN CREATE PUBLICATION ${DENEXT_PUBLICATION}; END IF; ` +
        `EXCEPTION WHEN duplicate_object THEN NULL; END $do$`,
    );
    await tx.unsafe(`ALTER PUBLICATION ${DENEXT_PUBLICATION} SET TABLE ${list}`);
  });
}

/** Run a script of statements (`;` + newline separated), in order, on `tx`. */
async function runStatements(tx: SqlClient, script: string): Promise<void> {
  const statements = script.split(/;\s*\n/).map((s) => s.trim().replace(/;$/, "")).filter(Boolean);
  for (const statement of statements) await tx.unsafe(statement);
}

/**
 * Audiences re-read as the same role and claims share a re-read — one query for all their
 * filters (see `#reread`).
 */
function groupId(audience: Audience): string {
  return JSON.stringify([audience.scope.role, audience.scope.claims]);
}

/**
 * File one re-read row under each of `filters` it matches: all of them for a single-filter
 * query (its WHERE already matched), else those whose `m<n>` column is true.
 */
function sortRow(
  row: Record<string, unknown>,
  filters: Array<ParsedFilter | undefined>,
  out: Map<string, Map<string, unknown>>,
): void {
  const parsed = JSON.parse(String(row.r));
  filters.forEach((filter, n) => {
    if (filters.length === 1 || row[`m${n}`] === true) {
      out.get(filterId(filter))!.set(String(row.k), parsed);
    }
  });
}

/** A group's audiences by filter (in first-seen order). */
function byFilterOf(group: Audience[]): Map<string, Audience[]> {
  const byFilter = new Map<string, Audience[]>();
  for (const audience of group) {
    const id = filterId(audience.filter);
    const same = byFilter.get(id);
    if (same) same.push(audience);
    else byFilter.set(id, [audience]);
  }
  return byFilter;
}

/** A filter's identity within a group (`""`: none). */
function filterId(filter: ParsedFilter | undefined): string {
  return filter ? JSON.stringify([filter.column, filter.op ?? "eq", filter.value]) : "";
}

/** The longest key the reconnect journal keeps (a longer one is journaled as a resync). */
const JOURNAL_KEY_CHARS = 1_024;

/**
 * What the reconnect journal keeps of a change: its keys and time only — never the old row a
 * `old: "full"` table carries (a replay re-reads rows; it never sends an old image) — and a
 * change whose key is longer than {@linkcode JOURNAL_KEY_CHARS} (the logical source does not
 * bound it) as a resync of its table, so a write cannot make the journal hold large values.
 *
 * @param event The change as received.
 * @returns What the journal keeps of it.
 */
export function journaled(event: TableNotification): TableNotification {
  const { table, op, key, oldKey, ts } = event;
  if (op === "resync" || (key?.length ?? 0) > JOURNAL_KEY_CHARS) return { table, op: "resync" };
  if ((oldKey?.length ?? 0) > JOURNAL_KEY_CHARS) return { table, op: "resync" };
  const entry: TableNotification = { table, op };
  if (key !== undefined) entry.key = key;
  if (oldKey !== undefined) entry.oldKey = oldKey;
  if (ts !== undefined) entry.ts = ts;
  return entry;
}

/**
 * Fold one change into a burst's changes by key: the latest op per key wins (an insert stays an
 * insert), moved to the end so the map keeps the commit order of each key's LAST change.
 *
 * @returns Whether the key is new to the burst.
 */
function coalesceInto(byKey: Map<string, Pending>, key: string, event: TableNotification): boolean {
  const previous = byKey.get(key);
  if (previous) byKey.delete(key);
  byKey.set(key, merge(previous, event.op as Pending["op"], event));
  return previous === undefined;
}

/** A notification payload, validated (malformed → `null`; overflow or no key → `resync`). */
export function parseNotification(payload: string): TableNotification | null {
  const value = jsonRecord(payload);
  if (!value || typeof value.table !== "string") return null;
  const { table, op } = value;
  if (op === "truncate") {
    return typeof value.ts === "number" ? { table, op, ts: value.ts } : { table, op };
  }
  if (op !== "insert" && op !== "update" && op !== "delete") return null;
  if (value.overflow === true || typeof value.key !== "string") return { table, op: "resync" };
  return withOld({
    table,
    op,
    key: value.key,
    ...(typeof value.old_key === "string" ? { oldKey: value.old_key } : {}),
    ...(typeof value.ts === "number" ? { ts: value.ts } : {}),
  }, value);
}

/** A notification's JSON object (bounded), or `null`. */
function jsonRecord(payload: string): Record<string, unknown> | null {
  if (typeof payload !== "string" || payload.length > 8_000) return null;
  try {
    const value = JSON.parse(payload);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The event with the old row the notification carries (or the note that it did not fit). */
function withOld(event: TableNotification, value: Record<string, unknown>): TableNotification {
  const old = value.old;
  if (old && typeof old === "object" && !Array.isArray(old)) {
    event.old = old as Record<string, unknown>;
  } else if (value.old_overflow === true) {
    event.oldOverflow = true;
  }
  return event;
}

/** The SQL operator of each comparison filter. */
const OPERATORS = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

/**
 * `t."column" <op> $n` in the column's own type (`$n::text::<type>`), so an index on the column
 * serves it; compared as text only when the type is unknown. `in` matches any of a JSON list
 * (`$n`) cast to the type. The column was validated as an identifier; the value is a parameter.
 */
function filterSql(filter: ParsedFilter, param: string, types: Map<string, string>): string {
  const { column } = filter;
  const type = types.get(column);
  if (filter.op === "in") {
    return type
      ? `t."${column}" = any(array(select jsonb_array_elements_text(${param}::jsonb)::${type}))`
      : `t."${column}"::text in (select jsonb_array_elements_text(${param}::jsonb))`;
  }
  const op = OPERATORS[filter.op ?? "eq"];
  return type
    ? `t."${column}" ${op} ${param}::text::${type}`
    : `t."${column}"::text ${op} ${param}`;
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
    text += ` and ${filterSql(filter, "$2", types)}`;
  }
  return { text, params };
}

/**
 * `select key, row, m0, m1, …` for the given keys under the caller's scope, where `m<n>` says
 * whether the row matches `filters[n]` (`false` for a NULL comparison): one re-read for several
 * subscriptions of one identity with different filters. Each filter value is its own parameter.
 */
function groupRereadQuery(
  table: ResolvedTable,
  filters: Array<ParsedFilter | undefined>,
  keys: string[],
  types: Map<string, string>,
): { text: string; params: unknown[] } {
  const base = rereadQuery(table, undefined, keys, types);
  const params = [...base.params];
  const columns = filters.map((filter, n) => {
    if (!filter) return `true as m${n}`;
    params.push(filter.value);
    return `coalesce(${filterSql(filter, `$${params.length}`, types)}, false) as m${n}`;
  });
  const text = base.text.replace(" as r from ", ` as r, ${columns.join(", ")} from `);
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
    text += ` where ${filterSql(filter, "$2", types)}`;
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
  const untrack = (key: string | undefined, old?: Record<string, unknown>) => {
    if (key === undefined || !audience.tracked.delete(key)) return;
    out.push(old ? { op: "delete", key, old } : { op: "delete", key });
  };
  for (const [key, change] of changes) {
    const row = change.op === "delete" ? undefined : rows.get(key);
    if (row === undefined) {
      untrack(key, change.old);
      untrack(change.oldKey, change.old);
    } else {
      const visible = visibleChange(audience.tracked, key, change.oldKey, row, maxTracked);
      if (visible.op === "update" && change.old) visible.old = change.old;
      out.push(visible);
    }
  }
  return out;
}

/**
 * One `raw` audience's changes for a burst (Supabase's semantics, under row-level security): an
 * insert or update is sent with the operation the database ran when the subscriber can see the
 * row now (and it is tracked); a delete is sent only for a tracked row — one the subscriber could
 * see. A row that left its view is untracked silently. Only `events` are sent.
 */
function rawChanges(
  audience: { tracked: Set<string>; events?: ReadonlySet<TableEvent> },
  changes: Map<string, Pending>,
  rows: Map<string, unknown>,
  maxTracked: number,
  open: boolean,
): TableChange[] {
  const out: TableChange[] = [];
  for (const [key, change] of changes) {
    // The row as it is now (re-read once per burst): every step of the key is judged by it.
    const row = change.op === "delete" ? undefined : rows.get(key) as Record<string, unknown>;
    // A table without row-level security: every old row is everyone's (Supabase sends it). Under
    // row-level security (or not known to be off) the old row is the subscriber's only if they
    // could see the row before this burst (it was tracked), and only on the burst's first step: a
    // later step's old row is an intermediate state nobody re-read for them (the row may have
    // left their view and come back). Everyone else gets the key alone in `old_record`, as
    // Supabase sends under row-level security.
    const firstOld = open || sawBefore(audience.tracked, key, change);
    change.steps.forEach((step, i) => {
      const sent = rawStep(audience.tracked, key, step, row, maxTracked, i === 0 ? firstOld : open);
      if (sent && (audience.events?.has(step.op) ?? true)) out.push(sent);
    });
  }
  return out;
}

/** One step of a key as a raw subscriber is sent it (or nothing), judged by the row as it is now. */
function rawStep(
  tracked: Set<string>,
  key: string,
  step: Step,
  row: Record<string, unknown> | undefined,
  maxTracked: number,
  withOld: boolean,
): TableChange | null {
  return step.op === "delete" || row === undefined
    ? rawGone(tracked, key, step, withOld)
    : rawVisible(tracked, key, step, row, maxTracked, withOld);
}

/**
 * Whether a subscriber could see a key's row before this burst (it was tracked, under its key or
 * its old one), with the burst's first step still the first change to it (not cut off by
 * {@linkcode MAX_STEPS}), so that step's old row is one they saw.
 */
function sawBefore(tracked: Set<string>, key: string, change: Pending): boolean {
  const first = change.steps[0];
  if (first === undefined || first.old !== change.old) return false;
  return tracked.has(key) || (first.oldKey !== undefined && tracked.has(first.oldKey));
}

/** What a raw change carries besides the row: when, and — when `withOld` — the old row. */
function rawExtra(change: Step, withOld: boolean): Record<string, unknown> {
  return {
    ...(change.ts === undefined ? {} : { ts: change.ts }),
    ...(withOld && change.old ? { old: change.old } : {}),
    ...(withOld && change.oldOverflow ? { oldOverflow: true } : {}),
  };
}

/**
 * A row the subscriber cannot see now: untracked; a DELETE is sent when they could see it before
 * (it was tracked), an update out of their view is not.
 */
function rawGone(
  tracked: Set<string>,
  key: string,
  change: Step,
  withOld: boolean,
): TableChange | null {
  const known = tracked.delete(key) ||
    (change.oldKey !== undefined && tracked.delete(change.oldKey));
  return known && change.op === "delete"
    ? { op: "delete", key, ...rawExtra(change, withOld) } as TableChange
    : null;
}

/**
 * A row the subscriber can see: tracked, and sent with the operation the database ran — its old
 * row only when `withOld` (they could see the row before).
 */
function rawVisible(
  tracked: Set<string>,
  key: string,
  change: Step,
  row: Record<string, unknown>,
  maxTracked: number,
  withOld: boolean,
): TableChange {
  if (change.oldKey !== undefined && change.oldKey !== key) tracked.delete(change.oldKey);
  if (!tracked.has(key) && tracked.size < maxTracked) tracked.add(key);
  const extra = rawExtra(change, withOld);
  if (change.op === "insert") return { op: "insert", key, row, ...extra } as TableChange;
  const renamed = change.oldKey === undefined ? {} : { oldKey: change.oldKey };
  return { op: "update", key, ...renamed, row, ...extra } as TableChange;
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

/**
 * Split changes into frames of about `limit` bytes ({@linkcode FRAME_BYTES} by default); an
 * oversized row is truncated.
 */
export function toFrames(
  changes: TableChange[],
  limit = FRAME_BYTES,
): Array<Omit<TableChangesFrame, "seq">> {
  const frames: Array<Omit<TableChangesFrame, "seq">> = [];
  let current: TableChange[] = [];
  let size = 0;
  for (let change of changes) {
    let bytes = encoder.encode(JSON.stringify(change)).byteLength;
    if (bytes > limit) {
      change = truncate(change);
      bytes = encoder.encode(JSON.stringify(change)).byteLength;
    }
    if (current.length > 0 && size + bytes > limit) {
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

/** A change without its row and old row (too large to send). */
function truncate(change: TableChange): TableChange {
  if (change.op === "truncate") return change;
  if (change.op === "delete") {
    const { old: _old, ...rest } = change;
    return rest;
  }
  const { row: _row, ...rest } = change as TableChange & { row?: unknown; old?: unknown };
  delete (rest as { old?: unknown }).old;
  return { ...rest, truncated: true } as TableChange;
}

/** Halve a frame the channel refused as too large (one change: drop its row). */
export function splitFrame(frame: TableChangesFrame): TableChangesFrame[] {
  const changes = frame.changes ?? [];
  if (changes.length <= 1) {
    return changes.length === 1 && changes[0].op !== "delete" && changes[0].op !== "truncate" &&
        !("truncated" in changes[0])
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
