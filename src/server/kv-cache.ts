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
// the eventual-consistency window. Overwriting an entry cleans up markers it no
// longer carries (so re-tagging a non-TTL entry can't leak index keys). Explicit
// `deleteByTag`/`deleteByPath` may still leave the entry's OTHER markers behind,
// which at worst causes mild over-invalidation (safe for a cache), never a stale
// read — those markers carry the entry key, so they never mis-delete a sibling.

import type { CachedPage, CacheStore, DataEntry } from "./cache.ts";

const PREFIX = "denext";

/** Deno KV's hard per-value size limit (64 KiB). A larger value can't be stored. */
const KV_MAX_VALUE_BYTES = 64 * 1024;

// Throttled warnings so a recurring KV write problem (a too-large page, a sustained
// atomic conflict) surfaces without flooding stdout.
let lastKvWarn = 0;
function warnKv(msg: string): void {
  const t = Date.now();
  if (t - lastKvWarn < 1000) return;
  lastKvWarn = t;
  console.warn(`denext: KV cache — ${msg}`);
}

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
      // An already-expired entry maps to expireIn ≤ 0 — nothing worth storing.
      if (entry.expiresAt !== Infinity && entry.expiresAt <= Date.now()) return;
      const kvh = await getKv();
      const opts = ttlOpts(entry.expiresAt);
      let atomic = kvh.atomic().set(dataKey(key), entry, opts);
      // Overwrite: drop tag markers for tags this entry no longer carries, so a
      // non-TTL entry that is repeatedly re-tagged can't leak orphaned markers.
      const prev = (await kvh.get<DataEntry>(dataKey(key))).value;
      if (prev) {
        for (const old of prev.tags) {
          if (!entry.tags.includes(old)) atomic = atomic.delete(tagKey(old, "data", key));
        }
      }
      for (const tag of entry.tags) atomic = atomic.set(tagKey(tag, "data", key), key, opts);
      // A failed atomic commit (a concurrent write conflict) silently drops the
      // write — surface it so a persistent conflict is visible, not invisible.
      const res = await atomic.commit();
      if (!res.ok) warnKv(`data set for "${key}" was not committed (atomic conflict)`);
    },

    async getPage(key) {
      const kvh = await getKv();
      const res = await kvh.get<CachedPage>(pageKey(key));
      return fresh(res.value);
    },

    async setPage(key, page) {
      // Already-expired → nothing worth storing (expireIn would be ≤ 0).
      if (page.expiresAt !== Infinity && page.expiresAt <= Date.now()) return;
      // Skip a body that clearly can't fit KV's per-value limit rather than letting
      // the commit throw an opaque error (approximate: the serialized value adds
      // some overhead, but a body already over the limit definitely won't fit).
      if (page.body.length + (page.csp?.length ?? 0) > KV_MAX_VALUE_BYTES) {
        warnKv(`page "${key}" exceeds the ${KV_MAX_VALUE_BYTES}-byte value limit — not cached`);
        return;
      }
      const kvh = await getKv();
      const opts = ttlOpts(page.expiresAt);
      let atomic = kvh.atomic()
        .set(pageKey(key), page, opts)
        .set(pathKey(page.path, key), key, opts);
      // Overwrite: drop markers this entry no longer carries (stale tags, or an
      // old path if the pathname changed) to keep the index bounded.
      const prev = (await kvh.get<CachedPage>(pageKey(key))).value;
      if (prev) {
        if (prev.path !== page.path) atomic = atomic.delete(pathKey(prev.path, key));
        for (const old of prev.tags) {
          if (!page.tags.includes(old)) atomic = atomic.delete(tagKey(old, "page", key));
        }
      }
      for (const tag of page.tags) atomic = atomic.set(tagKey(tag, "page", key), key, opts);
      const res = await atomic.commit();
      if (!res.ok) warnKv(`page set for "${key}" was not committed (atomic conflict)`);
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
