/**
 * The page side of the desktop runtime's pull queues (notification clicks, menu and tray clicks,
 * shortcut presses): one subscription per queue, shared by every listener in the page. The first
 * listener subscribes to the queue's payload-free signal and takes the queue at once (a click that
 * started the app is already waiting); each signal then takes it again, and every item goes to
 * every listener present. The last listener to leave closes the subscription.
 *
 * Client-only: web APIs, nothing runs at import.
 *
 * @module
 */

import { desktopRpc, subscribeDesktopEvent } from "./bridge-client.ts";

/** Subscribe a listener to a pull queue; returns its unsubscribe. */
export type PullSubscribe<T> = (listener: (item: T) => void) => () => void;

/**
 * A shared subscription to the pull queue of `cap` (its `event` signal and `take` method).
 *
 * @param cap The capability.
 * @param event The signal event.
 * @param parse Turns one raw item into the listeners' value (`undefined` drops it).
 * @returns The subscribe function.
 */
export function pullQueue<T>(
  cap: string,
  event: string,
  parse: (raw: unknown) => T | undefined,
): PullSubscribe<T> {
  const listeners = new Set<(item: T) => void>();
  let stop: (() => void) | undefined;
  let taking = false;
  let again = false;

  /** Hand each parsed item to every listener present (a throwing listener does not stop the rest). */
  const deliver = (raw: unknown): void => {
    for (const r of Array.isArray(raw) ? raw : []) {
      const item = parse(r);
      if (item === undefined) continue;
      for (const fn of [...listeners]) {
        try {
          fn(item);
        } catch (err) {
          console.error(`denext: a ${cap} listener threw`, err);
        }
      }
    }
  };

  /** Take the queue (again, when a signal arrived meanwhile). */
  const take = async (): Promise<void> => {
    if (taking) {
      again = true;
      return;
    }
    taking = true;
    try {
      do {
        again = false;
        deliver(await desktopRpc<unknown>(cap, "take", {}).catch(() => []));
      } while (again && listeners.size > 0);
    } finally {
      taking = false;
    }
  };

  return (listener) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      stop = subscribeDesktopEvent(cap, event, () => void take());
      void take();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size > 0) return;
      stop?.();
      stop = undefined;
    };
  };
}
