// The AuthAdapter contract's clock: epoch seconds read ONCE per case, so a case that writes
// `at(-1)` and later asserts the stored value against `at(-1)` compares the same number even when
// the wall clock crosses a second in between (CI: `1792013487` against `1792013488`).

let pinned: number | null = null;

/** Epoch seconds, `offset` seconds from the current case's start (from now outside a case). */
export const at = (offset: number): number => (pinned ?? Math.floor(Date.now() / 1000)) + offset;

/** Run `fn` with the contract clock pinned to the current second. */
export async function withPinnedClock<T>(fn: () => Promise<T>): Promise<T> {
  pinned = Math.floor(Date.now() / 1000);
  try {
    return await fn();
  } finally {
    pinned = null;
  }
}
