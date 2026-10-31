// Server-push channels — `createChannel`: publish a typed payload to every authorized subscriber
// of a key, from anywhere on the server, over the Live socket.
//
//   // app/channels.ts
//   "use server";
//   export const orderEvents = createChannel<{ status: string }>({
//     schema: z.object({ status: z.string() }),
//     authorize: async (_ctx, key) => (await auth())?.user.id === key.split(":")[1],
//   });
//   // anywhere: an action, a webhook, a cron, after()
//   await orderEvents.publish(`user:${userId}`, { status: "shipped" });
//   // a client component
//   const { data } = useChannel(orderEvents, `user:${userId}`);
//
// `<Live>` / `useLive` / `useSubscription` are PULL-recompute on tag invalidation; a channel is
// the push half: arbitrary emits (progress, messages, presence-adjacent events) with no recompute.
// Semantics, stated once: at-most-once; latest-wins per (connection, subscription) under
// back-pressure and within a publisher burst; no history or replay on reconnect (use SSR
// `initial` for the cold start) unless the channel opts into `history` — then every publish is
// logged per key (bounded) with a cursor, a subscriber passing `since` replays what it missed
// (after `authorize`), a reconnect or a drained socket resumes from its last cursor, and a burst
// is delivered whole; `seq` orders frames from ONE instance only. Delivery reaches
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
import { decodeWire, WIRE_ENC } from "./wire-codec.ts";
import { prepareWire } from "./wire-encode.ts";
import { CHANNEL_BRAND, setChannelRegistrar } from "./channel-brand.ts";
import { processShared } from "./process-shared.ts";
import {
  type ChannelHistory,
  type ChannelLog,
  inMemoryChannelLog,
  resolveHistory,
} from "./channel-log.ts";
import {
  LIVE_RESTART_DEFAULTS,
  type ResolvedRestart,
  resolveRestart,
  restartLoop,
  type RestartOptions,
} from "./restart.ts";

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
  /**
   * Keep a replay log of each key's publishes: the last `size` (1–1000) for `ttlSeconds`
   * (default 24 hours). A subscriber passing `since` (`useChannel(ch, key, { since: "0" })`)
   * receives what it missed after `authorize` allows it, a reconnect resumes from its last
   * cursor, and a burst is delivered whole rather than latest-wins. The log is this instance's
   * (in memory, bounded) unless the transport brings a shared one (`redisChannelTransport`).
   */
  history?: number | { size: number; ttlSeconds?: number };
  /**
   * Deliver every publish, in order, instead of the latest one: two publishes to a key within the
   * hub's coalescing window both go out, and while a subscriber's frames are held (a slow socket,
   * a re-authorization in flight) up to 256 of them are kept in order
   * rather than the last one only. Past that the oldest are dropped, so a payload that must not
   * be lost silently should carry its own sequence number for the subscriber to check. For a
   * stream of deltas (each publish a batch of changes), not a state value.
   */
  ordered?: boolean;
  /**
   * Called when `key` gets its first subscriber on THIS instance (after `authorize` allowed it
   * and the subscription was registered). Runs in the root context; a throw is logged.
   */
  onActive?: (key: string) => void;
  /**
   * Called when the last subscriber of `key` on THIS instance leaves (unsubscribed, revoked,
   * denied on re-authorization, or its connection closed) — the place to release per-key state
   * a channel keeps for its subscribers. Runs in the root context; a throw is logged.
   *
   * `reason` is `"disconnect"` when the last subscriber's connection closed (or the hub shut
   * down) — it may come back with the same key — and `"unsubscribe"` otherwise (unsubscribed,
   * revoked, or denied on re-authorization).
   */
  onIdle?: (key: string, reason: ChannelIdleReason) => void;
  /**
   * A supervised producer for each active key: started when `key` gets its first subscriber on
   * THIS instance (in the root context), its `signal` aborted when the last one leaves. A throw
   * restarts it with exponential backoff (see `publisherRestart`); subscribers stay connected
   * throughout and simply receive nothing until it publishes again. Returning ends it for good
   * (until the key goes idle and active again).
   */
  publisher?: ChannelPublisher<T>;
  /**
   * How a throwing `publisher` restarts (default: 5 restarts a minute, 250 ms doubling to 10 s,
   * 20% jitter). Past `maxRestarts` within `period` it gives up for that key (logged); the
   * subscribers stay connected, and the key's next activation starts it afresh.
   */
  publisherRestart?: RestartOptions;
}

