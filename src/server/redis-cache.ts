/**
 * A {@linkcode CacheStore} on Redis (7+, or Valkey): the data cache (`unstable_cache`,
 * `"use cache"`) and the page (ISR) cache shared by every replica, so `revalidateTag` /
 * `revalidatePath` on one instance invalidates what all of them serve.
 *
 * ```ts
 * // denext.config.ts
 * import { redisCacheStore } from "denext/server";
 * export default { cache: { store: redisCacheStore({ url: Deno.env.get("REDIS_URL") }) } };
 * ```
 *
 * Each entry is a hash; a set per tag and per page path indexes them, and two sorted sets per
 * namespace order them by write time (for the size cap) and by hard expiry (for the sweep).
 * A write replaces the entry and its index memberships in one `MULTI` block. Index sets may
 * briefly hold a key that was rewritten without that tag (two writers racing); every
 * invalidation re-reads the entry's own tags or path before it deletes, so a stale membership
 * never purges an entry it no longer describes. Like the SQLite and Postgres stores it bounds
 * its footprint: past a per-namespace cap the oldest-written entries go, and hard-expired ones
 * are swept on a throttle. Zero npm: it runs on denext's own RESP client ({@linkcode redisClient}).
 *
 * @module
 */

import type { CachedPage, CacheEntryTiming, CacheStore, DataEntry } from "./cache.ts";
import { encodePprExtras } from "./cache-ppr.ts";
import {
  type RedisClient,
  type RedisCommand,
  type RedisConnectionOptions,
  type RedisReply,
  resolveRedis,
} from "./redis.ts";

/** Options for {@linkcode redisCacheStore}. */
export interface RedisCacheStoreOptions extends RedisConnectionOptions {
  /** Max data entries before the oldest-written are evicted. Default 1000. */
  maxDataEntries?: number;
  /** Max cached pages before the oldest-written are evicted. Default 1000. */
  maxPageEntries?: number;
  /** Min ms between proactive hard-expiry sweeps (default 30000; `0` = every write). */
  sweepIntervalMs?: number;
}

const DEFAULT_MAX = 1000;
const SWEEP_INTERVAL = 30_000;
const DEFAULT_PREFIX = "denext:cache:";

type Ns = "d" | "p";
type Fields = Record<string, string>;

/** `Infinity` (no expiry) is stored as `inf`; a finite epoch-ms as its decimal text. */
const encodeTime = (at: number | undefined): string =>
  at === undefined ? "" : at === Infinity ? "inf" : String(at);
const decodeTime = (v: string | undefined): number | undefined =>
  v === undefined || v === "" ? undefined : v === "inf" ? Infinity : Number(v);

/** A flat `HGETALL` reply as a record (empty for a missing key). */
function toFields(reply: RedisReply): Fields {
  const fields: Fields = {};
  if (!Array.isArray(reply)) return fields;
  for (let i = 0; i + 1 < reply.length; i += 2) fields[String(reply[i])] = String(reply[i + 1]);
  return fields;
}

