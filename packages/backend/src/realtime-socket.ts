// Supabase Realtime's wire protocol, served by the app: `/realtime/v1/websocket` speaks Phoenix
// channels (serializer vsn 1.0.0 and 2.0.0, see realtime-phoenix.ts) so the stock
// `@supabase/supabase-js` `supabase.channel(…)` works unchanged, and
// `POST /realtime/v1/api/broadcast` is the REST broadcast (`httpSend`, and `send()` before the
// socket is up).
//
// One hub per server instance holds the sockets and their channels:
//   - `postgres_changes` bindings are RealtimeEngine audiences in `raw` mode — every row re-read
//     AS the channel's user under row-level security, a delete sent only to a subscriber who could
//     see the row;
//   - broadcasts and presence go through the bus (realtime-bus.ts), so every instance on the
//     database delivers them; presence state lives in Postgres;
//   - a private channel is authorized by the `realtime.messages` policies (realtime-authz.ts).
//
// Who a socket is: its session cookie (same-origin upgrades only), re-read every minute — a
// changed or ended session closes the socket so the client reconnects as whoever it is now — or
// an access token (see realtime-identity.ts). A token's expiry closes its channels, as
// Supabase's does. Limits: connections per instance and per client address, channels per socket,
// events per second, frame and payload sizes, and a socket whose buffered output grows past a
// bound is closed rather than buffered without end.

import { clientIpForLimits } from "@denext/denext/server";
import { captureRequestContext, verifyOrigin } from "@denext/denext/plugin-kit";
import type { RealtimeBinding, RealtimeEngine } from "./realtime.ts";
import { DEFAULT_SOCKET_LIMITS, type ResolvedTable, type SocketLimits } from "./realtime-sql.ts";
import {
  type ParsedFilter,
  parseFilter,
  type TableChange,
  type TableChangesFrame,
  type TableEvent,
} from "./realtime-shared.ts";
import {
  decodeFrame,
  encodeBroadcast,
  encodeMessage,
  parseVsn,
  type PhxMessage,
  reply,
  type Vsn,
} from "./realtime-phoenix.ts";
import type {
  BusBroadcast,
  BusHandlers,
  PresenceDiff,
  PresenceEntry,
  RealtimeBus,
} from "./realtime-bus.ts";
import { type ChannelPermissions, PUBLIC_PERMISSIONS } from "./realtime-authz.ts";
import { isIdentityError } from "./identity.ts";
import {
  ANON_SOCKET_IDENTITY,
  apiKeyRefusal,
  type ExpiredToken,
  sessionIdentity,
  type SocketIdentity,
  subjectOf,
  tokenIdentity,
} from "./realtime-identity.ts";
import type { RlsScope } from "./rls.ts";

/** The WebSocket path (app-relative). */
const SOCKET_PATH = "/realtime/v1/websocket";
/** The REST broadcast path (app-relative). */
const BROADCAST_PATH = "/realtime/v1/api/broadcast";

/** A socket's output buffered past this is a consumer that cannot keep up: it is closed. */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** A socket silent this long (no heartbeat) is closed. */
const IDLE_MS = 75_000;
/** How often the cookie session behind a socket is re-read. */
const REAUTH_MS = 60_000;
/** The longest topic (`realtime:` included), in bytes. */
const MAX_TOPIC_BYTES = 255;
/** postgres_changes bindings per channel. */
const MAX_BINDINGS = 100;
/** The REST endpoint's body cap (a batch of messages). */
const REST_BODY_LIMIT = 1024 * 1024;
/** Messages per REST call. */
const MAX_REST_MESSAGES = 100;
/** Supabase's error for a too-large row. */
const TOO_LARGE = "Error 413: Payload Too Large";

const encoder = new TextEncoder();

/** The transport a connection writes to: a `WebSocket`, or a test double. */
export interface SocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  readonly readyState: number;
}

/** A `postgres_changes` binding of a channel. */
interface Binding {
  id: number;
  events: ReadonlySet<TableEvent>;
  tables: ResolvedTable[];
  filter?: ParsedFilter;
  handles: RealtimeBinding[];
  columns: Map<string, Array<{ name: string; type: string }>>;
  /** Supabase's `select`: the columns `new` / `old` keep (all when absent). */
  select?: ReadonlySet<string>;
}

/** A joined channel. */
interface Channel {
  conn: Connection;
  /** `realtime:<name>`. */
  topic: string;
  /** `<name>`. */
  sub: string;
  joinRef: string | null;
  /** Unique: a broadcast's `exclude`. */
  uid: string;
  private: boolean;
  identity: SocketIdentity;
  /** The identity came from the socket's cookie session (not a token). */
  fromSession: boolean;
  perms: ChannelPermissions;
  self: boolean;
  ack: boolean;
  presenceEnabled: boolean;
  presenceKey: string;
  presence: PresenceEntry[];
  bindings: Binding[];
  expiry: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

/** Client address info, captured at the upgrade. */
interface Peer {
  /** The per-address limit bucket, if there is one. */
  limitIp?: string;
}

/** What the hub needs from the rest of the backend. */
export interface HubDeps {
  /** The realtime engine (postgres_changes). */
  engine: RealtimeEngine;
  /** Builds the bus, given where its messages go. */
  bus: (handlers: BusHandlers) => RealtimeBus;
  /** Evaluates a private topic's policies. */
  permissions: (scope: RlsScope, topic: string) => Promise<ChannelPermissions>;
  /** The limits. */
  limits?: Partial<SocketLimits>;
}

/** A random token (base64url). */
function randomId(bytes = 12): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** A random positive 31-bit integer: a binding id. */
function bindingId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 1 || 1;
}

/** The byte size of a payload as JSON (raw bytes: their length). */
function sizeOf(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  try {
    return encoder.encode(JSON.stringify(value ?? null)).byteLength;
  } catch {
    return Infinity;
  }
}

/** A plain object, or `{}`. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** The Supabase event name of an engine op. */
const EVENT_NAME: Record<TableEvent, string> = {
  insert: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
  truncate: "TRUNCATE",
};

