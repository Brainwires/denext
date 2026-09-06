// Server-push channels — `createChannel`: publish a typed payload to every authorized subscriber
// of a key, from anywhere on the server, over the Live socket.
//
//   // app/channels.ts
//   "use server";
//   export const orderEvents = createChannel<{ status: string }>({
//     schema: z.object({ status: z.string() }),
//     authorize: async (ctx, key) => (await getSession(ctx))?.userId === key.split(":")[1],
//   });
//   // anywhere: an action, a webhook, a cron, after()
//   await orderEvents.publish(`user:${userId}`, { status: "shipped" });
//   // a client component
//   const { data } = useChannel(orderEvents, `user:${userId}`);
//
// `<Live>` / `useLive` / `useSubscription` are PULL-recompute on tag invalidation; a channel is
// the push half: arbitrary emits (progress, chat, presence-adjacent events) with no recompute.
// Semantics, stated once: at-most-once; latest-wins per (connection, subscription) under
// back-pressure and within a publisher burst; no history or replay on reconnect (use SSR
// `initial` for the cold start); `seq` orders frames from ONE instance only. Delivery reaches
// connections on other instances through a `ChannelTransport` — the default is in-memory
// (single instance); `broadcastChannelTransport` covers Deno Deploy isolates / multi-worker
// hosts; Redis/NATS implement the two-method interface.
//
// Security: `authorize(ctx, key)` is REQUIRED (construction throws without it) and runs in the
// subscriber's session at subscribe time, then lazily on traffic once `authTtlSeconds` has
// passed (default 300; per-publish re-auth would be subscribers × authorize per emit); `revoke`
// ends a key's (or one peer's) subscriptions immediately, cluster-wide. Payloads are validated
// on the PUBLISHER side (a schema failure is a server bug thrown at the publisher, never sent)
// and byte-capped. The channel id is an opaque hash assigned at export from a "use server"
// module (like an action id); the browser only ever sees that id.

import {
  ActionValidationError,
  fieldErrorsFrom,
  isStandardSchema,
  type StandardSchemaV1,
} from "./define-action.ts";
import { prepareWire, WIRE_ENC } from "./wire-codec.ts";

/** The subscriber's identity handed to `authorize` (the Live connection context). */
export interface ChannelContext {
  /** The connection's origin. */
  origin: string;
  /** The route the connection is on. */
  url: string;
  /** The viewer's raw Cookie header (their replayed identity). */
  cookie: string;
  /** The connection's stable peer id. */
  peerId: string;
}

/** The definition passed to {@link createChannel}. */
export interface ChannelConfig<T> {
  /** An explicit stable id; otherwise the export must live in a `"use server"` module. */
  id?: string;
  /** Validates every published payload (publisher side). */
  schema?: StandardSchemaV1<T>;
  /** Accepted key shape (default `/^[A-Za-z0-9_:.\-]{1,128}$/`). */
  key?: RegExp | ((key: string) => boolean);
  /** REQUIRED: may this subscriber receive `key`? Runs in the subscriber's session. */
  authorize: (ctx: ChannelContext, key: string) => boolean | Promise<boolean>;
  /** Re-authorize a subscriber lazily after this many seconds (default: `live.limits.channelAuthTtlSeconds`). */
  authTtlSeconds?: number;
}

/** A channel on the server. */
export interface Channel<T> {
  /** The stable id (assigned at export, or the explicit `id`). */
  readonly denextChannelId: string;
  /** Validate, encode once, and deliver to every authorized subscriber of `key` on every instance. */
  publish(key: string, payload: T): Promise<void>;
  /** End every subscription to `key` (or one peer's); the client sees `denied`. Cluster-wide. */
  revoke(key: string, opts?: { peerId?: string }): void;
  /** Phantom — carries the payload type for `useChannel`. */
  readonly __channel?: { payload: T };
}

/** A channel as the browser sees it: the id (and the phantom type). */
export interface ChannelRef<T> {
  /** The stable channel id. */
  readonly denextChannelId: string;
  /** Phantom — carries the payload type. */
  readonly __channel?: { payload: T };
}

/** One transport event: a publish (encoded payload) or a revoke. */
export interface ChannelEvent {
  /** `publish` or `revoke`. */
  kind: "publish" | "revoke";
  /** The channel. */
  channelId: string;
  /** The key. */
  key: string;
  /** The wire-encoded payload JSON (`publish`). */
  encoded?: string;
  /** `1` when `encoded` carries codec tags. */
  enc?: 1;
  /** Per-instance, per-key monotonic sequence (`publish`). */
  seq: number;
  /** The publishing instance's id (frames from one instance are ordered by `seq`). */
  instance: string;
  /** Revoke only this peer's subscriptions (`revoke`). */
  peerId?: string;
}

