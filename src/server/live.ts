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
import type { LiveConfig, LiveConnectionContext, LiveLimits } from "./config.ts";
import { ID_PATH_PROP } from "../jsx/tree-id.ts";
import { setLiveInvalidateHook } from "./cache.ts";
import { getServerAction, isLiveReadable } from "../runtime/server-action.ts";
import { createRequestContext, runWithContext } from "./request-context.ts";
import {
  LIVE_REF_ID,
  type LiveBoundarySub,
  type LiveClientMessage,
  type LiveError,
  type LivePeer,
  type LiveServerMessage,
} from "../runtime/live-protocol.ts";

/** A live-data subscription: a registered server fn re-run when one of its tags changes. */
interface DataSub {
  actionId: string;
  args: unknown[];
  tags: string[];
  /**
   * Per-subscription single-flight (mirrors the `<Live>` boundary's `conn.busy`/
   * `conn.dirty`): a recompute in flight sets `busy`; a further invalidation sets
   * `dirty` so exactly one follow-up runs after it. This keeps a burst from racing the
   * async fetcher and pushing out-of-order `data` frames (the client keeps whichever
   * *arrives* last), so the final frame always reflects the latest state.
   */
  busy?: boolean;
  dirty?: boolean;
}

/** How long to coalesce a burst of tag invalidations before re-rendering (ms). */
const COALESCE_MS = 16;

/** Skip a push when the socket's send buffer already exceeds this (bytes). */
const MAX_BUFFERED = 1 << 20; // 1 MiB

/** How often to re-check a back-pressured socket's buffer before replaying shed frames. */
const RECOVER_POLL_MS = 250;

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
  /**
   * Back-pressure recovery. When a stateful frame is shed because the send buffer is
   * full ({@link MAX_BUFFERED}), these record what to replay once the socket drains:
   * `recoverBoundaries` = a `<Live>` patch was dropped (a `refresh` catches every
   * boundary up), `recoverSubs` = the `useLive` sub ids whose `data` was dropped
   * (re-running each fetcher pushes its latest value). `recoverTimer` polls for the
   * drain (Deno's `WebSocket` has no drain event).
   */
  recoverBoundaries?: boolean;
  recoverSubs?: Set<string>;
  recoverTimer?: ReturnType<typeof setTimeout> | null;
}

const connections = new Set<Conn>();

/** Presence room membership: room → the connections currently in it. */
const rooms = new Map<string, Set<Conn>>();

let appHandler: ((req: Request) => Promise<Response>) | null = null;
let originAllowed: (req: Request) => boolean = () => false;
let policy: LiveConfig = {};

/** Built-in resource caps — apply unless overridden via `live.limits`. */
const DEFAULT_LIMITS: Required<LiveLimits> = {
  maxConnections: 10_000,
  maxSubscriptionsPerConnection: 64,
  maxRoomsPerConnection: 32,
  maxBoundaries: 256,
  maxMessageBytes: 64 * 1024,
  idleTimeoutSeconds: 120,
  maxConcurrentRenders: 40,
  renderTimeoutSeconds: 30,
};
let limits: Required<LiveLimits> = DEFAULT_LIMITS;

// Fleet-wide concurrency gate for flush-driven re-renders/recomputes. A single
// `revalidateTag` can match every connection; without this, `flush()` would spawn one
// full-route render (or fetcher run) per connection at once — a self-inflicted DoS.
// The per-connection single-flight (`conn.busy`/`sub.busy`) only serializes ONE
// connection, so the bound has to live here, above the whole fan-out.
let activeRenders = 0;
const renderWaiters: Array<() => void> = [];
export function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    activeRenders++;
    try {
      return await fn();
    } finally {
      activeRenders--;
      renderWaiters.shift()?.();
    }
  };
  if (activeRenders < limits.maxConcurrentRenders) return run();
  // Re-check after each wake (a slot could be taken between wake and acquire).
  const waitAndRun = async (): Promise<T> => {
    while (activeRenders >= limits.maxConcurrentRenders) {
      await new Promise<void>((resolve) => renderWaiters.push(resolve));
    }
    return run();
  };
  return waitAndRun();
}

