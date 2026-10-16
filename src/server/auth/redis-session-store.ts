/**
 * A {@linkcode SessionStore} on Redis (7+, or Valkey), so revocable auth sessions are shared by
 * every replica and survive restarts:
 *
 * ```ts
 * import { denextAuth, redisSessionStore } from "denext/server";
 * denextAuth({ ..., sessionStore: redisSessionStore({ url: Deno.env.get("REDIS_URL") }) });
 * ```
 *
 * A session is one string key that Redis expires at the session's `expiresAt`; a set per user
 * lists that user's session ids for `deleteByUser`. `update` is `SET … XX`, so a session
 * revoked while a request was refreshing it is never written back.
 *
 * @module
 */

import type { SessionStore } from "./session-store.ts";
import { sessionExpired } from "./session-store.ts";
import type { AuthSession } from "./types.ts";
import { type RedisConnectionOptions, resolveRedis } from "../redis.ts";

/** Options for {@linkcode redisSessionStore}. */
export type RedisSessionStoreOptions = RedisConnectionOptions;

const DEFAULT_PREFIX = "denext:session:";

/** Parse a stored session, or `undefined` for a corrupt one. */
function parse(text: unknown): AuthSession | undefined {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as AuthSession;
  } catch {
    return undefined;
  }
}

/**
 * A durable, shared {@linkcode SessionStore} on Redis.
 *
 * @param options `client` (a {@linkcode redisClient}) or `url`, and a key `prefix` (default
 *   `denext:session:`).
 * @returns A store to pass as `denextAuth({ sessionStore })`; its `close()` closes a client it
 *   opened.
 * @throws {TypeError} When both `client` and `url` are given, or the URL is not a Redis URL.
 */
export function redisSessionStore(
  options: RedisSessionStoreOptions = {},
): SessionStore & { close(): Promise<void> } {
  const { client: redis, owned } = resolveRedis(options, "redisSessionStore");
  const p = options.prefix ?? DEFAULT_PREFIX;
  const sessionKey = (id: string) => `${p}s:${id}`;
  const userKey = (userId: string) => `${p}u:${userId}`;
  /** Index the session under its user; the set lives as long as its longest session. */
  const index = (id: string, session: AuthSession, at: number) => [
    ["SADD", userKey(session.user.id), id],
    ["PEXPIREAT", userKey(session.user.id), at, "NX"],
    ["PEXPIREAT", userKey(session.user.id), at, "GT"],
  ];
  return {
    async create(id, session) {
      if (sessionExpired(session)) {
        await redis.command("DEL", sessionKey(id));
        return;
      }
      const at = session.expiresAt * 1000;
      await redis.transaction([
        ["SET", sessionKey(id), JSON.stringify(session), "PXAT", at],
        ...index(id, session, at),
      ]);
    },
    async update(id, session) {
      if (sessionExpired(session)) return false;
      const at = session.expiresAt * 1000;
      // XX: only an existing (unrevoked, unexpired) key is rewritten, never recreated.
      const set = await redis.command(
        "SET",
        sessionKey(id),
        JSON.stringify(session),
        "XX",
        "PXAT",
        at,
      );
      if (set !== "OK") return false;
      await redis.transaction(index(id, session, at));
      return true;
    },
    async get(id) {
      const session = parse(await redis.command("GET", sessionKey(id)));
      return session && !sessionExpired(session) ? session : undefined;
    },
    async delete(id) {
      await redis.command("DEL", sessionKey(id));
    },
    async deleteByUser(userId) {
      const ids = (await redis.command("SMEMBERS", userKey(userId)) as string[]) ?? [];
      if (!ids.length) return;
      const sessions = await redis.pipeline(ids.map((id) => ["GET", sessionKey(id)]));
      // A session that moved to another user keeps its key; everyone else's goes.
      const mine = ids.filter((_, i) => {
        const session = parse(sessions[i]);
        return !session || session.user.id === userId;
      });
      // SREM only these ids: one created for the user meanwhile stays indexed.
      await redis.transaction([
        ...mine.map((id) => ["DEL", sessionKey(id)]),
        ["SREM", userKey(userId), ...ids],
      ]);
    },
    async close() {
      if (owned) await redis.close();
    },
  };
}
