/**
 * Live Server Components hub — the server side of `<Live>`.
 *
 * Connected clients open a WebSocket to {@link LIVE_ENDPOINT} and subscribe with
 * their route URL and the `<Live>` boundaries on the page. When a cache tag is
 * invalidated ({@link setLiveInvalidateHook} fires), the hub re-renders each
 * affected connection's route **under that connection's own cookies** — reusing the
 * whole app pipeline via a synthetic Flight request — slices out each boundary's
 * new subtree, and pushes it as a {@link LivePatch}. A boundary that can no longer
 * be located (route changed, auth expired) degrades to a {@link LiveRefresh}.
 *
 * The same socket also carries the **live-data** family: {@link useLive}
 * subscriptions (a registered server function re-run under the viewer's session and
 * pushed when one of its tags is invalidated) and {@link usePresence} rooms
 * (who's-online / cursors, broadcast on join/update/leave). Those flows run parallel
 * to the `<Live>` boundary path and never disturb it.
 *
 * The hub is mounted by the prod/dev server wrapper (outside `createApp`, so a
 * long-lived socket dodges the per-request timeout and concurrency ceiling). It is
 * a no-op until {@link installLiveHub} is called, so apps without live features pay
 * nothing.
 *
 * @module
 */

import type { FlightNode } from "../jsx/render-to-flight.ts";
import type { FlightNavPayload } from "./document.ts";
import { ID_PATH_PROP } from "../jsx/tree-id.ts";
import { setLiveInvalidateHook } from "./cache.ts";
import { getServerAction } from "../runtime/server-action.ts";
import { createRequestContext, runWithContext } from "./request-context.ts";
import {
  LIVE_REF_ID,
  type LiveBoundarySub,
  type LiveClientMessage,
  type LivePeer,
  type LiveServerMessage,
} from "../runtime/live-protocol.ts";

/** A live-data subscription: a registered server fn re-run when one of its tags changes. */
interface DataSub {
  actionId: string;
  args: unknown[];
  tags: string[];
}

/** How long to coalesce a burst of tag invalidations before re-rendering (ms). */
const COALESCE_MS = 16;

/** Skip a push when the socket's send buffer already exceeds this (bytes). */
const MAX_BUFFERED = 1 << 20; // 1 MiB

/** One connected client and the boundaries it is watching. */
interface Conn {
  socket: WebSocket;
  /** A stable per-connection id, used as this peer's presence identity. */
  peerId: string;
  /** The connection's origin (from the upgrade request) — re-renders are pinned here. */
  origin: string;
  /** The current route href to re-render (same-origin, set on subscribe). */
  url: string;
  /** The upgrade request's Cookie header, replayed so re-renders use the viewer's identity. */
  cookie: string;
  boundaries: LiveBoundarySub[];
  /** Live-data subscriptions ({@link useLive}), keyed by client sub id. */
  dataSubs: Map<string, DataSub>;
  /** Presence rooms this connection is in → this peer's state in each. */
  presenceRooms: Map<string, unknown>;
  /** A re-render is in flight; further invalidations set `dirty` to re-run once. */
  busy: boolean;
  dirty: Set<string> | null;
}

const connections = new Set<Conn>();

/** Presence room membership: room → the connections currently in it. */
const rooms = new Map<string, Set<Conn>>();

let appHandler: ((req: Request) => Promise<Response>) | null = null;
let originAllowed: (req: Request) => boolean = () => false;

/**
 * Enable the live hub: record the app handler used for out-of-band re-renders, the
 * origin policy for the WebSocket handshake, and subscribe to cache invalidations.
 * Idempotent — the latest handler/policy wins.
 *
 * @param opts.appHandler The `createApp` handler (re-invoked with synthetic requests).
 * @param opts.originAllowed Predicate gating the upgrade to same-origin clients.
 */
export function installLiveHub(opts: {
  appHandler: (req: Request) => Promise<Response>;
  originAllowed: (req: Request) => boolean;
}): void {
  appHandler = opts.appHandler;
  originAllowed = opts.originAllowed;
  setLiveInvalidateHook(onTagInvalidated);
}

/** Tear down the hub (tests / shutdown): clear the cache hook and drop connections. */
export function uninstallLiveHub(): void {
  setLiveInvalidateHook(null);
  appHandler = null;
  for (const conn of connections) {
    try {
      conn.socket.close();
    } catch { /* already closing */ }
  }
  connections.clear();
  rooms.clear();
}

/**
 * Handle a request to {@link LIVE_ENDPOINT}: reject non-WebSocket or cross-origin
 * handshakes, otherwise upgrade and register the connection.
 *
 * @param request The incoming upgrade request.
 * @returns The upgrade `Response`, or an error response when rejected.
 */
