// `realtime({ source: "logical" })`: changes read from the write-ahead log instead of NOTIFY.
//
// Each server instance creates a TEMPORARY logical replication slot with the built-in `pgoutput`
// plugin on a reserved connection (a temporary slot lives as long as its session, so an instance
// that dies leaves no slot holding WAL back), and reads it with
// `pg_logical_slot_get_binary_changes()` — plain SQL, so any client with `reserve()` can do it; no
// replication-protocol connection is needed. The slot streams the tables of the publications
// (`supabase_realtime`, and `denext_realtime` holding the configured tables), and each change
// becomes the same keys-only event a trigger would have sent: the rows are still re-read as each
// subscriber, under row-level security. What changes is the write path — no trigger and no
// `pg_notify` per row, so committing transactions no longer serialize on the notification queue —
// and the commit timestamp, which is the real one from the WAL.
//
// The slot is read with a bounded batch (`maxChanges`); a full batch is followed at once, an empty
// one waits `pollMs`. A lost connection loses its temporary slot: a new one is made, and every
// subscriber is told to re-read (changes in between were not seen).

import { inRoot } from "./root-context.ts";
import type { SqlClient } from "@denext/denext/server";
import type { ResolvedTable } from "./realtime-sql.ts";

/** A change as the engine ingests it (see `TableNotification` in realtime.ts). */
export interface LogicalEvent {
  table: string;
  op: "insert" | "update" | "delete" | "truncate" | "resync";
  key?: string;
  oldKey?: string;
  ts?: number;
  old?: Record<string, unknown>;
}

/** A relation as pgoutput describes it. */
interface Relation {
  schema: string;
  table: string;
  columns: Array<{ name: string; type: number }>;
}

/** One column value of a tuple: text, `null`, or unchanged TOAST (`undefined`). */
type Cell = string | null | undefined;

/** Microseconds between the Unix epoch and Postgres's (2000-01-01). */
const PG_EPOCH_MS = 946_684_800_000;

const decoder = new TextDecoder();

/** A cursor over one pgoutput message. */
class Reader {
  offset = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  ) {}
  u8(): number {
    return this.view.getUint8(this.offset++);
  }
  i16(): number {
    const value = this.view.getInt16(this.offset);
    this.offset += 2;
    return value;
  }
  i32(): number {
    const value = this.view.getInt32(this.offset);
    this.offset += 4;
    return value;
  }
  i64(): bigint {
    const value = this.view.getBigInt64(this.offset);
    this.offset += 8;
    return value;
  }
  /** A NUL-terminated string. */
  cstring(): string {
    const end = this.bytes.indexOf(0, this.offset);
    const text = decoder.decode(this.bytes.subarray(this.offset, end));
    this.offset = end + 1;
    return text;
  }
  /** TupleData: per column, `n` null, `u` unchanged TOAST, `t` text, `b` binary (as text). */
  tuple(): Cell[] {
    const count = this.i16();
    const cells: Cell[] = [];
    for (let i = 0; i < count; i++) {
      const kind = String.fromCharCode(this.u8());
      if (kind === "n") cells.push(null);
      else if (kind === "u") cells.push(undefined);
      else {
        const length = this.i32();
        cells.push(decoder.decode(this.bytes.subarray(this.offset, this.offset + length)));
        this.offset += length;
      }
    }
    return cells;
  }
}

/** Type oids whose text needs respelling to match `to_jsonb()`'s. */
const BOOL = 16;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;
const NUMBERS = new Set([20, 21, 23, 26, 700, 701, 1700]);
const JSONS = new Set([114, 3802]);

/**
 * A key as the trigger spells it (`to_jsonb(k) #>> '{}'`, a `timestamptz` in UTC): pgoutput sends
 * the type's text output, in the reading session's `TimeZone` (UTC).
 *
 * @param text The text value.
 * @param type The column's type oid.
 * @returns The key.
 */