/** What a {@linkcode ChannelConfig.publisher} receives. */
export interface ChannelPublisherContext<T> {
  /** The key it produces for. */
  readonly key: string;
  /** Aborted when the key's last local subscriber leaves (or the hub shuts down). */
  readonly signal: AbortSignal;
  /** Which run this is: `1` first, `2` after the first restart, … */
  readonly attempt: number;
  /** Publish to this key (`channel.publish(key, payload)`). */
  publish(payload: T): Promise<void>;
}

/** A supervised per-key producer ({@linkcode ChannelConfig.publisher}). */
export type ChannelPublisher<T> = (ctx: ChannelPublisherContext<T>) => unknown;

/** Why a channel key lost its last local subscriber (see {@linkcode ChannelConfig.onIdle}). */
export type ChannelIdleReason = "unsubscribe" | "disconnect";

/** A channel on the server. */
export interface Channel<T> {
  /** The stable id (assigned at export, or the explicit `id`). */
  readonly denextChannelId: string;
  /** Validate, encode once, and deliver to every authorized subscriber of `key` on every instance. */
  publish(key: string, payload: T): Promise<void>;
  /** End every subscription to `key` (or one peer's); the client sees `denied`. Cluster-wide. */
  revoke(key: string, opts?: { peerId?: string }): void;
  /**
   * Drop this instance's publishes of `key` that its Live hub has not yet sent to a subscriber:
   * those inside the hub's coalescing window, or still in the transport. Later publishes are
   * delivered as usual. For a key whose next subscriber must not get what was published for an
   * earlier one (a subscription re-authorized under other claims); publishes from other
   * instances, and frames already held for a connected subscriber, are not reached.
   */
  discard(key: string): void;
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

/**
 * One transport event: a channel `publish`/`revoke`, a cross-instance cache-tag `invalidate`, an
 * instance's `presence` snapshot of one `usePresence` room, or a parked live view's
 * `view-resumed` (it resumed on another instance, so the one that parked it stops its copy).
 */
export interface ChannelEvent {
  /**
   * `publish`, `revoke`, a cross-instance cache-tag `invalidate`, a room's `presence`, or a live
   * view's `view-resumed`.
   */
  kind: "publish" | "revoke" | "invalidate" | "presence" | "view-resumed";
  /** The channel (empty on an `invalidate`, `presence` or `view-resumed`: not channel-scoped). */
  channelId: string;
  /** The key (empty on an `invalidate`; the room on a `presence`; the instance id on a `view-resumed`). */
  key: string;
  /**
   * The wire-encoded payload JSON (`publish`), or the JSON of the publishing instance's peers in
   * the room (`presence`; `[]` once it has none).
   */
  encoded?: string;
  /** `1` when `encoded` carries codec tags. */
  enc?: 1;
  /** The publish's replay-log cursor (`publish` on a channel with `history`). */
  cursor?: string;
  /** Per-instance, per-key monotonic sequence (`publish`; `0` otherwise). */
  seq: number;
  /** The publishing instance's id (frames from one instance are ordered by `seq`). */
  instance: string;
  /** Revoke only this peer's subscriptions (`revoke`). */
  peerId?: string;
  /** The invalidated cache tags (`invalidate` only). */
  tags?: readonly string[];
}

/**
 * True when `ev` originated on ANOTHER instance (not this process). The Live hub uses it to
 * suppress the echo of its own `invalidate` events, which the default in-memory transport
 * loops back to the publisher (and which some cross-instance transports also do).
 */
export function isForeignEvent(ev: ChannelEvent): boolean {
  return ev.instance !== shared.instance;
}

/**
 * This process's instance id, as its events carry it (the Live hub stamps its presence
 * snapshots with it).
 *
 * @returns The id.
 */
export function channelInstanceId(): string {
  return shared.instance;
}

/**
 * Publish an event on the installed transport, fire-and-forget (the Live hub's presence
 * snapshots).
 *
 * @param ev The event.
 */
export function publishChannelEvent(ev: ChannelEvent): void {
  void Promise.resolve(currentTransport().publish(ev)).catch(() => {});
}

/** Carries {@link ChannelEvent}s to every hub that should deliver them (across instances). */
export interface ChannelTransport {
  /** Emit an event to every subscriber (this instance included). */
  publish(ev: ChannelEvent): void | Promise<void>;
  /** Receive events; returns an unsubscribe. */
  subscribe(fn: (ev: ChannelEvent) => void): () => void;
  /**
   * The replay log channels with `history` use while this transport is installed (one every
   * instance shares, e.g. Redis). Without one, each instance logs its own publishes in memory.
   */
  log?: ChannelLog;
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
  /** The replay-log retention (`history`), when the channel keeps one. */
  history?: ChannelHistory;
  /** Every publish delivered in order, none coalesced ({@linkcode ChannelConfig.ordered}). */
  ordered?: boolean;
  /** A key's first local subscriber arrived. */
  onActive?: (key: string) => void;
  /** A key's last local subscriber left. */
  onIdle?: (key: string, reason: ChannelIdleReason) => void;
}

/** Brand shared across module instances. */
// The brand lives in `channel-brand.ts` (side-effect free) so client bundles can recognize a
// channel without loading this module's server-only state; `isChannel` is re-exported from here.
export { isChannel } from "./channel-brand.ts";
const DEFAULT_KEY = /^[A-Za-z0-9_:.\-]{1,128}$/;

/** How many held frames an {@linkcode ChannelConfig.ordered} channel keeps per subscriber. */
export const ORDERED_HOLD_LIMIT = 256;

/**
 * The process's channel state, shared by every copy of this module (see process-shared.ts): the
 * registry, sequence counters, the installed transport and its settings.
 */
const shared = /* @__PURE__ */ processShared("channels", () => ({
  /** This process's instance id (orders `seq` within one instance). */
  instance: crypto.randomUUID(),
  channels: new Map<string, ChannelInternals>(),
  seqs: new Map<string, number>(),
  transportListeners: new Set<(t: ChannelTransport) => void>(),
  /** Channel ids a tap warned about (once each). */
  warnedUnknown: new Set<string>(),
  payloadCap: 16 * 1024,
  /** The default lazy re-authorization TTL (seconds) — the hub applies `live.limits.channelAuthTtlSeconds`. */
  authTtlSeconds: 300,
  transport: null as ChannelTransport | null,
  /** The in-memory replay log (used while the transport brings none). */
  memoryLog: null as ChannelLog | null,
  /** Warned that the replay log failed (once per process). */
  warnedLog: false,
  /** Per (channel, key): this instance's publishes up to this `seq` are discarded. */
  fences: new Map<string, number>() as Map<string, number> | undefined,
}));
/** Cap on remembered (channel, key) sequence counters (each is one short string + number). */
const MAX_SEQ_KEYS = 10_000;

/** The discard fences (`shared.fences`; set here when an older copy of this module made it). */
function fences(): Map<string, number> {
  return shared.fences ??= new Map();
}

/** Deliver one event to one subscriber; a throwing consumer is logged, never propagated. */
function deliverTo(fn: (ev: ChannelEvent) => void, ev: ChannelEvent): void {
  try {
    fn(ev);
  } catch (err) {
    console.error("denext channels: a subscriber threw", err);
  }
}
/** The installed transport (in-memory until one is set). */
function currentTransport(): ChannelTransport {
  return shared.transport ??= inMemoryChannelTransport();
}

/** The in-memory replay log. */
function currentMemoryLog(): ChannelLog {
  return shared.memoryLog ??= inMemoryChannelLog();
}

/**
 * Create a channel. Export it from a `"use server"` module (or give it an `id`).
 *
 * @param config Schema, key shape, the REQUIRED `authorize`, and the re-auth TTL.
 * @returns The channel (`publish` / `revoke` on the server; an opaque id in the browser).
 * @throws TypeError when `authorize` is not a function.
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
    history: resolveHistory(config.history),
    ordered: config.ordered === true,
    onActive: config.onActive,
    onIdle: config.onIdle,
  };
  const channel: Channel<T> = {
    denextChannelId: internals.id,
    publish: (key, payload) => publish(internals, config.schema, key, payload),
    revoke: (key, opts) => revoke(internals, key, opts?.peerId),
    discard: (key) => discard(internals, key),
  };
  if (config.publisher) superviseKeys(internals, channel, config);
  Object.defineProperty(channel, CHANNEL_BRAND, { value: internals });
  if (config.id) registerChannel(config.id, channel);
  return channel;
}

/**
 * Run `config.publisher` for each active key under a restart loop: started on `onActive` (before
 * the app's own hook, so a throwing hook cannot keep it from starting), stopped on `onIdle`.
 */
function superviseKeys<T>(
  internals: ChannelInternals,
  channel: Channel<T>,
  config: ChannelConfig<T>,
): void {
  const publisher = config.publisher!;
  if (typeof publisher !== "function") {
    throw new TypeError("createChannel: `publisher` must be a function");
  }
  const policy: ResolvedRestart = resolveRestart(
    config.publisherRestart ?? true,
    LIVE_RESTART_DEFAULTS,
    "createChannel: publisherRestart",
  )!;
  const running = new Map<string, AbortController>();
  internals.onActive = (key) => {
    running.get(key)?.abort();
    const controller = new AbortController();
    running.set(key, controller);
    void restartLoop({
      path: `channel:${internals.id}/${key}`,
      signal: controller.signal,
      policy,
      run: (signal, attempt) =>
        publisher({ key, signal, attempt, publish: (payload) => channel.publish(key, payload) }),
    }).finally(() => {
      if (running.get(key) === controller) running.delete(key);
    });
    config.onActive?.(key);
  };
  internals.onIdle = (key, reason) => {
    running.get(key)?.abort();
    running.delete(key);
    config.onIdle?.(key, reason);
  };
}

function browserStub<T>(id: string): Channel<T> {
  const notHere = (): never => {
    throw new Error("createChannel: publish/revoke run on the server only");
  };
  return { denextChannelId: id, publish: notHere, revoke: notHere, discard: notHere };
}

function keyMatcher(key: ChannelConfig<unknown>["key"]): (k: string) => boolean {
  if (typeof key === "function") return key;
  const re = key ?? DEFAULT_KEY;
  return (k) => typeof k === "string" && re.test(k);
}

/**
 * Register a channel under `id` (called by `createChannel` for an explicit id and by the
 * `"use server"` export tagging). Sets the channel's `denextChannelId`.
 *
 * @param id The stable id.
 * @param channel The channel.
 */
function registerChannel(id: string, channel: Channel<unknown>): void {
  const internals = (channel as unknown as { [CHANNEL_BRAND]: ChannelInternals })[CHANNEL_BRAND];
  internals.id = id;
  Object.defineProperty(channel, "denextChannelId", {
    value: id,
    enumerable: true,
    configurable: true,
  });
  shared.channels.set(id, internals);
}

// Let the brand module (what `server-action.ts`'s export tagging imports) reach the registry
// once this module is loaded — i.e. on the server, always.
setChannelRegistrar(registerChannel);

/**
 * The registered channel for `id`, if any.
 *
 * @param id The channel id.
 * @returns Its internals, or `undefined`.
 */
export function getChannel(id: string): ChannelInternals | undefined {
  return shared.channels.get(id);
}

/**
 * Install the transport that carries channel events between instances (default: in-memory,
 * single instance). The Live hub re-subscribes to the new transport.
 *
 * @param t The transport.
 */
export function setChannelTransport(t: ChannelTransport): void {
  shared.transport = t;
  for (const fn of shared.transportListeners) fn(t);
}

/**
 * The replay log in use: the transport's own, else this instance's in-memory one.
 *
 * @returns The log.
 */
export function channelLog(): ChannelLog {
  return currentTransport().log ?? currentMemoryLog();
}

/**
 * Does every instance read the same replay log (the transport brings one)? Without, a cursor is
 * meaningful only on the instance that issued it.
 *
 * @returns Whether the log is shared.
 */
export function channelLogShared(): boolean {
  return currentTransport().log !== undefined;
}

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
  shared.transportListeners.add(fn);
  return { current: currentTransport(), stop: () => shared.transportListeners.delete(fn) };
}

