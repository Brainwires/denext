/**
 * A Live {@linkcode ChannelTransport} over Redis pub/sub, so `createChannel` publishes and revokes,
 * `revalidateTag`'s Live re-pushes and `usePresence` rooms reach the sockets of every replica:
 *
 * ```ts
 * // instrumentation.ts (or any module the server loads at startup)
 * import { redisChannelTransport, setChannelTransport } from "denext/server";
 * setChannelTransport(redisChannelTransport({ url: Deno.env.get("REDIS_URL") }));
 * ```
 *
 * Every event is one `PUBLISH` on one Redis channel (`denext:channels` by default). The transport
 * delivers its own events to this instance directly and ignores their echo; a dedicated
 * connection holds the `SUBSCRIBE` (a subscribed connection can run nothing else), reconnects
 * with backoff when it drops and subscribes again, calling `onResync`. Delivery is at most once,
 * like every Live transport: an event published while a replica's subscriber is reconnecting is
 * not replayed to it (presence repairs itself on the next heartbeat) — a channel with `history`
 * fills that gap from its replay log, which this transport keeps in Redis (see
 * {@linkcode redisChannelLog}).
 *
 * @module
 */

import type { ChannelEvent, ChannelTransport } from "../runtime/channel.ts";
import { inMemoryChannelTransport } from "../runtime/channel.ts";
import {
  dial,
  encodeCommand,
  handshake,
  redisClient,
  type RedisClientOptions,
  RedisError,
  type RedisReply,
  resolveRedisTarget,
  RespReader,
  type Target,
} from "./redis.ts";
import { inRootContext } from "./root-context.ts";
import { redisChannelLog, type RedisChannelLogOptions } from "./redis-channel-log.ts";

/** Options for {@linkcode redisChannelTransport}. */
export interface RedisChannelTransportOptions {
  /**
   * A `redis://` / `rediss://` URL or full {@linkcode RedisClientOptions}. The transport opens two
   * connections of its own: one to publish, one to subscribe. Default: `REDIS_URL`, then
   * `redis://127.0.0.1:6379`.
   */
  url?: string | RedisClientOptions;
  /** The Redis pub/sub channel every replica of the app shares (default `denext:channels`). */
  channel?: string;
  /** Called each time the subscriber is back after a dropped connection (events may be missed). */
  onResync?: () => void;
  /**
   * The replay log for channels with `history`, kept in Redis so every replica replays the same
   * publishes (default on, keys under `denext:chlog`). `false` leaves each instance its own
   * in-memory log.
   */
  log?: false | RedisChannelLogOptions;
}

/** A {@linkcode ChannelTransport} with its connections' lifecycle. */
export interface RedisChannelTransport extends ChannelTransport {
  /** Resolves once the subscriber is subscribed (it reconnects on its own after that). */
  ready(): Promise<void>;
  /** Unsubscribe and close both connections. Idempotent. */
  close(): Promise<void>;
}

/** The first and the longest wait between reconnect attempts. */
const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 5_000;

/** What one subscribed connection reports. */
interface SubscribeHooks {
  /** The socket is open (so `close()` can end a pending read). */
  opened(conn: Deno.Conn): void;
  /** `SUBSCRIBE` was acknowledged. */
  subscribed(): void;
  /** A `message` push. */
  message(payload: string): void;
}

/** Write every command, in order. */
async function writeCommands(conn: Deno.Conn, commands: readonly (readonly (string | number)[])[]) {
  for (const command of commands) {
    const bytes = encodeCommand(command);
    let at = 0;
    while (at < bytes.length) at += await conn.write(bytes.subarray(at));
  }
}

/**
 * One subscribed connection: handshake, `SUBSCRIBE`, then `message` pushes until it drops.
 *
 * @throws {RedisError} When the handshake or `SUBSCRIBE` is refused.
 */
