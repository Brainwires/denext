# caching — denext data cache & ISR

Demonstrates denext's Next.js-compatible caching primitives, none of which had
an example before.

## What it shows

- **`unstable_cache(fn, keyParts, { revalidate, tags })`** (`/data`) — wraps an
  expensive async loader in a cross-request cache with a TTL and tags. The
  cached "fetched at" timestamp stays stable across reloads (a HIT) next to a
  live render timestamp that changes every request.
- **`revalidateTag(tag)`** (`/api/revalidate`) — a native form POST purges the
  `products` tag; the next render re-runs the loader and the cached timestamp
  jumps.
- **ISR — `export const revalidate = 5`** (`/isr`) — opts the whole rendered
  page into the prod server's `PageCache`: served from cache within the window
  (`x-denext-cache: HIT`), regenerated in the background once stale
  (stale-while-revalidate).

## Cache store

The default store is a durable local SQLite file via Deno's built-in
**`node:sqlite`** (real SQLite), resolved automatically at startup with an
in-memory fallback. Override it with `setCacheStore(...)`:

- `sqliteCacheStore({ path })` — the durable single-node `node:sqlite` file (the
  default); bounded (FIFO eviction) and stale-while-revalidate, no unstable
  flag.
- a custom `CacheStore` (e.g. a Redis adapter) — to share one cache across
  instances.

## Run

```sh
# from this directory
deno task dev             # http://localhost:3000  (dev always renders fresh)
deno task build && deno task start   # ISR + data cache active
```

Note: ISR (`/isr`) only caches in **production** (`deno task start`). In dev,
pages always render fresh so you see your edits immediately.
