/**
 * Wire protocol shared by the Live Server Components hub (server) and client.
 *
 * A `<Live tags={[...]}>` boundary opens a WebSocket to {@link LIVE_ENDPOINT} and
 * subscribes with its route URL and the boundaries on the page. When the server
 * invalidates one of a boundary's tags (`revalidateTag`/`updateTag`), the hub
 * re-renders that route under the connection's own cookies, slices out the
 * boundary's new subtree, and pushes a {@link LivePatch} — or a {@link LiveRefresh}
 * fallback. This module is a dependency-free leaf so both sides can import it.
 *
 * @module
 */

import type { FlightNode } from "../jsx/render-to-flight.ts";

/** The reserved URL the Live WebSocket upgrades on. */
export const LIVE_ENDPOINT = "/_denext/live";

/**
 * The client-reference id under which the framework's `<Live>` island is emitted
 * in the Flight tree. The hub recognises boundaries by this id when slicing.
 */
export const LIVE_REF_ID = "denext#Live";

/** One boundary a connection is watching: its tree-path id and declared tags. */
export interface LiveBoundarySub {
  /** The boundary's stable tree-path id (its `<Live>` island scope prefix). */
  id: string;
  /** Cache tags that should push an update to this boundary when invalidated. */
  tags: string[];
}

/** Client → server: (re)declare the route and boundaries this connection watches. */
export interface LiveSubscribe {
  type: "subscribe";
  /** The current route URL (used to re-render under the connection's cookies). */
  url: string;
  /** The `<Live>` boundaries currently mounted on the page. */
  boundaries: LiveBoundarySub[];
}

/** Client → server: liveness keep-alive reply. */
export interface LivePong {
  type: "pong";
}

// ---- Live data ({@link useLive}) --------------------------------------------

/**
 * Client → server: subscribe to a server function's result, recomputed and pushed
 * whenever one of `tags` is invalidated. `actionId` is a registered server-function
 * id (a `serverAction`), re-invoked under the connection's own session.
 */
export interface LiveDataSubscribe {
  type: "data-subscribe";
  /** Client-generated id correlating pushes back to this subscription. */
  subId: string;
  /** The registered server-function id to run (a `serverAction`'s `denextActionId`). */
  actionId: string;
  /** Arguments passed to the server function. */
  args: unknown[];
  /** Cache tags whose invalidation triggers a recompute + push. */
  tags: string[];
}

/** Client → server: drop a {@link LiveDataSubscribe}. */
export interface LiveDataUnsubscribe {
  type: "data-unsubscribe";
  /** The subscription to drop. */
  subId: string;
}

/** Server → client: a fresh value for a {@link LiveDataSubscribe}. */
export interface LiveData {
  type: "data";
  /** The subscription this value is for. */
  subId: string;
  /** The server function's return value (JSON), or `undefined` on error. */
  value: unknown;
  /** Present when the recompute failed. */
  error?: string;
}

// ---- Presence ({@link usePresence}) -----------------------------------------

/** Client → server: join a presence room and publish this peer's initial state. */
export interface LivePresenceJoin {
  type: "presence-join";
  /** The room to join. */
  room: string;
  /** This peer's initial presence state. */
  state: unknown;
}

/** Client → server: update this peer's presence state in a room. */
export interface LivePresenceUpdate {
  type: "presence-update";
  /** The room. */
  room: string;
  /** This peer's new presence state. */
  state: unknown;
}

/** Client → server: leave a presence room. */
export interface LivePresenceLeave {
  type: "presence-leave";
  /** The room to leave. */
  room: string;
}

/** One peer in a presence room. */
export interface LivePeer {
  /** The peer's stable per-connection id. */
  id: string;
  /** The peer's published presence state. */
  state: unknown;
}

/** Server → client: the current membership of a presence room. */
export interface LivePresenceState {
  type: "presence-state";
  /** The room. */
  room: string;
  /** Every peer currently in the room (including this connection). */
  peers: LivePeer[];
  /** This recipient's own peer id, so the client can split self vs. others. */
  selfId: string;
}

/** Any message the client may send. */
export type LiveClientMessage =
  | LiveSubscribe
  | LivePong
  | LiveDataSubscribe
  | LiveDataUnsubscribe
  | LivePresenceJoin
  | LivePresenceUpdate
  | LivePresenceLeave;

/** Server → client: replace one boundary's subtree with a freshly-rendered one. */
export interface LivePatch {
  type: "patch";
  /** The boundary to patch (matches a subscribed {@link LiveBoundarySub.id}). */
  boundaryId: string;
  /** The boundary's new children as a Flight payload (parsed via the registry). */
  flight: FlightNode[];
}

/** Server → client: re-fetch and re-render the whole current route (coarse fallback). */
export interface LiveRefresh {
  type: "refresh";
}

/** Server → client: liveness keep-alive. */
export interface LivePing {
  type: "ping";
}

/**
 * Server → client: a subscription/join was refused or a limit was hit. Advisory —
 * the client may surface it in dev; it never carries sensitive detail.
 */
export interface LiveError {
  type: "error";
  /** Machine-readable cause: `denied` (policy), `limit` (cap/size), `bad-message`. */
  code: "denied" | "limit" | "bad-message";
  /** A short, non-sensitive human explanation (dev-facing). */
  reason?: string;
  /** The data subscription this error concerns, when applicable. */
  subId?: string;
  /** The presence room this error concerns, when applicable. */
  room?: string;
}

/** Any message the server may send. */
export type LiveServerMessage =
  | LivePatch
  | LiveRefresh
  | LivePing
  | LiveData
  | LivePresenceState
  | LiveError;
