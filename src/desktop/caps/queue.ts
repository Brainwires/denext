/**
 * A bounded pull queue for OS events the page must see once (notification clicks, menu clicks,
 * shortcut presses): the runtime queues each item and pushes a payload-free signal down the
 * bridge's event stream; the page takes the queue with an RPC, which empties it. The stream
 * replays its buffer on reconnect, so pushing the items themselves would deliver a click twice
 * after a reload; a replayed signal only makes the page take an empty queue.
 *
 * Runtime-only (imported by the capability modules, never a client bundle).
 *
 * @module
 */

/** How many untaken items a queue keeps by default (oldest dropped past it). */
const DEFAULT_MAX = 64;

/** A bounded queue the page takes. */
export interface PullQueue<T> {
  /** Queue `item` (dropping the oldest past the bound) and signal the page. */
  push(item: T): void;
  /** Everything queued, oldest first; the queue is empty afterwards. */
  take(): T[];
  /** Forget everything queued. */
  clear(): void;
}

/**
 * Create a pull queue.
 *
 * @param signal Tells the page there is something to take (an `emit` without data).
 * @param max How many items are kept.
 * @returns The queue.
 */
export function createPullQueue<T>(signal: () => void, max: number = DEFAULT_MAX): PullQueue<T> {
  const items: T[] = [];
  return {
    push: (item) => {
      items.push(item);
      if (items.length > max) items.shift();
      signal();
    },
    take: () => items.splice(0, items.length),
    clear: () => {
      items.length = 0;
    },
  };
}