// Bound how long a single live re-render/recompute may run. A slot from
// `withRenderSlot` is held for the whole duration of `fn`, so a user fetcher that
// hangs would pin its slot forever; `renderTimeoutSeconds` (default 30) hung fetchers
// would then peg `activeRenders` at the cap and stall the whole fleet. The signal lets
// cooperative user code abort; the race guarantees the slot is released even if the
// user code ignores it (the detached promise no longer holds a slot — the bounded
// resource). Exported for testing.
export function withDeadline<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("live render deadline exceeded", "TimeoutError")),
    ms,
  );
  return Promise.race([
    fn(ctrl.signal),
    new Promise<never>((_, reject) =>
      ctrl.signal.addEventListener(
        "abort",
        () => reject(ctrl.signal.reason ?? new DOMException("aborted", "AbortError")),
        { once: true },
      )
    ),
  ]).finally(() => clearTimeout(timer));
}

/** The configured per-render deadline in milliseconds. */
function renderDeadlineMs(): number {
  return limits.renderTimeoutSeconds * 1000;
}

/**
 * Enable the live hub: record the app handler used for out-of-band re-renders, the
 * origin policy for the WebSocket handshake, the app's authorization/limits config,
 * and subscribe to cache invalidations. Idempotent — the latest wins.
 *
 * @param opts.appHandler The `createApp` handler (re-invoked with synthetic requests).
 * @param opts.originAllowed Predicate gating the upgrade to same-origin clients.
 * @param opts.config The app's `live` policy + limits (optional).
 */
export function installLiveHub(opts: {
  appHandler: (req: Request) => Promise<Response>;
  originAllowed: (req: Request) => boolean;
  config?: LiveConfig;
}): void {
  appHandler = opts.appHandler;
  originAllowed = opts.originAllowed;
  policy = opts.config ?? {};
  limits = sanitizeLimits(policy.limits);
  warnedNoPolicy = false;
  setLiveInvalidateHook(onTagInvalidated);
}

/**
 * Merge caller limits over the defaults, but only accept a finite number > 0 for each
 * cap. A bad-type value (e.g. `maxMessageBytes: "64kb"`) would otherwise survive the
 * spread and make the runtime comparison `raw.length > "64kb"` a `NaN` test that is
 * always false — silently DISABLING the cap. Any invalid value falls back to the
 * default with a one-time warning, so a config typo can never turn a control off.
 */
export function sanitizeLimits(overrides?: LiveLimits): Required<LiveLimits> {
  const out = { ...DEFAULT_LIMITS };
  if (!overrides) return out;
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof LiveLimits)[]) {
    const v = overrides[key];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[key] = v;
    } else {
      console.warn(
        `denext: ignoring invalid live.limits.${key} (${JSON.stringify(v)}) — ` +
          `must be a finite number > 0; using the default ${DEFAULT_LIMITS[key]}.`,
      );
    }
  }
  return out;
}

/** Tear down the hub (tests / shutdown): clear the cache hook and drop connections. */
export function uninstallLiveHub(): void {
  setLiveInvalidateHook(null);
  appHandler = null;
  policy = {};
  limits = DEFAULT_LIMITS;
  for (const conn of connections) {
    // `close()` triggers `onclose` → `dropConnection` (which clears this too), but that
    // fires async; clear the recovery poll here so teardown leaves no dangling timer.
    if (conn.recoverTimer != null) {
      clearTimeout(conn.recoverTimer);
      conn.recoverTimer = null;
    }
    try {
      conn.socket.close();
    } catch { /* already closing */ }
  }
  connections.clear();
  rooms.clear();
  // Disarm any pending coalesce flush so teardown leaves no dangling timer (the Deno
  // test op-sanitizer flags one) and no tags leak into the next install.
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingTags.clear();
}

/** The identity/context handed to policy hooks (also the ctx `getSession` reads from). */
function connContext(conn: Conn): LiveConnectionContext {
  return { origin: conn.origin, url: conn.url, cookie: conn.cookie, peerId: conn.peerId };
}

/**
 * Run a policy hook (or any fn needing the viewer's identity) inside the
 * connection's own request context — its replayed cookie — so `getSession()` /
 * `cookies()` resolve to the acting user. Mirrors {@link runFetcher}.
 */
