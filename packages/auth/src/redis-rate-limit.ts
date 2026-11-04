/**
 * A {@linkcode RateLimitStore} on Redis (7+, or Valkey): the auth limiters' failure counts
 * shared by every replica, so a lockout on one instance holds on all of them.
 *
 * ```ts
 * import { denextAuth, redisRateLimitStore } from "@denext/auth";
 * denextAuth({ ..., rateLimit: { store: redisRateLimitStore({ url: Deno.env.get("REDIS_URL") }) } });
 * ```
 *
 * A window is a hash (`c` = count, `r` = reset time) that Redis expires when the window closes.
 * Each `increment` is one `MULTI` block (open the window if none is open, count, read back), so
 * concurrent failures on many replicas are all counted.
 *
 * @module
 */

import type { RateLimitStore, RateLimitWindow } from "./rate-limit.ts";
import {
  type RedisConnectionOptions,
  type RedisReply,
  resolveRedis,
} from "@denext/denext/auth-kit";

/** Options for {@linkcode redisRateLimitStore}. */
export type RedisRateLimitStoreOptions = RedisConnectionOptions;

const DEFAULT_PREFIX = "denext:ratelimit:";

/** A window from an `HMGET c r` reply, or `undefined` when there is none or it closed. */
function windowOf(reply: RedisReply, now: number): RateLimitWindow | undefined {
  if (!Array.isArray(reply) || reply[0] == null || reply[1] == null) return undefined;
  const window = { count: Math.max(0, Number(reply[0])), resetAt: Number(reply[1]) };
  return window.resetAt > now ? window : undefined;
}

/**
 * A shared {@linkcode RateLimitStore} on Redis.
 *
 * @param options `client` (a {@linkcode redisClient}) or `url`, and a key `prefix` (default
 *   `denext:ratelimit:`).
 * @returns A store to pass as `denextAuth({ rateLimit: { store } })`; `close()` closes a client
 *   it opened.
 * @throws {TypeError} When both `client` and `url` are given, or the URL is not a Redis URL.
 */
export function redisRateLimitStore(
  options: RedisRateLimitStoreOptions = {},
): RateLimitStore & { close(): Promise<void> } {
  const { client: redis, owned } = resolveRedis(options, "redisRateLimitStore");
  const p = options.prefix ?? DEFAULT_PREFIX;
  const keyOf = (key: string) => `${p}${key}`;
  /** Start a fresh window at 1 (the open one's reset time already passed). */
  const restart = async (k: string, resetAt: number): Promise<RateLimitWindow> => {
    await redis.transaction([
      ["DEL", k],
      ["HSET", k, "c", 1, "r", resetAt],
      ["PEXPIREAT", k, resetAt],
    ]);
    return { count: 1, resetAt };
  };
  return {
    async get(key) {
      return windowOf(await redis.command("HMGET", keyOf(key), "c", "r"), Date.now());
    },
    async increment(key, windowMs) {
      const k = keyOf(key);
      const now = Date.now();
      const resetAt = now + windowMs;
      // HSETNX + PEXPIREAT NX open a window only when none is open; Redis drops the key when
      // it closes, so the next failure opens a new one.
      const replies = await redis.transaction([
        ["HSETNX", k, "r", resetAt],
        ["HINCRBY", k, "c", 1],
        ["PEXPIREAT", k, resetAt, "NX"],
        ["HMGET", k, "c", "r"],
      ]);
      const window = windowOf(replies[3], now);
      // Still there past its reset time by this clock (the server's runs behind): start over.
      if (!window) return await restart(k, resetAt);
      return { count: Math.max(1, window.count), resetAt: window.resetAt };
    },
    async reset(key) {
      await redis.command("DEL", keyOf(key));
    },
    async decrement(key) {
      const k = keyOf(key);
      const window = windowOf(await redis.command("HMGET", k, "c", "r"), Date.now());
      if (!window || window.count <= 0) return;
      // PEXPIREAT again: should the key have gone meanwhile, the hash HINCRBY recreates still
      // expires with the window (reads clamp its count at 0).
      await redis.transaction([["HINCRBY", k, "c", -1], ["PEXPIREAT", k, window.resetAt]]);
    },
    async close() {
      if (owned) await redis.close();
    },
  };
}