export function handleLiveUpgrade(request: Request): Response {
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("expected a WebSocket upgrade", { status: 426 });
  }
  // Reject cross-origin handshakes (CVE-2025-48068 class): a WebSocket handshake is
  // not covered by CORS, so an attacker page could otherwise open an authenticated
  // socket. The connection's own cookies still gate every pushed render regardless.
  if (!originAllowed(request)) {
    return new Response("forbidden", { status: 403 });
  }
  // Capture the identity-bearing headers BEFORE upgrading — `Deno.upgradeWebSocket`
  // consumes the request, after which reading its headers throws "Request closed".
  const origin = new URL(request.url).origin;
  const cookie = request.headers.get("cookie") ?? "";
  let upgrade: { socket: WebSocket; response: Response };
  try {
    upgrade = Deno.upgradeWebSocket(request);
  } catch {
    return new Response("upgrade failed", { status: 400 });
  }
  const { socket, response } = upgrade;
  const conn: Conn = {
    socket,
    peerId: crypto.randomUUID(),
    origin,
    url: "",
    cookie,
    boundaries: [],
    dataSubs: new Map(),
    presenceRooms: new Map(),
    busy: false,
    dirty: null,
  };
  socket.onmessage = (ev) => {
    if (typeof ev.data === "string") handleClientMessage(conn, ev.data);
  };
  socket.onclose = () => dropConnection(conn);
  socket.onerror = () => {
    dropConnection(conn);
    try {
      socket.close();
    } catch { /* already closing */ }
  };
  connections.add(conn);
  return response;
}

/** Remove a connection from the hub and every presence room it was in (rebroadcasting). */
function dropConnection(conn: Conn): void {
  connections.delete(conn);
  for (const room of conn.presenceRooms.keys()) {
    const members = rooms.get(room);
    if (!members) continue;
    members.delete(conn);
    if (members.size === 0) rooms.delete(room);
    else broadcastRoom(room);
  }
  conn.presenceRooms.clear();
}

/** Parse and apply a client message (subscribe / pong). Malformed input is ignored. */
function handleClientMessage(conn: Conn, raw: string): void {
  let msg: LiveClientMessage;
  try {
    msg = JSON.parse(raw) as LiveClientMessage;
  } catch {
    return;
  }
  switch (msg.type) {
    case "subscribe": {
      // Pin the re-render URL to the connection's own origin — never trust a
      // client-supplied origin (SSRF / cross-origin render), only its path + query.
      let resolved: URL;
      try {
        resolved = new URL(msg.url, conn.origin);
      } catch {
        return;
      }
      if (resolved.origin !== conn.origin) return;
      conn.url = resolved.href;
      conn.boundaries = Array.isArray(msg.boundaries)
        ? msg.boundaries.filter((b) => b && typeof b.id === "string" && Array.isArray(b.tags))
        : [];
      return;
    }
    case "data-subscribe": {
      if (typeof msg.subId !== "string" || typeof msg.actionId !== "string") return;
      const sub: DataSub = {
        actionId: msg.actionId,
        args: Array.isArray(msg.args) ? msg.args : [],
        tags: Array.isArray(msg.tags) ? msg.tags : [],
      };
      conn.dataSubs.set(msg.subId, sub);
      void recomputeData(conn, msg.subId, sub); // push the initial value
      return;
    }
    case "data-unsubscribe":
      if (typeof msg.subId === "string") conn.dataSubs.delete(msg.subId);
      return;
    case "presence-join":
    case "presence-update": {
      if (typeof msg.room !== "string") return;
      conn.presenceRooms.set(msg.room, msg.state);
      let members = rooms.get(msg.room);
      if (!members) rooms.set(msg.room, members = new Set());
      members.add(conn);
      broadcastRoom(msg.room);
      return;
    }
    case "presence-leave": {
      if (typeof msg.room !== "string") return;
      conn.presenceRooms.delete(msg.room);
      const members = rooms.get(msg.room);
      if (members) {
        members.delete(conn);
        if (members.size === 0) rooms.delete(msg.room);
        else broadcastRoom(msg.room);
      }
      return;
    }
      // "pong" needs no action; the client answering keeps the connection live.
  }
}

/** Broadcast a room's current membership to every peer in it. */
function broadcastRoom(room: string): void {
  const members = rooms.get(room);
  if (!members) return;
  const peers: LivePeer[] = [];
  for (const c of members) peers.push({ id: c.peerId, state: c.presenceRooms.get(room) });
  // Each recipient learns its own peer id so the client can split self vs. others.
  for (const c of members) send(c, { type: "presence-state", room, peers, selfId: c.peerId });
}

/** Cache hook: coalesce invalidated tags, then flush a re-render pass. */
function onTagInvalidated(tags: readonly string[]): void {
  for (const t of tags) pendingTags.add(t);
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flush, COALESCE_MS);
}

const pendingTags = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  flushTimer = null;
  if (pendingTags.size === 0 || connections.size === 0) {
    pendingTags.clear();
    return;
  }
  const invalidated = new Set(pendingTags);
  pendingTags.clear();
  for (const conn of connections) {
    void pushUpdates(conn, invalidated); // <Live> boundary patches
    pushDataUpdates(conn, invalidated); // useLive data subscriptions
  }
}

