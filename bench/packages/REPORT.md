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
| `@denext/sqlite` (durable file) | 491 µs             | 12.3 ms         |

**Verdict: slower than KV, but durable on a single node with no unstable flag.**
`@denext/sqlite` reads are ~6× slower than KV and writes ~35× slower. What the
numbers don't show is the point of it: it **survives process restarts**
(in-memory does not) and needs **no `--unstable-kv`** (unlike Deno KV), as a
first-party zero-npm dependency. For self-hosted single-node deployments — where
writes are infrequent (revalidation) and reads dominate — a ~0.5 ms durable read
is well within budget behind a page render.

Note: the 12 ms write is dominated by the **store adapter**, not the engine —
`sqliteCacheStore` re-indexes tags on every `setData` (`reindexTags`), which is
O(rows). That's a denext-side optimization target (batch/incremental tag
indexing), tracked separately from the `@denext/sqlite` package itself.
