/**
 * Cross-tab / cross-worker single-flight via the Web Locks API — a small,
 * web-standard coordination primitive with a graceful fallback.
 *
 * @module
 */

import { isServer } from "./environment.ts";

/** Options for {@linkcode withWebLock}. */
export interface WebLockOptions {
  /**
   * Lock mode: `"exclusive"` (default — one holder at a time) or `"shared"`
   * (any number of shared holders, but never alongside an exclusive one).
   */
  mode?: "exclusive" | "shared";
  /**
   * Acquire the lock only if it is free *right now*: when it is already held,
   * `fn` is NOT run and the promise resolves to `undefined` instead of waiting.
   * Mirrors the Web Locks `ifAvailable` option.
   */
  ifAvailable?: boolean;
  /** Stop waiting for the lock when this signal aborts (rejects the promise). */
  signal?: AbortSignal;
}

/**
 * Run `fn` while holding a same-origin lock named `name`, coordinating across
 * every tab, iframe, and worker of the origin (the Web Locks API). Only one
 * holder runs an exclusive lock at a time; the lock is released automatically
 * when `fn` settles — or when the holding context is destroyed — so a crashed
 * tab can never deadlock the others.
 *
 * It degrades gracefully: on the server (SSR) and in any browser without the Web
 * Locks API (an insecure context, or a very old browser) `fn` is simply run
 * without coordination, so the same call works in every environment.
 *
 * The canonical use is cross-tab single-flight: an auth-token refresh that must
 * not stampede a one-time-use refresh cookie, a once-per-origin client bootstrap
 * or migration, or electing a single leader tab to own a shared connection.
 *
 * @typeParam T The value produced by `fn`.
 * @param name The lock name — any string; scope it, e.g. `"auth:refresh"`.
 * @param fn The work to run while holding the lock.
 * @param options Lock mode, `ifAvailable`, and an optional abort `signal`.
 * @returns The result of `fn`, or `undefined` when `ifAvailable` is set and the
 *   lock was already held (so `fn` did not run).
 * @example Cross-tab token refresh (only one tab hits the endpoint):
 * ```ts
 * await withWebLock("auth:refresh", async () => {
 *   if (tokenIsFresh()) return;              // another tab already refreshed
 *   await fetch("/api/refresh", { method: "POST" });
 * });
 * ```
 */
export function withWebLock<T>(
  name: string,
  fn: () => T | Promise<T>,
  options: WebLockOptions = {},
): Promise<T | undefined> {
  const { mode = "exclusive", ifAvailable, signal } = options;

  // Client-only coordination: on the server, or in a browser without Web Locks,
  // run the work directly so callers need no environment branching of their own.
  // Match the real path's contract: a synchronous throw in `fn` becomes a rejected
  // promise (never a synchronous throw), and an already-aborted `signal` rejects.
  const locks = isServer() ? undefined : (navigator as Navigator).locks as LockManager | undefined;
  if (!locks) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  return locks.request(
    name,
    { mode, ifAvailable, signal },
    // With `ifAvailable`, the callback receives `null` when the lock was not
    // granted — resolve to `undefined` and skip the work.
    (lock: Lock | null) => (lock === null ? undefined : fn()),
  ) as Promise<T | undefined>;
}