/** Carries {@link ChannelEvent}s to every hub that should deliver them (across instances). */
export interface ChannelTransport {
  /** Emit an event to every subscriber (this instance included). */
  publish(ev: ChannelEvent): void | Promise<void>;
  /** Receive events; returns an unsubscribe. */
  subscribe(fn: (ev: ChannelEvent) => void): () => void;
}

/** What the hub needs from a registered channel. */
export interface ChannelInternals {
  /** The id. */
  id: string;
  /** Is `key` an acceptable key for this channel? */
  keyOk(key: string): boolean;
  /** The subscriber gate (may be missing at runtime → the hub answers `no-policy`). */
  authorize?: (ctx: ChannelContext, key: string) => boolean | Promise<boolean>;
  /** Per-channel re-auth TTL override. */
  authTtlSeconds?: number;
}

/** Brand shared across module instances. */
const CHANNEL_BRAND: unique symbol = Symbol.for("denext.channel") as never;
const DEFAULT_KEY = /^[A-Za-z0-9_:.\-]{1,128}$/;

/** This process's instance id (orders `seq` within one instance). */
const INSTANCE = crypto.randomUUID();

const channels = new Map<string, ChannelInternals>();
const seqs = new Map<string, number>();
let payloadCap = 16 * 1024;
let transport: ChannelTransport = inMemoryChannelTransport();

/**
 * Create a channel. Export it from a `"use server"` module (or give it an `id`).
 *
 * @param config Schema, key shape, the REQUIRED `authorize`, and the re-auth TTL.
 * @returns The channel (`publish` / `revoke` on the server; an opaque id in the browser).
 */
export function createChannel<T>(config: ChannelConfig<T>): Channel<T> {
  if (typeof config.authorize !== "function") {
    throw new TypeError(
      "createChannel: `authorize(ctx, key)` is required — a channel without a policy would " +
        "push to any same-origin subscriber. Return `true` explicitly for a public channel.",
    );
  }
  if (typeof document !== "undefined") return browserStub<T>(config.id ?? "");
  const internals: ChannelInternals = {
    id: config.id ?? "",
    keyOk: keyMatcher(config.key),
    authorize: config.authorize,
    authTtlSeconds: config.authTtlSeconds,
  };
  const channel: Channel<T> = {
    denextChannelId: internals.id,
    publish: (key, payload) => publish(internals, config.schema, key, payload),
    revoke: (key, opts) => revoke(internals, key, opts?.peerId),
  };
  Object.defineProperty(channel, CHANNEL_BRAND, { value: internals });
  if (config.id) registerChannel(config.id, channel);
  return channel;
}

function browserStub<T>(id: string): Channel<T> {
  const notHere = (): never => {
    throw new Error("createChannel: publish/revoke run on the server only");
  };
  return { denextChannelId: id, publish: notHere, revoke: notHere };
}

function keyMatcher(key: ChannelConfig<unknown>["key"]): (k: string) => boolean {
  if (typeof key === "function") return key;
  const re = key ?? DEFAULT_KEY;
  return (k) => typeof k === "string" && re.test(k);
}

/**
 * Is `value` a server-side channel object?
 *
 * @param value Any export.
 * @returns True for a `createChannel` result.
 */
export function isChannel(value: unknown): value is Channel<unknown> {
  return typeof value === "object" && value !== null && CHANNEL_BRAND in value;
}

/**
 * Register a channel under `id` (called by `createChannel` for an explicit id and by the
 * `"use server"` export tagging). Sets the channel's `denextChannelId`.
 *
 * @param id The stable id.
 * @param channel The channel.
 */
export function registerChannel(id: string, channel: Channel<unknown>): void {
  const internals = (channel as unknown as { [CHANNEL_BRAND]: ChannelInternals })[CHANNEL_BRAND];
  internals.id = id;
  Object.defineProperty(channel, "denextChannelId", {
    value: id,
    enumerable: true,
    configurable: true,
  });
  channels.set(id, internals);
}

/**
 * The registered channel for `id`, if any.
 *
 * @param id The channel id.
 * @returns Its internals, or `undefined`.
 */