export function keyText(text: string, type: number): string {
  if (type === BOOL) return text === "t" ? "true" : "false";
  if (type === TIMESTAMP) return text.replace(" ", "T");
  if (type === TIMESTAMPTZ) return text.replace(" ", "T").replace(/\+00(?::00)?$/, "");
  return text;
}

/** A value as `to_jsonb()` would give it (for an old row). */
function jsonValue(text: string, type: number): unknown {
  if (type === BOOL) return text === "t";
  if (NUMBERS.has(type)) {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  if (JSONS.has(type)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (type === TIMESTAMP) return text.replace(" ", "T");
  if (type === TIMESTAMPTZ) return text.replace(" ", "T").replace(/\+00$/, "+00:00");
  return text;
}

/** The pgoutput decoder: relations it has seen, and the transaction it is in. */
export class PgoutputDecoder {
  readonly #relations = new Map<number, Relation>();
  #commitTs: number | undefined;

  /**
   * @param tableOf The realtime table for a relation (`null`: not a realtime table).
   * @param emit Where events go.
   */
  constructor(
    readonly tableOf: (schema: string, table: string) => ResolvedTable | null,
    readonly emit: (event: LogicalEvent) => void,
  ) {}

  /** Forget every relation (a new slot: pgoutput sends them again). */
  reset(): void {
    this.#relations.clear();
    this.#commitTs = undefined;
  }

  /**
   * Decode one message.
   *
   * @param bytes The message (one row of `pg_logical_slot_get_binary_changes`).
   */
  decode(bytes: Uint8Array): void {
    const r = new Reader(bytes);
    const kind = String.fromCharCode(r.u8());
    switch (kind) {
      case "B": {
        r.i64(); // final LSN
        this.#commitTs = Number(r.i64() / 1000n) + PG_EPOCH_MS;
        return;
      }
      case "R":
        return this.#relation(r);
      case "I":
      case "U":
      case "D":
        return this.#change(kind, r);
      case "T":
        return this.#truncate(r);
      default:
        return; // C(ommit), Y(type), O(rigin), M(essage): nothing to deliver
    }
  }

  #relation(r: Reader): void {
    const oid = r.i32();
    const schema = r.cstring();
    const table = r.cstring();
    r.u8(); // replica identity
    const count = r.i16();
    const columns: Relation["columns"] = [];
    for (let i = 0; i < count; i++) {
      r.u8(); // flags
      const name = r.cstring();
      const type = r.i32();
      r.i32(); // typmod
      columns.push({ name, type });
    }
    this.#relations.set(oid, { schema, table, columns });
  }

  #change(kind: string, r: Reader): void {
    const relation = this.#relations.get(r.i32());
    const resolved = relation && this.tableOf(relation.schema, relation.table);
    if (!relation || !resolved) return;
    let before: Cell[] | undefined;
    let beforeFull = false;
    let marker = String.fromCharCode(r.u8());
    if (marker === "K" || marker === "O") {
      beforeFull = marker === "O";
      before = r.tuple();
      if (kind === "U") marker = String.fromCharCode(r.u8());
    }
    const after = marker === "N" ? r.tuple() : undefined;
    const keyAt = relation.columns.findIndex((column) => column.name === resolved.key);
    const keyType = relation.columns[keyAt]?.type ?? 0;
    const keyOf = (cells: Cell[] | undefined) => {
      const cell = cells?.[keyAt];
      return typeof cell === "string" ? keyText(cell, keyType) : undefined;
    };
    const event = this.#event(kind, resolved.name, keyOf(after), keyOf(before));
    if (!event) return;
    if (beforeFull && before && resolved.old === "full" && kind !== "I") {
      event.old = Object.fromEntries(
        relation.columns.flatMap((column, i) => {
          const cell = before![i];
          if (cell === undefined) return [];
          return [[column.name, cell === null ? null : jsonValue(cell, column.type)]];
        }),
      );
    }
    this.emit(event);
  }

  /** The event for one change (a change without its key is a resync of the table). */
  #event(
    kind: string,
    table: string,
    key: string | undefined,
    oldKey: string | undefined,
  ): LogicalEvent | null {
    const ts = this.#commitTs;
    const at = ts === undefined ? {} : { ts };
    if (kind === "D") {
      return oldKey === undefined
        ? { table, op: "resync" }
        : { table, op: "delete", key: oldKey, ...at };
    }
    if (key === undefined) return { table, op: "resync" };
    const op = kind === "I" ? "insert" : "update";
    const renamed = op === "update" && oldKey !== undefined && oldKey !== key ? { oldKey } : {};
    return { table, op, key, ...renamed, ...at };
  }

  #truncate(r: Reader): void {
    const count = r.i32();
    r.u8(); // options
    for (let i = 0; i < count; i++) {
      const relation = this.#relations.get(r.i32());
      const resolved = relation && this.tableOf(relation.schema, relation.table);
      if (!resolved) continue;
      const ts = this.#commitTs;
      this.emit(
        ts === undefined ? { table: resolved.name, op: "truncate" } : {
          table: resolved.name,
          op: "truncate",
          ts,
        },
      );
    }
  }
}

