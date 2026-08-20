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

interface DataSub {
  actionId: string;
  args: unknown[];
  tags: string[];
  onData: (value: unknown, error?: string) => void;
}

interface PresenceRoom {
  state: unknown;
  onState: (peers: LivePeer[], selfId: string) => void;
}

const boundaries = new Map<string, Boundary>();
const dataSubs = new Map<string, DataSub>();
const presenceRooms = new Map<string, PresenceRoom>();
let subCounter = 0;

let socket: WebSocket | null = null;
let parse: ((flight: FlightNode) => VNodeChild) | null = null;
let refresh: (() => void) | null = null;

/** Any live subscription (boundary, data, or presence) that keeps the socket alive. */
function hasSubscriptions(): boolean {
  return boundaries.size > 0 || dataSubs.size > 0 || presenceRooms.size > 0;
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
  parse: (flight: FlightNode) => VNodeChild;
  refresh: () => void;
}): void {
  parse = opts.parse;
  refresh = opts.refresh;
  setLiveRegistrar(register);
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
  onData: (value: unknown, error?: string) => void,
): () => void {
  const subId = `d${++subCounter}`;
  dataSubs.set(subId, { actionId, args, tags, onData });
  ensureSocket();
  sendFrame({ type: "data-subscribe", subId, actionId, args, tags });
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
      if (b && parse) b.onPatch(parse(msg.flight));
      break;
    }
    case "refresh":
      refresh?.();
      break;
    case "data":
      dataSubs.get(msg.subId)?.onData(msg.value, msg.error);
      break;
    case "presence-state":
      presenceRooms.get(msg.room)?.onState(msg.peers, msg.selfId);
      break;
    case "ping":
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong" }));
      break;
    case "error":
      // A refused subscription/join or a hit limit. Deliver to the owning data
      // subscription if it has one; otherwise surface it (dev-facing).
      if (msg.subId) dataSubs.get(msg.subId)?.onData(undefined, msg.reason ?? msg.code);
      else console.warn(`denext live: ${msg.code}${msg.reason ? ` — ${msg.reason}` : ""}`);
      break;
  }
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
  for (const [subId, s] of dataSubs) {
    sendFrame({ type: "data-subscribe", subId, actionId: s.actionId, args: s.args, tags: s.tags });
  }
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