function withConnContext<T>(conn: Conn, fn: () => T | Promise<T>): Promise<T> {
  const request = new Request(conn.url || conn.origin, {
    headers: conn.cookie ? { cookie: conn.cookie } : {},
  });
  return Promise.resolve(runWithContext(createRequestContext(request), fn));
}

/**
 * An authorization outcome:
 * - `allow`   — a policy (or `liveReadable`/`allowAnonymous`) admitted it;
 * - `deny`    — a policy hook evaluated and returned `false` (the app said no);
 * - `no-policy` — nothing was configured for this at all: NOT a runtime denial but a
 *   **configuration** gap, treated the SAME in dev and production (no divergence) and
 *   surfaced loudly and actionably so it is caught the first time it runs locally.
 */
type AuthDecision = "allow" | "deny" | "no-policy";

/** The one-line, actionable hint sent/logged when no policy is configured. */
const NO_POLICY_HINT =
  "Live presence / useLive need a `live` policy in denext.config. Add `canJoinRoom` / " +
  "`canSubscribe` (the hook runs in the visitor's session, so `getSession()` works " +
  "inside it), or mark read actions with `liveReadable(...)`. For genuinely public " +
  "access set `live.allowAnonymous: true`.";

// Loud, one-time server-side error when a gated hook is used with no policy. Fires in
// dev AND production alike — the whole point is to catch it the first time, not to let
// it work in dev and silently break in prod.
let warnedNoPolicy = false;
function warnNoPolicyOnce(): void {
  if (warnedNoPolicy) return;
  warnedNoPolicy = true;
  console.error(`denext: ${NO_POLICY_HINT}`);
}

/** Decide whether a connection may join/update a presence room. */
async function authorizeRoom(conn: Conn, room: string): Promise<AuthDecision> {
  if (policy.canJoinRoom) {
    const ok = await withConnContext(conn, () => policy.canJoinRoom!(connContext(conn), room));
    return ok ? "allow" : "deny";
  }
  return policy.allowAnonymous ? "allow" : "no-policy";
}

/** Decide whether a connection may run a `useLive` data subscription. */
async function authorizeData(
  conn: Conn,
  sub: { actionId: string; args: unknown[]; tags: string[] },
): Promise<AuthDecision> {
  if (policy.canSubscribe) {
    const ok = await withConnContext(conn, () => policy.canSubscribe!(connContext(conn), sub));
    return ok ? "allow" : "deny";
  }
  // Data subscriptions ALWAYS require the explicit `liveReadable` opt-in — even under
  // `allowAnonymous`. That flag opens presence rooms (see `authorizeRoom`) and makes
  // already-readable data reachable, but it must NOT silently expose every registered
  // action (incl. mutations) on the persistent socket: unlike the one-shot HTTP
  // dispatch, a data-subscribe re-runs its handler on every tag invalidation. Without a
  // `canSubscribe` policy, an unmarked action is a configuration gap (`no-policy`), not
  // an anonymous allow.
  return isLiveReadable(sub.actionId) ? "allow" : "no-policy";
}

/** Refuse a subscription/join by decision, sending the right error frame + log. */
function refuse(
  conn: Conn,
  decision: "deny" | "no-policy",
  what: string,
  extra?: Partial<LiveError>,
): void {
  if (decision === "no-policy") {
    warnNoPolicyOnce();
    sendError(conn, "no-policy", NO_POLICY_HINT, extra);
  } else {
    sendError(conn, "denied", `${what} not permitted`, extra);
  }
}

/** Send an advisory error frame (subscription refused / limit hit). */
function sendError(
  conn: Conn,
  code: LiveError["code"],
  reason: string,
  extra?: Partial<LiveError>,
): void {
  send(conn, { type: "error", code, reason, ...extra });
}

/**
 * Handle a request to {@link LIVE_ENDPOINT}: reject non-WebSocket or cross-origin
 * handshakes, otherwise upgrade and register the connection.
 *
 * @param request The incoming upgrade request.
 * @returns The upgrade `Response`, or an error response when rejected.
 */
