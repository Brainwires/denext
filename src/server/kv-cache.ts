// A Deno KV-backed {@link CacheStore}, so ISR renders and cached data are shared
// across replicas and `revalidateTag`/`revalidatePath` reach every instance.
//
//   import { setCacheStore } from "denext/server";
//   import { denoKvCacheStore } from "denext/server";
//   setCacheStore(denoKvCacheStore());   // requires --unstable-kv
//
// Entries live under stable prefixes ([ "denext", "data"|"page", key ]). Tag and
// path indexes ([ "denext", "tag", … ] / [ "denext", "pathidx", … ]) let
// invalidation `list` the affected keys instead of scanning the whole store.
// Native KV TTLs (`expireIn`) handle expiry; a passive `expiresAt` check guards
// the eventual-consistency window. Invalidation is best-effort: an overwritten
// entry may leave a stale index marker, which at worst causes mild
// over-invalidation (safe for a cache), never a stale read.

import type { CachedPage, CacheStore, DataEntry } from "./cache.ts";

const PREFIX = "denext";

/**
 * A {@link CacheStore} backed by Deno KV. Pass an open {@linkcode Deno.Kv}
 * handle, or omit it to lazily open the default store on first use (which
 * requires the `--unstable-kv` flag). Share one KV across replicas — via the
 * same path or a Deno Deploy database — so a render or data entry produced on
 * one instance is served by another.
 *
 * @param kv An open Deno KV handle; omitted, the default store is opened lazily.
 * @returns A store to pass to {@linkcode setCacheStore}.
 */
export function denoKvCacheStore(kv?: Deno.Kv): CacheStore {
  let handle: Promise<Deno.Kv> | undefined = kv ? Promise.resolve(kv) : undefined;

  const getKv = (): Promise<Deno.Kv> => {
    if (handle) return handle;
    const open = (Deno as { openKv?: (path?: string) => Promise<Deno.Kv> }).openKv;
    if (typeof open !== "function") {
      return Promise.reject(
        new Error(
          "denext: Deno KV is unavailable. Enable it with the --unstable-kv flag " +
            "(or a Deno build that includes KV), or pass a Deno.Kv handle to denoKvCacheStore().",
        ),
      );
    }
    handle = open();
    return handle;
  };

  const dataKey = (k: string): Deno.KvKey => [PREFIX, "data", k];
  const pageKey = (k: string): Deno.KvKey => [PREFIX, "page", k];
  const tagKey = (tag: string, ns: string, k: string): Deno.KvKey => [PREFIX, "tag", tag, ns, k];
  const pathKey = (path: string, k: string): Deno.KvKey => [PREFIX, "pathidx", path, k];

  // KV expireIn is ms-from-now; Infinity means no TTL.
  const ttlOpts = (expiresAt: number): { expireIn?: number } => {
    if (expiresAt === Infinity) return {};
    return { expireIn: Math.max(0, expiresAt - Date.now()) };
  };

  // Treat an expired entry as a miss even if KV hasn't reaped it yet.
  const fresh = <T extends { expiresAt: number }>(v: T | null): T | undefined => {
    if (!v) return undefined;
    if (v.expiresAt !== Infinity && v.expiresAt <= Date.now()) return undefined;
    return v;
  };

  return {
    async getData(key) {
      const kvh = await getKv();
      const res = await kvh.get<DataEntry>(dataKey(key));
      return fresh(res.value);
    },

    async setData(key, entry) {
      const kvh = await getKv();
      const opts = ttlOpts(entry.expiresAt);
      let atomic = kvh.atomic().set(dataKey(key), entry, opts);
      for (const tag of entry.tags) atomic = atomic.set(tagKey(tag, "data", key), key, opts);
      await atomic.commit();
    },

    async getPage(key) {
      const kvh = await getKv();
      const res = await kvh.get<CachedPage>(pageKey(key));
      return fresh(res.value);
    },

    async setPage(key, page) {
      const kvh = await getKv();
      const opts = ttlOpts(page.expiresAt);
      let atomic = kvh.atomic()
        .set(pageKey(key), page, opts)
        .set(pathKey(page.path, key), key, opts);
      for (const tag of page.tags) atomic = atomic.set(tagKey(tag, "page", key), key, opts);
      await atomic.commit();
    },

    async deleteByTag(tag) {
      const kvh = await getKv();
      // Index key shape: [PREFIX, "tag", tag, ns, key]; value is the entry key.
      for await (const marker of kvh.list<string>({ prefix: [PREFIX, "tag", tag] })) {
        const ns = String(marker.key[3]);
        const k = marker.value;
        await kvh.delete(ns === "page" ? pageKey(k) : dataKey(k));
        await kvh.delete(marker.key);
      }
    },

    async deleteByPath(path) {
      const kvh = await getKv();
      for await (const marker of kvh.list<string>({ prefix: [PREFIX, "pathidx", path] })) {
        await kvh.delete(pageKey(marker.value));
        await kvh.delete(marker.key);
      }
    },
  };
}