/**
 * A push's reply: an error always (when the client asked with a ref), `ok` only when `acked`.
 */
function answerer(
  channel: Channel,
  message: PhxMessage,
  acked: boolean,
): (status: "ok" | "error", reason?: string) => void {
  return (status, reason) => {
    if (message.ref === null || (status === "ok" && !acked)) return;
    channel.conn.send(reply(message, status, reason ? { reason } : {}));
  };
}

/** The engine ops one Supabase binding event selects. */
function eventsOf(event: unknown): ReadonlySet<TableEvent> | null {
  switch (typeof event === "string" ? event.toUpperCase() : event) {
    case "*":
      return new Set(["insert", "update", "delete", "truncate"]);
    case "INSERT":
      return new Set(["insert"]);
    case "UPDATE":
      return new Set(["update"]);
    case "DELETE":
      return new Set(["delete"]);
    case "TRUNCATE":
      return new Set(["truncate"]);
    default:
      return null;
  }
}

/**
 * One `postgres_changes` binding as the client sent it, validated: its events, the configured
 * tables it selects, its filter and its `select`.
 *
 * @throws {Error} With the reason the join is refused.
 */
function bindingOf(spec: Record<string, unknown>, configured: Iterable<ResolvedTable>): Binding {
  const events = eventsOf(spec.event);
  if (!events) throw new Error(`invalid postgres_changes event ${JSON.stringify(spec.event)}`);
  const tables = tablesFor(configured, spec.schema, spec.table);
  if (tables.length === 0) {
    throw new Error(
      "Unable to subscribe to changes with given parameters. Please check Realtime is " +
        `enabled for the given connect parameters: [schema: ${String(spec.schema)}, ` +
        `table: ${String(spec.table ?? "*")}, filters: ${String(spec.filter ?? "[]")}] ` +
        "(the table must be listed in backend({ realtime: { tables } }))",
    );
  }
  const binding: Binding = {
    id: bindingId(),
    events,
    tables,
    filter: bindingFilter(spec.filter, tables.length),
    handles: [],
    columns: new Map(),
  };
  if (Array.isArray(spec.select) && spec.select.length > 0) {
    binding.select = new Set(spec.select.filter((c): c is string => typeof c === "string"));
  }
  return binding;
}

/** A binding's filter (one table only), parsed. */
function bindingFilter(filter: unknown, tables: number): ParsedFilter | undefined {
  if (filter === undefined || filter === null || filter === "") return undefined;
  if (typeof filter !== "string") throw new Error("invalid filter: a string");
  if (tables !== 1) throw new Error("a filter needs one table, not a wildcard");
  return parseFilter(filter);
}

/** What the join reply echoes for a binding: the fields the client sent, and the id. */
function echoOf(spec: Record<string, unknown>, id: number): Record<string, unknown> {
  const out: Record<string, unknown> = { id, event: spec.event };
  for (const field of ["schema", "table", "filter", "select"] as const) {
    if (spec[field] !== undefined) out[field] = spec[field];
  }
  return out;
}

/** The configured tables one binding's `schema` / `table` select (`*` or absent: all). */
export function tablesFor(
  tables: Iterable<ResolvedTable>,
  schema: unknown,
  table: unknown,
): ResolvedTable[] {
  const anySchema = schema === undefined || schema === null || schema === "*";
  const anyTable = table === undefined || table === null || table === "*";
  return [...tables].filter((t) =>
    (anySchema || (t.schema ?? "public") === schema) && (anyTable || t.name === table)
  );
}

/**
 * One engine change as Supabase's `postgres_changes` `data`.
 *
 * @param table The table.
 * @param columns Its columns.
 * @param change The change.
 * @returns The `data` object.
 */
export function changeData(
  table: ResolvedTable,
  columns: Array<{ name: string; type: string }>,
  change: TableChange & { ts?: number; oldOverflow?: true },
): Record<string, unknown> {
  const errors = new Set<string>();
  const data: Record<string, unknown> = {
    schema: table.schema ?? "public",
    table: table.name,
    commit_timestamp: new Date(change.ts ?? Date.now()).toISOString(),
    type: EVENT_NAME[change.op],
    columns,
  };
  if (change.op === "insert" || change.op === "update") {
    if (change.truncated || !change.row) errors.add(TOO_LARGE);
    data.record = change.row ?? { [table.key]: change.key };
  }
  if (change.op === "update" || change.op === "delete") {
    if (change.oldOverflow) errors.add(TOO_LARGE);
    data.old_record = change.old ?? { [table.key]: oldKeyOf(change) };
  }
  data.errors = errors.size > 0 ? [...errors] : null;
  return data;
}

/** The key a change's row had before it. */
function oldKeyOf(change: TableChange): string | undefined {
  return change.op === "update" ? change.oldKey ?? change.key : change.key;
}

/** One socket. */
class Connection {
  readonly id = randomId();
  readonly channels = new Map<string, Channel>();
  identity: SocketIdentity;
  lastSeen = Date.now();
  #window = 0;
  #count = 0;
  #timers: Array<ReturnType<typeof setInterval>> = [];
  closed = false;

