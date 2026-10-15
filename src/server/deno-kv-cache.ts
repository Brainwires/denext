/**
 * A {@linkcode CacheStore} on Deno KV: the data cache and the page (ISR) cache shared by every
 * isolate and region of a Deno Deploy app (or every process opening one KV database), so
 * `revalidateTag` / `revalidatePath` anywhere invalidates what all of them serve.
 *
 * ```ts
 * // denext.config.ts
 * import { denoKvCacheStore } from "denext/server";
 * export default { cache: { store: denoKvCacheStore() } }; // Deno's default database
 * ```
 *
 * An entry is a small head (tags, path, expiry, write time) plus its value as bytes: inline when
 * small, else in 60 KB chunks written before the head (a KV value holds at most 64 KiB). The head
 * and its index keys (tag, path, write order, expiry) change in one atomic commit, checked
 * against the head's version, so an index never disagrees with its entry. The size caps and the
 * hard-expiry sweep run on the sweep schedule.
 *
 * @module
 */

import type { CachedPage, CacheEntryTiming, CacheStore, DataEntry } from "./cache.ts";
import {
  type DenoKvConnectionOptions,
  type KvAtomicLike,
  type KvEntryLike,
  type KvHandle,
  kvHandle,
  type KvKey,
  type KvLike,
  listAll,
  retryCommit,
} from "./deno-kv.ts";

/** Options for {@linkcode denoKvCacheStore}. */
export interface DenoKvCacheStoreOptions extends DenoKvConnectionOptions {
  /** Max data entries before the oldest-written are evicted (on the sweep). Default 1000. */
  maxDataEntries?: number;
  /** Max cached pages before the oldest-written are evicted (on the sweep). Default 1000. */
  maxPageEntries?: number;
  /** Min ms between sweeps of expired and over-cap entries (default 30000; `0` = every write). */
  sweepIntervalMs?: number;
}

const DEFAULT_MAX = 1000;
const SWEEP_INTERVAL = 30_000;
const DEFAULT_PREFIX: KvKey = ["denext", "cache"];
/** Bytes per chunk: under KV's 64 KiB value limit. */
const CHUNK = 60_000;
/** The largest value kept inline in the head (leaving room for the head's other fields). */
const INLINE = 48_000;
/** Chunks per commit / keys per `getMany` (KV reads at most 10 keys at once). */
const BATCH = 10;

type Ns = "data" | "page";

/** What the head of an entry stores. */
interface Head {
  /** Tags. */
  t: string[];
  /** The page's path (pages only). */
  pa?: string;
  /** Hard expiry (epoch ms), `null` = never. */
  e: number | null;
  /** Stale-at (epoch ms), `null` = never / absent. */
  s: number | null;
  /** Write time (epoch ms), the eviction order. */
  w: number;
  /** The value's bytes when inline. */
  v?: Uint8Array;
  /** Otherwise: its chunk generation and count. */
  g?: string;
  n?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toDb = (at: number | undefined): number | null =>
  at === undefined || at === Infinity ? null : at;

/** The {@link CacheStore} behind {@linkcode denoKvCacheStore}. */
class DenoKvCache implements CacheStore {
  readonly #handle: KvHandle;
  readonly #p: KvKey;
  readonly #max: Record<Ns, number>;
  readonly #sweepInterval: number;
  #lastSweep = 0;

  constructor(options: DenoKvCacheStoreOptions) {
    this.#handle = kvHandle(options, "denoKvCacheStore");
    this.#p = options.prefix ?? DEFAULT_PREFIX;
    this.#max = {
      data: options.maxDataEntries ?? DEFAULT_MAX,
      page: options.maxPageEntries ?? DEFAULT_MAX,
    };
    this.#sweepInterval = options.sweepIntervalMs ?? SWEEP_INTERVAL;
  }

  #head = (ns: Ns, key: string): KvKey => [...this.#p, ns, key];
  #chunk = (gen: string, i: number): KvKey => [...this.#p, "chunk", gen, i];
  #tag = (tag: string, ns: Ns, key: string): KvKey => [...this.#p, "tag", tag, ns, key];
  #path = (path: string, key: string): KvKey => [...this.#p, "path", path, key];
  #written = (ns: Ns, w: number, key: string): KvKey => [...this.#p, "written", ns, w, key];
  #expiry = (ns: Ns, e: number, key: string): KvKey => [...this.#p, "expiry", ns, e, key];

