/**
 * The page half of the Deno Desktop launch queues (`deepLinks` / `openFiles`, see
 * `src/desktop/launch-events.ts`): an attach function for {@link createFanout} that, while anyone
 * is subscribed, takes the runtime's queue on every `available` signal (and once at attach, for a
 * cold start) and hands each item to the subscribers. The runtime empties its queue on take, so
 * each item is delivered once — never replayed to a later subscriber or after a reload. Internal;
 * not re-exported from `denext/mobile`.
 *
 * @module
 */

import { type DesktopNative, onDesktop } from "./desktop-branch.ts";

/** How many taken-but-undelivered items are kept for the next subscriber (oldest dropped). */
const MAX_LEFTOVER = 64;

/**
 * An attach function for {@link createFanout} over one desktop queue.
 *
 * @param cap The runtime capability (`deepLinks` / `openFiles`).
 * @param take Takes the queue.
 * @param leftover Items taken while the last subscriber was leaving (delivered to the next one).
 * @returns The attach function.
 */
export function desktopQueueAttach<T>(
  cap: "deepLinks" | "openFiles",
  take: (desktop: DesktopNative) => Promise<T[]>,
  leftover: T[],
): (emit: (value: T) => void) => () => void {
  return (emit) => {
    if (!onDesktop()) return () => {};
    let live = true;
    let stop = () => {};
    // One take at a time, in order.
    let chain = Promise.resolve();
    const deliver = (items: T[]) => {
      if (!live) {
        leftover.push(...items);
        leftover.splice(0, Math.max(0, leftover.length - MAX_LEFTOVER));
        return;
      }
      for (const item of items) emit(item);
    };
    // After the subscribing call returns, so its caller has the unsubscribe in hand.
    queueMicrotask(() => deliver(leftover.splice(0)));
    void import("../desktop/native.ts").then((desktop) => {
      if (!live) return;
      const drain = () => {
        chain = chain.then(() => take(desktop).then(deliver, () => {}));
      };
      stop = desktop.onDesktopQueue(cap, drain);
      drain();
    });
    return () => {
      live = false;
      stop();
    };
  };
}