/**
 * Set the publisher-side payload byte cap (the hub applies `live.limits.maxChannelPayloadBytes`).
 *
 * @param bytes The cap.
 */
export function setChannelPayloadCap(bytes: number): void {
  shared.payloadCap = bytes;
}

/**
 * Set the default lazy re-authorization TTL in seconds (the hub applies
 * `live.limits.channelAuthTtlSeconds`); a channel's own `authTtlSeconds` overrides it.
 *
 * @param seconds The TTL.
 */
export function setChannelAuthTtl(seconds: number): void {
  shared.authTtlSeconds = seconds;
}

/**
 * The re-authorization TTL in milliseconds for a channel: its own `authTtlSeconds`, else the
 * default {@link setChannelAuthTtl} installed.
 *
 * @param id The channel id.
 * @returns The TTL in milliseconds.
 */
export function channelAuthTtlMs(id: string): number {
  return (shared.channels.get(id)?.authTtlSeconds ?? shared.authTtlSeconds) * 1000;
}

/**
 * Forget every registered channel and sequence counter and restore the default transport and
 * payload cap — for tests, which share one process-wide registry (kept off the public barrels,
 * like `resetPlugins`).
 */
export function resetChannels(): void {
  shared.channels.clear();
  shared.seqs.clear();
  fences().clear();
  shared.warnedUnknown.clear();
  shared.payloadCap = 16 * 1024;
  shared.authTtlSeconds = 300;
  shared.memoryLog = inMemoryChannelLog();
  shared.warnedLog = false;
  setChannelTransport(inMemoryChannelTransport());
}

