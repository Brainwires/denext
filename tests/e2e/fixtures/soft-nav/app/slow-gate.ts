// The gate the /deferred page's slow value waits on (see app/deferred/page.tsx). Kept on
// globalThis so the page render and the /release-slow handler share it whichever module
// instance each one loaded.

type Gate = { waiters: Array<() => void> };

function gate(): Gate {
  const g = globalThis as { __denextSlowGate?: Gate };
  return g.__denextSlowGate ??= { waiters: [] };
}

/** A promise of `value` that settles at the next `releaseSlow()` (or after 60 s). */
export function waitForSlowRelease<T>(value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(done, 60_000);
    function done() {
      clearTimeout(timer);
      resolve(value);
    }
    gate().waiters.push(done);
  });
}

/** Settle every slow value waiting so far; how many there were. */
export function releaseSlow(): number {
  const waiters = gate().waiters.splice(0);
  for (const w of waiters) w();
  return waiters.length;
}
