// One macrotask turn: every microtask queued before it has run by the time it resolves.
// Shared by the client's `act` (which waits for a turn of quiet) and the streaming server
// renderers (which let Suspense boundaries that need only microtasks finish before the shell
// flushes, so they render inline).

/** The waiters of the macrotask turn already scheduled, or null when none is. */
let batch: Array<() => void> | null = null;

/**
 * Resolve on the next macrotask. A MessageChannel, as React's act uses where Node's
 * `setImmediate` is unavailable: fake timers replace `setTimeout`, which would stall the
 * wait. Every call made before that turn runs shares it (one channel, resolved in call
 * order); both ports close afterwards so no handle outlives it.
 */
export function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    if (batch) return void batch.push(resolve);
    const waiters = (batch = [resolve]);
    const fire = () => {
      batch = null;
      for (const wake of waiters) wake();
    };
    if (typeof MessageChannel !== "function") return void setTimeout(fire, 0);
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      fire();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * `promise`'s value, or `undefined` once a macrotask turn passes first — a cap on a wait that
 * should need only microtasks. When `promise` wins, the pending turn is cancelled, so no
 * handle outlives the race.
 */
export function withinMacrotask<T>(promise: Promise<T>): Promise<T | undefined> {
  if (typeof MessageChannel !== "function") {
    return Promise.race([promise, new Promise<undefined>((r) => setTimeout(r, 0))]);
  }
  const channel = new MessageChannel();
  const close = () => {
    channel.port1.close();
    channel.port2.close();
  };
  // Settle before closing: closing a port can deliver its queued message synchronously.
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      resolve(undefined);
      close();
    };
    channel.port2.postMessage(null);
    promise.then((value) => {
      resolve(value);
      close();
    });
  });
}
