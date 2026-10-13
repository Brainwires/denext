// The realtime bus: how broadcasts and presence changes reach every server instance sharing the
// database. Each instance LISTENs on `denext_realtime_bus` (one connection); a broadcast is one
// `pg_notify` — its message inline when it fits the 8000-byte NOTIFY limit, else stored in
// `realtime.messages` and sent by id — and every instance, the sender's included, delivers what
// it receives to its own sockets. `realtime.send()` (SQL) publishes the same way, so a database
// broadcast and a client's are one path.
//
// Presence is shared state: one row per tracked presence in `realtime.denext_presences`, owned by
// the instance holding the socket, which heartbeats `realtime.denext_instances`. A track or untrack
// changes the rows and NOTIFYs the diff; a joining channel reads the topic's rows for its
// `presence_state`. An instance that stops untracks its own; one that died stops heartbeating, and
// whichever instance next sweeps deletes its presences (atomically: `DELETE … RETURNING`, so the
// leaves are announced once) — the next sweep after the heartbeat window.

import type { SqlClient, SqlListener } from "@denext/denext/server";
import { REALTIME_BUS_CHANNEL } from "./realtime-sql.ts";

/** A broadcast, as the bus carries it. */
export interface BusBroadcast {
  /** The topic (`realtime:` stripped, as `realtime.messages.topic` holds it). */
  topic: string;
  /** A private channel's topic (a different topic from the public one of the same name). */
  private: boolean;
  /** The user's event name. */
  event: string;
  /** The payload: JSON-able, or raw bytes. */
  payload: unknown;
  /** The sending channel's id: it is not sent its own message (`broadcast.self: false`). */
  exclude?: string;
}

/** One tracked presence. */
export interface PresenceEntry {
  /** Unique per track (`phx_ref`). */
  ref: string;
  /** The presence key (`config.presence.key`, else a per-channel id). */
  key: string;
  /** What the client tracked. */
  meta: Record<string, unknown>;
}

/** A presence change on one topic. */
export interface PresenceDiff {
  topic: string;
  private: boolean;
  joins: PresenceEntry[];
  leaves: PresenceEntry[];
}

/** What the bus delivers to this instance. */
export interface BusHandlers {
  /** A broadcast for some topic (delivered to every instance, the sender's included). */
  broadcast(message: BusBroadcast): void;
  /** A presence diff for some topic. */
  presence(diff: PresenceDiff): void;
  /** A topic's presence changed by more than a NOTIFY carries: re-read its state. */
  presenceReload(topic: string, isPrivate: boolean): void;
  /** The listener re-subscribed after a lost connection: messages may have been missed. */
  resync(): void;
}

/** The bus an instance publishes on. */
export interface RealtimeBus {
  /** Listen (memoized): resolves once subscribed. */
  start(): Promise<void>;
  /** Publish a broadcast to every instance. */
  broadcast(message: BusBroadcast): Promise<void>;
  /** Track a presence (replacing the given refs of the same channel) and announce the diff. */
  track(
    topic: string,
    isPrivate: boolean,
    entry: PresenceEntry,
    replaces: PresenceEntry[],
  ): Promise<void>;
  /** Untrack presences (by their entries) and announce the leaves. */
  untrack(topic: string, isPrivate: boolean, entries: PresenceEntry[]): Promise<void>;
  /** A topic's current presences. */
  presenceState(topic: string, isPrivate: boolean): Promise<PresenceEntry[]>;
  /** Stop: untrack this instance's presences, UNLISTEN. */
  stop(): Promise<void>;
}

/** The NOTIFY payload's longest text. */
const MAX_NOTIFY = 7900;
/** How often an instance heartbeats (and sweeps dead instances). */
const HEARTBEAT_MS = 10_000;
/** An instance silent this long is dead: its presences are removed. */
const DEAD_AFTER_SECONDS = 30;
/** How long a stored (large) broadcast is kept in `realtime.messages`. */
const RETENTION = "1 day";
/** Every this many heartbeats, old stored messages are deleted. */
const CLEANUP_EVERY = 60;

/** A binary payload's marker when it travels as JSON (base64). */
const BINARY_KEY = "__denext_binary";

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** A payload as JSON: raw bytes as `{ __denext_binary: base64 }`. */
export function payloadToJson(payload: unknown): unknown {
  return payload instanceof Uint8Array ? { [BINARY_KEY]: toBase64(payload) } : payload ?? null;
}

/** The inverse of {@linkcode payloadToJson}. */
export function payloadFromJson(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && typeof record[BINARY_KEY] === "string") {
      return fromBase64(record[BINARY_KEY] as string);
    }
  }
  return value;
}

/** Entries as the wire carries them (short keys). */
function entriesOut(entries: PresenceEntry[]): unknown[] {
  return entries.map((entry) => ({ r: entry.ref, k: entry.key, m: entry.meta }));
}