export async function handleLiveUpgrade(request: Request): Promise<Response> {
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("expected a WebSocket upgrade", { status: 426 });
  }
  // Reject cross-origin handshakes (CVE-2025-48068 class): a WebSocket handshake is
  // not covered by CORS, so an attacker page could otherwise open an authenticated
  // socket. The connection's own cookies still gate every pushed render regardless.
  if (!originAllowed(request)) {
    return new Response("forbidden", { status: 403 });
  }
  // Total-connection cap (DoS guard): refuse before upgrading rather than accept and
  // immediately close, so a flood can't churn upgrades.
  if (connections.size >= limits.maxConnections) {
    return new Response("too many connections", { status: 503 });
  }
  // Capture the identity-bearing headers BEFORE upgrading — `Deno.upgradeWebSocket`
  // consumes the request, after which reading its headers throws "Request closed".
  const origin = new URL(request.url).origin;
  const cookie = request.headers.get("cookie") ?? "";
  const peerId = crypto.randomUUID();
  // Connection-level authorization: run the app's `authorize` hook (if any) under the
  // viewer's own session before consuming the request for the upgrade.
  if (policy.authorize) {
    const ctx: LiveConnectionContext = { origin, url: "", cookie, peerId };
    const req = new Request(origin, { headers: cookie ? { cookie } : {} });
    let ok = false;
    try {
      ok = await Promise.resolve(
        runWithContext(createRequestContext(req), () => policy.authorize!(ctx)),
      );
    } catch {
      ok = false;
    }
    if (!ok) return new Response("forbidden", { status: 403 });
  }
  let upgrade: { socket: WebSocket; response: Response };
  try {
    upgrade = Deno.upgradeWebSocket(request, { idleTimeout: limits.idleTimeoutSeconds });
  } catch {
    return new Response("upgrade failed", { status: 400 });
  }
  const { socket, response } = upgrade;
  const conn: Conn = {
    socket,
    peerId,
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
  if (conn.recoverTimer != null) {
    clearTimeout(conn.recoverTimer);
    conn.recoverTimer = null;
  }
  for (const room of conn.presenceRooms.keys()) {
    const members = rooms.get(room);
    if (!members) continue;
    members.delete(conn);
    if (members.size === 0) rooms.delete(room);
    else broadcastRoom(room);
  }
  conn.presenceRooms.clear();
}

/** Parse and apply a client message. Oversized or malformed input is ignored. */
function handleClientMessage(conn: Conn, raw: string): void {
  // Inbound size cap (DoS guard) — refuse before parsing / storing.
  if (raw.length > limits.maxMessageBytes) {
    sendError(conn, "limit", "message too large");
    return;
  }
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
      const boundaries = Array.isArray(msg.boundaries)
        ? msg.boundaries.filter((b) => b && typeof b.id === "string" && Array.isArray(b.tags))
        : [];
      // Cap the number of watched boundaries (bounds per-invalidation work).
      conn.boundaries = boundaries.slice(0, limits.maxBoundaries);
      return;
    }
    case "data-subscribe":
      void handleDataSubscribe(conn, msg);
      return;
    case "data-unsubscribe":
      if (typeof msg.subId === "string") conn.dataSubs.delete(msg.subId);
      return;
    case "presence-join":
    case "presence-update":
      void handlePresence(conn, msg);
      return;
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

/** Authorize + register a `useLive` data subscription (subscribing runs the action). */
async function handleDataSubscribe(
  conn: Conn,
  msg: { subId?: unknown; actionId?: unknown; args?: unknown; tags?: unknown },
): Promise<void> {
  if (typeof msg.subId !== "string" || typeof msg.actionId !== "string") return;
  const subId = msg.subId;
  // Per-connection subscription cap (a new id when already at the cap is refused).
  if (!conn.dataSubs.has(subId) && conn.dataSubs.size >= limits.maxSubscriptionsPerConnection) {
    sendError(conn, "limit", "too many subscriptions", { subId });
    return;
  }
  const sub: DataSub = {
    actionId: msg.actionId,
    args: Array.isArray(msg.args) ? msg.args : [],
    tags: Array.isArray(msg.tags) ? msg.tags : [],
  };
  let decision: AuthDecision = "deny";
  try {
    decision = await authorizeData(conn, sub);
  } catch {
    decision = "deny";
  }
  if (decision !== "allow") {
    refuse(conn, decision, "subscription", { subId });
    return;
  }
  if (!connections.has(conn)) return; // disconnected while authorizing
  conn.dataSubs.set(subId, sub);
  void recomputeData(conn, subId, sub); // push the initial value
}