/** Recompute + push every live-data subscription whose tags were invalidated. */
function pushDataUpdates(conn: Conn, invalidated: Set<string>): void {
  for (const [subId, sub] of conn.dataSubs) {
    if (sub.tags.some((t) => invalidated.has(t))) void recomputeData(conn, subId, sub);
  }
}

/** Run a subscription's server function under the viewer's session and push the result. */
async function recomputeData(conn: Conn, subId: string, sub: DataSub): Promise<void> {
  try {
    const value = await runFetcher(conn, sub.actionId, sub.args);
    send(conn, { type: "data", subId, value });
  } catch {
    send(conn, { type: "data", subId, value: undefined, error: "recompute failed" });
  }
}

/**
 * Invoke a registered server function by id **under the connection's own session**
 * (its replayed cookie), inside a fresh request context so the fn's `cookies()` /
 * `getSession` / cache reads run as the viewer. The socket was origin-gated at
 * handshake; the fn must still authorize its own access (same as any server action).
 */
function runFetcher(conn: Conn, actionId: string, args: unknown[]): Promise<unknown> {
  const handler = getServerAction(actionId);
  if (!handler) return Promise.reject(new Error(`unknown live action: ${actionId}`));
  const request = new Request(conn.url || conn.origin, {
    headers: conn.cookie ? { cookie: conn.cookie } : {},
  });
  return Promise.resolve(runWithContext(createRequestContext(request), () => handler(...args)));
}

/** Re-render `conn`'s route and push a patch for each affected boundary. */
async function pushUpdates(conn: Conn, invalidated: Set<string>): Promise<void> {
  const affected = conn.boundaries.filter((b) => b.tags.some((t) => invalidated.has(t)));
  if (affected.length === 0 || !conn.url) return;

  // Per-connection single-flight: if a render is already running, remember the tags
  // and re-run once it finishes, so a burst collapses to at most one queued render.
  if (conn.busy) {
    conn.dirty ??= new Set();
    for (const t of invalidated) conn.dirty.add(t);
    return;
  }
  conn.busy = true;
  try {
    const flight = await rerender(conn);
    if (flight === null) {
      send(conn, { type: "refresh" }); // route changed / redirect / auth lost
    } else {
      for (const b of affected) {
        const children = sliceBoundary(flight, b.id);
        send(
          conn,
          children ? { type: "patch", boundaryId: b.id, flight: children } : { type: "refresh" },
        );
      }
    }
  } catch {
    send(conn, { type: "refresh" }); // degrade to a client-driven refresh, never stale
  } finally {
    conn.busy = false;
    const queued = conn.dirty;
    conn.dirty = null;
    if (queued && connections.has(conn)) void pushUpdates(conn, queued);
  }
}

/**
 * Re-render a connection's route as Flight, under its captured cookies. Returns the
 * route's Flight tree, or `null` when the route yields no Flight payload (a redirect,
 * a 401, or a non-Flight response) — the caller then degrades to a refresh.
 */
async function rerender(conn: Conn): Promise<FlightNode | null> {
  if (!appHandler) return null;
  const req = new Request(conn.url, {
    method: "GET",
    headers: {
      "x-denext-nav": "1", // request the Flight soft-nav payload, not full HTML
      accept: "application/json",
      ...(conn.cookie ? { cookie: conn.cookie } : {}),
    },
  });
  const res = await appHandler(req);
  if (res.headers.get("x-denext-flight") !== "1") {
    // Drain the body so the response isn't left dangling, then signal a refresh.
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const payload = JSON.parse(await res.text()) as FlightNavPayload;
  return payload?.flight ?? null;
}

/** Send a server message if the socket is open and not back-pressured. */
function send(conn: Conn, msg: LiveServerMessage): void {
  const s = conn.socket;
  if (s.readyState !== WebSocket.OPEN) return;
  if (s.bufferedAmount > MAX_BUFFERED) return; // shed rather than unbounded-buffer
  try {
    s.send(JSON.stringify(msg));
  } catch { /* closing between the check and the send */ }
}

/**
 * Locate the `<Live>` boundary identified by `boundaryId` in a Flight tree and
 * return its (new) children — the payload the client swaps into that boundary.
 * Returns `null` if the boundary is not present in this render.
 *
 * @param node The route's Flight tree.
 * @param boundaryId The boundary's tree-path id (its island `__dnxIdPath`).
 * @returns The boundary's children array, or `null` when not found.
 */
export function sliceBoundary(node: FlightNode, boundaryId: string): FlightNode[] | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = sliceBoundary(child, boundaryId);
      if (found) return found;
    }
    return null;
  }
  if (node.$ === "c" && node.i === LIVE_REF_ID && node.p?.[ID_PATH_PROP] === boundaryId) {
    return node.c;
  }
  if (node.$ === "h" || node.$ === "c") {
    for (const child of node.c) {
      const found = sliceBoundary(child, boundaryId);
      if (found) return found;
    }
  }
  return null;
}