  constructor(
    readonly hub: RealtimeHub,
    readonly socket: SocketLike,
    readonly vsn: Vsn,
    readonly peer: Peer,
    identity: SocketIdentity,
    readonly reauth: (<T>(fn: () => T) => T) | null,
  ) {
    this.identity = identity;
    this.#timers.push(setInterval(() => this.#idleCheck(), IDLE_MS / 3));
    if (reauth) this.#timers.push(setInterval(() => void this.#reauthorize(), REAUTH_MS));
    for (const timer of this.#timers) Deno.unrefTimer?.(timer as unknown as number);
  }

  /** The quota owner for postgres_changes bindings. */
  get owner(): string {
    const subject = subjectOf(this.identity);
    return subject === "anon" ? `anon:${this.peer.limitIp ?? this.id}` : subject;
  }

  send(message: PhxMessage): void {
    this.#write(encodeMessage(this.vsn, message));
  }

  #write(data: string | Uint8Array): void {
    if (this.closed || this.socket.readyState !== 1) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED) {
      this.close(1013, "slow consumer");
      return;
    }
    try {
      this.socket.send(data);
    } catch {
      this.close(1011, "send failed");
    }
  }

  /** Send a user broadcast on a channel. */
  broadcast(channel: Channel, event: string, payload: unknown): void {
    const frame = encodeBroadcast(this.vsn, channel.topic, event, payload);
    if (frame !== null) this.#write(frame);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    try {
      this.socket.close(code, reason);
    } catch { /* already closing */ }
    this.dispose();
  }

  /** The socket closed: drop every channel. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.#timers) clearInterval(timer);
    for (const channel of [...this.channels.values()]) this.hub.drop(channel);
    this.hub.detach(this);
  }

  #idleCheck(): void {
    if (Date.now() - this.lastSeen > IDLE_MS) this.close(1000, "heartbeat timeout");
  }

  /**
   * Re-read the cookie session: a different subject (signed out, signed in as someone else, the
   * session ended) closes the socket so the client reconnects — and rejoins — as whoever it is
   * now; the same subject's refreshed claims replace the channels' scopes.
   */
  async #reauthorize(): Promise<void> {
    if (this.closed || !this.reauth) return;
    let next: SocketIdentity;
    try {
      next = await this.reauth(() => sessionIdentity());
    } catch {
      return; // the database is unavailable: keep the identity until the next check
    }
    if (subjectOf(next) !== subjectOf(this.identity)) {
      this.close(1000, "session changed");
      return;
    }
    this.identity = next;
    for (const channel of this.channels.values()) {
      if (channel.fromSession) this.hub.rescope(channel, next);
    }
  }

  /** Count one inbound message; `false` when the socket is over its rate. */
  admit(): boolean {
    const now = Date.now();
    this.lastSeen = now;
    if (now - this.#window >= 1000) {
      this.#window = now;
      this.#count = 0;
    }
    this.#count++;
    const limit = this.hub.limits.maxEventsPerSecond;
    if (this.#count > limit * 2) this.close(1008, "rate limit exceeded");
    return this.#count <= limit;
  }
}

/** The hub: every socket of this instance, and the topic → channels registry. */
export class RealtimeHub {
  readonly limits: SocketLimits;
  readonly #engine: RealtimeEngine;
  readonly #bus: RealtimeBus;
  readonly #permissions: HubDeps["permissions"];
  readonly #connections = new Set<Connection>();
  readonly #perAddress = new Map<string, number>();
  readonly #topics = new Map<string, Set<Channel>>();
  readonly #restBudgets = new Map<string, { tokens: number; at: number }>();
  #ready: Promise<void> | null = null;
  #stopped = false;

