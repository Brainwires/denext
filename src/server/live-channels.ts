// The Live hub's channel half (`createChannel` → `useChannel`): subscriptions per connection,
// a global (channel, key) → subscribers index for O(subscribers) fan-out, lazy TTL
// re-authorization, revocation, publisher-burst coalescing, and latest-wins back-pressure.
//
// Built as a factory over the hub's own primitives (`createChannelHub(deps)`) so this module
// never imports `live.ts` — the hub owns the socket, the limits, and the policy plumbing; this
// module owns channel state. Every check on `channel-subscribe`, in order: frame shape; the
// per-connection channel cap; a registered channel (an unknown id is `denied`, never a
// distinguishable "unknown" — no enumeration oracle); the channel's key shape; `authorize` in
// the subscriber's session (`no-policy` when the channel has none; a throw is a deny); a
// post-await connected + cap re-check. No initial frame: a channel is stateless — unless it keeps
// a replay log (`history`) and the subscriber passes `since`: then, once `authorize` allowed it
// and the subscription is live, the log's entries for ITS key after that cursor are sent first
// (re-authorizing if the TTL lapsed), every frame carries its cursor, a frame at or before the
// subscriber's last cursor is skipped (replay and live never double up), a burst is fanned out
// whole, and a back-pressured subscriber resumes from the log once its socket drains.

import { liveDevtoolsEnabled, recordChannelPush } from "./live-devtools.ts";
import {
  type ChannelEvent,
  channelEventDiscarded,
  type ChannelIdleReason,
  channelInstanceId,
  channelLog,
  channelLogShared,
  getChannel,
  ORDERED_HOLD_LIMIT,
} from "../runtime/channel.ts";
import { type ChannelLogEntry, compareCursors, isCursor } from "../runtime/channel-log.ts";
import { inRootContext } from "./root-context.ts";
import type { LiveError, LiveServerMessage } from "../runtime/live-protocol.ts";

/** One connection's subscription to a (channel, key). */
export interface ChannelSub {
  /** The channel id. */
  channelId: string;
  /** The key. */
  key: string;
  /** Epoch ms after which the next frame triggers a re-authorization. */
  authExpires: number;
  /** An unlogged frame held back (back-pressure or pending re-auth); latest wins. */
  pending?: string;
  /** An `ordered` channel's held frames, oldest first (bounded; see `ORDERED_HOLD_LIMIT`). */
  held?: string[];
  /**
   * A logged frame was held back: once it can go, the log is replayed after this cursor (every
   * held publish, not just the latest).
   */
  resumeFrom?: string;
  /** Replay steps in flight for this sub: a logged live frame meanwhile is left to them. */
  replaying?: number;
  /** Bumped when a logged live frame was left to an in-flight replay (it reads again). */
  missed?: number;
  /** A re-authorization in flight. */
  reauth?: Promise<void>;
  /** This subscription's entry in the fan-out index (so removal is a Set delete, not a scan). */
  entry?: { conn: unknown; subId: string };
  /** The last replay-log cursor sent (a channel with `history`). */
  cursor?: string;
}

/** The hub connection surface this module needs. */
export interface ChannelConn {
  /** The socket (for readiness / back-pressure). */
  socket: WebSocket;
  /** This connection's channel subscriptions. */
  channelSubs: Map<string, ChannelSub>;
  /** Sub ids whose last frame was shed and must be replayed once the socket drains. */
  recoverChannels?: Set<string>;
  /** The peer id (for a per-peer revoke). */
  peerId: string;
}

