// Shared abort helpers: distinguishing a real error from a client
// disconnect / request timeout, and awaiting a promise without letting a hung
// producer pin the awaiter past its own abort. Used by the request pipeline
// (`app.ts`) and the data cache's single-flight followers (`cache.ts`).

/** True for an abort (client disconnect / request timeout), not a real error. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : (error as { name?: string } | null)?.name === "AbortError";
}

/** Await `promise`, but stop waiting early if `signal` aborts. */
export function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | void> {
  if (!signal || signal.aborted) {
    return signal?.aborted ? Promise.resolve() : promise;
  }
  return Promise.race([
    promise,
    new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true })
    ),
  ]);
}