/** The next `seq` of a (channel, key) on this instance, recorded. */
function nextSeq(seqKey: string): number {
  // Past a discard fence even when the key's counter was evicted meanwhile.
  const seq = Math.max(shared.seqs.get(seqKey) ?? 0, fences().get(seqKey) ?? 0) + 1;
  // Bounded: a hot key keeps its counter (re-inserted at the tail); the oldest cold key goes.
  shared.seqs.delete(seqKey);
  if (shared.seqs.size >= MAX_SEQ_KEYS) shared.seqs.delete(shared.seqs.keys().next().value!);
  shared.seqs.set(seqKey, seq);
  return seq;
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
  if (new TextEncoder().encode(encoded).byteLength > shared.payloadCap) {
    throw new RangeError(`channel.publish: payload exceeds ${shared.payloadCap} bytes`);
  }
  const seq = nextSeq(`${ch.id}\0${key}`);
  const ev: ChannelEvent = {
    kind: "publish",
    channelId: ch.id,
    key,
    encoded,
    seq,
    instance: shared.instance,
  };
  if (p.tagged) ev.enc = WIRE_ENC;
  if (ch.history) await logPublish(ch.id, key, ev, ch.history);
  await currentTransport().publish(ev);
}

/**
 * Log a publish of a channel with `history` and stamp its cursor on `ev`. A log that fails (a
 * Redis outage) costs the replay, never the live delivery: warned once, sent without a cursor.
 */