export function getChannel(id: string): ChannelInternals | undefined {
  return channels.get(id);
}

/**
 * Install the transport that carries channel events between instances (default: in-memory,
 * single instance). The Live hub re-subscribes to the new transport.
 *
 * @param t The transport.
 */
export function setChannelTransport(t: ChannelTransport): void {
  transport = t;
  for (const fn of transportListeners) fn(t);
}

const transportListeners = new Set<(t: ChannelTransport) => void>();

/**
 * Be told when the transport changes (the hub uses this to re-subscribe). Returns the current
 * transport immediately.
 *
 * @param fn Called with each newly installed transport.
 * @returns The current transport and an unsubscribe.
 */
export function watchChannelTransport(
  fn: (t: ChannelTransport) => void,
): { current: ChannelTransport; stop: () => void } {
  transportListeners.add(fn);
  return { current: transport, stop: () => transportListeners.delete(fn) };
}

/**
 * Set the publisher-side payload byte cap (the hub applies `live.limits.maxChannelPayloadBytes`).
 *
 * @param bytes The cap.
 */
export function setChannelPayloadCap(bytes: number): void {
  payloadCap = bytes;
}

async function publish<T>(
  ch: ChannelInternals,
  schema: StandardSchemaV1<T> | undefined,
  key: string,
  payload: T,
): Promise<void> {
  if (!ch.keyOk(key)) throw new TypeError(`channel.publish: invalid key ${JSON.stringify(key)}`);
  if (!ch.id) {
    throw new Error(
      'channel.publish: the channel has no id — export it from a "use server" module or pass `id`',
    );
  }
  const value = schema ? await validate(schema, payload) : payload;
  const p = prepareWire(value);
  const encoded = JSON.stringify(p.value);
  if (new TextEncoder().encode(encoded).byteLength > payloadCap) {
    throw new RangeError(`channel.publish: payload exceeds ${payloadCap} bytes`);
  }
  const seqKey = `${ch.id} ${key}`;
  const seq = (seqs.get(seqKey) ?? 0) + 1;
  seqs.set(seqKey, seq);
  const ev: ChannelEvent = {
    kind: "publish",
    channelId: ch.id,
    key,
    encoded,
    seq,
    instance: INSTANCE,
  };
  if (p.tagged) ev.enc = WIRE_ENC;
  await transport.publish(ev);
}

async function validate<T>(schema: StandardSchemaV1<T>, payload: T): Promise<T> {
  if (!isStandardSchema(schema)) {
    throw new TypeError("createChannel: `schema` is not a Standard Schema");
  }
  const result = await schema["~standard"].validate(payload);
  if (result.issues) {
    throw new ActionValidationError("Invalid channel payload", fieldErrorsFrom(result.issues));
  }
  return result.value;
}

function revoke(ch: ChannelInternals, key: string, peerId?: string): void {
  if (!ch.id) return;
  const ev: ChannelEvent = { kind: "revoke", channelId: ch.id, key, seq: 0, instance: INSTANCE };
  if (peerId) ev.peerId = peerId;
  void transport.publish(ev);
}

/**
 * The default transport: loopback, this instance only.
 *
 * @returns An in-memory transport.
 */
export function inMemoryChannelTransport(): ChannelTransport {
  const subs = new Set<(ev: ChannelEvent) => void>();
  return {
    publish(ev) {
      for (const fn of subs) fn(ev);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/**
 * A transport over the Web `BroadcastChannel` API: every instance that shares the channel
 * name (Deno Deploy isolates, workers in one host) receives each event. Zero dependencies.
 *
 * @param name The BroadcastChannel name (default `"denext-channels"`).
 * @returns The transport.
 */
export function broadcastChannelTransport(name = "denext-channels"): ChannelTransport {
  if (typeof BroadcastChannel === "undefined") {
    throw new Error("broadcastChannelTransport: BroadcastChannel is not available in this runtime");
  }
  const bc = new BroadcastChannel(name);
  const local = inMemoryChannelTransport();
  bc.onmessage = (e: MessageEvent) => {
    const ev = e.data as ChannelEvent;
    if (ev && typeof ev === "object" && ev.instance !== INSTANCE) local.publish(ev);
  };
  return {
    publish(ev) {
      bc.postMessage(ev); // other instances (a BroadcastChannel does not echo to its sender)
      local.publish(ev); // this instance
    },
    subscribe: (fn) => local.subscribe(fn),
  };
}
