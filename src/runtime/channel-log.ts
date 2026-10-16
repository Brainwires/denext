// A channel's message log: the opt-in `history` of `createChannel`, so a late subscriber — or one
// reconnecting, or one whose socket was back-pressured — replays what was published to its key
// since a cursor instead of only the next push.
//
// A cursor is a decimal string that grows with every logged publish (a log-wide counter seeded
// from the clock, so it keeps growing across a restart of an in-memory log); entries of one key
// are returned in cursor order. The log is a seam (`ChannelLog`): the in-memory one below holds
// this instance's publishes; `redisChannelTransport` brings a log in Redis that every replica
// shares. Either way it is bounded: `size` entries per key, a TTL, and (in memory) a cap on keys
// and bytes, the oldest key evicted first. Payloads are already capped at publish
// (`live.limits.maxChannelPayloadBytes`).
//
// Authorization is the hub's: a replay is only ever read for a subscription `authorize` allowed,
// for its own (channel, key).

/** One logged publish. */
export interface ChannelLogEntry {
  /** Its cursor (a decimal string; later publishes have larger cursors). */
  cursor: string;
  /** The wire-encoded payload JSON. */
  encoded: string;
  /** `1` when `encoded` carries codec tags. */
  enc?: 1;
}

/** A channel's retention: how many entries per key, for how long. */
export interface ChannelHistory {
  /** Entries kept per key (1–1000). */
  size: number;
  /** Seconds an entry is kept (default 24 hours). */
  ttlSeconds: number;
}

/** Where channel publishes are logged for replay. */
export interface ChannelLog {
  /** Log one publish to `key` and return its cursor. */
  append(
    channelId: string,
    key: string,
    entry: { encoded: string; enc?: 1 },
    history: ChannelHistory,
  ): Promise<string>;
  /**
   * The retained entries of `key` after `cursor` (all retained with `"0"`), oldest first, at most
   * `limit` (the newest `limit` when more remain).
   */
  since(channelId: string, key: string, cursor: string, limit: number): Promise<ChannelLogEntry[]>;
}

/** The most entries a channel may keep per key. */
const MAX_HISTORY_SIZE = 1000;
/** The default retention of a logged entry (seconds). */
const DEFAULT_HISTORY_TTL_SECONDS = 24 * 60 * 60;

/**
 * A channel's `history` option, checked and resolved (`undefined` when off).
 *
 * @param option `history` as given to `createChannel`.
 * @returns The retention, or `undefined`.
 * @throws TypeError for a size outside 1–1000 or a non-positive TTL.
 */
export function resolveHistory(
  option: number | { size: number; ttlSeconds?: number } | undefined,
): ChannelHistory | undefined {
  if (option === undefined) return undefined;
  const size = typeof option === "number" ? option : option?.size;
  const ttlSeconds = (typeof option === "object" ? option.ttlSeconds : undefined) ??
    DEFAULT_HISTORY_TTL_SECONDS;
  if (!Number.isInteger(size) || size < 1 || size > MAX_HISTORY_SIZE) {
    throw new TypeError(`createChannel: \`history\` keeps 1–${MAX_HISTORY_SIZE} entries per key`);
  }
  if (!(ttlSeconds > 0)) throw new TypeError("createChannel: `history.ttlSeconds` must be > 0");
  return { size, ttlSeconds };
}

/** Is `cursor` a cursor (`"0"` or a decimal counter value)? */
export function isCursor(cursor: unknown): cursor is string {
  return typeof cursor === "string" && /^\d{1,20}$/.test(cursor);
}

/**
 * Compare two cursors (decimal strings of any length).
 *
 * @returns Negative, zero or positive, as `a` is before, at or after `b`.
 */
export function compareCursors(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/** Options for {@linkcode inMemoryChannelLog}. */
export interface InMemoryChannelLogOptions {
  /** Keys (channel × key) kept at once; the least recently published goes first (default 1000). */
  maxKeys?: number;
  /** Payload bytes kept across every key (default 8 MiB); the least recently published key goes first. */
  maxBytes?: number;
}

/** One key's ring. */
interface Ring {
  entries: Array<ChannelLogEntry & { expires: number; bytes: number }>;
  bytes: number;
}

/**
 * The default log: this instance's publishes, in memory, bounded per key ({@link ChannelHistory}),
 * by key count and by total bytes.
 *
 * @param options The key and byte caps.
 * @returns The log.
 */
export function inMemoryChannelLog(options: InMemoryChannelLogOptions = {}): ChannelLog {
  const maxKeys = options.maxKeys ?? 1000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const rings = new Map<string, Ring>();
  let total = 0;
  // Seeded from the clock (µs) so cursors keep growing across a restart of the process.
  let counter = Date.now() * 1000;

  const drop = (id: string): void => {
    const ring = rings.get(id);
    if (!ring) return;
    total -= ring.bytes;
    rings.delete(id);
  };
  const trim = (ring: Ring, size: number, now: number): void => {
    while (
      ring.entries.length > size || (ring.entries.length > 0 && ring.entries[0].expires <= now)
    ) {
      const gone = ring.entries.shift()!;
      ring.bytes -= gone.bytes;
      total -= gone.bytes;
    }
  };

  return {
    append(channelId, key, entry, history) {
      const id = `${channelId}\0${key}`;
      const now = Date.now();
      counter = Math.max(counter + 1, now * 1000);
      const cursor = String(counter);
      const bytes = entry.encoded.length * 2;
      // Most recently published last: a Map's insertion order is the eviction order.
      const ring = rings.get(id) ?? { entries: [], bytes: 0 };
      rings.delete(id);
      rings.set(id, ring);
      const expires = now + history.ttlSeconds * 1000;
      ring.entries.push({ cursor, encoded: entry.encoded, enc: entry.enc, expires, bytes });
      ring.bytes += bytes;
      total += bytes;
      trim(ring, history.size, now);
      while (rings.size > maxKeys || (total > maxBytes && rings.size > 1)) {
        drop(rings.keys().next().value!);
      }
      return Promise.resolve(cursor);
    },
    since(channelId, key, cursor, limit) {
      const ring = rings.get(`${channelId}\0${key}`);
      if (!ring) return Promise.resolve([]);
      const now = Date.now();
      const after = ring.entries.filter((e) =>
        e.expires > now && compareCursors(e.cursor, cursor) > 0
      );
      return Promise.resolve(
        after.slice(-limit).map(({ cursor, encoded, enc }) => ({
          cursor,
          encoded,
          ...(enc ? { enc } : {}),
        })),
      );
    },
  };
}