/** A `bytea` as the client returns it: bytes, or Postgres's `\x…` hex text. */
export function byteaOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" && value.startsWith("\\x")) {
    const hex = value.slice(2);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("realtime: unexpected bytea value from the client");
}

/** A reserved connection. */
export type Reserved = SqlClient & { release(): void | Promise<void> };

/** A statement {@linkcode releaseReserved} runs first: its text, and its parameters. */
export type Cleanup = readonly [text: string, params?: unknown[]];

/**
 * Give a reserved connection back to the pool with nothing of ours left on it. Each `cleanup`
 * statement runs first, best effort: a session-level lock, a temporary replication slot or a
 * session setting would otherwise ride the pooled connection to its next borrower. On a dead
 * connection they fail, and the server already dropped what the session held. Never throws.
 *
 * @param conn The reserved connection.
 * @param cleanup The statements that undo what this caller left on the session.
 */
export async function releaseReserved(conn: Reserved, cleanup: readonly Cleanup[]): Promise<void> {
  for (const [text, params] of cleanup) {
    await Promise.resolve(conn.unsafe(text, params)).then(() => {}, () => {});
  }
  await Promise.resolve().then(() => conn.release()).catch(() => {});
}

/** Options for {@linkcode LogicalSource}. */
export interface LogicalSourceOptions {
  /** The connecting role's client (with `reserve()`). */
  client: () => SqlClient;
  /** The publications the slot streams. */
  publications: () => string[];
  /** The realtime table for a relation. */
  tableOf: (schema: string, table: string) => ResolvedTable | null;
  /** Where events go. */
  emit: (event: LogicalEvent) => void;
  /** Changes may have been missed (a new slot): every table re-reads. */
  resync: () => void;
  /** The wait after an empty read, in milliseconds. */
  pollMs: number;
  /** Changes per read. */
  maxChanges: number;
}

/** Why logical decoding cannot run here. */
export class LogicalUnsupportedError extends Error {
  /** Build the error. */
  constructor(reason: string) {
    super(
      `realtime({ source: "logical" }): ${reason}. It needs wal_level = logical, a connecting ` +
        "role with the REPLICATION attribute (`alter role <app> replication`), and a client with " +
        "reserve() (Deno.SQL, or postgres.js through fromPostgresJs).",
    );
    this.name = "LogicalUnsupportedError";
  }
}

/** The logical-decoding source of one server instance. */
export class LogicalSource {
  readonly #options: LogicalSourceOptions;
  readonly #decoder: PgoutputDecoder;
  readonly #slot = `denext_rt_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  #conn: Reserved | null = null;
  #stopped = false;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  /** Reads made (diagnostics). */
  reads = 0;

