# denext package & cache benchmarks — `@denext/photon` & `node:sqlite`

> Refreshed 2026-08-25 on an Intel i7-7700HQ, Deno 2.9.5. Single machine →
> **read the ratios, not the absolute times.** Reproduce:
>
> ```sh
> deno bench -A --config deno.json bench/packages/image_bench.ts
> deno bench -A --config deno.json bench/packages/cache_bench.ts
> ```

## `@denext/photon` vs the npm `@cf-wasm/photon` it replaces

Both wrap the **same photon-rs 0.3.3** Rust codec; `@denext/photon` is the
Deno-native `wasmbuild` build, `@cf-wasm/photon` the npm `wasm-pack` build.
Pipeline: decode a 256×256 PNG → resize to 128×128 (Lanczos3) → encode WebP
(denext's image optimizer path).

| Codec                              | time/iter | vs baseline      |
| ---------------------------------- | --------- | ---------------- |
| `@cf-wasm/photon` (npm, wasm-pack) | 7.1 ms    | baseline         |
| `@denext/photon` (JSR, wasmbuild)  | 8.2 ms    | **1.16× slower** |

**Verdict: parity, no correctness regression.** Output is **byte-identical**
(1508 B WebP from both) — same codec. The ~1.15× latency gap is a build-flag
difference (`wasm-pack --release` vs `wasmbuild`). An `opt-level=3` + LTO
rebuild was tried to close it and made **no meaningful difference** (within
run-to-run noise), so it was not adopted — `@denext/photon` stays on the default
build. In exchange denext gets a **zero-npm**, first-party codec it controls and
can rebuild against upstream CVEs.

## Durable cache — `node:sqlite` vs the in-memory default

A cache-store `getData`/`setData`, seeded with 200 entries. `getData` (a cache
hit) is the hot path — an ISR/page cache is read on every request, written only
on revalidation. The durable store is Deno's built-in **`node:sqlite`** (real,
native SQLite — no npm, no unstable flag); the in-memory default is ephemeral
(lost on restart).

| Store                          | getData (read hit) | setData (write) |
| ------------------------------ | ------------------ | --------------- |
| in-memory (default, ephemeral) | 385 ns             | 625 ns          |
| `node:sqlite` (durable file)   | 40 µs              | 145 µs          |

**Verdict: durability for microseconds, on a single node, with no unstable
flag.** In-memory is ~100× faster on reads and ~230× on writes — but it does not
survive a restart. `node:sqlite` buys persistence (and process-crash safety) for
a low-tens-of- microseconds read and ~150 µs write — comfortably under any
network or render cost in the request path.

`node:sqlite` is Deno's built-in binding to the C SQLite engine, so point
lookups are native B-tree index seeks (`WHERE key = ?` is an index `SEARCH`),
flat as the cache grows. It **replaced the former first-party `@denext/sqlite`
wasm codec**, and being native rather than wasm it is also faster on this same
benchmark (the wasm codec read at ~96 µs / wrote at ~210 µs). `sqliteCacheStore`
opens with `PRAGMA synchronous = NORMAL`: cache data is regenerable, so it
trades fsync-per-commit durability for throughput — a crash may lose the last
few writes but never corrupts the DB, and a broken cache file just degrades to
serving uncached.

For **multi-replica** deployments (e.g. Deno Deploy, where there is no durable
local disk), the default resolver falls back to the in-memory store per replica;
a cache shared across replicas (Redis, etc.) is a custom `CacheStore`
implementation.