function entriesIn(value: unknown): PresenceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const { r, k, m } = (item ?? {}) as { r?: unknown; k?: unknown; m?: unknown };
    return typeof r === "string" && typeof k === "string" && m && typeof m === "object"
      ? [{ ref: r, key: k, meta: m as Record<string, unknown> }]
      : [];
  });
}

/**
 * Parse one bus notification. A message stored by id (`k: "m"`) is fetched with `fetch`.
 *
 * @param text The NOTIFY payload.
 * @param handlers Where it goes.
 * @param fetch Reads a stored message.
 */
export async function receiveBus(
  text: string,
  handlers: BusHandlers,
  fetch: (id: string) => Promise<Omit<BusBroadcast, "exclude"> | null>,
): Promise<void> {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (!value || typeof value !== "object") return;
  const exclude = typeof value.x === "string" ? { exclude: value.x } : {};
  if (value.k === "m") {
    if (typeof value.id !== "string") return;
    const stored = await fetch(value.id);
    if (stored) handlers.broadcast({ ...stored, ...exclude });
    return;
  }
  const topic = value.t;
  if (typeof topic !== "string") return;
  const isPrivate = value.pr === true;
  if (value.k === "b" && typeof value.e === "string") {
    handlers.broadcast({
      topic,
      private: isPrivate,
      event: value.e,
      payload: payloadFromJson(value.p),
      ...exclude,
    });
  } else if (value.k === "pd") {
    handlers.presence({
      topic,
      private: isPrivate,
      joins: entriesIn(value.j),
      leaves: entriesIn(value.l),
    });
  } else if (value.k === "pr") {
    handlers.presenceReload(topic, isPrivate);
  }
}

type RootBridge = { __denextInRootContext?: <R>(fn: () => R) => R };

/** Run `fn` in the root async context: the bus serves every socket, not one request. */
function inRoot<T>(fn: () => T): T {
  const run = (globalThis as RootBridge).__denextInRootContext;
  return run ? run(fn) : fn();
}

/** Options for {@linkcode postgresBus}. */
export interface PostgresBusOptions {
  /** The connecting role's client (`db.service()`), resolved on each use. */
  client: () => SqlClient;
  /** This instance's id. */
  instance: string;
  /** Applies the realtime migrations (the tables the bus uses) before it listens. */
  ready: () => Promise<void>;
  /** Where messages go. */
  handlers: BusHandlers;
}

/**
 * The Postgres bus (LISTEN/NOTIFY + the presence tables).
 *
 * @param options The client, this instance's id, the migration gate and the handlers.
 * @returns The bus.
 */
