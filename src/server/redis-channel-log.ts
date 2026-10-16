/**
 * A {@linkcode ChannelLog} in Redis — the replay log `redisChannelTransport` brings, so a
 * subscriber on any replica replays a channel key's history (`createChannel({ history })`), not
 * only what its own instance published.
 *
 * Each (channel, key) is one sorted set (`<prefix>:<channel>:<key>`) scored by cursor, trimmed to
 * the channel's `size` on every append and expiring `ttlSeconds` after its latest one; an entry
 * older than the TTL is skipped on read. Cursors come from one counter for the whole app
 * (`<prefix>:seq`, seeded from the clock), so they grow across keys, replicas and restarts.
 *
 * @module
 */

import type { ChannelLog, ChannelLogEntry } from "../runtime/channel-log.ts";
import type { RedisClient, RedisReply } from "./redis.ts";

/** Options for {@linkcode redisChannelLog}. */
export interface RedisChannelLogOptions {
  /** The key prefix (default `denext:chlog`). */
  prefix?: string;
}

/** A logged entry as stored: cursor, payload, codec flag, expiry (epoch ms). */
interface Stored {
  c: string;
  v: string;
  e?: 1;
  x: number;
}

/**
 * A channel replay log over a Redis connection.
 *
 * @param client The connection (the transport's publishing client).
 * @param options The key prefix.
 * @returns The log.
 */
export function redisChannelLog(
  client: RedisClient,
  options: RedisChannelLogOptions = {},
): ChannelLog {
  const prefix = options.prefix ?? "denext:chlog";
  const seqKey = `${prefix}:seq`;
  const keyOf = (channelId: string, key: string) => `${prefix}:${channelId}:${key}`;
  let seeded: Promise<unknown> | undefined;

  return {
    async append(channelId, key, entry, history) {
      // Seed the counter from the clock once (NX: never moves it back), so a counter lost with a
      // flushed Redis still issues cursors past the ones clients hold.
      seeded ??= client.command("SET", seqKey, String(Date.now() * 1000), "NX");
      await seeded.catch((err) => {
        seeded = undefined; // a failed seed is retried by the next append
        throw err;
      });
      const cursor = String(await client.command("INCR", seqKey));
      const now = Date.now();
      const stored: Stored = {
        c: cursor,
        v: entry.encoded,
        ...(entry.enc ? { e: entry.enc } : {}),
        x: now + history.ttlSeconds * 1000,
      };
      const zkey = keyOf(channelId, key);
      await client.pipeline([
        ["ZADD", zkey, cursor, JSON.stringify(stored)],
        ["ZREMRANGEBYRANK", zkey, 0, -(history.size + 1)],
        ["PEXPIREAT", zkey, now + history.ttlSeconds * 1000],
      ]);
      return cursor;
    },
    async since(channelId, key, cursor, limit) {
      const min = (BigInt(cursor) + 1n).toString();
      const reply = await client.command("ZRANGEBYSCORE", keyOf(channelId, key), min, "+inf");
      const now = Date.now();
      return entriesOf(reply).filter((s) => s.x > now).slice(-limit).map((s) => ({
        cursor: s.c,
        encoded: s.v,
        ...(s.e ? { enc: s.e } : {}),
      } as ChannelLogEntry));
    },
  };
}

/** The stored entries of a `ZRANGEBYSCORE` reply (a malformed member is skipped). */
function entriesOf(reply: RedisReply): Stored[] {
  if (!Array.isArray(reply)) return [];
  const out: Stored[] = [];
  for (const member of reply) {
    if (typeof member !== "string") continue;
    try {
      const s = JSON.parse(member) as Stored;
      if (typeof s?.c === "string" && typeof s.v === "string" && typeof s.x === "number") {
        out.push(s);
      }
    } catch {
      // not ours
    }
  }
  return out;
}