/** Parse JSON, or `undefined` for a missing or corrupt field. */
function parseJson<T>(text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** The tags an entry's hash carries. */
const tagsOf = (fields: Fields): string[] => parseJson<string[]>(fields.t) ?? [];

/** A data entry from its hash, or `undefined` when a required field is missing. */
function readData(f: Fields): DataEntry | undefined {
  const expiresAt = decodeTime(f.e);
  if (f.v === undefined || expiresAt === undefined) return undefined;
  const staleAt = decodeTime(f.s);
  return {
    value: parseJson(f.v),
    expiresAt,
    ...(staleAt === undefined || staleAt === Infinity ? {} : { staleAt }),
    tags: tagsOf(f),
  };
}

/** A cached page from its hash, or `undefined` when a required field is missing. */
function readPage(f: Fields): CachedPage | undefined {
  const expiresAt = decodeTime(f.e);
  if (f.b === undefined || f.pa === undefined || expiresAt === undefined) return undefined;
  return {
    body: f.b,
    status: Number(f.st) || 200,
    path: f.pa,
    expiresAt,
    staleAt: decodeTime(f.s) ?? Infinity,
    tags: tagsOf(f),
    csp: f.c || undefined,
    ...(f.x ? parseJson<Partial<CachedPage>>(f.x) : {}),
  };
}

/** The {@link CacheStore} behind {@linkcode redisCacheStore}. */
class RedisCache implements CacheStore {
  readonly #redis: RedisClient;
  readonly #owned: boolean;
  readonly #p: string;
  readonly #max: Record<Ns, number>;
  readonly #sweepInterval: number;
  #lastSweep = 0;

  constructor(options: RedisCacheStoreOptions) {
    const { client, owned } = resolveRedis(options, "redisCacheStore");
    this.#redis = client;
    this.#owned = owned;
    this.#p = options.prefix ?? DEFAULT_PREFIX;
    this.#max = {
      d: options.maxDataEntries ?? DEFAULT_MAX,
      p: options.maxPageEntries ?? DEFAULT_MAX,
    };
    this.#sweepInterval = options.sweepIntervalMs ?? SWEEP_INTERVAL;
  }

  #entry = (ns: Ns, key: string): string => `${this.#p}${ns}:${key}`;
  #tag = (tag: string): string => `${this.#p}tag:${tag}`;
  #path = (path: string): string => `${this.#p}path:${path}`;
  #written = (ns: Ns): string => `${this.#p}w:${ns}`;
  #expiry = (ns: Ns): string => `${this.#p}x:${ns}`;

  /** One entry's hash, removing (and missing) it when hard-expired. */
  async #live(ns: Ns, key: string): Promise<Fields | undefined> {
    const fields = toFields(await this.#redis.command("HGETALL", this.#entry(ns, key)));
    if (!Object.keys(fields).length) return undefined;
    const expiresAt = decodeTime(fields.e);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      await this.#remove(ns, [key]);
      return undefined;
    }
    return fields;
  }

  /** Replace one entry and its index memberships, then evict past the cap and maybe sweep. */
  async #write(ns: Ns, key: string, fields: Fields, tags: string[], path?: string) {
    const entry = this.#entry(ns, key);
    const old = await this.#redis.command("HMGET", entry, "t", "pa") as (string | null)[];
    await this.#redis.transaction([
      ["DEL", entry],
      ["HSET", entry, ...Object.entries(fields).flat()],
      ...this.#retag(ns, key, parseJson<string[]>(old[0] ?? undefined) ?? [], tags),
      ...this.#repath(key, old[1], path),
      ["ZADD", this.#written(ns), Date.now(), key],
      this.#expiryCommand(ns, key, decodeTime(fields.e)!),
    ]);
    await this.#evict(ns);
    await this.#maybeSweep();
  }

  /** Move an entry's tag-set memberships from `before` to `after`. */
  #retag(ns: Ns, key: string, before: string[], after: string[]): RedisCommand[] {
    const member = `${ns}:${key}`;
    return [
      ...before.filter((tag) => !after.includes(tag)).map((
        tag,
      ) => ["SREM", this.#tag(tag), member]),
      ...after.map((tag) => ["SADD", this.#tag(tag), member]),
    ];
  }

  /** Move a page's path-set membership. */
  #repath(key: string, before: string | null | undefined, after?: string): RedisCommand[] {
    const commands: RedisCommand[] = [];
    if (before && before !== after) commands.push(["SREM", this.#path(before), key]);
    if (after !== undefined) commands.push(["SADD", this.#path(after), key]);
    return commands;
  }

  /** Index (or un-index) an entry's hard expiry. */
  #expiryCommand(ns: Ns, key: string, expiresAt: number): RedisCommand {
    return expiresAt === Infinity
      ? ["ZREM", this.#expiry(ns), key]
      : ["ZADD", this.#expiry(ns), expiresAt, key];
  }

  /**
   * Delete entries with their index memberships (read first, so each set loses its member).
   *
   * @returns How many of them existed.
   */
  async #remove(ns: Ns, keys: readonly string[]): Promise<number> {
    if (!keys.length) return 0;
    const indexes = await this.#redis.pipeline(
      keys.map((key) => ["HMGET", this.#entry(ns, key), "t", "pa"]),
    ) as (string | null)[][];
    const commands: RedisCommand[] = [];
    keys.forEach((key, i) => {
      const [tags, path] = indexes[i];
      commands.push(["DEL", this.#entry(ns, key)]);
      for (const tag of parseJson<string[]>(tags ?? undefined) ?? []) {
        commands.push(["SREM", this.#tag(tag), `${ns}:${key}`]);
      }
      if (path) commands.push(["SREM", this.#path(path), key]);
    });
    commands.push(["ZREM", this.#written(ns), ...keys], ["ZREM", this.#expiry(ns), ...keys]);
    const replies = await this.#redis.transaction(commands);
    return commands.reduce((n, c, i) => n + (c[0] === "DEL" ? Number(replies[i]) : 0), 0);
  }

  /** Drop the oldest-written entries past the namespace's cap. */
  async #evict(ns: Ns): Promise<void> {
    const excess = Number(await this.#redis.command("ZCARD", this.#written(ns))) - this.#max[ns];
    if (excess <= 0) return;
    const oldest = await this.#redis.command("ZRANGE", this.#written(ns), 0, excess - 1);
    await this.#remove(ns, (oldest as string[]) ?? []);
  }

  /** Reclaim hard-expired entries, throttled; never-expiring ones are left to the cap. */
  async #maybeSweep(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastSweep < this.#sweepInterval) return;
    this.#lastSweep = now;
    for (const ns of ["d", "p"] as const) {
      const due = await this.#redis.command("ZRANGEBYSCORE", this.#expiry(ns), "-inf", now);
      await this.#remove(ns, (due as string[]) ?? []);
    }
  }

  /**
   * The members of an index set whose entry still matches, after dropping the stale ones.
   *
   * @param set The index set.
   * @param matches Whether an entry's hash still belongs in the set.
   * @param field The hash field `matches` reads.
   */
  async #members(
    set: string,
    field: string,
    matches: (value: string | null) => boolean,
    toEntry: (member: string) => { ns: Ns; key: string },
  ): Promise<{ ns: Ns; key: string }[]> {
    const members = (await this.#redis.command("SMEMBERS", set) as string[]) ?? [];
    if (!members.length) return [];
    const entries = members.map(toEntry);
    const values = await this.#redis.pipeline(
      entries.map(({ ns, key }) => ["HGET", this.#entry(ns, key), field]),
    ) as (string | null)[];
    const stale = members.filter((_, i) => !matches(values[i]));
    if (stale.length) await this.#redis.command("SREM", set, ...stale);
    return entries.filter((_, i) => matches(values[i]));
  }

  /** The entries tagged `tag` (a member is `d:<key>` or `p:<key>`). */
  #tagged(tag: string) {
    return this.#members(
      this.#tag(tag),
      "t",
      (tags) => (parseJson<string[]>(tags ?? undefined) ?? []).includes(tag),
      (member) => ({ ns: member.slice(0, 1) as Ns, key: member.slice(2) }),
    );
  }

  /** Remove entries grouped by namespace. */
  async #removeAll(entries: readonly { ns: Ns; key: string }[]): Promise<number> {
    let removed = 0;
    for (const ns of ["d", "p"] as const) {
      removed += await this.#remove(ns, entries.filter((e) => e.ns === ns).map((e) => e.key));
    }
    return removed;
  }

  async getData(key: string): Promise<DataEntry | undefined> {
    const fields = await this.#live("d", key);
    return fields && readData(fields);
  }

  async setData(key: string, entry: DataEntry): Promise<void> {
    await this.#write("d", key, {
      v: JSON.stringify(entry.value) ?? "null",
      e: encodeTime(entry.expiresAt),
      s: encodeTime(entry.staleAt),
      t: JSON.stringify(entry.tags),
    }, entry.tags);
  }

  async getPage(key: string): Promise<CachedPage | undefined> {
    const fields = await this.#live("p", key);
    return fields && readPage(fields);
  }

  async setPage(key: string, page: CachedPage): Promise<void> {
    await this.#write(
      "p",
      key,
      {
        b: page.body,
        st: String(page.status),
        pa: page.path,
        e: encodeTime(page.expiresAt),
        s: encodeTime(page.staleAt),
        t: JSON.stringify(page.tags),
        c: page.csp ?? "",
        x: encodePprExtras(page) ?? "",
      },
      page.tags,
      page.path,
    );
  }

  async deleteByTag(tag: string): Promise<void> {
    await this.#removeAll(await this.#tagged(tag));
  }

  async deleteByPath(path: string): Promise<void> {
    const pages = await this.#members(
      this.#path(path),
      "pa",
      (value) => value === path,
      (key) => ({ ns: "p", key }),
    );
    await this.#removeAll(pages);
  }

  async expireByTag(tag: string, timing: CacheEntryTiming): Promise<void> {
    const entries = await this.#tagged(tag);
    if (!entries.length) return;
    const commands: RedisCommand[] = [];
    for (const { ns, key } of entries) {
      // HSET XX does not exist: a concurrent delete may leave a partial hash, which a read
      // treats as corrupt (missing `v` / `b`) and removes.
      commands.push(
        [
          "HSET",
          this.#entry(ns, key),
          "s",
          encodeTime(timing.staleAt),
          "e",
          encodeTime(timing.expiresAt),
        ],
        this.#expiryCommand(ns, key, timing.expiresAt),
      );
    }
    await this.#redis.transaction(commands);
  }

  async sweepPages(keep: string): Promise<number> {
    const keys = (await this.#redis.command("ZRANGE", this.#written("p"), 0, -1) as string[]) ?? [];
    return await this.#remove("p", keys.filter((key) => !key.startsWith(keep)));
  }

  /** Close the client when this store opened it (from `url`). */
  async close(): Promise<void> {
    if (this.#owned) await this.#redis.close();
  }
}

/**
 * A {@link CacheStore} on Redis, shared by every replica. Size-bounded: the oldest-written
 * entries past `maxDataEntries` / `maxPageEntries` are evicted, and hard-expired ones are swept
 * on a throttle.
 *
 * @param options `client` (a {@linkcode redisClient}) or `url`, a key `prefix`, the caps and the
 *   sweep interval.
 * @returns A store for `cache.store` / {@linkcode setCacheStore}; its `close()` closes a client it
 *   opened.
 * @throws {TypeError} When both `client` and `url` are given, or the URL is not a Redis URL.
 */
export function redisCacheStore(
  options: RedisCacheStoreOptions = {},
): CacheStore & { close(): Promise<void> } {
  return new RedisCache(options);
}
