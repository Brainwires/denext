// denext's own client for the backend's Supabase Realtime endpoint: `useBroadcast` and
// `useRealtimePresence` (and the `realtimeChannel()` they share), over ONE WebSocket per page to
// `<basePath>/realtime/v1/websocket` — the same hub `supabase.channel()` talks to, so a message
// or a presence crosses every server instance sharing the database, and supabase-js clients and
// these hooks see each other. Same-origin, so the socket is the visitor's session (row-level
// security, private channels) with no key to ship. Imports no server code.
//
// One channel per topic (and private flag) per page: hooks on the same topic share it — its
// `presence.key` is the first tracker's — and the socket reconnects (with backoff) and rejoins
// every channel by itself.

import { useEffect, useRef, useState } from "@denext/denext";
import { decodeServerFrame, encodeBroadcastPush, encodeMessage } from "./realtime-phoenix.ts";

/** The serializer this client speaks (binary broadcasts included). */
const VSN = "2.0.0";
/** Heartbeat interval. */
const HEARTBEAT_MS = 25_000;
/** Reconnect delays, in milliseconds (the last repeats). */
const BACKOFF = [500, 1_000, 2_000, 5_000, 10_000];
/** How long a push waits for its reply. */
const PUSH_TIMEOUT_MS = 10_000;

/** A channel's state. */
export type RealtimeStatus = "joining" | "joined" | "error" | "closed";

/** One broadcast as a listener receives it. */
export interface BroadcastMessage<T = unknown> {
  /** The event name. */
  event: string;
  /** The payload (a `Uint8Array` for a binary one). */
  payload: T;
  /** Supabase's `meta`: `{ id }` of a stored message, `replayed: true` on replay. */
  meta?: { id?: string; replayed?: boolean };
}

/** A presence as listed in {@linkcode PresenceState}. */
export type Presence<T> = T & { presence_ref: string };

/** Everyone present on a topic, by presence key. */
export type PresenceState<T> = Record<string, Array<Presence<T>>>;

/** Options of a channel. */
export interface RealtimeChannelOptions {
  /** A private channel, authorized by the `realtime.messages` policies. */
  private?: boolean;
  /** Receive the broadcasts this page sends (default `false`). */
  self?: boolean;
  /** This page's presence key (default: a random one per channel). */
  presenceKey?: string;
  /** Replay a private channel's stored broadcasts since `since` (epoch ms), at most `limit`. */
  replay?: { since: number; limit?: number };
}

/** A WebSocket, or a test double. */
export interface ClientSocket {
  /** Set to `"arraybuffer"` (binary broadcasts). */
  binaryType: string;
  /** `1` once open. */
  readonly readyState: number;
  /** Send a frame. */
  send(data: string | ArrayBufferLike | Uint8Array): void;
  /** Close it. */
  close(code?: number, reason?: string): void;
  /** Opened. */
  onopen: ((event: unknown) => void) | null;
  /** A frame arrived. */
  onmessage: ((event: { data: unknown }) => void) | null;
  /** Closed. */
  onclose: ((event: unknown) => void) | null;
  /** Failed. */
  onerror: ((event: unknown) => void) | null;
}

/** Opens the socket (default: the page's own origin and `basePath`). */
export type SocketFactory = (url: string) => ClientSocket;

/** Called with each broadcast. */
export type BroadcastListener = (message: BroadcastMessage) => void;
/** Called with the presence state after each change. */
export type PresenceListener = (state: PresenceState<Record<string, unknown>>) => void;
/** Called on each status change (`reason` with `error`). */
export type StatusListener = (status: RealtimeStatus, reason?: string) => void;

/** A server message, as a channel takes it. */
export interface ChannelMessage {
  /** The join it belongs to. */
  joinRef: string | null;
  /** The reply reference, if any. */
  ref?: string | null;
  /** `realtime:<name>`. */
  topic: string;
  /** The event. */
  event: string;
  /** Its payload. */
  payload: unknown;
}

