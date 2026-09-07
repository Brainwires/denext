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
// post-await connected + cap re-check. No initial frame: a channel is stateless.

import { type ChannelEvent, getChannel } from "../runtime/channel.ts";
import type { LiveError, LiveServerMessage } from "../runtime/live-protocol.ts";

/** One connection's subscription to a (channel, key). */
export interface ChannelSub {
  /** The channel id. */
  channelId: string;
  /** The key. */
  key: string;
  /** Epoch ms after which the next frame triggers a re-authorization. */
  authExpires: number;
  /** A frame held back (back-pressure or pending re-auth); latest wins. */
  pending?: string;
  /** A re-authorization in flight. */
  reauth?: Promise<void>;
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

/** The hub's channel operations. */
export interface ChannelHub<C extends ChannelConn> {
  /** Handle a `channel-subscribe` frame. */
  subscribe(conn: C, msg: { subId?: unknown; channelId?: unknown; key?: unknown }): Promise<void>;
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
  const deindex = (conn: C, subId: string, sub: ChannelSub): void => {
    const set = index.get(sub.channelId)?.get(sub.key);
    if (!set) return;
    for (const entry of set) if (entry.conn === conn && entry.subId === subId) set.delete(entry);
    if (set.size === 0) index.get(sub.channelId)!.delete(sub.key);
  };
  const remove = (conn: C, subId: string): void => {
    const sub = conn.channelSubs.get(subId);
    if (!sub) return;
    conn.channelSubs.delete(subId);
    deindex(conn, subId, sub);
  };
  const atCap = (conn: C, subId: string): boolean =>
    !conn.channelSubs.has(subId) && conn.channelSubs.size >= deps.limits().maxChannelsPerConnection;

  /** Send one frame to one sub, honoring back-pressure (latest wins) and the auth TTL. */
  const sendTo = (
    conn: C,
    subId: string,
    sub: ChannelSub,
    text: string,
    msg: LiveServerMessage,
  ): void => {
    if (sub.authExpires <= Date.now()) {
      sub.pending = text;
      startReauth(conn, subId, sub);
      return;
    }
    if (deps.backPressured(conn)) {
      sub.pending = text;
      (conn.recoverChannels ??= new Set()).add(subId);
      deps.armRecover(conn);
      return;
    }
    deps.sendFrame(conn, text, msg);
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
        const text = sub.pending;
        sub.pending = undefined;
        if (text) sendTo(conn, subId, sub, text, { type: "channel", subId, seq: 0, value: null });
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
    if (!subs || subs.size === 0) return;
    // The frame is assembled by interpolation for speed; the transport is trusted by design,
    // but a malformed event (a non-numeric seq, a non-JSON payload) must not corrupt it.
    if (!Number.isFinite(ev.seq) || !isJsonText(ev.encoded)) return;
    const tail = `,"seq":${ev.seq},"value":${ev.encoded ?? "null"}${ev.enc ? ',"enc":1' : ""}}`;
    for (const { conn, subId } of [...subs]) {
      const sub = conn.channelSubs.get(subId);
      if (!sub) continue;
      const text = `{"type":"channel","subId":${JSON.stringify(subId)}${tail}`;
      sendTo(conn, subId, sub, text, { type: "channel", subId, seq: ev.seq, value: null });
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
      const { subId, channelId, key } = shape;
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
      remove(conn, subId); // a re-subscribe under the same id replaces the old one
      conn.channelSubs.set(subId, sub);
      indexFor(channelId, key).add({ conn, subId });
    },
    unsubscribe: remove,
    drop(conn) {
      for (const subId of [...conn.channelSubs.keys()]) remove(conn, subId);
    },
    dispose() {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      pendingEvents.clear();
      index.clear();
    },
    deliver(ev) {
      if (ev.kind === "revoke") return revokeAll(ev);
      pendingEvents.set(`${ev.channelId} ${ev.key}`, ev); // latest publish wins in the window
      if (flushTimer === null) flushTimer = setTimeout(flush, COALESCE_MS);
    },
    replayPending(conn) {
      const ids = conn.recoverChannels;
      if (!ids) return;
      conn.recoverChannels = undefined;
      for (const subId of ids) {
        const sub = conn.channelSubs.get(subId);
        const text = sub?.pending;
        if (!sub || !text) continue;
        sub.pending = undefined;
        sendTo(conn, subId, sub, text, { type: "channel", subId, seq: 0, value: null });
      }
    },
  };
}

/** The `channel-subscribe` frame's fields, bounded; `null` when malformed (silently dropped). */
function subscribeShape(
  msg: { subId?: unknown; channelId?: unknown; key?: unknown },
): { subId: string; channelId: string; key: string } | null {
  const { subId, channelId, key } = msg;
  if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) return null;
  if (typeof channelId !== "string" || channelId.length === 0 || channelId.length > 128) {
    return null;
  }
  if (typeof key !== "string" || key.length === 0 || key.length > 128) return null;
  return { subId, channelId, key };
}
