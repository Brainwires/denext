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

/** Any message the client may send. */
export type LiveClientMessage = LiveSubscribe | LivePong;

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

/** Any message the server may send. */
export type LiveServerMessage = LivePatch | LiveRefresh | LivePing;