  constructor(deps: HubDeps) {
    this.#engine = deps.engine;
    this.#permissions = deps.permissions;
    this.limits = { ...DEFAULT_SOCKET_LIMITS, ...deps.limits };
    this.#bus = deps.bus({
      broadcast: (message) => this.#deliverBroadcast(message),
      presence: (diff) => this.#deliverPresence(diff),
      presenceReload: (topic, isPrivate) => void this.#reloadPresence(topic, isPrivate),
      resync: () => {
        for (const id of this.#topics.keys()) {
          const [flag, ...rest] = id.split(":");
          void this.#reloadPresence(rest.join(":"), flag === "1");
        }
      },
    });
  }

  /** How many sockets are open. */
  get size(): number {
    return this.#connections.size;
  }

  /** The engine listener and the bus, up (memoized; a failure is retried next time). */
  ready(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("realtime: the server is shutting down"));
    this.#ready ??= this.#engine.start().then(() => this.#bus.start()).catch((error) => {
      this.#ready = null;
      throw error;
    });
    return this.#ready;
  }

  /**
   * One REST call from `bucket` (a client address's limit bucket): `maxEventsPerSecond` a second,
   * a burst of as many; unlimited when the address is not known (as per-address limits are).
   *
   * @param bucket The address bucket.
   * @returns Whether it may proceed.
   */
  admitRest(bucket: string | undefined): boolean {
    if (bucket === undefined) return true;
    const now = Date.now();
    const rate = this.limits.maxEventsPerSecond;
    if (this.#restBudgets.size > 10_000) {
      for (const [key, budget] of this.#restBudgets) {
        if (now - budget.at > 1000) this.#restBudgets.delete(key);
      }
    }
    const budget = this.#restBudgets.get(bucket) ?? { tokens: rate, at: now };
    budget.tokens = Math.min(rate, budget.tokens + ((now - budget.at) / 1000) * rate);
    budget.at = now;
    this.#restBudgets.set(bucket, budget);
    if (budget.tokens < 1) return false;
    budget.tokens--;
    return true;
  }

  /** A refusal when the instance (or the address) holds its cap; `null` when there is room. */
  full(limitIp: string | undefined): Response | null {
    if (this.#connections.size >= this.limits.maxConnections) {
      return new Response("too many connections", { status: 503 });
    }
    if (
      limitIp !== undefined &&
      (this.#perAddress.get(limitIp) ?? 0) >= this.limits.maxConnectionsPerAddress
    ) {
      return new Response("too many connections from this address", { status: 429 });
    }
    return null;
  }

  /**
   * Take an upgraded socket.
   *
   * @param socket The socket.
   * @param vsn Its serializer version.
   * @param peer Its client address bucket.
   * @param identity Who it is (its cookie session, or anon).
   * @param reauth Re-enters its request to re-read the session (`null`: never — not a session).
   * @returns The message and close handlers to wire to it.
   */
  attach(
    socket: SocketLike,
    vsn: Vsn,
    peer: Peer,
    identity: SocketIdentity,
    reauth: (<T>(fn: () => T) => T) | null,
  ): { message(data: string | ArrayBuffer | Uint8Array): void; close(): void } {
    const conn = new Connection(this, socket, vsn, peer, identity, reauth);
    this.#connections.add(conn);
    if (peer.limitIp !== undefined) {
      this.#perAddress.set(peer.limitIp, (this.#perAddress.get(peer.limitIp) ?? 0) + 1);
    }
    return {
      message: (data) => {
        try {
          this.#receive(conn, data);
        } catch (error) {
          console.error("[@denext/backend] realtime message failed", error);
        }
      },
      close: () => conn.dispose(),
    };
  }

  /** A connection is gone. */
  // fallow-ignore-next-line unused-class-member -- called by Connection.dispose (same module)
  detach(conn: Connection): void {
    if (!this.#connections.delete(conn)) return;
    const ip = conn.peer.limitIp;
    if (ip === undefined) return;
    const left = (this.#perAddress.get(ip) ?? 1) - 1;
    if (left <= 0) this.#perAddress.delete(ip);
    else this.#perAddress.set(ip, left);
  }

  #receive(conn: Connection, data: string | ArrayBuffer | Uint8Array): void {
    const size = typeof data === "string" ? data.length : data.byteLength;
    if (size > this.limits.maxPayloadBytes + 64 * 1024) {
      conn.close(1009, "message too big");
      return;
    }
    if (!conn.admit()) return;
    const message = decodeFrame(conn.vsn, data);
    if (!message) return;
    if (message.topic === "phoenix" && message.event === "heartbeat") {
      conn.send(reply(message, "ok"));
      return;
    }
    if (message.event === "phx_join") {
      void this.#join(conn, message).catch((error) => {
        console.error("[@denext/backend] realtime join failed", error);
        conn.send(reply(message, "error", { reason: "join failed" }));
      });
      return;
    }
    const channel = conn.channels.get(message.topic);
    if (!channel || (message.joinRef !== null && message.joinRef !== channel.joinRef)) {
      if (message.ref !== null) conn.send(reply(message, "error", { reason: "unmatched topic" }));
      return;
    }
    switch (message.event) {
      case "phx_leave":
        conn.send(reply(message, "ok"));
        this.#close(channel, false);
        return;
      case "access_token":
        void this.#accessToken(channel, record(message.payload).access_token);
        return;
      case "broadcast":
        void this.#broadcast(channel, message);
        return;
      case "presence":
        void this.#presence(channel, message);
        return;
      default:
        if (message.ref !== null) conn.send(reply(message, "ok"));
    }
  }

  /** `phx_join`: authorize, bind, register, reply — then presence state and the system note. */
  async #join(conn: Connection, message: PhxMessage): Promise<void> {
    const { topic } = message;
    const fail = (reason: string) => conn.send(reply(message, "error", { reason }));
    if (!topic.startsWith("realtime:") || encoder.encode(topic).byteLength > MAX_TOPIC_BYTES) {
      return fail("invalid topic: realtime:<name>, at most 255 bytes");
    }
    const previous = conn.channels.get(topic);
    if (previous) this.#close(previous, true);
    if (conn.channels.size >= this.limits.maxChannelsPerConnection) {
      return fail(`Too many channels: at most ${this.limits.maxChannelsPerConnection} per socket`);
    }
    const payload = record(message.payload);
    const config = record(payload.config);
    const broadcast = record(config.broadcast);
    const presence = record(config.presence);
    const sub = topic.slice("realtime:".length);
    const resolved = await tokenIdentity(payload.access_token, conn.identity);
    if ("expired" in resolved) {
      return fail(`InvalidJWTToken: ${resolved.reason}`);
    }
    const channel: Channel = {
      conn,
      topic,
      sub,
      joinRef: message.joinRef,
      uid: `${conn.id}.${randomId(6)}`,
      private: config.private === true,
      identity: resolved,
      fromSession: resolved === conn.identity,
      perms: PUBLIC_PERMISSIONS,
      self: broadcast.self === true,
      ack: broadcast.ack === true,
      // A client from before `presence.enabled` existed always received presence.
      presenceEnabled: presence.enabled !== false,
      presenceKey: typeof presence.key === "string" && presence.key !== ""
        ? presence.key.slice(0, 255)
        : crypto.randomUUID(),
      presence: [],
      bindings: [],
      expiry: null,
      closed: false,
    };
    conn.channels.set(topic, channel); // claimed now: a leave or a re-join supersedes it
    try {
      await this.#admitChannel(conn, message, channel, config);
    } catch (error) {
      this.#forget(channel);
      throw error;
    }
  }

  /** The rest of a join, once the channel is claimed: authorize, bind, register, reply. */
  async #admitChannel(
    conn: Connection,
    message: PhxMessage,
    channel: Channel,
    config: Record<string, unknown>,
  ): Promise<void> {
    const { topic } = message;
    const { sub } = channel;
    const resolved = channel.identity;
    const fail = (reason: string) => conn.send(reply(message, "error", { reason }));
    if (channel.private) {
      channel.perms = await this.#permissions(resolved.scope, sub);
      if (!channel.perms.readBroadcast && !channel.perms.readPresence) {
        this.#forget(channel);
        return fail(
          `Unauthorized: You do not have permissions to read from this Channel topic: ${sub}`,
        );
      }
    }
    const specs = Array.isArray(config.postgres_changes) ? config.postgres_changes : [];
    let echoed: Array<Record<string, unknown>>;
    try {
      echoed = await this.#bind(channel, specs);
    } catch (error) {
      this.#forget(channel);
      return fail((error as Error).message);
    }
    if (channel.closed || conn.channels.get(topic) !== channel || conn.closed) {
      this.#forget(channel);
      return;
    }
    this.#register(channel);
    conn.send(reply(message, "ok", { postgres_changes: echoed }));
    if (channel.bindings.length > 0) {
      this.#system(channel, "postgres_changes", "ok", "Subscribed to PostgreSQL");
    }
    this.#armExpiry(channel);
    if (channel.presenceEnabled && (!channel.private || channel.perms.readPresence)) {
      await this.#sendPresenceState(channel);
    }
  }

  /**
   * The channel's `postgres_changes` bindings, as the engine's `raw` audiences — one per
   * configured table a binding selects. Returns what the join reply echoes: each binding as the
   * client sent it, with its id.
   */
  async #bind(channel: Channel, specs: unknown[]): Promise<Array<Record<string, unknown>>> {
    if (specs.length > MAX_BINDINGS) throw new Error(`at most ${MAX_BINDINGS} postgres_changes`);
    const echoed: Array<Record<string, unknown>> = [];
    try {
      for (const raw of specs) {
        const spec = record(raw);
        const binding = bindingOf(spec, this.#engine.config.tables.values());
        channel.bindings.push(binding);
        await this.#attachBinding(channel, binding, channel.identity.scope);
        echoed.push(echoOf(spec, binding.id));
      }
    } catch (error) {
      this.#unbind(channel);
      throw error;
    }
    return echoed;
  }

  /** Create a binding's engine audiences under `scope`. */
  async #attachBinding(channel: Channel, binding: Binding, scope: RlsScope): Promise<void> {
    for (const table of binding.tables) {
      binding.columns.set(table.name, await this.#engine.columns(table).catch(() => []));
      const handle = await this.#engine.bind({
        table,
        filter: binding.filter,
        scope,
        owner: channel.conn.owner,
        events: binding.events,
        onFrame: (frame) => this.#deliverChanges(channel, binding, table, frame),
      });
      if (!handle) throw new Error("Too many postgres_changes subscriptions");
      binding.handles.push(handle);
    }
  }

  #unbind(channel: Channel): void {
    for (const binding of channel.bindings) {
      for (const handle of binding.handles) handle.stop();
      binding.handles = [];
    }
  }

  /** Engine frames → `postgres_changes` messages (one per change). */
  #deliverChanges(
    channel: Channel,
    binding: Binding,
    table: ResolvedTable,
    frame: TableChangesFrame,
  ): void {
    if (channel.closed) return;
    if (frame.resync) {
      this.#system(
        channel,
        "postgres_changes",
        "error",
        "Changes may have been missed: re-read the table",
      );
    }
    const columns = binding.columns.get(table.name) ?? [];
    const kept = binding.select;
    const pick = (row: unknown) =>
      row && typeof row === "object"
        ? Object.fromEntries(Object.entries(row).filter(([column]) => kept!.has(column)))
        : row;
    for (const change of frame.changes ?? []) {
      const data = changeData(table, columns, change);
      if (kept) {
        if ("record" in data) data.record = pick(data.record);
        if ("old_record" in data) data.old_record = pick(data.old_record);
        data.columns = columns.filter((column) => kept.has(column.name));
      }
      channel.conn.send({
        joinRef: channel.joinRef,
        ref: null,
        topic: channel.topic,
        event: "postgres_changes",
        payload: { ids: [binding.id], data },
      });
    }
  }

  /** A `system` message on a channel. */
  #system(channel: Channel, extension: string, status: "ok" | "error", message: string): void {
    channel.conn.send({
      joinRef: channel.joinRef,
      ref: null,
      topic: channel.topic,
      event: "system",
      payload: { extension, status, message, channel: channel.sub },
    });
  }

  #key(isPrivate: boolean, topic: string): string {
    return `${isPrivate ? 1 : 0}:${topic}`;
  }

  #register(channel: Channel): void {
    const key = this.#key(channel.private, channel.sub);
    let set = this.#topics.get(key);
    if (!set) this.#topics.set(key, set = new Set());
    set.add(channel);
  }

  /** Remove a channel from the registries and its bindings, untracking its presence. */
  #forget(channel: Channel): void {
    channel.closed = true;
    if (channel.expiry !== null) clearTimeout(channel.expiry);
    channel.expiry = null;
    this.#unbind(channel);
    if (channel.conn.channels.get(channel.topic) === channel) {
      channel.conn.channels.delete(channel.topic);
    }
    const key = this.#key(channel.private, channel.sub);
    const set = this.#topics.get(key);
    if (set?.delete(channel) && set.size === 0) this.#topics.delete(key);
    if (channel.presence.length > 0) {
      const entries = channel.presence;
      channel.presence = [];
      this.#bus.untrack(channel.sub, channel.private, entries).catch((error) =>
        console.error("[@denext/backend] realtime untrack failed", error)
      );
    }
  }

  /** A connection went away: forget its channel. */
  // fallow-ignore-next-line unused-class-member -- called by Connection.dispose (same module)
  drop(channel: Channel): void {
    this.#forget(channel);
  }

  /** Close a channel: `phx_close` to the client when the server closes it, then forget it. */
  #close(channel: Channel, notify: boolean): void {
    if (channel.closed) return;
    if (notify) {
      channel.conn.send({
        joinRef: channel.joinRef,
        ref: null,
        topic: channel.topic,
        event: "phx_close",
        payload: {},
      });
    }
    this.#forget(channel);
  }

  /** Close the channel when its identity expires (Supabase: "Token has expired"). */
  #armExpiry(channel: Channel): void {
    if (channel.expiry !== null) clearTimeout(channel.expiry);
    channel.expiry = null;
    const at = channel.identity.expiresAt;
    if (at === undefined || channel.fromSession) return; // a session is re-read instead
    const delay = Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1);
    channel.expiry = setTimeout(() => {
      if (channel.closed) return;
      this.#system(channel, "system", "error", "Token has expired 0 seconds ago");
      this.#close(channel, true);
    }, delay);
    Deno.unrefTimer?.(channel.expiry as unknown as number);
  }

  /** The same subject's refreshed scope: the bindings and private permissions follow it. */
  rescope(channel: Channel, identity: SocketIdentity): void {
    channel.identity = identity;
    for (const binding of channel.bindings) {
      for (const handle of binding.handles) handle.rescope(identity.scope);
    }
  }

  /**
   * `access_token`: a refreshed token. Expired: the channel closes. The same subject: its scope
   * is refreshed. Another subject (an anonymous channel whose user signed in): the bindings are
   * re-created as that user and a private channel's policies evaluated again.
   */
  async #accessToken(channel: Channel, token: unknown): Promise<void> {
    const resolved: SocketIdentity | ExpiredToken = await tokenIdentity(
      token,
      channel.conn.identity,
    );
    if (channel.closed) return;
    if ("expired" in resolved) {
      this.#system(
        channel,
        "system",
        "error",
        resolved.reason,
      );
      this.#close(channel, true);
      return;
    }
    const changed = subjectOf(resolved) !== subjectOf(channel.identity);
    channel.fromSession = resolved === channel.conn.identity;
    if (!changed) {
      this.rescope(channel, resolved);
      this.#armExpiry(channel);
      return;
    }
    channel.identity = resolved;
    try {
      if (channel.private) {
        channel.perms = await this.#permissions(resolved.scope, channel.sub);
        if (!channel.perms.readBroadcast && !channel.perms.readPresence) {
          this.#system(
            channel,
            "system",
            "error",
            "Unauthorized: You do not have permissions to read from this Channel topic: " +
              channel.sub,
          );
          this.#close(channel, true);
          return;
        }
      }
      this.#unbind(channel);
      for (const binding of channel.bindings) {
        await this.#attachBinding(channel, binding, resolved.scope);
      }
      this.#armExpiry(channel);
    } catch (error) {
      this.#system(channel, "system", "error", (error as Error).message);
      this.#close(channel, true);
    }
  }

  /** A client broadcast: authorize, size, publish (to every instance), ack. */
  async #broadcast(channel: Channel, message: PhxMessage): Promise<void> {
    const body = record(message.payload);
    const answer = answerer(channel, message, channel.ack);
    if (typeof body.event !== "string" || body.event === "") {
      return answer("error", "an event name is required");
    }
    if (channel.private && !channel.perms.writeBroadcast) {
      return answer(
        "error",
        "Unauthorized: You do not have permissions to write to this Channel topic: " + channel.sub,
      );
    }
    if (sizeOf(body.payload) > this.limits.maxPayloadBytes) {
      return answer("error", `Payload too large: at most ${this.limits.maxPayloadBytes} bytes`);
    }
    try {
      await this.#bus.broadcast({
        topic: channel.sub,
        private: channel.private,
        event: body.event,
        payload: body.payload,
        ...(channel.self ? {} : { exclude: channel.uid }),
      });
      answer("ok");
    } catch (error) {
      console.error("[@denext/backend] realtime broadcast failed", error);
      answer("error", "broadcast failed");
    }
  }

  /** `presence` track / untrack. */
  async #presence(channel: Channel, message: PhxMessage): Promise<void> {
    const body = record(message.payload);
    const answer = answerer(channel, message, true);
    if (channel.private && !channel.perms.writePresence) {
      return answer(
        "error",
        "Unauthorized: You do not have permissions to track presence on this Channel topic: " +
          channel.sub,
      );
    }
    try {
      if (body.event === "track") {
        const meta = record(body.payload);
        if (sizeOf(meta) > this.limits.maxPayloadBytes) {
          return answer(
            "error",
            `Presence payload too large: at most ${this.limits.maxPayloadBytes} bytes`,
          );
        }
        const entry: PresenceEntry = { ref: randomId(), key: channel.presenceKey, meta };
        const replaces = channel.presence;
        channel.presence = [entry];
        await this.#bus.track(channel.sub, channel.private, entry, replaces);
        if (channel.closed) {
          await this.#bus.untrack(channel.sub, channel.private, [entry]);
          return;
        }
        return answer("ok");
      }
      if (body.event === "untrack") {
        const entries = channel.presence;
        channel.presence = [];
        await this.#bus.untrack(channel.sub, channel.private, entries);
        return answer("ok");
      }
      answer("error", "presence events are track and untrack");
    } catch (error) {
      console.error("[@denext/backend] realtime presence failed", error);
      answer("error", "presence failed");
    }
  }

  /** Presence as Phoenix's `{ key: { metas: [{ phx_ref, …meta }] } }`. */
  #presenceMap(
    entries: PresenceEntry[],
  ): Record<string, { metas: Array<Record<string, unknown>> }> {
    const out: Record<string, { metas: Array<Record<string, unknown>> }> = {};
    for (const entry of entries) {
      (out[entry.key] ??= { metas: [] }).metas.push({ ...entry.meta, phx_ref: entry.ref });
    }
    return out;
  }

  async #sendPresenceState(channel: Channel): Promise<void> {
    const entries = await this.#bus.presenceState(channel.sub, channel.private);
    if (channel.closed) return;
    channel.conn.send({
      joinRef: channel.joinRef,
      ref: null,
      topic: channel.topic,
      event: "presence_state",
      payload: this.#presenceMap(entries),
    });
  }

  /** Channels of a topic that receive presence. */
  #presenceAudience(topic: string, isPrivate: boolean): Channel[] {
    return [...this.#topics.get(this.#key(isPrivate, topic)) ?? []].filter((channel) =>
      !channel.closed && channel.presenceEnabled && (!channel.private || channel.perms.readPresence)
    );
  }

  #deliverPresence(diff: PresenceDiff): void {
    const channels = this.#presenceAudience(diff.topic, diff.private);
    if (channels.length === 0) return;
    const payload = {
      joins: this.#presenceMap(diff.joins),
      leaves: this.#presenceMap(diff.leaves),
    };
    for (const channel of channels) {
      channel.conn.send({
        joinRef: channel.joinRef,
        ref: null,
        topic: channel.topic,
        event: "presence_diff",
        payload,
      });
    }
  }

  async #reloadPresence(topic: string, isPrivate: boolean): Promise<void> {
    for (const channel of this.#presenceAudience(topic, isPrivate)) {
      await this.#sendPresenceState(channel).catch((error) =>
        console.error("[@denext/backend] realtime presence state failed", error)
      );
    }
  }

  #deliverBroadcast(message: BusBroadcast): void {
    for (const channel of this.#topics.get(this.#key(message.private, message.topic)) ?? []) {
      if (channel.closed || channel.uid === message.exclude) continue;
      if (channel.private && !channel.perms.readBroadcast) continue;
      channel.conn.broadcast(channel, message.event, message.payload);
    }
  }

  /**
   * Publish a broadcast (REST, or the server API): authorized by the caller already.
   *
   * @param message The message.
   */
  publish(message: BusBroadcast): Promise<void> {
    return this.ready().then(() => this.#bus.broadcast(message));
  }

  /** Stop: close every socket, untrack, UNLISTEN. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const conn of [...this.#connections]) conn.close(1001, "server shutting down");
    await this.#ready?.catch(() => {});
    await this.#bus.stop();
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * Whether a request comes from the app's own origin (or from no browser at all: no `Origin`).
 * Compared with the `Host` header, as denext's own same-origin check does, so a TLS-terminating
 * proxy in front of the app does not make every visitor cross-origin.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (!request.headers.has("host")) return origin === new URL(request.url).origin;
  return verifyOrigin(request, {});
}

/** The client's limit bucket, where per-address limits apply (inside the request). */
function limitBucket(): string | undefined {
  try {
    return clientIpForLimits({ bucket: true });
  } catch {
    return undefined;
  }
}

/**
 * Upgrade `/realtime/v1/websocket`.
 *
 * @param hub The hub.
 * @param request The upgrade request (inside its request context).
 * @returns The 101, or the refusal.
 */
export async function upgradeSocket(hub: RealtimeHub, request: Request): Promise<Response> {
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("expected a WebSocket upgrade", { status: 426 });
  }
  const url = new URL(request.url);
  const vsn = parseVsn(url.searchParams.get("vsn"));
  if (!vsn) return new Response("unsupported vsn: use 1.0.0 or 2.0.0", { status: 400 });
  const limitIp = limitBucket();
  const refused = hub.full(limitIp) ?? await notReady(hub);
  if (refused) return refused;
  const who = await socketIdentity(request, url);
  if (who instanceof Response) return who;
  const stillFull = hub.full(limitIp);
  if (stillFull) return stillFull;
  return accept(hub, request, vsn, limitIp, who);
}