async function logPublish(
  id: string,
  key: string,
  ev: ChannelEvent,
  history: ChannelHistory,
): Promise<void> {
  try {
    ev.cursor = await channelLog().append(id, key, { encoded: ev.encoded!, enc: ev.enc }, history);
  } catch (err) {
    if (shared.warnedLog) return;
    shared.warnedLog = true;
    console.warn("denext channels: the replay log could not record a publish", err);
  }
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

/** Fence `key` at this instance's latest publish ({@linkcode Channel.discard}). */
function discard(ch: ChannelInternals, key: string): void {
  if (!ch.id) return;
  const seqKey = `${ch.id}\0${key}`;
  const seq = shared.seqs.get(seqKey);
  if (seq === undefined) return; // nothing published here (or long ago): nothing in flight
  const all = fences();
  all.delete(seqKey);
  if (all.size >= MAX_SEQ_KEYS) all.delete(all.keys().next().value!);
  all.set(seqKey, seq);
}

/**
 * Whether `ev` is one of this instance's publishes a {@linkcode Channel.discard} dropped: the Live
 * hub sends it to no one.
 *
 * @param ev The event.
 * @returns `true` to drop it.
 */
export function channelEventDiscarded(ev: ChannelEvent): boolean {
  if (ev.kind !== "publish" || ev.instance !== shared.instance) return false;
  const fence = fences().get(`${ev.channelId}\0${ev.key}`);
  return fence !== undefined && ev.seq <= fence;
}

function revoke(ch: ChannelInternals, key: string, peerId?: string): void {
  if (!ch.id) return;
  const ev: ChannelEvent = {
    kind: "revoke",
    channelId: ch.id,
    key,
    seq: 0,
    instance: shared.instance,
  };
  if (peerId) ev.peerId = peerId;
  void currentTransport().publish(ev);
}

/**
 * Publish a cross-instance cache-tag invalidation over the installed transport. Every OTHER
 * instance's Live hub then re-pushes the `<Live>` / `useLive` / `useSubscription` /
 * `useApi({ tags })` watchers of these tags — the same fan-out `revalidateTag` already does
 * in-process, now propagated cluster-wide the way `createChannel` publishes are. The local hub
 * fans out directly (this is additive), and suppresses the transport's own loopback by
 * `instance` id ({@link isForeignEvent}); with the default in-memory transport that loopback is
 * the only delivery and it is a self-skip, so a single-instance app pays nothing observable.
 */
export function broadcastInvalidation(tags: readonly string[]): void {
  if (tags.length === 0) return;
  void currentTransport().publish({
    kind: "invalidate",
    channelId: "",
    key: "",
    seq: 0,
    instance: shared.instance,
    tags,
  });
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
      for (const fn of subs) deliverTo(fn, ev);
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
 * @returns The transport; its `close()` closes the BroadcastChannel (which otherwise keeps the
 *   process's event loop alive for as long as it is open).
 */
export function broadcastChannelTransport(
  name = "denext-channels",
): ChannelTransport & { close(): void } {
  if (typeof BroadcastChannel === "undefined") {
    throw new Error("broadcastChannelTransport: BroadcastChannel is not available in this runtime");
  }
  const bc = new BroadcastChannel(name);
  const local = inMemoryChannelTransport();
  bc.onmessage = (e: MessageEvent) => {
    const ev = e.data as ChannelEvent;
    if (ev && typeof ev === "object" && ev.instance !== shared.instance) local.publish(ev);
  };
  return {
    publish(ev) {
      bc.postMessage(ev); // other instances (a BroadcastChannel does not echo to its sender)
      local.publish(ev); // this instance
    },
    subscribe: (fn) => local.subscribe(fn),
    close: () => bc.close(),
  };
}

/** What {@link tapChannel} reports. */
export interface ChannelTapHandlers<T> {
  /** A payload published to the key (decoded; `seq` orders publishes from one instance). */
  onPayload: (payload: T, seq: number) => void;
  /**
   * The key was revoked cluster-wide — or, when {@linkcode ChannelTapHandlers.peerId} is set, for
   * that peer. Any other peer-scoped revoke is not reported.
   */
  onRevoke?: () => void;
  /** The peer this tap acts for: a `revoke(key, { peerId })` naming it is reported too. */
  peerId?: string;
}

/**
 * Observe a channel's publishes on the SERVER: every payload published to `key` on any
 * instance — through the installed transport, decoded, in `seq` order per instance — until
 * the returned disposer runs. The seam a plugin uses to bridge channel pushes into another
 * protocol (a GraphQL subscription in `@denext/graphql`, an SSE stream, a queue) without a
 * second event bus. Survives `setChannelTransport` (re-binds to the new transport).
 *
 * Not authorization: `authorize` gates socket SUBSCRIBERS; a server-side tap sees every
 * publish to the key. A tap that serves a viewer goes through `tapChannelAuthorized` (from
 * `denext/server`), which runs the channel's `authorize` for that viewer first.
 *
 * @param channel The channel (or its id).
 * @param key The key to observe (exact match).
 * @param handlers Payload and revoke callbacks.
 * @returns A disposer that stops the tap.
 * @throws Error when the channel has no id yet (not exported from a `"use server"` module, no `id`).
 */
export function tapChannel<T>(
  channel: Channel<T> | string,
  key: string,
  handlers: ChannelTapHandlers<T>,
): () => void {
  const id = typeof channel === "string" ? channel : channel.denextChannelId;
  if (!id) {
    throw new Error(
      'tapChannel: the channel has no id — export it from a "use server" module or pass `id`',
    );
  }
  // A tap on an id no channel registered yields nothing forever — a typo, not a subscriber
  // that has yet to appear; say so once (a programming error, so in production too).
  if (!shared.channels.has(id) && !shared.warnedUnknown.has(id)) {
    shared.warnedUnknown.add(id);
    console.warn(
      `denext channels: tapChannel(${JSON.stringify(id)}) — no channel is registered under that id`,
    );
  }
  let unsubscribe: (() => void) | null = null;
  const bind = (t: ChannelTransport) => {
    unsubscribe?.();
    unsubscribe = t.subscribe((ev) => {
      if (ev.channelId !== id || ev.key !== key) return;
      if (ev.kind === "revoke") {
        if (!ev.peerId || ev.peerId === handlers.peerId) handlers.onRevoke?.();
        return;
      }
      if (ev.encoded === undefined) return;
      // A malformed event or a throwing consumer is logged and dropped — never propagated
      // into the transport (which would starve later subscribers and reject the publisher).
      try {
        const parsed = JSON.parse(ev.encoded);
        handlers.onPayload((ev.enc ? decodeWire(parsed) : parsed) as T, ev.seq);
      } catch (err) {
        console.error(`denext channels: tap on ${id}/${key} failed`, err);
      }
    });
  };
  const { current, stop } = watchChannelTransport(bind);
  bind(current);
  return () => {
    stop();
    unsubscribe?.();
    unsubscribe = null;
  };
}