  /** @param options The client, publications, table lookup and sinks. */
  constructor(options: LogicalSourceOptions) {
    this.#options = options;
    this.#decoder = new PgoutputDecoder(options.tableOf, options.emit);
  }

  /** Open the slot, then read it until stopped. Resolves once the slot exists. */
  async start(): Promise<void> {
    await this.#open();
    this.#loop = inRoot(() => this.#run());
  }

  /** Reserve a connection and create the temporary slot on it. */
  async #open(): Promise<void> {
    const sql = this.#options.client();
    if (typeof sql.reserve !== "function") throw new LogicalUnsupportedError("no reserve()");
    const conn = await sql.reserve() as Reserved;
    try {
      const [level] = await conn.unsafe<{ wal_level: string }>("show wal_level");
      if (level?.wal_level !== "logical") {
        throw new LogicalUnsupportedError(`wal_level is ${level?.wal_level ?? "unknown"}`);
      }
      await conn.unsafe("set TimeZone = 'UTC'");
      await conn.unsafe(
        "select pg_create_logical_replication_slot($1, 'pgoutput', true)",
        [this.#slot],
      );
    } catch (error) {
      await this.#retire(conn);
      if (error instanceof LogicalUnsupportedError) throw error;
      throw new LogicalUnsupportedError((error as Error).message);
    }
    this.#decoder.reset();
    this.#conn = conn;
  }

  /** Read until stopped; a failed read reopens the slot (and resyncs). */
  async #run(): Promise<void> {
    while (!this.#stopped) {
      let count = 0;
      try {
        count = await this.#read();
      } catch (error) {
        if (this.#stopped) return;
        console.error("[@denext/backend] realtime logical slot read failed; reopening", error);
        await this.#reopen();
        continue;
      }
      if (count < this.#options.maxChanges) await this.#sleep(this.#options.pollMs);
    }
  }

  /**
   * Return a slot connection: its temporary slot dropped and its TimeZone reset first. A read can
   * fail with the session alive (a statement timeout, a decode error): released as it was, the
   * pooled connection would keep the slot — pinning WAL for as long as it lives, and refusing the
   * next slot of the same name, so the source could never reopen — and the session setting.
   */
  #retire(conn: Reserved): Promise<void> {
    return releaseReserved(conn, [
      ["select pg_drop_replication_slot($1)", [this.#slot]],
      ["reset TimeZone"],
    ]);
  }

  async #reopen(): Promise<void> {
    const old = this.#conn;
    this.#conn = null;
    if (old) await this.#retire(old);
    while (!this.#stopped) {
      try {
        await this.#open();
        this.#options.resync();
        return;
      } catch (error) {
        console.error("[@denext/backend] realtime logical slot unavailable", error);
        await this.#sleep(1_000);
      }
    }
  }

  /** One read: decode every message; the number of rows read. */
  async #read(): Promise<number> {
    const conn = this.#conn;
    if (!conn) throw new Error("no slot connection");
    this.reads++;
    const rows = await conn.unsafe<{ data: unknown }>(
      "select data from pg_logical_slot_get_binary_changes($1, NULL, $2, " +
        "'proto_version', '1', 'publication_names', $3)",
      [this.#slot, this.#options.maxChanges, this.#options.publications().join(",")],
    );
    for (const row of rows) this.#decoder.decode(byteaOf(row.data));
    return rows.length;
  }

  /** Wait `ms` (unref'd), or until {@linkcode stop} wakes it. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      Deno.unrefTimer?.(timer as unknown as number);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }

  /** Stop reading, drop the slot, return the connection. */
  async stop(): Promise<void> {
    this.#stopped = true;
    // A loop asleep on an unref'd timer would otherwise keep stop() waiting with nothing else
    // alive to fire it.
    this.#wake?.();
    await this.#loop?.catch(() => {});
    const conn = this.#conn;
    this.#conn = null;
    if (conn) await this.#retire(conn);
  }
}
