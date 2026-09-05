/**
 * A promise that resolves (to `undefined`) when `signal` aborts, and never resolves without
 * a signal. Create it ONCE per stream and race it against each pending step — one listener
 * for the whole stream, not one per boundary.
 */
export function abortedPromise(signal?: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}
