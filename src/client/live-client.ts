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
 * @module
 */

import type { FlightNode } from "../jsx/render-to-flight.ts";
import type { VNodeChild } from "../jsx/types.ts";
import { setLiveRegistrar } from "../runtime/live-registry.ts";
import {
  LIVE_ENDPOINT,
  type LiveServerMessage,
  type LiveSubscribe,
} from "../runtime/live-protocol.ts";

interface Boundary {
  tags: string[];
  onPatch: (children: VNodeChild) => void;
}

const boundaries = new Map<string, Boundary>();
let socket: WebSocket | null = null;
let parse: ((flight: FlightNode) => VNodeChild) | null = null;
let refresh: (() => void) | null = null;

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
    if (boundaries.size === 0) closeSocket();
    else scheduleSubscribe();
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
    sendSubscribe();
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
    case "ping":
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong" }));
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
  if (!socket || socket.readyState !== WebSocket.OPEN || typeof location === "undefined") return;
  const msg: LiveSubscribe = {
    type: "subscribe",
    url: location.href,
    boundaries: [...boundaries].map(([id, b]) => ({ id, tags: b.tags })),
  };
  try {
    socket.send(JSON.stringify(msg));
  } catch { /* socket closed underneath us */ }
}

function scheduleReconnect(): void {
  if (boundaries.size === 0) return; // nothing to keep alive for
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