/** A 503 when the listener or the bus cannot start; `null` once they are up. */
async function notReady(hub: RealtimeHub): Promise<Response | null> {
  try {
    await hub.ready();
    return null;
  } catch (error) {
    console.error("[@denext/backend] realtime is unavailable", error);
    return new Response("realtime is unavailable", { status: 503 });
  }
}

/**
 * Who an upgrading socket is (and how to re-read it), or the 401 refusing it: with
 * `backend({ supabase })` keys installed it must carry a valid `apikey`; a same-origin socket is
 * its session's user, any other `anon`.
 */
async function socketIdentity(
  request: Request,
  url: URL,
): Promise<{ identity: SocketIdentity; reauth: (<T>(fn: () => T) => T) | null } | Response> {
  const unauthorized = (error: string) => new Response(JSON.stringify({ error }), { status: 401 });
  const refusal = await apiKeyRefusal(url.searchParams.get("apikey"));
  if (refusal) return unauthorized(refusal);
  if (!sameOrigin(request)) return { identity: ANON_SOCKET_IDENTITY, reauth: null };
  try {
    return { identity: await sessionIdentity(), reauth: captureRequestContext() };
  } catch (error) {
    if (!isIdentityError(error)) throw error;
    return unauthorized(error.message);
  }
}

/** Upgrade and attach the socket. */
function accept(
  hub: RealtimeHub,
  request: Request,
  vsn: Vsn,
  limitIp: string | undefined,
  who: { identity: SocketIdentity; reauth: (<T>(fn: () => T) => T) | null },
): Response {
  const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",")
    .map((p) => p.trim());
  let upgrade: { socket: WebSocket; response: Response };
  try {
    upgrade = Deno.upgradeWebSocket(request, {
      idleTimeout: 120,
      ...(offered.includes("phoenix") ? { protocol: "phoenix" } : {}),
    });
  } catch {
    return new Response("upgrade failed", { status: 400 });
  }
  const { socket } = upgrade;
  socket.binaryType = "arraybuffer";
  const handlers = hub.attach(
    socket,
    vsn,
    limitIp === undefined ? {} : { limitIp },
    who.identity,
    who.reauth,
  );
  socket.onmessage = (event) => handlers.message(event.data);
  socket.onclose = () => handlers.close();
  socket.onerror = () => handlers.close();
  return upgrade.response;
}