/** Authorize + apply a presence join/update, then rebroadcast the room. */
async function handlePresence(
  conn: Conn,
  msg: { room?: unknown; state?: unknown },
): Promise<void> {
  if (typeof msg.room !== "string") return;
  const room = msg.room;
  // Per-connection room cap (joining a NEW room when already at the cap is refused).
  if (!conn.presenceRooms.has(room) && conn.presenceRooms.size >= limits.maxRoomsPerConnection) {
    sendError(conn, "limit", "too many rooms", { room });
    return;
  }
  let decision: AuthDecision = "deny";
  try {
    decision = await authorizeRoom(conn, room);
  } catch {
    decision = "deny";
  }
  if (decision !== "allow") {
    refuse(conn, decision, "room", { room });
    return;
  }
  if (!connections.has(conn)) return; // disconnected while authorizing
  // `state` is peer-supplied and only ever rebroadcast (never executed); the
  // authorization above is what gates who may publish into this room.
  conn.presenceRooms.set(room, msg.state);
  let members = rooms.get(room);
  if (!members) rooms.set(room, members = new Set());
  members.add(conn);
  broadcastRoom(room);
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
  if (sub.busy) {
    sub.dirty = true; // a recompute is in flight — collapse this into one follow-up
    return;
  }
  sub.busy = true;
  try {
    do {
      sub.dirty = false;
      // Re-authorize on every recompute. `canSubscribe` ran once at subscribe time;
      // a mid-session authorization change (role/tenant revoked) must stop further
      // pushes, or a long-lived socket keeps receiving updates after access is lost.
      const decision = await authorizeData(conn, sub);
      if (decision !== "allow") {
        send(conn, { type: "data", subId, value: undefined, error: "unauthorized" });
        conn.dataSubs.delete(subId); // drop it; the client may re-subscribe if re-granted
        break;
      }
      try {
        const value = await withRenderSlot(() =>
          withDeadline(renderDeadlineMs(), (s) => runFetcher(conn, sub.actionId, sub.args, s))
        );
        send(conn, { type: "data", subId, value });
      } catch {
        // A thrown deadline (or a real fetcher error) lands here; the slot was already
        // released by `withDeadline`, so the fleet keeps moving.
        send(conn, { type: "data", subId, value: undefined, error: "recompute failed" });
      }
      // Re-run only while still subscribed (unsubscribe deletes the sub mid-flight).
    } while (sub.dirty && conn.dataSubs.get(subId) === sub);
  } catch {
    // `recomputeData` runs fire-and-forget (`void recomputeData(...)`) and the prod
    // server installs no global unhandledrejection handler, so ANY throw escaping here
    // (most plausibly the app's `canSubscribe`/`authorizeData` hook dereferencing a
    // revoked session) would crash the whole process, dropping every connection — not
    // just this socket. Degrade like a denied recompute: notify + drop the sub.
    send(conn, { type: "data", subId, value: undefined, error: "recompute failed" });
    conn.dataSubs.delete(subId);
  } finally {
    sub.busy = false;
  }
}

/**
 * Invoke a registered server function by id **under the connection's own session**
 * (its replayed cookie), inside a fresh request context so the fn's `cookies()` /
 * `getSession` / cache reads run as the viewer. The socket was origin-gated at
 * handshake; the fn must still authorize its own access (same as any server action).
 */