interface Pending {
  resolve: (status: "ok" | "error" | "timeout", response: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A presence meta as the server sends it. */
type Metas = Record<string, { metas: Array<Record<string, unknown>> }>;

/** One channel of the page's socket, shared by every hook on its topic. */
export class SharedChannel {
  /** `realtime:<name>`. */
  readonly topic: string;
  /** Its state. */
  status: RealtimeStatus = "closed";
  /** Why it failed, when `status` is `error`. */
  reason?: string;
  readonly #client: RealtimeClient;
  readonly #options: RealtimeChannelOptions;
  readonly #listeners = new Set<BroadcastListener>();
  readonly #presenceListeners = new Set<PresenceListener>();
  readonly #statusListeners = new Set<StatusListener>();
  #joinRef: string | null = null;
  #presence = new Map<string, Array<Record<string, unknown>>>();
  #synced = false;
  #pendingDiffs: Array<{ joins: Metas; leaves: Metas }> = [];
  /** What this page tracks here, re-tracked after a rejoin. */
  #tracked: Record<string, unknown> | null = null;
  /** Fingerprints of this page's own broadcasts, to drop their echoes for `self: false`. */
  #own: string[] = [];
  /** How many holders it has (see {@linkcode RealtimeClient.acquire}). */
  refs = 0;

  /**
   * A channel (use {@linkcode RealtimeClient.acquire}, which shares one per topic).
   *
   * @param client The page's client.
   * @param name The topic.
   * @param options Its options.
   */
  constructor(client: RealtimeClient, name: string, options: RealtimeChannelOptions) {
    this.topic = `realtime:${name}`;
    this.#client = client;
    this.#options = options;
  }

  /** Listen for broadcasts; returns an unsubscribe. */
  // fallow-ignore-next-line unused-class-member -- public API, used by the hooks below
  onBroadcast(listener: BroadcastListener): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** Listen for the presence state; returns an unsubscribe. */
  onPresence(listener: PresenceListener): () => void {
    this.#presenceListeners.add(listener);
    if (this.#synced) listener(this.presenceState());
    return () => void this.#presenceListeners.delete(listener);
  }

  /** Listen for status changes; returns an unsubscribe. */
  // fallow-ignore-next-line unused-class-member -- public API, used by the hooks below
  onStatus(listener: StatusListener): () => void {
    this.#statusListeners.add(listener);
    return () => void this.#statusListeners.delete(listener);
  }

  /** Everyone present now. */
  presenceState<T = Record<string, unknown>>(): PresenceState<T> {
    const out: PresenceState<T> = {};
    for (const [key, metas] of this.#presence) {
      out[key] = metas.map(({ phx_ref, ...meta }) => ({ ...meta, presence_ref: phx_ref })) as Array<
        Presence<T>
      >;
    }
    return out;
  }

  #setStatus(status: RealtimeStatus, reason?: string): void {
    this.status = status;
    this.reason = reason;
    for (const listener of this.#statusListeners) listener(status, reason);
  }

  /** Join (again, after a reconnect). */
  join(): void {
    const ref = this.#client.nextRef();
    this.#joinRef = ref;
    this.#synced = false;
    this.#pendingDiffs = [];
    this.#setStatus("joining");
    const config = {
      broadcast: {
        self: true,
        ack: true,
        ...(this.#options.replay ? { replay: this.#options.replay } : {}),
      },
      presence: { enabled: true, key: this.#options.presenceKey ?? "" },
      postgres_changes: [],
      private: this.#options.private === true,
    };
    this.#client.push(this.topic, "phx_join", { config }, ref, ref).then(({ status, response }) => {
      if (this.#joinRef !== ref) return;
      if (status !== "ok") {
        this.#setStatus("error", String(response.reason ?? status));
        return;
      }
      this.#setStatus("joined");
      if (this.#tracked) void this.track(this.#tracked);
    });
  }

  /** Leave. */
  leave(): void {
    if (this.#joinRef) void this.#client.push(this.topic, "phx_leave", {}, this.#joinRef);
    this.#joinRef = null;
    this.#setStatus("closed");
  }

  /**
   * Send a broadcast to everyone on the topic.
   *
   * @param event The event name.
   * @param payload The payload (JSON-able, or a `Uint8Array`).
   * @returns `"ok"` once the server has published it, else `"error"` / `"timeout"`.
   */
  // fallow-ignore-next-line unused-class-member -- public API, used by the hooks below
  async send(event: string, payload: unknown): Promise<"ok" | "error" | "timeout"> {
    if (this.status !== "joined" || !this.#joinRef) return "error";
    const fingerprint = fingerprintOf(event, payload);
    this.#own.push(fingerprint);
    if (this.#own.length > 256) this.#own.shift();
    const { status } = await this.#client.push(
      this.topic,
      "broadcast",
      { type: "broadcast", event, payload },
      this.#joinRef,
    );
    return status;
  }

  /** Track this page's presence (replacing what it tracked). */
  async track(state: Record<string, unknown>): Promise<"ok" | "error" | "timeout"> {
    this.#tracked = state;
    if (this.status !== "joined" || !this.#joinRef) return "error";
    const { status } = await this.#client.push(
      this.topic,
      "presence",
      { type: "presence", event: "track", payload: state },
      this.#joinRef,
    );
    return status;
  }

  /** Stop tracking this page's presence. */
  async untrack(): Promise<"ok" | "error" | "timeout"> {
    this.#tracked = null;
    if (this.status !== "joined" || !this.#joinRef) return "error";
    const { status } = await this.#client.push(
      this.topic,
      "presence",
      { type: "presence", event: "untrack" },
      this.#joinRef,
    );
    return status;
  }

  /** A server message on this topic. */
  receive(message: ChannelMessage): void {
    const payload = record(message.payload);
    switch (message.event) {
      case "broadcast":
        return this.#broadcast(payload);
      case "presence_state":
        this.#presence = new Map(
          Object.entries(payload as Metas).map(([key, value]) => [key, [...value.metas]]),
        );
        this.#synced = true;
        for (const diff of this.#pendingDiffs) this.#applyDiff(diff);
        this.#pendingDiffs = [];
        return this.#emitPresence();
      case "presence_diff": {
        const diff = {
          joins: record(payload.joins) as Metas,
          leaves: record(payload.leaves) as Metas,
        };
        if (!this.#synced) return void this.#pendingDiffs.push(diff);
        this.#applyDiff(diff);
        return this.#emitPresence();
      }
      case "phx_close":
        if (message.joinRef === this.#joinRef) this.#setStatus("closed");
        return;
      case "system":
        if (payload.status === "error" && payload.extension === "system") {
          this.#setStatus("error", String(payload.message ?? "error"));
        }
        return;
    }
  }

  #broadcast(payload: Record<string, unknown>): void {
    const event = String(payload.event ?? "");
    const message: BroadcastMessage = { event, payload: payload.payload };
    if (payload.meta) message.meta = payload.meta as BroadcastMessage["meta"];
    if (!this.#options.self) {
      const at = this.#own.indexOf(fingerprintOf(event, payload.payload));
      if (at >= 0) {
        this.#own.splice(at, 1);
        return;
      }
    }
    for (const listener of this.#listeners) listener(message);
  }

  #applyDiff(diff: { joins: Metas; leaves: Metas }): void {
    for (const [key, { metas }] of Object.entries(diff.leaves)) {
      const refs = new Set(metas.map((meta) => meta.phx_ref));
      const left = (this.#presence.get(key) ?? []).filter((meta) => !refs.has(meta.phx_ref));
      if (left.length > 0) this.#presence.set(key, left);
      else this.#presence.delete(key);
    }
    for (const [key, { metas }] of Object.entries(diff.joins)) {
      const refs = new Set(metas.map((meta) => meta.phx_ref));
      const kept = (this.#presence.get(key) ?? []).filter((meta) => !refs.has(meta.phx_ref));
      this.#presence.set(key, [...kept, ...metas]);
    }
  }

  #emitPresence(): void {
    const state = this.presenceState();
    for (const listener of this.#presenceListeners) listener(state);
  }

  /** The socket dropped: every reply is lost, and the channel waits for the rejoin. */
  disconnected(): void {
    if (this.#joinRef) this.#setStatus("joining");
  }
}

/** A payload's identity, to recognize this page's own echo. */
function fingerprintOf(event: string, payload: unknown): string {
  if (payload instanceof Uint8Array) return `${event}\u0000bin:${payload.byteLength}`;
  try {
    return `${event}\u0000${JSON.stringify(payload)}`;
  } catch {
    return `${event}\u0000?`;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** The page's connection to the realtime endpoint. */
export class RealtimeClient {
  readonly #url: string;
  readonly #open: SocketFactory;
  #socket: ClientSocket | null = null;
  #ref = 0;
  #attempt = 0;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #reconnect: ReturnType<typeof setTimeout> | null = null;
  #queue: Array<string | Uint8Array> = [];
  readonly #pending = new Map<string, Pending>();
  readonly #channels = new Map<string, SharedChannel>();

  /**
   * A client: one socket, every channel of the page on it.
   *
   * @param url The endpoint (default: `<basePath>/realtime/v1/websocket` on the page's origin).
   * @param open Opens a socket (default: `new WebSocket(url)`).
   */
  constructor(url?: string, open?: SocketFactory) {
    this.#url = url ?? defaultUrl();
    this.#open = open ?? ((u) => new WebSocket(u) as unknown as ClientSocket);
  }

  /** A fresh message reference. */
  nextRef(): string {
    return String(++this.#ref);
  }

  /**
   * The shared channel of a topic (joined while anyone holds it — see {@linkcode release}).
   *
   * @param name The topic, as `supabase.channel(name)` names it.
   * @param options Its options (the first holder's are kept).
   * @returns The channel.
   */
  acquire(name: string, options: RealtimeChannelOptions = {}): SharedChannel {
    const id = `${options.private ? 1 : 0}:${name}`;
    let channel = this.#channels.get(id);
    if (!channel) {
      channel = new SharedChannel(this, name, options);
      this.#channels.set(id, channel);
      this.#connect();
      if (this.#socket?.readyState === 1) channel.join();
    }
    channel.refs++;
    return channel;
  }

  /** Let go of a channel: the last holder leaves it, and an idle socket closes. */
  release(channel: SharedChannel): void {
    if (--channel.refs > 0) return;
    for (const [id, c] of this.#channels) if (c === channel) this.#channels.delete(id);
    channel.leave();
    if (this.#channels.size === 0) this.close();
  }

  /** Send a message; resolves with its reply (or `timeout`). */
  push(
    topic: string,
    event: string,
    payload: unknown,
    joinRef: string,
    ref: string = this.nextRef(),
  ): Promise<{ status: "ok" | "error" | "timeout"; response: Record<string, unknown> }> {
    // A broadcast of raw bytes rides the binary push frame (JSON cannot carry them).
    const body = payload as { event?: unknown; payload?: unknown } | null;
    const frame = event === "broadcast" && body?.payload instanceof Uint8Array
      ? encodeBroadcastPush(joinRef, ref, topic, String(body.event), body.payload)
      : encodeMessage(VSN, { joinRef, ref, topic, event, payload });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(ref);
        resolve({ status: "timeout", response: {} });
      }, PUSH_TIMEOUT_MS);
      this.#pending.set(ref, {
        timer,
        resolve: (status, response) => resolve({ status, response }),
      });
      this.#send(frame);
    });
  }

  #send(frame: string | Uint8Array): void {
    if (this.#socket?.readyState === 1) this.#socket.send(frame);
    else this.#queue.push(frame);
  }

  #connect(): void {
    if (this.#socket || this.#reconnect) return;
    const socket = this.#open(this.#url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.onopen = () => {
      this.#attempt = 0;
      const queued = this.#queue;
      this.#queue = [];
      for (const channel of this.#channels.values()) channel.join();
      for (const frame of queued) socket.send(frame);
      this.#heartbeat = setInterval(() => {
        this.#send(encodeMessage(VSN, {
          joinRef: null,
          ref: this.nextRef(),
          topic: "phoenix",
          event: "heartbeat",
          payload: {},
        }));
      }, HEARTBEAT_MS);
    };
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onclose = () => this.#dropped(socket);
    socket.onerror = () => this.#dropped(socket);
  }

  /** The socket went away: fail every pending reply, then reconnect (while channels remain). */
  #dropped(socket: ClientSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const [ref, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve("error", { reason: "disconnected" });
      this.#pending.delete(ref);
    }
    this.#queue = [];
    for (const channel of this.#channels.values()) channel.disconnected();
    if (this.#channels.size === 0) return;
    const delay = BACKOFF[Math.min(this.#attempt++, BACKOFF.length - 1)];
    this.#reconnect = setTimeout(() => {
      this.#reconnect = null;
      this.#connect();
    }, delay);
  }

  #receive(data: unknown): void {
    const message = decodeServerFrame(
      VSN,
      typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer),
    );
    if (!message) return;
    if (message.event === "phx_reply" && message.ref !== null) {
      const pending = this.#pending.get(message.ref);
      if (pending) {
        this.#pending.delete(message.ref);
        clearTimeout(pending.timer);
        const payload = record(message.payload);
        pending.resolve(payload.status === "ok" ? "ok" : "error", record(payload.response));
      }
      return;
    }
    for (const channel of this.#channels.values()) {
      if (channel.topic === message.topic) channel.receive(message);
    }
  }

  /** Close the socket (no reconnect). */
  close(): void {
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#reconnect = null;
    const socket = this.#socket;
    this.#socket = null;
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    try {
      socket?.close(1000);
    } catch { /* already closed */ }
  }
}

/** The endpoint on the page's own origin, under the app's `basePath`. */
function defaultUrl(): string {
  const base = (globalThis as { __denextBasePath?: string }).__denextBasePath ?? "";
  const location = (globalThis as { location?: { protocol: string; host: string } }).location;
  const scheme = location?.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location?.host ?? "localhost"}${base}/realtime/v1/websocket?vsn=${VSN}`;
}

let shared: RealtimeClient | null = null;

/**
 * The page's realtime client (one socket for every hook), or install another (tests, a custom
 * URL); `null` resets it.
 *
 * @param client The client to use from now on.
 * @returns The client.
 */
export function realtimeClient(client?: RealtimeClient | null): RealtimeClient {
  if (client !== undefined) {
    shared?.close();
    shared = client;
  }
  return shared ??= new RealtimeClient();
}

/**
 * Hold the page's shared channel of a topic while mounted (and `enabled`): its status goes to
 * `onStatus`, and `attach` subscribes to it (returning the unsubscribe).
 */
function useSharedChannel(
  topic: string,
  options: RealtimeChannelOptions,
  enabled: boolean,
  onStatus: StatusListener,
  attach: (channel: SharedChannel) => () => void,
): { current: SharedChannel | null } {
  const channelRef = useRef<SharedChannel | null>(null);
  const handlers = useRef({ onStatus, attach });
  handlers.current = { onStatus, attach };
  const isPrivate = options.private === true;
  useEffect(() => {
    if (!enabled) return;
    const client = realtimeClient();
    const channel = client.acquire(topic, options);
    channelRef.current = channel;
    handlers.current.onStatus(channel.status);
    const offStatus = channel.onStatus((status, reason) =>
      handlers.current.onStatus(status, reason)
    );
    const detach = handlers.current.attach(channel);
    return () => {
      offStatus();
      detach();
      channelRef.current = null;
      client.release(channel);
    };
    // deno-lint-ignore no-explicit-any
  }, [topic, isPrivate, enabled] as any);
  return channelRef;
}

/** Options for {@linkcode useBroadcast}. */
export interface UseBroadcastOptions<T> extends RealtimeChannelOptions {
  /** Only this event (default: every event). */
  event?: string;
  /** Called with each message. */
  onMessage?: (message: BroadcastMessage<T>) => void;
  /** `false` keeps the hook idle. Default true. */
  enabled?: boolean;
}

/** What {@linkcode useBroadcast} returns. */
export interface BroadcastState<T> {
  /** The latest message. */
  last?: BroadcastMessage<T>;
  /** The channel's state. */
  status: RealtimeStatus;
  /** Why it failed, when `status` is `error`. */
  error?: string;
  /** Send to everyone on the topic (every server instance); resolves `"ok"` once published. */
  send: (event: string, payload: unknown) => Promise<"ok" | "error" | "timeout">;
}

/**
 * Broadcast on a topic and receive its messages — the same channel `supabase.channel(topic)` uses,
 * so supabase-js clients, SQL's `realtime.send()` and `broadcast()` on the server reach it too,
 * on every server instance.
 *
 * ```tsx
 * "use client";
 * import { useBroadcast } from "@denext/backend/client";
 *
 * export function Cursors({ room }: { room: string }) {
 *   const { last, send } = useBroadcast<{ x: number; y: number }>(`room:${room}`, { event: "cursor" });
 *   return <div onPointerMove={(e) => send("cursor", { x: e.clientX, y: e.clientY })}>{last?.payload.x}</div>;
 * }
 * ```
 *
 * @param topic The topic.
 * @param options `event`, `onMessage`, `private`, `self`, `replay`, `enabled`.
 * @returns `{ last, status, error, send }`.
 */
export function useBroadcast<T = unknown>(
  topic: string,
  options: UseBroadcastOptions<T> = {},
): BroadcastState<T> {
  const [state, setState] = useState<
    { last?: BroadcastMessage<T>; status: RealtimeStatus; error?: string }
  >(
    { status: "closed" },
  );
  const callbacks = useRef(options);
  callbacks.current = options;
  const channelRef = useSharedChannel(
    topic,
    { private: options.private === true, self: options.self, replay: options.replay },
    options.enabled ?? true,
    (status, reason) =>
      setState((s) => ({ ...s, status, error: status === "error" ? reason : undefined })),
    (channel) =>
      channel.onBroadcast((message) => {
        const wanted = callbacks.current.event;
        if (wanted && wanted !== message.event) return;
        const typed = message as BroadcastMessage<T>;
        setState((s) => ({ ...s, last: typed }));
        callbacks.current.onMessage?.(typed);
      }),
  );
  return {
    ...state,
    send: (event, payload) => channelRef.current?.send(event, payload) ?? Promise.resolve("error"),
  };
}

/** Options for {@linkcode useRealtimePresence}. */
export interface UsePresenceOptions extends RealtimeChannelOptions {
  /** `false` keeps the hook idle. Default true. */
  enabled?: boolean;
}

/** What {@linkcode useRealtimePresence} returns. */
export interface RealtimePresenceResult<T> {
  /** Everyone present, by presence key (each key may be on several tabs/devices). */
  peers: PresenceState<T>;
  /** The channel's state. */
  status: RealtimeStatus;
  /** Why it failed, when `status` is `error`. */
  error?: string;
}

/**
 * Be present on a topic and see who else is — Supabase presence, shared by every server instance
 * on the database (a crashed instance's presences are swept within about 40 seconds), and seen
 * by supabase-js's `channel.presenceState()` too. Pass `state` to track this page (a new object
 * re-tracks; `undefined` untracks); omit it to only watch.
 *
 * ```tsx
 * const { peers } = useRealtimePresence<{ name: string }>("room:1", { name: user.name }, {
 *   presenceKey: user.id,
 * });
 * ```
 *
 * @param topic The topic.
 * @param state What to track for this page, or `undefined`.
 * @param options `presenceKey`, `private`, `enabled`.
 * @returns `{ peers, status, error }`.
 */
export function useRealtimePresence<T extends Record<string, unknown> = Record<string, unknown>>(
  topic: string,
  state?: T,
  options: UsePresenceOptions = {},
): RealtimePresenceResult<T> {
  const [result, setResult] = useState<RealtimePresenceResult<T>>({ peers: {}, status: "closed" });
  const enabled = options.enabled ?? true;
  const isPrivate = options.private === true;
  const channelRef = useSharedChannel(
    topic,
    { private: isPrivate, presenceKey: options.presenceKey },
    enabled,
    (status, reason) =>
      setResult((r) => ({ ...r, status, error: status === "error" ? reason : undefined })),
    (channel) =>
      channel.onPresence((peers) => setResult((r) => ({ ...r, peers: peers as PresenceState<T> }))),
  );
  const tracked = state === undefined ? "" : JSON.stringify(state);
  useEffect(() => {
    const channel = channelRef.current;
    if (!channel) return;
    if (state === undefined) void channel.untrack();
    else void channel.track(state);
    // deno-lint-ignore no-explicit-any
  }, [tracked, topic, isPrivate, enabled] as any);
  return result;
}
