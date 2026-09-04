# Cache Components (`use cache` + PPR)

A minimal demo of Next.js 16 **Cache Components** on denext, a stable opt-in
enabled by top-level `cacheComponents: true` in
[`denext.config.ts`](./denext.config.ts) (the legacy
`experimental: { cacheComponents: true }` still works and warns in dev).

The single page renders in two lifetimes:

- **Static shell** — the page chrome plus a [`use cache`](./lib/data.ts) data
  helper (`getCachedStamp`). Its body runs **once** and is cached, so the
  timestamp it renders is stable across requests. The shell (with this island)
  is prerendered and cached in the page cache.
- **Dynamic hole** — a Suspense boundary wrapping a component that calls
  `connection()` (a dynamic signal). During the prerender it **postpones**,
  becoming a per-request hole; on every request it is re-rendered (a fresh
  `Date.now()`) and spliced into the cached shell.

So the first request is a cache `MISS` (the shell is rendered and cached); later
requests are `HIT`s that reuse the same shell while re-rendering only the hole —
visible in the `x-denext-cache` response header and the two timestamps on the
page.

## Run

```sh
deno task dev      # http://localhost:3000
# or
deno task build && deno task start
```

## How it works

- `use cache` is compiled (build-time, swc) into a cross-request server cache
  with `cacheLife`/`cacheTag`.
- A cacheable page (`export const revalidate = 60`) is prerendered to a
  request-independent shell; dynamic reads
  (`cookies()`/`headers()`/`connection()`) behind a Suspense boundary become
  holes filled per request.

See [KNOWN-LIMITATIONS.md](../../KNOWN-LIMITATIONS.md) (Cache Components
section) for the feature's documented bounds.
