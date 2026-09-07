/**
 * GraphQL subscriptions over denext channels. A `createChannel` is the app's push primitive
 * (validated at the publisher, authorized per socket subscriber, multi-instance through a
 * `ChannelTransport`); {@linkcode fromChannel} turns one key of it into the `AsyncIterable`
 * a GraphQL `subscribe` resolver returns, so a subscription rides the same events the Live
 * socket delivers — no second pub/sub bus, no separate WebSocket server (Yoga streams it as
 * GraphQL over SSE).
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
 * Authorization is yours: a channel's `authorize` gates SOCKET subscribers; a server-side
 * tap sees every publish, so check the viewer in the resolver before returning the iterable.
 *
 * @module
 */

import { type Channel, tapChannel } from "@denext/denext/plugin-kit";

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
 * The payloads published to one key of a channel, as an async iterable. Ends when the key is
 * revoked, when `signal` aborts, or when the consumer returns (a GraphQL client disconnect).
 *
 * @param channel The channel (or its id).
 * @param key The key to follow.
 * @param options Abort signal and buffer cap.
 */
export function fromChannel<T>(
  channel: Channel<T> | string,
  key: string,
  options: FromChannelOptions = {},
): AsyncIterableIterator<T> {
  const cap = Math.max(1, options.buffer ?? 64);
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    stop();
    options.signal?.removeEventListener("abort", finish);
    wake?.();
  };
  const stop = tapChannel<T>(channel, key, {
    onPayload: (payload) => {
      if (done) return;
      if (queue.length >= cap) queue.shift();
      queue.push(payload);
      wake?.();
    },
    onRevoke: finish,
  });
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
