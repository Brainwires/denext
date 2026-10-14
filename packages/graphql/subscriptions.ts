/**
 * GraphQL subscriptions over denext channels. A `createChannel` is the app's push primitive
 * (validated at the publisher, authorized per subscriber, multi-instance through a
 * `ChannelTransport`); {@linkcode fromChannel} turns one key of it into the `AsyncIterable`
 * a GraphQL `subscribe` resolver returns, so a subscription rides the same events the Live
 * socket delivers — no second pub/sub bus (Yoga streams it as GraphQL over SSE, and the plugin
 * serves the `graphql-ws` protocol over WebSocket on the same path).
 *
 * ```ts
 * // Pothos
 * builder.subscriptionType({
 *   fields: (t) => ({
 *     orderStatus: t.field({
 *       type: OrderStatus,
 *       args: { id: t.arg.string({ required: true }) },
 *       subscribe: (_root, args, ctx) => fromChannel(orderEvents, `order:${args.id}`, { signal: ctx.signal }),
 *       resolve: (payload) => payload,
 *     }),
 *   }),
 * });
 * ```
 *
 * Authorization is the channel's: `fromChannel` runs its `authorize(ctx, key)` for the
 * subscribing request — the context and key the Live socket passes — and refuses the
 * subscription with a GraphQL error (`extensions.code: "FORBIDDEN"`) when it says no. An active
 * subscription is re-checked lazily (the channel's `authTtlSeconds`) and ends when that re-check
 * fails or the key is revoked, exactly as a `useChannel` subscriber does.
 *
 * @module
 */

import { type Channel, ChannelAccessError, tapChannelAuthorized } from "@denext/denext/plugin-kit";
import { createGraphQLError } from "graphql-yoga";
import { currentPeer } from "./peer.ts";

export type { Channel };

/** Options for {@linkcode fromChannel}. */
export interface FromChannelOptions {
  /** Ends the iterable when aborted (pass the request's signal). */
  signal?: AbortSignal;
  /**
   * How many undelivered payloads to hold while the consumer is slow (default 64). Past the
   * cap the OLDEST is dropped — a subscription is a live feed, not a log.
   */
  buffer?: number;
}

/**
 * The payloads published to one key of a channel, as an async iterable — once the channel's
 * `authorize` admits the subscribing request. Ends when the key is revoked (or revoked for this
 * connection's peer), when a lazy re-authorization says no, when `signal` aborts, or when the
 * consumer returns (a GraphQL client disconnect).
 *
 * Call it from a `subscribe` resolver (inside the request), and return the promise:
 * `subscribe: (_root, { room }, ctx) => fromChannel(messages, room, { signal: ctx.signal })`.
 *
 * @param channel The channel (or its id).
 * @param key The key to follow (validated against the channel's key shape).
 * @param options Abort signal and buffer cap.
 * @returns The subscription's payloads.
 * @throws A GraphQL error (`extensions.code: "FORBIDDEN"`) when the channel is unknown, the key
 *   malformed, or `authorize` refuses the request.
 */
export async function fromChannel<T>(
  channel: Channel<T> | string,
  key: string,
  options: FromChannelOptions = {},
): Promise<AsyncIterableIterator<T>> {
  const cap = Math.max(1, options.buffer ?? 64);
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let stop: (() => void) | null = null;

  const finish = () => {
    if (done) return;
    done = true;
    stop?.();
    options.signal?.removeEventListener("abort", finish);
    wake?.();
  };
  try {
    stop = await tapChannelAuthorized<T>(channel, key, {
      peerId: currentPeer(),
      onPayload: (payload) => {
        if (done) return;
        if (queue.length >= cap) queue.shift();
        queue.push(payload);
        wake?.();
      },
      // Access ended (revoke / failed re-check): nothing still queued is delivered.
      onEnd: () => {
        queue.length = 0;
        finish();
      },
    });
  } catch (err) {
    if (err instanceof ChannelAccessError) {
      throw createGraphQLError("Not authorized to subscribe to this channel", {
        extensions: { code: "FORBIDDEN" },
      });
    }
    throw err;
  }
  if (options.signal?.aborted) finish();
  else options.signal?.addEventListener("abort", finish, { once: true });

  const next = async (): Promise<IteratorResult<T>> => {
    while (queue.length === 0 && !done) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
    if (queue.length) return { value: queue.shift() as T, done: false };
    return { value: undefined as never, done: true };
  };
  const iterator: AsyncIterableIterator<T> = {
    next,
    return: () => {
      finish();
      return Promise.resolve({ value: undefined as never, done: true });
    },
    throw: (err) => {
      finish();
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}
