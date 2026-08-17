# First-party package benchmarks — `@denext/photon` & `@denext/sqlite`

> Load-gated run (1-min load average `1.69` at start), 2026-08-17. Machine:
> Intel i7-7700HQ, Deno 2.9.5. Single machine → **read the ratios, not the
> absolute times.** Reproduce:
>
> ```sh
> deno bench -A --unstable-kv --config deno.json bench/packages/cache_bench.ts
> deno bench -A --config deno.json bench/packages/image_bench.ts
> ```

## `@denext/photon` vs the npm `@cf-wasm/photon` it replaces

Both wrap the **same photon-rs 0.3.3** Rust codec; `@denext/photon` is the
Deno-native `wasmbuild` build, `@cf-wasm/photon` the npm `wasm-pack` build.
Pipeline: decode a 256×256 PNG → resize to 128×128 (Lanczos3) → encode WebP
(denext's image optimizer path).

| Codec                              | time/iter | vs baseline      |
| ---------------------------------- | --------- | ---------------- |
| `@cf-wasm/photon` (npm, wasm-pack) | 6.9 ms    | baseline         |
| `@denext/photon` (JSR, wasmbuild)  | 8.0 ms    | **1.15× slower** |

**Verdict: parity, no correctness regression.** Output is **byte-identical**
(1508 B WebP from both). The ~15% latency gap is a build-flag difference
(`wasm-pack --release` vs `wasmbuild`'s wasm-opt defaults), not a code
difference — a candidate for a later wasm-opt tune. In exchange denext gets a
**zero-npm**, first-party codec it controls and can rebuild against upstream
CVEs.

## `@denext/sqlite` vs Deno KV vs the in-memory default

A cache-store `getData`/`setData`, seeded with 200 entries. `getData` (a cache
hit) is the hot path — an ISR/page cache is read on every request, written only
on revalidation.

| Store                           | getData (read hit) | setData (write) |
| ------------------------------- | ------------------ | --------------- |
| in-memory (default, ephemeral)  | 362 ns             | 537 ns          |
| Deno KV (`--unstable-kv`)       | 80 µs              | 356 µs          |
| `@denext/sqlite` (durable file) | 491 µs             | ~0.2 ms         |

**Verdict: durable on a single node, no unstable flag, and writes now on par with
KV.** `sqliteCacheStore` opens the DB with `PRAGMA synchronous = NORMAL` (added to
rsqlite-wasm in 0.1.3). Cache data is regenerable, so it trades fsync-per-commit
durability for a **~50× write speedup** (~11.3 ms → ~0.2 ms in a commit-per-write
loop, from a focused measurement) — now faster than Deno KV's 356 µs. Reads stay
~491 µs (≈6× slower than KV, dominated by the wasm query round-trip); for a
read-heavy page cache that sits comfortably behind a render. A crash may lose the
last few writes but not corrupt the DB, and a broken cache file just degrades to
serving uncached.

Note (superseded): an earlier run put writes at ~12 ms. That cost was the
**per-commit fsync** in the node:fs VFS — proven by an in-memory DB writing in
0.36 ms vs 11.5 ms on file — not the store's tag indexing. `PRAGMA synchronous =
NORMAL` skips that fsync. (A full load-gated refresh of the write row is pending.)
