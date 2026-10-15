/**
 * What denext's Deno KV stores ({@linkcode denoKvCacheStore}, {@linkcode denoKvSessionStore},
 * {@linkcode denoKvRateLimitStore}) need from a `Deno.Kv`, and how they open one.
 *
 * The types are a structural subset of `Deno.Kv`, so a store type-checks without the unstable
 * KV types and any `Deno.Kv` (`await Deno.openKv()`, a remote one from `Deno.openKv(url)`, or
 * an in-memory one from `Deno.openKv(":memory:")`) can be passed as `kv`. Opening one needs
 * `--unstable-kv` (or `"unstable": ["kv"]` in `deno.json`) outside Deno Deploy.
 *
 * @module
 */

import { inRootContext } from "./root-context.ts";

/** One part of a KV key. */
export type KvKeyPart = string | number | bigint | boolean | Uint8Array;

/** A KV key. */
export type KvKey = readonly KvKeyPart[];

/** An entry as KV returns it (`versionstamp` is `null` when the key is absent). */
export interface KvEntryLike {
  /** The key. */
  readonly key: readonly unknown[];
  /** The value, or `null` when absent. */
  readonly value: unknown;
  /** The entry's version, or `null` when absent. */
  readonly versionstamp: string | null;
}

/** The atomic-operation subset the stores use. */
export interface KvAtomicLike {
  /** Fail the commit unless `key`'s version is still `versionstamp`. */
  check(...checks: { key: KvKey; versionstamp: string | null }[]): KvAtomicLike;
  /** Write a value (`expireIn`: ms after which KV may delete it). */
  set(key: KvKey, value: unknown, options?: { expireIn?: number }): KvAtomicLike;
  /** Delete a key. */
  delete(key: KvKey): KvAtomicLike;
  /** Commit; `ok` is `false` when a check failed. */
  commit(): Promise<{ ok: boolean }>;
}

/** The `Deno.Kv` subset the stores use. */
export interface KvLike {
  /** Read one key. */
  get(key: KvKey): Promise<KvEntryLike>;
  /** Read up to 10 keys at once. */
  getMany(keys: KvKey[]): Promise<KvEntryLike[]>;
  /** List entries by prefix or range. */
  list(
    selector:
      | { prefix: KvKey }
      | { prefix: KvKey; start: KvKey }
      | { prefix: KvKey; end: KvKey }
      | {
        start: KvKey;
        end: KvKey;
      },
    options?: { limit?: number; reverse?: boolean },
  ): AsyncIterable<KvEntryLike>;
  /** Start an atomic operation. */
  atomic(): KvAtomicLike;
  /** Close the database. */
  close(): void;
}

/** Options shared by the Deno KV stores: a database of your own, or a path to open one. */
export interface DenoKvConnectionOptions {
  /** An open `Deno.Kv` the app owns (the store never closes it). */
  kv?: KvLike;
  /**
   * What to pass to `Deno.openKv` (a file path, a remote KV URL, or `":memory:"`) when the
   * store opens its own database. With neither `kv` nor `path`: Deno's default database (the
   * project's on Deno Deploy).
   */
  path?: string;
  /** Key prefix, so several apps (or stores) share one database. Each store has a default. */
  prefix?: KvKey;
}

/** Thrown when this Deno has no `Deno.openKv` (outside Deno Deploy without `--unstable-kv`). */
export class DenoKvUnsupportedError extends Error {
  /** Always `"unsupported"`. */
  readonly code = "unsupported";

  /**
   * Create the error.
   *
   * @param feature The store that needed KV.
   */
  constructor(feature: string) {
    super(
      `${feature}: Deno KV is not available in this runtime. Run with --unstable-kv (or add ` +
        `"unstable": ["kv"] to deno.json), or pass an open database as \`kv\`.`,
    );
    this.name = "DenoKvUnsupportedError";
  }
}

/** How many commit attempts an optimistic update makes before it gives up. */
const MAX_ATTEMPTS = 32;

/**
 * Run an optimistic read-check-write until its commit lands.
 *
 * @param attempt One try: returns `{ ok }` from a commit, or a value to stop with.
 * @param feature The store, for the error.
 * @returns The first attempt's result that was not a failed commit.
 * @throws {Error} After {@link MAX_ATTEMPTS} conflicting commits.
 */
export async function retryCommit<T>(
  attempt: () => Promise<{ done: true; value: T } | { done: false }>,
  feature: string,
): Promise<T> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const result = await attempt();
    if (result.done) return result.value;
  }
  throw new Error(`${feature}: gave up after ${MAX_ATTEMPTS} conflicting writes`);
}

/** A store's database handle: opened on first use when the store owns it. */
export interface KvHandle {
  /** The open database. */
  db(): Promise<KvLike>;
  /** Close it when the store opened it (idempotent). */
  close(): Promise<void>;
}

/**
 * The store's database handle.
 *
 * @param options The store's options.
 * @param feature The store's name, for errors.
 * @returns A lazy handle.
 * @throws {TypeError} When both `kv` and `path` are given.
 * @throws {DenoKvUnsupportedError} When the store must open a database and this Deno can't.
 */
export function kvHandle(options: DenoKvConnectionOptions, feature: string): KvHandle {
  if (options.kv && options.path !== undefined) {
    throw new TypeError(`${feature}: pass either \`kv\` or \`path\`, not both`);
  }
  if (options.kv) {
    const kv = options.kv;
    return { db: () => Promise.resolve(kv), close: () => Promise.resolve() };
  }
  const open = (Deno as unknown as { openKv?: (path?: string) => Promise<KvLike> }).openKv;
  if (typeof open !== "function") throw new DenoKvUnsupportedError(feature);
  let opened: Promise<KvLike> | undefined;
  let closed = false;
  return {
    db() {
      if (closed) return Promise.reject(new Error(`${feature}: the store is closed`));
      // Shared by every request, so opened in the root context (see root-context.ts).
      opened ??= inRootContext(() => open.call(Deno, options.path));
      return opened;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (opened) (await opened).close();
    },
  };
}

/**
 * Every entry under a selector, collected.
 *
 * @param kv The database.
 * @param selector What to list.
 * @returns The entries.
 */
export async function listAll(
  kv: KvLike,
  selector: Parameters<KvLike["list"]>[0],
): Promise<KvEntryLike[]> {
  const entries: KvEntryLike[] = [];
  for await (const entry of kv.list(selector)) entries.push(entry);
  return entries;
}
