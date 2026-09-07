// First-party middleware for `createApi().use(...)`: the two every API needs.
//
//   const authed = createApi().use(rateLimit({ max: 60, windowMs: 60_000 })).use(requireSession());
//   export const GET = authed.define({ … }, ({ ctx }) => ctx.session.user.id);
//
// Both run BEFORE validation (see `define-api.ts`), so a rejected caller never reaches a schema.

import type { ApiMiddleware, ApiMiddlewareInput } from "./define-api.ts";
import { ApiError } from "./api-error.ts";
import { auth } from "./auth/mod.ts";
import type { AuthSession } from "./auth/types.ts";
import { clientIp, inMemoryRateLimitStore, type RateLimitStore } from "./auth/rate-limit.ts";

/** Options for {@link requireSession}. */
export interface RequireSessionOptions {
  /** The 401's message (default `"Unauthorized"`). */
  message?: string;
}

/**
 * Require a signed-in viewer (denext auth): extends the context with `{ session }`, or fails
 * with a 401 `unauthorized` envelope before any schema runs.
 *
 * @param options The 401 message.
 * @returns A middleware adding `session: AuthSession` to the handler's `ctx`.
 */
export function requireSession(
  options: RequireSessionOptions = {},
): ApiMiddleware<object, { session: AuthSession }> {
  return async () => {
    const session = await auth();
    if (!session) {
      throw new ApiError(401, "unauthorized", { message: options.message ?? "Unauthorized" });
    }
    return { session };
  };
}

/** Options for {@link rateLimit}. */
export interface ApiRateLimitOptions {
  /** Requests allowed per key per window. */
  max: number;
  /** The fixed window length in ms. */
  windowMs: number;
  /**
   * The bucket key (default: client IP + method + pathname). Use it to key per user
   * (`({ ctx }) => ctx.session.user.id`) once a session middleware has run.
   */
  key?: (input: ApiMiddlewareInput<object>) => string;
  /** Where counts live (default: a bounded in-memory store — per process; use a shared store behind replicas). */
  store?: RateLimitStore;
  /** Behind a trusted proxy: key on the LAST `x-forwarded-for` hop instead of the socket peer. */
  trustForwardedHeaders?: boolean;
  /** The 429's message (default `"Too Many Requests"`). */
  message?: string;
}

/**
 * Fixed-window rate limit per key: the (max+1)th request in a window fails with a 429
 * `rate_limited` envelope carrying `retry-after` (seconds) — before validation, so a flood
 * never reaches a schema or the handler. The client identity is the socket peer, or the last
 * `x-forwarded-for` hop only when `trustForwardedHeaders` is set (a forged header can't dodge it).
 *
 * @param options Limit, window, key, store.
 * @returns A middleware (no context extension).
 */
export function rateLimit(options: ApiRateLimitOptions): ApiMiddleware<object> {
  const store = options.store ?? inMemoryRateLimitStore();
  const keyOptions = { trustForwardedHeaders: options.trustForwardedHeaders };
  return async (input) => {
    const key = options.key?.(input) ?? defaultKey(input, keyOptions);
    const window = await store.increment(key, options.windowMs);
    if (window.count <= options.max) return;
    const retryAfter = Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
    throw new ApiError(429, "rate_limited", {
      message: options.message ?? "Too Many Requests",
      data: { retryAfter },
      headers: { "retry-after": String(retryAfter) },
    });
  };
}

function defaultKey(
  input: ApiMiddlewareInput<object>,
  keyOptions: { trustForwardedHeaders?: boolean },
): string {
  const ip = clientIp(input.request, keyOptions);
  return `${ip}|${input.method} ${new URL(input.request.url).pathname}`;
}