async function subscribeOnce(target: Target, channel: string, hooks: SubscribeHooks) {
  const conn = await dial(target);
  hooks.opened(conn);
  try {
    const commands = [...handshake(target), ["SUBSCRIBE", channel]];
    await writeCommands(conn, commands);
    await readReplies(conn, commands.length, hooks);
  } catch (error) {
    if (error instanceof RedisError) throw error;
    // a dropped or closed socket: the caller reconnects (or stops)
  } finally {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
}

/** Read the handshake's `expected` replies, then pushes, until the socket ends. */
async function readReplies(conn: Deno.Conn, expected: number, hooks: SubscribeHooks) {
  let pending = expected;
  const reader = new RespReader();
  const buffer = new Uint8Array(64 * 1024);
  for (let n = await conn.read(buffer); n !== null; n = await conn.read(buffer)) {
    reader.feed(buffer.slice(0, n));
    for (let r = reader.next(); r; r = reader.next()) {
      if (r.value instanceof RedisError) throw r.value;
      if (pending === 0) deliverPush(r.value, hooks);
      else if (--pending === 0) hooks.subscribed();
    }
  }
}

/** Hand a `["message", channel, payload]` push to the hooks. */
function deliverPush(reply: RedisReply, hooks: SubscribeHooks): void {
  if (Array.isArray(reply) && reply[0] === "message" && typeof reply[2] === "string") {
    hooks.message(reply[2]);
  }
}

/** The envelope on the wire: the sending transport's id and the event. */
interface Envelope {
  o: string;
  e: ChannelEvent;
}

/** The URL option as client options. */
const clientOptions = (url: RedisChannelTransportOptions["url"]): RedisClientOptions =>
  typeof url === "string" ? { url } : url ?? {};

/**
 * Carry Live channel events between replicas through Redis pub/sub.
 *
 * @param options The Redis URL, the shared channel name and a resync callback.
 * @returns A transport for `setChannelTransport`; `close()` it on shutdown.
 * @throws {TypeError} For a URL that is not `redis://` / `rediss://`.
 */
export function redisChannelTransport(
  options: RedisChannelTransportOptions = {},
): RedisChannelTransport {
  const target = resolveRedisTarget(clientOptions(options.url));
  const channel = options.channel ?? "denext:channels";
  const id = crypto.randomUUID();
  const local = inMemoryChannelTransport();
  const publisher = redisClient(clientOptions(options.url));
  const state = {
    closed: false,
    connected: false,
    warned: false,
    socket: undefined as Deno.Conn | undefined,
  };
  let markReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => (markReady = resolve));
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let subscribedOnce = false;

  const hooks: SubscribeHooks = {
    opened: (conn) => (state.socket = conn),
    subscribed() {
      state.connected = true;
      if (subscribedOnce) options.onResync?.();
      subscribedOnce = true;
      markReady();
    },
    message(text) {
      const envelope = parseEnvelope(text);
      if (envelope && envelope.o !== id) local.publish(envelope.e);
    },
  };

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      retryTimer = setTimeout(resolve, ms);
    });

  const loop = async () => {
    let delay = RETRY_MIN_MS;
    while (!state.closed) {
      state.connected = false;
      try {
        await subscribeOnce(target, channel, hooks);
      } catch (error) {
        if (!state.closed) warnOnce(state, `subscriber: ${(error as Error).message}`);
      }
      if (state.closed) return;
      // A connection that subscribed and then dropped starts the backoff over.
      delay = state.connected ? RETRY_MIN_MS : Math.min(RETRY_MAX_MS, delay * 2);
      await pause(delay);
    }
  };
  // The subscriber outlives the request that created the transport: run it in the root context.
  const running = inRootContext(() => loop());

  return {
    publish(ev) {
      local.publish(ev);
      if (state.closed) return;
      const envelope: Envelope = { o: id, e: ev };
      // At most once, and never a rejection: the hub publishes revokes and invalidations
      // fire-and-forget, so a failed publish reaches this instance only (and is logged once).
      return publisher.command("PUBLISH", channel, JSON.stringify(envelope)).then(
        () => {},
        (error) => warnOnce(state, `could not publish: ${error.message}`),
      );
    },
    subscribe: (fn) => local.subscribe(fn),
    ...(options.log === false ? {} : { log: redisChannelLog(publisher, options.log) }),
    ready: () => readyPromise,
    async close() {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(retryTimer);
      wake?.();
      try {
        state.socket?.close();
      } catch {
        // already closed
      }
      markReady();
      await publisher.close();
      await running;
    },
  };
}

/** A wire message as an envelope, or `undefined` for anything else on the channel. */
function parseEnvelope(text: string): Envelope | undefined {
  try {
    const envelope = JSON.parse(text) as Envelope;
    return typeof envelope?.o === "string" && envelope.e && typeof envelope.e === "object"
      ? envelope
      : undefined;
  } catch {
    return undefined;
  }
}

/** Log a transport problem once per transport (a down Redis would otherwise flood the log). */
function warnOnce(state: { warned: boolean }, message: string): void {
  if (state.warned) return;
  state.warned = true;
  console.warn(`denext: redisChannelTransport ${message}`);
}