export function postgresBus(options: PostgresBusOptions): RealtimeBus {
  const { client, instance, handlers } = options;
  let listening: Promise<void> | null = null;
  let listener: SqlListener | null = null;
  let listens = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let beats = 0;
  let stopped = false;

  const notify = async (body: Record<string, unknown>): Promise<void> => {
    await client().unsafe("select pg_notify($1, $2)", [REALTIME_BUS_CHANNEL, JSON.stringify(body)]);
  };

  /** Send a diff — or, too large to carry, tell every instance to re-read the topic. */
  const announce = (
    topic: string,
    isPrivate: boolean,
    joins: PresenceEntry[],
    leaves: PresenceEntry[],
  ) => {
    const diff = { k: "pd", t: topic, pr: isPrivate, j: entriesOut(joins), l: entriesOut(leaves) };
    const fits = new TextEncoder().encode(JSON.stringify(diff)).byteLength <= MAX_NOTIFY;
    return notify(fits ? diff : { k: "pr", t: topic, pr: isPrivate });
  };

  const fetchStored = async (id: string): Promise<Omit<BusBroadcast, "exclude"> | null> => {
    const [row] = await client().unsafe<
      { topic: string; event: string | null; payload: unknown; private: boolean | null }
    >(
      "select topic, event, payload, private from realtime.messages where id = $1::uuid and extension = 'broadcast'",
      [id],
    );
    if (!row) return null;
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    return {
      topic: String(row.topic),
      private: row.private === true,
      event: String(row.event ?? ""),
      payload: payloadFromJson(payload),
    };
  };

  /** Heartbeat this instance; remove the presences of instances that stopped beating. */
  const heartbeat = async (): Promise<void> => {
    const sql = client();
    await sql.unsafe(
      "insert into realtime.denext_instances (id, seen_at) values ($1::uuid, now()) " +
        "on conflict (id) do update set seen_at = now()",
      [instance],
    );
    const gone = await sql.unsafe<
      { topic: string; private: boolean; ref: string; key: string; meta: unknown }
    >(
      "with dead as (delete from realtime.denext_instances where seen_at < now() - " +
        `interval '${DEAD_AFTER_SECONDS} seconds' returning id) ` +
        "delete from realtime.denext_presences p where p.instance in (select id from dead) or " +
        "not exists (select 1 from realtime.denext_instances i where i.id = p.instance) " +
        "returning p.topic, p.private, p.ref, p.key, p.meta",
    );
    const byTopic = new Map<string, { topic: string; private: boolean; leaves: PresenceEntry[] }>();
    for (const row of gone) {
      const id = `${row.private ? 1 : 0}:${row.topic}`;
      const group = byTopic.get(id) ??
        { topic: String(row.topic), private: row.private === true, leaves: [] };
      group.leaves.push({ ref: String(row.ref), key: String(row.key), meta: metaOf(row.meta) });
      byTopic.set(id, group);
    }
    for (const group of byTopic.values()) {
      await announce(group.topic, group.private, [], group.leaves);
    }
    if (++beats % CLEANUP_EVERY === 0) {
      await sql.unsafe(
        `delete from realtime.messages where inserted_at < now() - interval '${RETENTION}'`,
      );
    }
  };

  const beat = () => {
    if (stopped) return;
    heartbeat().catch((error) =>
      console.error("[@denext/backend] realtime presence heartbeat failed", error)
    );
  };

  return {
    start() {
      if (stopped) return Promise.reject(new Error("realtime: the server is shutting down"));
      listening ??= inRoot(async () => {
        await options.ready();
        await heartbeat();
        const sql = client();
        listener = await sql.listen!(
          REALTIME_BUS_CHANNEL,
          (payload) =>
            inRoot(() =>
              void receiveBus(payload, handlers, fetchStored).catch((error) =>
                console.error("[@denext/backend] realtime bus message failed", error)
              )
            ),
          () =>
            inRoot(() => {
              if (++listens > 1) handlers.resync();
            }),
        );
        if (stopped) {
          await listener.unlisten().catch(() => {});
          return;
        }
        timer = setInterval(beat, HEARTBEAT_MS);
        Deno.unrefTimer?.(timer as unknown as number);
      }).catch((error) => {
        listening = null;
        throw error;
      });
      return listening;
    },

    async broadcast(message) {
      const body = {
        k: "b",
        t: message.topic,
        e: message.event,
        p: payloadToJson(message.payload),
        pr: message.private,
        ...(message.exclude ? { x: message.exclude } : {}),
      };
      const text = JSON.stringify(body);
      if (new TextEncoder().encode(text).byteLength <= MAX_NOTIFY) {
        await client().unsafe("select pg_notify($1, $2)", [REALTIME_BUS_CHANNEL, text]);
        return;
      }
      const [row] = await client().unsafe<{ id: string }>(
        "insert into realtime.messages (topic, extension, event, payload, private) " +
          "values ($1, 'broadcast', $2, $3::jsonb, $4::boolean) returning id::text as id",
        [message.topic, message.event, JSON.stringify(body.p), String(message.private)],
      );
      await notify({ k: "m", id: row.id, ...(message.exclude ? { x: message.exclude } : {}) });
    },

    async track(topic, isPrivate, entry, replaces) {
      const sql = client();
      await sql.begin(async (tx) => {
        if (replaces.length > 0) {
          await tx.unsafe(
            "delete from realtime.denext_presences where ref in " +
              "(select jsonb_array_elements_text($1::jsonb))",
            [JSON.stringify(replaces.map((r) => r.ref))],
          );
        }
        await tx.unsafe(
          "insert into realtime.denext_presences (ref, topic, private, key, meta, instance) " +
            "values ($1, $2, $3::boolean, $4, $5::jsonb, $6::uuid)",
          [entry.ref, topic, String(isPrivate), entry.key, JSON.stringify(entry.meta), instance],
        );
      });
      await announce(topic, isPrivate, [entry], replaces);
    },

    async untrack(topic, isPrivate, entries) {
      if (entries.length === 0) return;
      await client().unsafe(
        "delete from realtime.denext_presences where ref in " +
          "(select jsonb_array_elements_text($1::jsonb))",
        [JSON.stringify(entries.map((entry) => entry.ref))],
      );
      await announce(topic, isPrivate, [], entries);
    },

    async presenceState(topic, isPrivate) {
      const rows = await client().unsafe<{ ref: string; key: string; meta: unknown }>(
        "select ref, key, meta from realtime.denext_presences where topic = $1 and " +
          "private = $2::boolean order by inserted_at",
        [topic, String(isPrivate)],
      );
      return rows.map((row) => ({
        ref: String(row.ref),
        key: String(row.key),
        meta: metaOf(row.meta),
      }));
    },

    async stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await listening?.catch(() => {});
      const current = listener;
      listener = null;
      await current?.unlisten().catch(() => {});
      try {
        const sql = client();
        const gone = await sql.unsafe<
          { topic: string; private: boolean; ref: string; key: string; meta: unknown }
        >(
          "delete from realtime.denext_presences where instance = $1::uuid " +
            "returning topic, private, ref, key, meta",
          [instance],
        );
        for (const row of gone) {
          await announce(String(row.topic), row.private === true, [], [{
            ref: String(row.ref),
            key: String(row.key),
            meta: metaOf(row.meta),
          }]);
        }
        await sql.unsafe("delete from realtime.denext_instances where id = $1::uuid", [instance]);
      } catch { /* the database is gone too: the others' sweep removes them */ }
    },
  };
}

/** A presence meta column, parsed. */
function metaOf(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
}
