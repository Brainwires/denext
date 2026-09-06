/**
 * Live Server Components client — the browser transport behind `<Live>`.
 *
 * A single WebSocket to {@link LIVE_ENDPOINT} is opened lazily when the first
 * `<Live>` boundary mounts and closed when the last unmounts, so pages without live
 * boundaries never connect. It subscribes the mounted boundaries (and the current
 * route URL) to the server hub, applies {@link LivePatch} frames to the addressed
 * boundary, and honours a {@link LiveRefresh} by re-rendering the route. It
 * reconnects with backoff and, after a reconnect, refreshes once to catch up on any
 * invalidations missed while offline.
 *
 * The generated Flight entry calls {@link configureLive} once with a Flight parser
 * (bound to the app's client registry) and the router refresh; boundaries then
 * register through {@link ../runtime/live-registry.ts | live-registry}.
 *
 * The same socket also carries the live-data family — {@link subscribeLiveData}
 * (backing `useLive`) and {@link joinPresence} (backing `usePresence`) — each with
 * its own frames, folded into the connect/reconnect resubscribe so subscriptions
 * survive a socket drop.
 *
 * @module
 */

import type { FlightNode } from "../jsx/render-to-flight.ts";
import type { VNodeChild } from "../jsx/types.ts";
import { setLiveRegistrar } from "../runtime/live-registry.ts";
import { decodeWire, prepareWire, WIRE_ENC } from "../runtime/wire-codec.ts";
import { setApiInvalidationSource } from "./use-api.ts";
import {
  LIVE_ENDPOINT,
  type LiveClientMessage,
  type LivePeer,
  type LiveServerMessage,
  type LiveSubscribe,
} from "../runtime/live-protocol.ts";

interface Boundary {
  tags: string[];
  onPatch: (children: VNodeChild) => void;
}

/** The structured part of a server `error` frame, handed to a data subscription's callback. */
export interface LiveErrorInfo {
  /** The frame's machine-readable code. */
  code: string;
  /** The frame's short explanation. */
  reason?: string;
  /** Per-field validation messages (`invalid-input`). */
  fieldErrors?: Record<string, string>;
  /** The redaction digest (`failed`). */
  digest?: string;
}

interface DataSub {
  actionId: string;
  /** Already wire-encoded (sent verbatim on every reconnect). */
  args: unknown[];
  tags: string[];
  /** `1` when `args` carries codec tags. */
  enc?: 1;
  /** Set when the server refused it for good (invalid input, denied, …): not re-sent on reconnect. */
  dead?: boolean;
  onData: (value: unknown, error?: string, info?: LiveErrorInfo) => void;
}

/** Error codes after which re-sending the same subscription can only fail again. */
const TERMINAL_CODES = new Set(["invalid-input", "denied", "no-policy", "bad-message", "limit"]);

interface PresenceRoom {
  state: unknown;
  onState: (peers: LivePeer[], selfId: string) => void;
}

interface TagSub {
  tags: string[];
  onInvalidate: () => void;
}

const boundaries = new Map<string, Boundary>();
const dataSubs = new Map<string, DataSub>();
const tagSubs = new Map<string, TagSub>();
const presenceRooms = new Map<string, PresenceRoom>();
let subCounter = 0;

let socket: WebSocket | null = null;
let parse: ((flight: FlightNode) => VNodeChild | Promise<VNodeChild>) | null = null;
let refresh: (() => void) | null = null;

/** Any live subscription (boundary, data, or presence) that keeps the socket alive. */
function hasSubscriptions(): boolean {
  return boundaries.size > 0 || dataSubs.size > 0 || tagSubs.size > 0 || presenceRooms.size > 0;
}

/** Send one client frame if the socket is open (no-op otherwise; resent on reconnect). */
function sendFrame(msg: LiveClientMessage): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch { /* socket closed underneath us */ }
}

const RECONNECT_MIN = 500;
const RECONNECT_MAX = 15_000;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let subscribeQueued = false;
/** True once we've connected at least once, so a later open is a *re*-connect. */
let hadConnection = false;

/**
 * Install the Flight parser and route-refresh used by the live transport, and wire
 * `<Live>` boundary registration. Called once by the generated Flight client entry.
 *
 * @param opts.parse Reconstruct a VNode subtree from a Flight payload (via the registry).
 * @param opts.refresh Re-render the current route (the router's `refresh`).
 */