  /** Queue the index keys of `head` for `set` (or deletion, with `remove`). */
  #indexes(op: KvAtomicLike, ns: Ns, key: string, head: Head, remove: boolean): void {
    const keys: KvKey[] = head.t.map((tag) => this.#tag(tag, ns, key));
    if (head.pa !== undefined) keys.push(this.#path(head.pa, key));
    keys.push(this.#written(ns, head.w, key));
    if (head.e !== null) keys.push(this.#expiry(ns, head.e, key));
    for (const k of keys) remove ? op.delete(k) : op.set(k, true);
  }

  /** Write a value's chunks (outside the head's commit: it may exceed one commit's size). */
  async #writeChunks(kv: KvLike, bytes: Uint8Array): Promise<Pick<Head, "v" | "g" | "n">> {
    if (bytes.length <= INLINE) return { v: bytes };
    const gen = crypto.randomUUID();
    const n = Math.ceil(bytes.length / CHUNK);
    for (let first = 0; first < n; first += BATCH) {
      const op = kv.atomic();
      for (let i = first; i < Math.min(n, first + BATCH); i++) {
        op.set(this.#chunk(gen, i), bytes.subarray(i * CHUNK, (i + 1) * CHUNK));
      }
      await op.commit();
    }
    return { g: gen, n };
  }

  /** Delete a superseded value's chunks. */
  async #dropChunks(kv: KvLike, head: Head | undefined): Promise<void> {
    if (!head?.g || !head.n) return;
    for (let first = 0; first < head.n; first += BATCH) {
      const op = kv.atomic();
      for (let i = first; i < Math.min(head.n, first + BATCH); i++) {
        op.delete(this.#chunk(head.g, i));
      }
      await op.commit();
    }
  }

  /** A value's bytes, or `undefined` when a chunk is missing. */
  async #readValue(kv: KvLike, head: Head): Promise<unknown> {
    if (head.v) return JSON.parse(decoder.decode(head.v));
    const parts: Uint8Array[] = [];
    for (let first = 0; first < (head.n ?? 0); first += BATCH) {
      const keys: KvKey[] = [];
      for (let i = first; i < Math.min(head.n!, first + BATCH); i++) {
        keys.push(this.#chunk(head.g!, i));
      }
      for (const entry of await kv.getMany(keys)) {
        if (!(entry.value instanceof Uint8Array)) return undefined;
        parts.push(entry.value);
      }
    }
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return JSON.parse(decoder.decode(bytes));
  }

  /** Replace an entry: chunks first, then the head and its indexes in one checked commit. */
  async #write(ns: Ns, key: string, value: unknown, head: Omit<Head, "w" | "v" | "g" | "n">) {
    const kv = await this.#handle.db();
    const stored = await this.#writeChunks(kv, encoder.encode(JSON.stringify(value) ?? "null"));
    const next: Head = { ...head, w: Date.now(), ...stored };
    const previous = await retryCommit<Head | undefined>(async () => {
      const current = await kv.get(this.#head(ns, key));
      const old = current.value as Head | null;
      const op = kv.atomic().check({
        key: this.#head(ns, key),
        versionstamp: current.versionstamp,
      });
      if (old) this.#indexes(op, ns, key, old, true);
      op.set(this.#head(ns, key), next);
      this.#indexes(op, ns, key, next, false);
      return (await op.commit()).ok ? { done: true, value: old ?? undefined } : { done: false };
    }, "denoKvCacheStore");
    await this.#dropChunks(kv, previous);
    await this.#maybeSweep(kv);
  }

  /**
   * Delete an entry and its indexes, if it is still the version read.
   *
   * @returns Whether it was deleted.
   */
  async #remove(kv: KvLike, ns: Ns, key: string, entry: KvEntryLike): Promise<boolean> {
    const head = entry.value as Head | null;
    if (!head) return false;
    const op = kv.atomic().check({ key: this.#head(ns, key), versionstamp: entry.versionstamp });
    op.delete(this.#head(ns, key));
    this.#indexes(op, ns, key, head, true);
    if (!(await op.commit()).ok) return false;
    await this.#dropChunks(kv, head);
    return true;
  }

  /** Remove the entries `pick` selects among `(ns, key)` pairs, re-reading each head. */
  async #removeWhere(
    kv: KvLike,
    pairs: readonly [Ns, string][],
    pick: (head: Head) => boolean = () => true,
  ): Promise<number> {
    let removed = 0;
    for (const [ns, key] of pairs) {
      const entry = await kv.get(this.#head(ns, key));
      if (entry.value && pick(entry.value as Head) && await this.#remove(kv, ns, key, entry)) {
        removed++;
      }
    }
    return removed;
  }

  /** Expired entries, then the oldest past each cap — on the sweep schedule. */
  async #maybeSweep(kv: KvLike): Promise<void> {
    const now = Date.now();
    if (now - this.#lastSweep < this.#sweepInterval) return;
    this.#lastSweep = now;
    for (const ns of ["data", "page"] as const) {
      const due = await listAll(kv, {
        start: [...this.#p, "expiry", ns],
        end: [...this.#p, "expiry", ns, now + 1],
      });
      await this.#removeWhere(kv, due.map((e) => [ns, String(e.key.at(-1))]));
      const written = await listAll(kv, { prefix: [...this.#p, "written", ns] });
      const excess = written.length - this.#max[ns];
      if (excess > 0) {
        await this.#removeWhere(
          kv,
          written.slice(0, excess).map((e) => [ns, String(e.key.at(-1))]),
        );
      }
    }
  }

  /** The live head of an entry (an expired one is removed and missed). */
  async #live(ns: Ns, key: string): Promise<{ kv: KvLike; head: Head } | undefined> {
    const kv = await this.#handle.db();
    const entry = await kv.get(this.#head(ns, key));
    const head = entry.value as Head | null;
    if (!head) return undefined;
    if (head.e !== null && head.e <= Date.now()) {
      await this.#remove(kv, ns, key, entry);
      return undefined;
    }
    return { kv, head };
  }

  async getData(key: string): Promise<DataEntry | undefined> {
    const live = await this.#live("data", key);
    if (!live) return undefined;
    const value = await this.#readValue(live.kv, live.head);
    const { head } = live;
    return {
      value,
      expiresAt: head.e ?? Infinity,
      ...(head.s === null ? {} : { staleAt: head.s }),
      tags: head.t,
    };
  }

  async setData(key: string, entry: DataEntry): Promise<void> {
    await this.#write("data", key, entry.value, {
      t: entry.tags,
      e: toDb(entry.expiresAt),
      s: toDb(entry.staleAt),
    });
  }

  async getPage(key: string): Promise<CachedPage | undefined> {
    const live = await this.#live("page", key);
    if (!live) return undefined;
    const rest = await this.#readValue(live.kv, live.head) as Omit<CachedPage, "staleAt">;
    if (!rest || typeof rest !== "object") return undefined;
    const { head } = live;
    return { ...rest, expiresAt: head.e ?? Infinity, staleAt: head.s ?? Infinity, tags: head.t };
  }

  async setPage(key: string, page: CachedPage): Promise<void> {
    const { expiresAt: _e, staleAt: _s, tags: _t, ...rest } = page;
    await this.#write("page", key, rest, {
      t: page.tags,
      pa: page.path,
      e: toDb(page.expiresAt),
      s: toDb(page.staleAt),
    });
  }

  /** The `(ns, key)` pairs under an index prefix whose last two key parts name them. */
  async #indexed(kv: KvLike, prefix: KvKey, ns?: Ns): Promise<[Ns, string][]> {
    const entries = await listAll(kv, { prefix });
    return entries.map((e) => [ns ?? e.key.at(-2) as Ns, String(e.key.at(-1))]);
  }

  async deleteByTag(tag: string): Promise<void> {
    const kv = await this.#handle.db();
    const pairs = await this.#indexed(kv, [...this.#p, "tag", tag]);
    await this.#removeWhere(kv, pairs, (head) => head.t.includes(tag));
  }

  async deleteByPath(path: string): Promise<void> {
    const kv = await this.#handle.db();
    const pairs = await this.#indexed(kv, [...this.#p, "path", path], "page");
    await this.#removeWhere(kv, pairs, (head) => head.pa === path);
  }

  async expireByTag(tag: string, timing: CacheEntryTiming): Promise<void> {
    const kv = await this.#handle.db();
    for (const [ns, key] of await this.#indexed(kv, [...this.#p, "tag", tag])) {
      await retryCommit<void>(async () => {
        const entry = await kv.get(this.#head(ns, key));
        const head = entry.value as Head | null;
        if (!head || !head.t.includes(tag)) return { done: true, value: undefined };
        const next: Head = { ...head, e: toDb(timing.expiresAt), s: toDb(timing.staleAt) };
        const op = kv.atomic().check({
          key: this.#head(ns, key),
          versionstamp: entry.versionstamp,
        });
        this.#indexes(op, ns, key, head, true);
        op.set(this.#head(ns, key), next);
        this.#indexes(op, ns, key, next, false);
        return (await op.commit()).ok ? { done: true, value: undefined } : { done: false };
      }, "denoKvCacheStore");
    }
  }

  async sweepPages(keep: string): Promise<number> {
    const kv = await this.#handle.db();
    const pages = await listAll(kv, { prefix: [...this.#p, "page"] });
    let swept = 0;
    for (const entry of pages) {
      const key = String(entry.key.at(-1));
      if (!key.startsWith(keep) && await this.#remove(kv, "page", key, entry)) swept++;
    }
    return swept;
  }

  /** Close the database when this store opened it. */
  close(): Promise<void> {
    return this.#handle.close();
  }
}

/**
 * A {@link CacheStore} on Deno KV, shared by every isolate using the database.
 *
 * @param options `kv` (an open `Deno.Kv`) or `path` (what to pass to `Deno.openKv`), a key
 *   `prefix` (default `["denext", "cache"]`), the caps and the sweep interval.
 * @returns A store for `cache.store` / {@linkcode setCacheStore}; `close()` closes a database it
 *   opened.
 * @throws {DenoKvUnsupportedError} When it must open a database and `Deno.openKv` is missing.
 */
export function denoKvCacheStore(
  options: DenoKvCacheStoreOptions = {},
): CacheStore & { close(): Promise<void> } {
  return new DenoKvCache(options);
}
