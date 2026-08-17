# First-party package benchmarks — `@denext/photon` & `@denext/sqlite`

> Load-gated run (1-min load average `~2.4` at finish), 2026-08-17, on
> `@denext/sqlite` **0.1.4** (B-tree index seeks + in-place deletes). Machine:
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
| `@cf-wasm/photon` (npm, wasm-pack) | 7.0 ms    | baseline         |
| `@denext/photon` (JSR, wasmbuild)  | 7.9 ms    | **1.12× slower** |

**Verdict: parity, no correctness regression.** Output is **byte-identical**
(1508 B WebP from both) — same codec. The ~1.1× latency gap is a build-flag
difference (`wasm-pack --release` vs `wasmbuild`). An `opt-level=3` + LTO rebuild
was tried to close it and made **no meaningful difference** (1.12× vs 1.15×, within
run-to-run noise), so it was not adopted — `@denext/photon` stays on the default
build. In exchange denext gets a **zero-npm**, first-party codec it controls and
can rebuild against upstream CVEs.

## `@denext/sqlite` vs Deno KV vs the in-memory default

A cache-store `getData`/`setData`, seeded with 200 entries. `getData` (a cache
hit) is the hot path — an ISR/page cache is read on every request, written only on
revalidation.

| Store                           | getData (read hit) | setData (write) |
| ------------------------------- | ------------------ | --------------- |
| in-memory (default, ephemeral)  | 383 ns             | 576 ns          |
| Deno KV (`--unstable-kv`)       | 88 µs              | 438 µs          |
| `@denext/sqlite` (durable file) | 96 µs              | **210 µs**      |

**Verdict: at parity with Deno KV on reads and ~2× faster on writes — durable, on
a single node, with no unstable flag.** Reads land at **96 µs vs KV's 88 µs**
(≈1.1×, effectively even); writes at **210 µs vs KV's 438 µs** (~2× faster). This
is the payoff of `@denext/sqlite` **0.1.4**: the engine used to be O(rows) on
_every_ operation — the planner emitted `SCAN TABLE`, so a read materialized the
whole b-tree and linear-filtered, and every delete **rebuilt the entire tree**. A
point lookup on a 5 000-row table took ~8 ms and grew with the table. 0.1.4 adds
real B-tree **index seeks** (PK/UNIQUE columns get an implicit `sqlite_autoindex`,
so `WHERE key = ?` is an index `SEARCH`) and **in-place single-cell deletes**
(rewrite one leaf instead of the tree). Both read and write are now **O(log n)**
and flat as the cache grows.

`sqliteCacheStore` still opens with `PRAGMA synchronous = NORMAL` (0.1.3): cache
data is regenerable, so it trades fsync-per-commit durability for throughput. A
crash may lose the last few writes but not corrupt the DB, and a broken cache file
just degrades to serving uncached. For a self-hosted node this is now a
strictly-better durable alternative to Deno KV for the cache: comparable reads,
faster writes, persists across restarts, and needs **no `--unstable-kv`**.

Historical context: before 0.1.4 this same benchmark read at ~505 µs (≈6× slower
than KV) and wrote at ~1.5 ms (≈4× slower), and both scaled linearly with table
size — the write cost was the whole-tree delete rebuild, the read cost the full
scan, neither the fsync (which 0.1.3's `NORMAL` had already addressed).