/** What the hub lends this module. */
export interface ChannelHubDeps<C extends ChannelConn> {
  /** Current limits. */
  limits(): { maxChannelsPerConnection: number; channelAuthTtlSeconds: number };
  /** Send a pre-encoded frame (the hub's back-pressure-aware send). */
  sendFrame(conn: C, text: string, msg: LiveServerMessage): void;
  /** Send an error frame. */
  sendError(conn: C, code: LiveError["code"], reason: string, extra?: Partial<LiveError>): void;
  /** Refuse by decision (`deny` / `no-policy`) with the hub's standard framing + logging. */
  refuse(conn: C, decision: "deny" | "no-policy", what: string, extra?: Partial<LiveError>): void;
  /** Run `fn` inside the connection's own request context (its replayed cookie). */
  withConnContext<T>(conn: C, fn: () => T | Promise<T>): Promise<T>;
  /** The identity handed to policy hooks. */
  connContext(conn: C): { origin: string; url: string; cookie: string; peerId: string };
  /** Is the connection still registered? */
  isConnected(conn: C): boolean;
  /** Bound concurrent work by the render-slot gate. */
  withRenderSlot<T>(fn: () => Promise<T>): Promise<T>;
  /** Is the socket back-pressured right now? */
  backPressured(conn: C): boolean;
  /** Arm the hub's drain-recovery timer for `conn`. */
  armRecover(conn: C): void;
}

/** Publisher bursts within this window collapse into one fan-out per (channel, key). */
const COALESCE_MS = 16;

/** Log reads one replay makes at most while live publishes keep arriving during them. */
const MAX_REPLAY_ROUNDS = 8;

/** The hub's channel operations. */
export interface ChannelHub<C extends ChannelConn> {
  /** Handle a `channel-subscribe` frame. */
  subscribe(
    conn: C,
    msg: { subId?: unknown; channelId?: unknown; key?: unknown; since?: unknown },
  ): Promise<void>;
  /** Handle a `channel-unsubscribe` frame. */
  unsubscribe(conn: C, subId: string): void;
  /** Drop every subscription of a closing connection. */
  drop(conn: C): void;
  /** Deliver a transport event (publish / revoke) to this instance's subscribers. */
  deliver(ev: ChannelEvent): void;
  /** Replay held-back frames once the socket drained (called by the hub's drain recovery). */
  replayPending(conn: C): void;
  /** Clear every subscription index and pending flush (teardown). */
  dispose(): void;
}

/**
 * Build the channel half of a hub.
 *
 * @param deps The hub primitives.
 * @returns The channel operations.
 */
