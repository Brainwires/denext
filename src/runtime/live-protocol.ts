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
  /** Arguments passed to the server function (wire-codec encoded when `enc` is set). */
  args: unknown[];
  /** Cache tags whose invalidation triggers a recompute + push. */
  tags: string[];
  /** `1` when `args` carries wire-codec tags (Date/Map/Set/BigInt/…) and must be decoded. */
  enc?: 1;
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
  /** The server function's return value (JSON; wire-codec encoded when `enc` is set), or `undefined` on error. */
  value: unknown;
  /** `1` when `value` carries wire-codec tags and must be decoded. */
  enc?: 1;
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
/**
 * Client → server: be told when any of `tags` is invalidated (`revalidateTag`). Backs
 * `useApi({ tags })`: the client REFETCHES over HTTP with its own cookies on an `invalidate`,
 * so data authorization stays with the route handler — the socket only carries tag names.
 */
export interface LiveTagsSubscribe {
  type: "tags-subscribe";
  /** Client-generated id correlating invalidations back to this watch. */
  subId: string;
  /** The cache tags to watch. */
  tags: string[];
}

/** Client → server: drop a {@link LiveTagsSubscribe}. */
export interface LiveTagsUnsubscribe {
  type: "tags-unsubscribe";
  /** The watch to drop. */
  subId: string;
}

/** Server → client: some of a watch's tags were invalidated. */
export interface LiveInvalidate {
  type: "invalidate";
  /** The watch this concerns. */
  subId: string;
  /** The watched tags that were invalidated. */
  tags: string[];
}

/** Client → server: receive a `createChannel` channel's pushes for `key`. */
export interface LiveChannelSubscribe {
  type: "channel-subscribe";
  /** Client-generated id correlating pushes back to this subscription. */
  subId: string;
  /** The channel's stable id. */
  channelId: string;
  /** The key within the channel. */
  key: string;
  /**
   * Replay the channel's log after this cursor (`"0"`: everything retained) before live pushes —
   * a channel with `history` only.
   */
  since?: string;
}

/** Client → server: drop a {@link LiveChannelSubscribe}. */
export interface LiveChannelUnsubscribe {
  type: "channel-unsubscribe";
  /** The subscription to drop. */
  subId: string;
}

/**
 * Server → client: a channel subscription is now registered (sent once, right after `authorize`
 * passes and the subscription is indexed). Channels have no initial value to imply registration the
 * way a data subscription's first `data` frame does, so this is the signal that a subsequent publish
 * will reach this subscriber — clients (and tests) can await it before relying on delivery.
 */
export interface LiveChannelReady {
  type: "channel-ready";
  /** The subscription that is now live. */
  subId: string;
}

/** Server → client: one published payload. */
export interface LiveChannel {
  type: "channel";
  /** The subscription this payload is for. */
  subId: string;
  /** The publishing instance's per-key sequence (orders frames from one instance only). */
  seq: number;
  /** The payload (wire-codec encoded when `enc` is set). */
  value: unknown;
  /** `1` when `value` carries codec tags. */
  enc?: 1;
  /** The payload's replay-log cursor (a channel with `history`); resume with `since`. */
  cursor?: string;
}

// ---- Live views (`defineLiveView`) -------------------------------------------

/**
 * Client → server: start (or resume) a server-held live view. `props` and `token` are what the
 * server rendered into the page: the props as JSON text, and the HMAC binding them to `view`.
 */
export interface LiveViewMount {
  type: "view-mount";
  /** Client-generated id for this view on this connection. */
  vid: string;
  /** The `defineLiveView` id. */
  view: string;
  /** The props, as the JSON text the server signed. */
  props: string;
  /** `1` when `props` carries wire-codec tags. */
  enc?: 1;
  /** The server's signature over `view` + `props`. */
  token: string;
  /** The instance id of a previous mount to resume (after a reconnect). */
  resume?: string;
}

/** Client → server: an event bound with `send(…)` fired. */
export interface LiveViewEvent {
  type: "view-event";
  /** The view. */
  vid: string;
  /** The render revision the handler came from. */
  rev: number;
  /** The handler's index in that render. */
  h: number;
  /** The event's payload (validated on the server). */
  payload?: unknown;
}

/** Client → server: stop a view. */
export interface LiveViewUnmount {
  type: "view-unmount";
  /** The view. */
  vid: string;
}

/** Client → server: a patch did not apply to what the client holds; send the whole tree. */
export interface LiveViewResync {
  type: "view-resync";
  /** The view. */
  vid: string;
}

/** Server → client: a view's whole rendered tree. */
export interface LiveViewRender {
  type: "view-render";
  /** The view. */
  vid: string;
  /** This render's revision (events name it). */
  rev: number;
  /** The view's children as Flight. */
  flight: FlightNode[];
  /** The instance id to resume with after a reconnect. */
  iid: string;
}

/** One change to a view's Flight tree (see `flight-patch.ts`). */
export type LiveViewOp =
  | ["r", number[], FlightNode]
  | ["p", number[], Record<string, unknown>, string[]]
  | ["s", number[], number, number, FlightNode[]]
  | ["m", number[], number[], FlightNode[]];

/** Server → client: the changes from revision `base` to `rev`. */
export interface LiveViewPatch {
  type: "view-patch";
  /** The view. */
  vid: string;
  /** The revision the ops apply to. */
  base: number;
  /** The revision they produce. */
  rev: number;
  /** The ops, applied in order. */
  ops: LiveViewOp[];
}

export type LiveClientMessage =
  | LiveViewMount
  | LiveViewEvent
  | LiveViewUnmount
  | LiveViewResync
  | LiveSubscribe
  | LivePong
  | LiveDataSubscribe
  | LiveDataUnsubscribe
  | LiveTagsSubscribe
  | LiveTagsUnsubscribe
  | LiveChannelSubscribe
  | LiveChannelUnsubscribe
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
  /**
   * Machine-readable cause: `denied` (a policy said no), `no-policy` (a gated hook
   * was used with NO `live` policy configured — a setup error, surfaced
   * loudly), `limit` (a cap/size was hit), `bad-message`, `invalid-input` (a
   * `defineSubscription` schema rejected the input — see `fieldErrors`), `failed` (a
   * resolver threw — redacted in production, `digest` correlates with the server log), `gone`
   * (a live view this server can't mount from what the client holds — the client re-renders the
   * route to get a fresh one).
   */
  code:
    | "denied"
    | "no-policy"
    | "limit"
    | "bad-message"
    | "invalid-input"
    | "failed"
    | "gone";
  /** A short, non-sensitive human explanation (dev-facing). */
  reason?: string;
  /** Per-field validation messages (`invalid-input`). */
  fieldErrors?: Record<string, string>;
  /** The redaction digest of a resolver failure (`failed`, production). */
  digest?: string;
  /** The data subscription (or live view) this error concerns, when applicable. */
  subId?: string;
  /** The presence room this error concerns, when applicable. */
  room?: string;
}

/** Any message the server may send. */
export type LiveServerMessage =
  | LiveViewRender
  | LiveViewPatch
  | LivePatch
  | LiveRefresh
  | LivePing
  | LiveData
  | LiveInvalidate
  | LiveChannelReady
  | LiveChannel
  | LivePresenceState
  | LiveError;
