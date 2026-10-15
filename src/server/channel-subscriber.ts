// An AUTHORIZED server-side channel subscriber: `tapChannel` behind the channel's own
// `authorize`, for a plugin that hands a channel's pushes to a viewer over another protocol (a
// GraphQL subscription in `@denext/graphql`). The checks are the Live socket's, in its order:
// a registered channel and an acceptable key (both refusals look the same), `authorize(ctx, key)`
// in the viewer's request context (a throw is a deny), then lazily again on traffic once the
// channel's `authTtlSeconds` (default `live.limits.channelAuthTtlSeconds`) has passed — the
// payload that found it stale is held (latest wins) until the re-check allows it — and
// `channel.revoke(key)` (or one naming this subscriber's peer) ends it immediately.

import {
  type Channel,
  channelAuthTtlMs,
  type ChannelContext,
  getChannel,
  tapChannel,
} from "../runtime/channel.ts";
import { captureRequestContext, currentContext } from "./request-context.ts";

/** Why {@linkcode tapChannelAuthorized} refused a subscriber. */
export class ChannelAccessError extends Error {
  /** `deny`: the channel is unknown, the key malformed, or `authorize` said no (or threw). */
  readonly decision: "deny";
  /**
   * Create the refusal.
   *
   * @param message What was refused.
   */
  constructor(message = "channel access denied") {
    super(message);
    this.name = "ChannelAccessError";
    this.decision = "deny";
  }
}

/** Options for {@linkcode tapChannelAuthorized}. */
export interface AuthorizedTapOptions<T> {
  /** A payload the subscriber may receive (decoded; `seq` orders publishes from one instance). */
  onPayload: (payload: T, seq: number) => void;
  /**
   * The subscription ended because access ended: a cluster-wide `revoke(key)`, a revoke naming
   * this subscriber's peer, or a lazy re-authorization that said no. Not called by the disposer.
   */
  onEnd?: () => void;
  /**
   * The subscriber's peer id (handed to `authorize` as `ctx.peerId`; a `revoke(key, { peerId })`
   * naming it ends this subscription). Default: a fresh id per call.
   */
  peerId?: string;
}

/**
 * Subscribe a viewer to one key of a channel on the server, behind the channel's `authorize` —
 * the same gate, context and key the Live socket applies to a `useChannel` subscriber. Call it
 * inside the viewer's request (a resolver, a route handler): `authorize(ctx, key)` runs there
 * with `ctx` = `{ origin, url, cookie, peerId }` from that request, and again, lazily, on the
 * first payload after the channel's re-authorization TTL, in a copy of that request's context.
 *
 * @param channel The channel (or its id).
 * @param key The key to follow.
 * @param options Payload / end callbacks and the peer id.
 * @returns A disposer that stops the subscription.
 * @throws ChannelAccessError when the channel is unknown, the key malformed, or `authorize`
 *   refused (or threw).
 */
export async function tapChannelAuthorized<T>(
  channel: Channel<T> | string,
  key: string,
  options: AuthorizedTapOptions<T>,
): Promise<() => void> {
  const id = typeof channel === "string" ? channel : channel.denextChannelId;
  const ch = id ? getChannel(id) : undefined;
  // An unknown channel and a key it rejects get the same refusal (no enumeration oracle).
  if (!ch || !ch.keyOk(key)) throw new ChannelAccessError();
  const ctx = subscriberContext(options.peerId ?? crypto.randomUUID());
  const runAs = captureRequestContext();
  const allowed = async (): Promise<boolean> => {
    if (typeof ch.authorize !== "function") return false;
    try {
      return (await runAs(() => ch.authorize!(ctx, key))) === true;
    } catch {
      return false;
    }
  };
  if (!(await allowed())) throw new ChannelAccessError();

  let expires = Date.now() + channelAuthTtlMs(id);
  let ended = false;
  let pending: { payload: T; seq: number } | null = null;
  let reauth: Promise<void> | null = null;
  const end = () => {
    if (ended) return;
    ended = true;
    pending = null;
    stop();
    options.onEnd?.();
  };
  const recheck = () => {
    reauth ??= allowed().then((ok) => {
      reauth = null;
      if (ended) return;
      if (!ok) return end();
      expires = Date.now() + channelAuthTtlMs(id);
      const held = pending;
      pending = null;
      if (held) options.onPayload(held.payload, held.seq);
    });
  };
  const stop = tapChannel<T>(id, key, {
    peerId: ctx.peerId,
    onPayload: (payload, seq) => {
      if (ended) return;
      if (Date.now() >= expires) {
        pending = { payload, seq }; // latest wins while the re-check runs
        return recheck();
      }
      options.onPayload(payload, seq);
    },
    onRevoke: end,
  });
  return () => {
    if (ended) return;
    ended = true;
    pending = null;
    stop();
  };
}

/** The `authorize` context for the current request — what Live builds from its upgrade request. */
function subscriberContext(peerId: string): ChannelContext {
  const request = currentContext()?.request;
  if (!request) return { origin: "", url: "", cookie: "", peerId };
  const url = new URL(request.url);
  return {
    origin: url.origin,
    url: url.href,
    cookie: request.headers.get("cookie") ?? "",
    peerId,
  };
}