export function configureLive(opts: {
  parse: (flight: FlightNode) => VNodeChild | Promise<VNodeChild>;
  refresh: () => void;
}): void {
  parse = opts.parse;
  refresh = opts.refresh;
  setLiveRegistrar(register);
  // `useApi({ tags })` refetches on a tag invalidation whenever the Live transport is present.
  setApiInvalidationSource(subscribeLiveTags);
}

/**
 * Be told when any of `tags` is invalidated on the server (`revalidateTag`); backs
 * `useApi({ tags })`. Returns an unsubscribe.
 *
 * @param tags The cache tags to watch.
 * @param onInvalidate Called with no arguments when one of them is invalidated.
 */
export function subscribeLiveTags(tags: string[], onInvalidate: () => void): () => void {
  const subId = `t${++subCounter}`;
  tagSubs.set(subId, { tags, onInvalidate });
  ensureSocket();
  sendFrame({ type: "tags-subscribe", subId, tags });
  return () => {
    tagSubs.delete(subId);
    sendFrame({ type: "tags-unsubscribe", subId });
    if (!hasSubscriptions()) closeSocket();
  };
}

/** Register a mounted boundary; opens the socket on the first one. Returns an unsubscribe. */
function register(
  id: string,
  tags: string[],
  onPatch: (children: VNodeChild) => void,
): () => void {
  boundaries.set(id, { tags, onPatch });
  ensureSocket();
  scheduleSubscribe();
  return () => {
    boundaries.delete(id);
    if (!hasSubscriptions()) closeSocket();
    else scheduleSubscribe();
  };
}

/**
 * Subscribe to a server function's result, pushed whenever one of `tags` is
 * invalidated. Backs {@link useLive}. Returns an unsubscribe.
 *
 * @param actionId The registered server-function id (a `serverAction`).
 * @param args Arguments for the server function.
 * @param tags Cache tags whose invalidation triggers a recompute.
 * @param onData Called with each pushed value (or `undefined` + error).
 */
export function subscribeLiveData(
  actionId: string,
  args: unknown[],
  tags: string[],
  onData: (value: unknown, error?: string, info?: LiveErrorInfo) => void,
): () => void {
  const subId = `d${++subCounter}`;
  // Encode once (the frame is re-sent verbatim on every reconnect).
  const p = prepareWire(args);
  const sub: DataSub = { actionId, args: p.value as unknown[], tags, onData };
  if (p.tagged) sub.enc = WIRE_ENC;
  dataSubs.set(subId, sub);
  ensureSocket();
  sendFrame(subscribeFrame(subId, sub));
  return () => {
    dataSubs.delete(subId);
    sendFrame({ type: "data-unsubscribe", subId });
    if (!hasSubscriptions()) closeSocket();
  };
}

/**
 * Join a presence room and receive its membership. Backs {@link usePresence}.
 *
 * @param room The room id.
 * @param initialState This peer's initial presence state.
 * @param onState Called with the room's peers whenever membership/state changes.
 * @returns `update(state)` to publish a new state, and `leave()` to exit.
 */
export function joinPresence(
  room: string,
  initialState: unknown,
  onState: (peers: LivePeer[], selfId: string) => void,
): { update: (state: unknown) => void; leave: () => void } {
  presenceRooms.set(room, { state: initialState, onState });
  ensureSocket();
  sendFrame({ type: "presence-join", room, state: initialState });
  return {
    update: (state: unknown) => {
      const entry = presenceRooms.get(room);
      if (!entry) return;
      entry.state = state;
      sendFrame({ type: "presence-update", room, state });
    },
    leave: () => {
      presenceRooms.delete(room);
      sendFrame({ type: "presence-leave", room });
      if (!hasSubscriptions()) closeSocket();
    },
  };
}

function ensureSocket(): void {
  if (typeof WebSocket === "undefined" || typeof location === "undefined") return;
  if (
    socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${scheme}//${location.host}${LIVE_ENDPOINT}`);
  socket = ws;
  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN;
    sendAllSubscriptions(); // boundaries + data subs + presence rooms
    // A reconnect may have missed invalidations while offline — reconcile once.
    if (hadConnection) refresh?.();
    hadConnection = true;
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") handleServerMessage(ev.data);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch { /* already closing */ }
  };
}

/**
 * Deliver a parsed patch to its boundary. The parser may first load island chunks the patch
 * references (code-split islands) and return a Promise; a synchronous parser patches
 * synchronously.
 */