function runFetcher(
  conn: Conn,
  actionId: string,
  args: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  const handler = getServerAction(actionId);
  if (!handler) return Promise.reject(new Error(`unknown live action: ${actionId}`));
  const request = new Request(conn.url || conn.origin, {
    headers: conn.cookie ? { cookie: conn.cookie } : {},
    ...(signal ? { signal } : {}),
  });
  // Thread the deadline signal onto the request context so `fetch`/cache reads inside
  // the fetcher observe it (cooperative abort), not just the outer race.
  return Promise.resolve(
    runWithContext(createRequestContext(request, signal), () => handler(...args)),
  );
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
    const flight = await withRenderSlot(() =>
      withDeadline(renderDeadlineMs(), (s) => rerender(conn, s))
    );
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
async function rerender(conn: Conn, signal?: AbortSignal): Promise<FlightNode | null> {
  if (!appHandler) return null;
  const req = new Request(conn.url, {
    method: "GET",
    headers: {
      "x-denext-nav": "1", // request the Flight soft-nav payload, not full HTML
      accept: "application/json",
      ...(conn.cookie ? { cookie: conn.cookie } : {}),
    },
    ...(signal ? { signal } : {}),
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
  if (s.bufferedAmount > MAX_BUFFERED) {
    // Shed rather than unbounded-buffer — but a shed *stateful* frame would leave the
    // client stale forever, so remember it and replay it once the socket drains.
    noteShed(conn, msg);
    return;
  }
  try {
    s.send(JSON.stringify(msg));
  } catch { /* closing between the check and the send */ }
}

/**
 * A frame was dropped because the socket was back-pressured. Record what to replay once
 * it drains. Only *stateful* frames need recovery: a `patch` leaves a `<Live>` boundary
 * stale (a single `refresh` catches every boundary up), and a `data` leaves a `useLive`
 * sub stale (re-running its fetcher pushes the latest value). `presence-state` is
 * self-superseding — the next broadcast carries the full room — and `refresh`/`error`/
 * `ping`/`pong` recover on their own, so those are left to drop.
 */
function noteShed(conn: Conn, msg: LiveServerMessage): void {
  if (msg.type === "patch") conn.recoverBoundaries = true;
  else if (msg.type === "data") (conn.recoverSubs ??= new Set()).add(msg.subId);
  else return;
  if (conn.recoverTimer == null) {
    conn.recoverTimer = setTimeout(() => drainRecover(conn), RECOVER_POLL_MS);
  }
}

/**
 * Replay shed stateful frames once the socket has drained. Polled, because Deno's
 * `WebSocket` has no drain event: while still back-pressured it reschedules; on a closed
 * socket it drops the intent (a reconnect refreshes anyway); once drained it sends one
 * `refresh` (if a boundary was shed) and re-runs the recompute for each shed data sub.
 */
function drainRecover(conn: Conn): void {
  conn.recoverTimer = null;
  const s = conn.socket;
  if (s.readyState !== WebSocket.OPEN) {
    conn.recoverBoundaries = false;
    conn.recoverSubs = undefined;
    return;
  }
  if (s.bufferedAmount > MAX_BUFFERED) {
    conn.recoverTimer = setTimeout(() => drainRecover(conn), RECOVER_POLL_MS);
    return;
  }
  if (conn.recoverBoundaries) {
    conn.recoverBoundaries = false;
    send(conn, { type: "refresh" }); // client re-renders → every boundary catches up
  }
  const subs = conn.recoverSubs;
  if (subs) {
    conn.recoverSubs = undefined;
    for (const subId of subs) {
      const sub = conn.dataSubs.get(subId);
      if (sub) void recomputeData(conn, subId, sub); // re-push the sub's latest value
    }
  }
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

/**
 * Test-only seam for the back-pressure recovery path. Real 1 MiB socket buffering can't
 * be forced deterministically over a loopback socket, so tests drive `send`/`noteShed`/
 * `drainRecover` against a fake socket whose `readyState`/`bufferedAmount` they control.
 * Not part of the public API — this module is internal (the public `<Live>` entrypoint is
 * `src/live.ts`) and re-exports nothing from here.
 */
export const __backpressureTestSeam = {
  /** Build a minimal {@link Conn} around a (fake) socket. */
  makeConn(socket: WebSocket): Conn {
    return {
      socket,
      peerId: "test",
      origin: "http://localhost",
      url: "http://localhost/",
      cookie: "",
      boundaries: [],
      dataSubs: new Map(),
      presenceRooms: new Map(),
      busy: false,
      dirty: null,
    };
  },
  send,
  noteShed,
  drainRecover,
  MAX_BUFFERED,
  RECOVER_POLL_MS,
};
