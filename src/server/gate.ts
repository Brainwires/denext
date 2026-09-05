// A tiny bounded FIFO semaphore shared by the CPU-heavy server paths (image optimization,
// scrypt password hashing). Bounds concurrency so an endpoint can't be turned into a
// CPU-amplification lever, and bounds the WAITER queue so load is shed instead of
// accumulating an unbounded backlog.

/** Rejection from a {@linkcode createGate} `acquire()` when the waiter queue is full. */
export class GateOverloadError extends Error {
  /** Create a gate-overload error. */
  constructor(message = "queue full") {
    super(message);
    this.name = "GateOverloadError";
  }
}

/**
 * A tiny FIFO semaphore: `acquire()` resolves when a slot is free, and the returned function
 * releases it (handing the slot to the next waiter).
 *
 * The waiter queue is itself bounded (`maxWaiters`): once that many callers are already
 * queued, `acquire()` rejects with a {@linkcode GateOverloadError} so the caller can shed
 * load (503 + Retry-After) instead of queueing without bound.
 *
 * @param max Maximum concurrent holders.
 * @param maxWaiters Maximum queued waiters before `acquire()` sheds (defaults to `max * 8`).
 * @param overloadMessage The message on the shed error.
 */
export function createGate(
  max: number,
  maxWaiters: number = max * 8,
  overloadMessage?: string,
): () => Promise<() => void> {
  let active = 0;
  const waiters: Array<() => void> = [];
  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) {
      active++;
      next();
    }
  };
  return function acquire(): Promise<() => void> {
    if (active < max) {
      active++;
      return Promise.resolve(release);
    }
    if (waiters.length >= maxWaiters) {
      return Promise.reject(new GateOverloadError(overloadMessage));
    }
    return new Promise<() => void>((resolve) => {
      waiters.push(() => resolve(release));
    });
  };
}