/** CORS for the REST endpoint: any origin, no credentials (a cross-site call is never the cookie's user). */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-max-age": "86400",
};

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, ...(body === null ? {} : { "content-type": "application/json" }) },
  });
}

/** The REST caller's identity: a bearer token, else (same-origin) the session, else anon. */
async function restIdentity(request: Request): Promise<SocketIdentity | ExpiredToken> {
  const refusal = await apiKeyRefusal(request.headers.get("apikey"));
  if (refusal) return { expired: true, agoSeconds: 0, reason: refusal };
  let fallback: SocketIdentity;
  try {
    fallback = sameOrigin(request) ? await sessionIdentity() : ANON_SOCKET_IDENTITY;
  } catch (error) {
    if (!isIdentityError(error)) throw error;
    return { expired: true, agoSeconds: 0, reason: error.message };
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  return await tokenIdentity(bearer, fallback);
}

/** Read the body (capped). */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > REST_BODY_LIMIT) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > REST_BODY_LIMIT ? null : bytes;
}

/**
 * `POST /realtime/v1/api/broadcast` (`{ messages: [{ topic, event, payload, private? }] }`) and
 * `POST /realtime/v1/api/broadcast/<topic>/events/<event>[?private=true]` (one message, JSON or
 * `application/octet-stream`). 202 once published.
 *
 * @param hub The hub.
 * @param request The request (inside its request context).
 * @param rest The path after `/realtime/v1/api/broadcast`.
 * @returns The response.
 */