function applyPatch(
  b: { onPatch: (tree: VNodeChild) => void },
  tree: VNodeChild | Promise<VNodeChild>,
): void {
  if (tree instanceof Promise) {
    tree.then((t) => b.onPatch(t)).catch((err) => {
      console.warn("denext: live patch failed:", (err as Error)?.message);
    });
  } else b.onPatch(tree);
}

function handleServerMessage(raw: string): void {
  let msg: LiveServerMessage;
  try {
    msg = JSON.parse(raw) as LiveServerMessage;
  } catch {
    return;
  }
  switch (msg.type) {
    case "patch": {
      const b = boundaries.get(msg.boundaryId);
      if (b && parse) applyPatch(b, parse(msg.flight));
      break;
    }
    case "refresh":
      refresh?.();
      break;
    case "data":
      deliverData(msg);
      break;
    case "invalidate":
      tagSubs.get(msg.subId)?.onInvalidate();
      break;
    case "presence-state":
      presenceRooms.get(msg.room)?.onState(msg.peers, msg.selfId);
      break;
    case "ping":
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong" }));
      break;
    case "error":
      deliverError(msg);
      break;
  }
}

/** The `data-subscribe` frame for one subscription (its args are already wire-encoded). */
function subscribeFrame(subId: string, s: DataSub): LiveClientMessage {
  const frame: LiveClientMessage = {
    type: "data-subscribe",
    subId,
    actionId: s.actionId,
    args: s.args,
    tags: s.tags,
  };
  if (s.enc) frame.enc = s.enc;
  return frame;
}

/** Hand a pushed value to its subscription, decoding a codec-flagged (`enc`) value first. */
function deliverData(msg: { subId: string; value: unknown; enc?: 1; error?: string }): void {
  const sub = dataSubs.get(msg.subId);
  if (!sub) return;
  if (msg.enc !== WIRE_ENC) return sub.onData(msg.value, msg.error);
  try {
    sub.onData(decodeWire(msg.value), msg.error);
  } catch {
    sub.onData(undefined, "malformed value");
  }
}

/**
 * A refused subscription/join, a hit limit, a missing policy, or a failed recompute. Deliver to
 * the owning data subscription if it has one (marking it dead when re-sending could only fail
 * again). `no-policy` is a setup error, logged as an ERROR (loud, and identical in dev and prod)
 * so it's caught immediately; other codes are advisory warnings.
 */
function deliverError(msg: LiveErrorInfo & { subId?: string }): void {
  const text = `denext live: ${msg.reason ?? msg.code}`;
  if (msg.code === "no-policy") console.error(text);
  else if (!msg.subId) console.warn(text);
  if (!msg.subId) return;
  const sub = dataSubs.get(msg.subId);
  if (!sub) return;
  if (TERMINAL_CODES.has(msg.code)) sub.dead = true;
  sub.onData(undefined, msg.reason ?? msg.code, msg);
}

/** Batch multiple mount/unmount events into a single subscribe on the next microtask. */
function scheduleSubscribe(): void {
  if (subscribeQueued) return;
  subscribeQueued = true;
  queueMicrotask(() => {
    subscribeQueued = false;
    sendSubscribe();
  });
}

function sendSubscribe(): void {
  if (typeof location === "undefined") return;
  const msg: LiveSubscribe = {
    type: "subscribe",
    url: location.href,
    boundaries: [...boundaries].map(([id, b]) => ({ id, tags: b.tags })),
  };
  sendFrame(msg);
}

/** (Re)send every live subscription — called on connect and reconnect. */
function sendAllSubscriptions(): void {
  if (boundaries.size > 0) sendSubscribe();
  for (const [subId, s] of dataSubs) if (!s.dead) sendFrame(subscribeFrame(subId, s));
  for (const [subId, t] of tagSubs) sendFrame({ type: "tags-subscribe", subId, tags: t.tags });
  for (const [room, r] of presenceRooms) {
    sendFrame({ type: "presence-join", room, state: r.state });
  }
}

function scheduleReconnect(): void {
  if (!hasSubscriptions()) return; // nothing to keep alive for
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}

function closeSocket(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  hadConnection = false;
  reconnectDelay = RECONNECT_MIN;
  const s = socket;
  socket = null;
  if (s) {
    try {
      s.close();
    } catch { /* already closing */ }
  }
}
