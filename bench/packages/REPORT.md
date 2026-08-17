# First-party package benchmarks — `@denext/photon` & `@denext/sqlite`

> Load-gated run (1-min load average `1.91` at finish), 2026-08-17. Machine:
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
| in-memory (default, ephemeral)  | 387 ns             | 540 ns          |
| Deno KV (`--unstable-kv`)       | 81 µs              | 357 µs          |
| `@denext/sqlite` (durable file) | 505 µs             | 1.5 ms          |

**Verdict: still slower than KV, but durable on a single node with no unstable
flag — and writes are now ~8× cheaper.** `sqliteCacheStore` opens with
`PRAGMA synchronous = NORMAL` (added to rsqlite-wasm in 0.1.3): cache data is
regenerable, so it trades fsync-per-commit durability for the skip. That cut the
`setData` cost from **~12.3 ms → 1.5 ms** (~8×), narrowing the gap to Deno KV from
~35× to ~4×. Reads stay ~505 µs (≈6× slower than KV, dominated by the wasm query
round-trip). For a read-heavy, write-rare page cache on a single self-hosted node,
that's comfortably behind a render — and it needs **no `--unstable-kv`**. A crash
may lose the last few writes but not corrupt the DB, and a broken cache file just
degrades to serving uncached.

Note: the pre-pragma ~12.3 ms write cost was the **per-commit fsync** in the
node:fs VFS — proven by an in-memory DB writing in 0.36 ms vs 11.5 ms on file —
not the store's tag indexing. (A raw single-`INSERT` commit loop under NORMAL hits
~0.2 ms; the store's 1.5 ms is that plus its per-write delete + re-insert + tag
bookkeeping over a seeded table.)