async function restBroadcast(
  hub: RealtimeHub,
  request: Request,
  rest: string,
): Promise<Response> {
  if (request.method === "OPTIONS") return json(204, null);
  if (request.method !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!hub.admitRest(limitBucket())) return json(429, { error: "Too many requests" });
  const identity = await restIdentity(request);
  if ("expired" in identity) {
    return json(401, { error: identity.reason });
  }
  const body = await readBody(request);
  if (!body) return json(413, { error: "Payload too large" });
  let messages: BusBroadcast[];
  try {
    messages = restMessages(request, rest, body);
  } catch (error) {
    return json(400, { error: (error as Error).message });
  }
  for (const message of messages) {
    if (sizeOf(message.payload) > hub.limits.maxPayloadBytes) {
      return json(413, { error: "Payload too large" });
    }
    if (!message.private) continue;
    const perms = await hubPermissions(hub, identity.scope, message.topic);
    if (!perms.writeBroadcast) {
      return json(403, {
        error:
          `Unauthorized: You do not have permissions to write to this Channel topic: ${message.topic}`,
      });
    }
  }
  try {
    for (const message of messages) await hub.publish(message);
  } catch (error) {
    console.error("[@denext/backend] realtime REST broadcast failed", error);
    return json(503, { error: "realtime is unavailable" });
  }
  return json(202, null);
}