/** Is `text` (when present) one complete JSON value? */
function isJsonText(text: string | undefined): boolean {
  if (text === undefined) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function createChannelHub<C extends ChannelConn>(deps: ChannelHubDeps<C>): ChannelHub<C> {
  /** (channelId → key → subscribers). */
  const index = new Map<string, Map<string, Set<{ conn: C; subId: string }>>>();
  const pendingEvents = new Map<string, ChannelEvent>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const indexFor = (channelId: string, key: string): Set<{ conn: C; subId: string }> => {
    let byKey = index.get(channelId);
    if (!byKey) index.set(channelId, byKey = new Map());
    let set = byKey.get(key);
    if (!set) byKey.set(key, set = new Set());
    return set;
  };
  const deindex = (sub: ChannelSub, reason: ChannelIdleReason): void => {
    const set = index.get(sub.channelId)?.get(sub.key);
    if (!set) return;
    if (sub.entry) set.delete(sub.entry as { conn: C; subId: string }); // O(1), no scan
    if (set.size === 0) {
      index.get(sub.channelId)!.delete(sub.key);
      keyLifecycle(sub.channelId, sub.key, "onIdle", reason);
    }
  };
  const remove = (conn: C, subId: string, reason: ChannelIdleReason = "unsubscribe"): void => {
    const sub = conn.channelSubs.get(subId);
    if (!sub) return;
    conn.channelSubs.delete(subId);
    deindex(sub, reason);
  };
  const atCap = (conn: C, subId: string): boolean =>
    !conn.channelSubs.has(subId) && conn.channelSubs.size >= deps.limits().maxChannelsPerConnection;

  /**
   * Send one frame to one sub, honoring back-pressure (latest wins) and the auth TTL. A frame
   * with a replay cursor at or before the sub's last one is skipped (a replay and a live push of
   * one publish); one that goes out advances the sub's cursor.
   */
  const sendTo = (
    conn: C,
    subId: string,
    sub: ChannelSub,
    text: string,
    msg: LiveServerMessage,
    cursor?: string,
  ): void => {
    if (cursor && sub.cursor && compareCursors(cursor, sub.cursor) <= 0) return;
    if (deferred(conn, subId, sub, text, cursor)) return;
    // No await between this check and `sendFrame`'s own `bufferedAmount` check, so the two
    // reads see the same buffer — a frame that clears this branch is never shed by `sendFrame`
    // (which drops `channel` frames). `fanOut` re-enters `sendTo` per subscriber, so a send that
    // pushes the buffer over the limit back-pressures the NEXT sub here, not silently downstream.
    deps.sendFrame(conn, text, msg);
    if (cursor) sub.cursor = cursor;
  };

  /**
   * Keep a frame from going out now: left to an in-flight replay, held for a re-authorization,
   * or held for a back-pressured socket. `false` when it may go.
   */
  const deferred = (
    conn: C,
    subId: string,
    sub: ChannelSub,
    text: string,
    cursor?: string,
  ): boolean => {
    if (cursor && sub.replaying) {
      // A replay is reading the log: this publish is in it (logged before it was sent), so the
      // replay sends it in order — sent now, it would advance the cursor past entries the read
      // has yet to return, and those would be skipped.
      sub.missed = (sub.missed ?? 0) + 1;
      return true;
    }
    if (sub.authExpires <= Date.now()) {
      hold(sub, text, cursor);
      startReauth(conn, subId, sub);
      return true;
    }
    if (!deps.backPressured(conn)) return false;
    hold(sub, text, cursor);
    (conn.recoverChannels ??= new Set()).add(subId);
    deps.armRecover(conn);
    return true;
  };

  /**
   * Hold a frame back: an unlogged one as the sub's `pending` (latest wins); a logged one as the
   * cursor to replay the log from (the first held one's predecessor), so none is lost.
   */
  const hold = (sub: ChannelSub, text: string, cursor?: string): void => {
    if (!cursor && getChannel(sub.channelId)?.ordered) {
      // Every frame, in order: dropping one would lose the changes it carried.
      const held = sub.held ??= [];
      held.push(text);
      if (held.length > ORDERED_HOLD_LIMIT) held.splice(0, held.length - ORDERED_HOLD_LIMIT);
      return;
    }
    if (!cursor) {
      sub.pending = text;
      return;
    }
    sub.resumeFrom ??= sub.cursor ?? (BigInt(cursor) - 1n).toString();
  };

  /** Send what a sub held back: its unlogged frame, then the log after its resume cursor. */
  const flushHeld = (conn: C, subId: string, sub: ChannelSub): void => {
    const text = sub.pending;
    const held = sub.held ?? [];
    const from = sub.resumeFrom;
    sub.pending = sub.resumeFrom = sub.held = undefined;
    if (text) sendTo(conn, subId, sub, text, { type: "channel", subId, seq: 0, value: null });
    // In order; one deferred again is held again, after any held before it.
    for (const frame of held) {
      sendTo(conn, subId, sub, frame, { type: "channel", subId, seq: 0, value: null });
    }
    if (from !== undefined && conn.channelSubs.get(subId) === sub) {
      void replay(conn, subId, sub, from);
    }
  };

  /** A `channel` frame's text (assembled by interpolation; the cursor is digits only). */
  const frameText = (subId: string, seq: number, encoded: string, enc?: 1, cursor?: string) =>
    `{"type":"channel","subId":${JSON.stringify(subId)},"seq":${seq},"value":${encoded}${
      enc ? ',"enc":1' : ""
    }${cursor ? `,"cursor":"${cursor}"` : ""}}`;

  /**
   * Send `sub` its key's logged publishes after `since` — only while it is still this
   * connection's live subscription and still authorized (re-checked when the TTL lapsed).
   */
  const replay = async (conn: C, subId: string, sub: ChannelSub, since: string): Promise<void> => {
    const history = getChannel(sub.channelId)?.history;
    if (!history) return;
    if (!(await whileReplaying(sub, () => replayAllowed(conn, subId, sub)))) return;
    let from: string | null = since;
    for (let round = 0; from !== null && round < MAX_REPLAY_ROUNDS; round++) {
      from = await replayRound(conn, subId, sub, from, history.size);
    }
  };

  /**
   * One log read of a replay, sent. Returns the cursor to read again from when a live frame was
   * left to this read, else `null` (done, the sub is gone, or held back: the drain resumes it).
   */
  const replayRound = async (
    conn: C,
    subId: string,
    sub: ChannelSub,
    from: string,
    size: number,
  ): Promise<string | null> => {
    const missed = sub.missed ?? 0;
    const entries = await whileReplaying(
      sub,
      () => channelLog().since(sub.channelId, sub.key, from, size).catch(() => []),
    );
    if (!sendEntries(conn, subId, sub, entries)) return null;
    if ((sub.missed ?? 0) === missed || sub.resumeFrom !== undefined) return null;
    return sub.cursor ?? from;
  };

  /**
   * Run `fn` (a replay's `authorize` or log read) with the sub's logged live frames left to the
   * replay: one arriving meanwhile is counted in `missed`, and the replay reads again.
   */
  const whileReplaying = async <T>(sub: ChannelSub, fn: () => Promise<T>): Promise<T> => {
    sub.replaying = (sub.replaying ?? 0) + 1;
    try {
      return await fn();
    } finally {
      sub.replaying -= 1;
    }
  };

  /** May the replay go on? Still this connection's sub, and allowed (re-checked past the TTL). */
  const replayAllowed = async (conn: C, subId: string, sub: ChannelSub): Promise<boolean> => {
    if (sub.authExpires > Date.now()) return true;
    const decision = await deps.withRenderSlot(() => authorizeSub(conn, sub));
    if (conn.channelSubs.get(subId) !== sub) return false;
    if (decision !== "allow") {
      deps.sendError(conn, "denied", "channel access revoked", { subId });
      remove(conn, subId);
      return false;
    }
    sub.authExpires = Date.now() + ttlMs(sub.channelId);
    return true;
  };

  /** Send logged entries in order; `false` once the sub is gone (or an entry is malformed). */
  const sendEntries = (
    conn: C,
    subId: string,
    sub: ChannelSub,
    entries: ChannelLogEntry[],
  ): boolean => {
    for (const e of entries) {
      if (conn.channelSubs.get(subId) !== sub || !isJsonText(e.encoded)) return false;
      const text = frameText(subId, 0, e.encoded, e.enc, e.cursor);
      sendTo(conn, subId, sub, text, { type: "channel", subId, seq: 0, value: null }, e.cursor);
    }
    return true;
  };

  /** Lazy re-authorization on traffic: allow → refresh the TTL and flush; deny → drop. */
  const startReauth = (conn: C, subId: string, sub: ChannelSub): void => {
    if (sub.reauth) return;
    sub.reauth = deps.withRenderSlot(() => authorizeSub(conn, sub))
      .then((decision) => {
        sub.reauth = undefined;
        if (!conn.channelSubs.has(subId)) return;
        if (decision !== "allow") {
          deps.sendError(conn, "denied", "channel access revoked", { subId });
          remove(conn, subId);
          return;
        }
        sub.authExpires = Date.now() + ttlMs(sub.channelId);
        flushHeld(conn, subId, sub);
      })
      .catch(() => {
        sub.reauth = undefined;
        deps.sendError(conn, "denied", "channel access revoked", { subId });
        remove(conn, subId);
      });
  };

  const ttlMs = (channelId: string): number =>
    (getChannel(channelId)?.authTtlSeconds ?? deps.limits().channelAuthTtlSeconds) * 1000;

  const authorizeSub = async (
    conn: C,
    sub: ChannelSub,
  ): Promise<"allow" | "deny" | "no-policy"> => {
    const ch = getChannel(sub.channelId);
    if (!ch || typeof ch.authorize !== "function") return ch ? "no-policy" : "deny";
    try {
      const ok = await deps.withConnContext(
        conn,
        () => ch.authorize!(deps.connContext(conn), sub.key),
      );
      return ok ? "allow" : "deny";
    } catch {
      return "deny";
    }
  };

  const flush = (): void => {
    flushTimer = null;
    const events = [...pendingEvents.values()];
    pendingEvents.clear();
    for (const ev of events) fanOut(ev);
  };

  const fanOut = (ev: ChannelEvent): void => {
    const subs = index.get(ev.channelId)?.get(ev.key);
    if (!subs || subs.size === 0 || channelEventDiscarded(ev)) return;
    // The frame is assembled by interpolation for speed; the transport is trusted by design,
    // but a malformed event (a non-numeric seq, a non-JSON payload) must not corrupt it.
    if (!Number.isFinite(ev.seq) || !isJsonText(ev.encoded)) return;
    const cursor = resumableCursor(ev);
    for (const { conn, subId } of [...subs]) {
      const sub = conn.channelSubs.get(subId);
      if (!sub) continue;
      const text = frameText(subId, ev.seq, ev.encoded ?? "null", ev.enc, cursor);
      sendTo(conn, subId, sub, text, { type: "channel", subId, seq: ev.seq, value: null }, cursor);
    }
  };

  const revokeAll = (ev: ChannelEvent): void => {
    const subs = index.get(ev.channelId)?.get(ev.key);
    if (!subs) return;
    for (const { conn, subId } of [...subs]) {
      if (ev.peerId && conn.peerId !== ev.peerId) continue;
      deps.sendError(conn, "denied", "channel access revoked", { subId });
      remove(conn, subId);
    }
  };

  return {
    async subscribe(conn, msg) {
      const shape = subscribeShape(msg);
      if (!shape) return;
      const { subId, channelId, key, since } = shape;
      if (atCap(conn, subId)) {
        return deps.sendError(conn, "limit", "too many subscriptions", { subId });
      }
      // An unknown channel and a key the channel rejects get the SAME refusal: a distinct
      // "malformed key" frame would tell an unauthenticated peer which ids exist.
      const ch = getChannel(channelId);
      if (!ch || !ch.keyOk(key)) return deps.refuse(conn, "deny", "channel", { subId });
      const sub: ChannelSub = { channelId, key, authExpires: 0 };
      const decision = await authorizeSub(conn, sub);
      if (decision !== "allow") return deps.refuse(conn, decision, "channel", { subId });
      if (!deps.isConnected(conn)) return;
      if (atCap(conn, subId)) {
        return deps.sendError(conn, "limit", "too many subscriptions", { subId });
      }
      sub.authExpires = Date.now() + ttlMs(channelId);
      // A re-subscribe under the same id replaces the old one — indexed first, so re-subscribing
      // to the same key never takes it through idle (and the channel's per-key state with it).
      const replaced = conn.channelSubs.get(subId);
      conn.channelSubs.set(subId, sub);
      const entry = { conn, subId };
      sub.entry = entry;
      const subscribers = indexFor(channelId, key);
      subscribers.add(entry);
      if (subscribers.size === 1) keyLifecycle(channelId, key, "onActive");
      if (replaced) deindex(replaced, "unsubscribe");
      // Acknowledge the now-live subscription. Unlike a data subscription (whose first `data`
      // frame implies registration), a channel has no initial value, so this is the client's only
      // signal that a subsequent publish will reach it — sent as a control frame, not a per-sub
      // stateful one (no back-pressure queuing or auth-TTL replay).
      const ready: LiveServerMessage = { type: "channel-ready", subId };
      deps.sendFrame(conn, JSON.stringify(ready), ready);
      if (since !== undefined && ch.history) await replay(conn, subId, sub, since);
    },
    unsubscribe: remove,
    drop(conn) {
      for (const subId of [...conn.channelSubs.keys()]) remove(conn, subId, "disconnect");
    },
    dispose() {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      pendingEvents.clear();
      for (const [channelId, byKey] of index) {
        for (const key of byKey.keys()) keyLifecycle(channelId, key, "onIdle", "disconnect");
      }
      index.clear();
    },
    deliver(ev) {
      if (liveDevtoolsEnabled()) {
        recordChannelPush(ev, index.get(ev.channelId)?.get(ev.key)?.size ?? 0);
      }
      if (ev.kind === "revoke") return revokeAll(ev);
      // Latest publish wins in the window — except a logged one, and every publish of an
      // `ordered` channel, which are delivered whole, in order.
      const whole = isCursor(ev.cursor)
        ? `\0${ev.cursor}`
        : ev.kind === "publish" && getChannel(ev.channelId)?.ordered
        ? `\0${ev.instance}\0${ev.seq}`
        : "";
      pendingEvents.set(`${ev.channelId}\0${ev.key}${whole}`, ev);
      // The flush serves every subscriber, not the publisher: start its timer outside the
      // publishing request's context.
      if (flushTimer === null) flushTimer = inRootContext(() => setTimeout(flush, COALESCE_MS));
    },
    replayPending(conn) {
      const ids = conn.recoverChannels;
      if (!ids) return;
      conn.recoverChannels = undefined;
      for (const subId of ids) {
        const sub = conn.channelSubs.get(subId);
        // A logged channel resumes from its log: every publish it shed, not just the latest.
        if (sub) flushHeld(conn, subId, sub);
      }
    },
  };
}

/**
 * Tell a channel that a key gained its first (`onActive`) or lost its last (`onIdle`) local
 * subscriber. The hook serves the channel, not whichever connection's frame triggered it, so it
 * runs in the root context; a throw is logged, never propagated into the hub.
 */
function keyLifecycle(
  channelId: string,
  key: string,
  hook: "onActive" | "onIdle",
  reason: ChannelIdleReason = "unsubscribe",
): void {
  const fn = getChannel(channelId)?.[hook];
  if (typeof fn !== "function") return;
  try {
    inRootContext(() => fn(key, reason));
  } catch (err) {
    console.error(`denext channels: ${hook} on ${channelId} threw`, err);
  }
}

/**
 * An event's replay cursor, when a subscriber can resume from it: one issued by this instance's
 * log, or by a log every instance shares. Another instance's, under a log that is not shared,
 * would make this instance's own (lower) cursors look already seen.
 */
function resumableCursor(ev: ChannelEvent): string | undefined {
  if (!isCursor(ev.cursor)) return undefined;
  return ev.instance === channelInstanceId() || channelLogShared() ? ev.cursor : undefined;
}

/**
 * The `channel-subscribe` frame's fields, bounded; `null` when malformed (silently dropped). A
 * `since` that is not a cursor is ignored (no replay).
 */
function subscribeShape(
  msg: { subId?: unknown; channelId?: unknown; key?: unknown; since?: unknown },
): { subId: string; channelId: string; key: string; since?: string } | null {
  const { subId, channelId, key } = msg;
  if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) return null;
  if (typeof channelId !== "string" || channelId.length === 0 || channelId.length > 128) {
    return null;
  }
  if (typeof key !== "string" || key.length === 0 || key.length > 128) return null;
  return isCursor(msg.since)
    ? { subId, channelId, key, since: msg.since }
    : { subId, channelId, key };
}