/** The permissions function a hub was built with, reached for REST. */
const permissionsOf = new WeakMap<RealtimeHub, HubDeps["permissions"]>();

function hubPermissions(
  hub: RealtimeHub,
  scope: RlsScope,
  topic: string,
): Promise<ChannelPermissions> {
  const fn = permissionsOf.get(hub);
  return fn ? fn(scope, topic) : Promise.resolve({ ...PUBLIC_PERMISSIONS, writeBroadcast: false });
}

/**
 * Build a hub (and remember its permissions function for the REST endpoint).
 *
 * @param deps The engine, bus factory, permissions and limits.
 * @returns The hub.
 */
export function createHub(deps: HubDeps): RealtimeHub {
  const hub = new RealtimeHub(deps);
  permissionsOf.set(hub, deps.permissions);
  return hub;
}

/** The messages of a REST call. */
function restMessages(request: Request, rest: string, body: Uint8Array): BusBroadcast[] {
  const single = /^\/([^/]+)\/events\/([^/]+)$/.exec(rest);
  if (single) {
    const topic = decodeURIComponent(single[1]);
    const event = decodeURIComponent(single[2]);
    const binary = (request.headers.get("content-type") ?? "").startsWith(
      "application/octet-stream",
    );
    const payload = binary ? body : JSON.parse(new TextDecoder().decode(body));
    const isPrivate = new URL(request.url).searchParams.get("private") === "true";
    return [checkMessage({ topic, event, payload, private: isPrivate })];
  }
  if (rest !== "" && rest !== "/") throw new Error("no such endpoint");
  const parsed = record(JSON.parse(new TextDecoder().decode(body)));
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    throw new Error("messages: a non-empty list is required");
  }
  if (parsed.messages.length > MAX_REST_MESSAGES) {
    throw new Error(`messages: at most ${MAX_REST_MESSAGES} per request`);
  }
  return parsed.messages.map((raw) => {
    const message = record(raw);
    return checkMessage({
      topic: message.topic as string,
      event: message.event as string,
      payload: message.payload,
      private: message.private === true,
    });
  });
}

function checkMessage(message: BusBroadcast): BusBroadcast {
  if (
    typeof message.topic !== "string" || message.topic === "" ||
    encoder.encode(message.topic).byteLength > MAX_TOPIC_BYTES - 9
  ) {
    throw new Error("topic: a non-empty string of at most 246 bytes");
  }
  if (typeof message.event !== "string" || message.event === "" || message.event.length > 255) {
    throw new Error("event: a non-empty string");
  }
  return message;
}

// ── The installed hub (process-global, like the engine) ──────────────────────

const SLOT = Symbol.for("denext.backend.realtimeHub");
type Holder = { [SLOT]?: RealtimeHub };

/**
 * Install the hub (plugin setup), or clear it with `undefined` (tests).
 *
 * @param hub The hub.
 */
export function installRealtimeHub(hub: RealtimeHub | undefined): void {
  (globalThis as Holder)[SLOT] = hub;
}

/**
 * The request handler for `/realtime/v1/*` (registered by the plugin when realtime is on).
 *
 * @param request The request (app-relative).
 * @returns The response, or `null` for any other path.
 */
export function handleRealtimeRequest(request: Request): Promise<Response> | null {
  const { pathname } = new URL(request.url);
  const hub = (globalThis as Holder)[SLOT];
  if (!hub) return null;
  if (pathname === SOCKET_PATH) return upgradeSocket(hub, request);
  if (pathname === BROADCAST_PATH || pathname.startsWith(BROADCAST_PATH + "/")) {
    return restBroadcast(hub, request, pathname.slice(BROADCAST_PATH.length));
  }
  return null;
}

/**
 * Broadcast to a Supabase Realtime topic from the server — every subscriber on every instance
 * (`supabase.channel(topic).on("broadcast", { event }, …)`), as `realtime.send()` does from SQL.
 * Server code is trusted: a private topic's write policy is not checked.
 *
 * ```ts
 * import { broadcast } from "@denext/backend/server";
 * await broadcast("room:42", "message", { body: "hello" });
 * ```
 *
 * @param topic The topic (as the client names its channel, without `realtime:`).
 * @param event The event name.
 * @param payload The payload (JSON-able, or a `Uint8Array`).
 * @param options `private: true` for a private channel's topic.
 * @returns When every instance has been sent it.
 * @throws {Error} When realtime is not configured.
 */
export function broadcast(
  topic: string,
  event: string,
  payload: unknown,
  options: { private?: boolean } = {},
): Promise<void> {
  const hub = (globalThis as Holder)[SLOT];
  if (!hub) {
    return Promise.reject(
      new Error("broadcast(): realtime is not configured — backend({ postgres, realtime })"),
    );
  }
  return hub.publish(checkMessage({ topic, event, payload, private: options.private === true }));
}
