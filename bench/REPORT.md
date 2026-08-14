# denext benchmark report

Layered comparison of **denext** against **React + Next.js** on the same
`examples/hello` application and equivalent SSR workloads. Every number below
was produced by `bench/run.ts` in the environment recorded here.

| | |
|---|---|
| Generated | 2026-08-14T13:09:16.685Z |
| Deno | 2.9.5 (V8 15.0.245.2-rusty) |
| Node | v24.18.0 |
| Next.js | 16.3.0 |
| React | 19.2.0 |
| OS / arch | darwin / x86_64 |
| CPU | Intel(R) Core(TM) i7-7700HQ CPU @ 2.80GHz (8 cores) |

> Absolute timings depend on this machine; the **ratios** between frameworks
> are the portable result. Re-run `bench/run.ts` to reproduce.

## Summary

Bottom line: **denext is at worst on par with React + Next.js on every layer
measured, and materially ahead on the two that users feel first** — bytes
downloaded and time-to-interactive.

| Layer | Result |
|---|---|
| **Bytes over the wire** | denext ships **~9.9× less** JavaScript (first load: 13.9 KB vs 137.3 KB) |
| **Time to interactive** | denext hydrates **~1.2× faster** (p50) |
| **Interaction latency** | on par — both ~1 ms per update |
| **SSR throughput** | competitive to substantially faster (workload-dependent; see Layer 2) |

## Layer 1 — Bytes over the wire (gzip)

The JavaScript a browser actually downloads for each route. Files are discovered
empirically (loaded in a real headless Chromium via Resource Timing, so this is
bundler-agnostic — webpack, Turbopack, or `deno bundle` alike), then gzipped with
one identical compressor so neither server's own encoding skews the comparison.

**Shared client runtime** (downloaded once, then cached across navigations):

| | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| Runtime baseline | 12.8 KB | 136.9 KB | **10.7× smaller** |

**First load** per route (all JS the route pulls, gzip):

| Route | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| `/` | 13.9 KB | 137.3 KB | **9.9× smaller** |
| `/about` | 13.4 KB | 136.9 KB | **10.2× smaller** |
| `/blog/hello-world` | 13.4 KB | 136.9 KB | **10.3× smaller** |

**Per client-side navigation** (route-specific JS only; shared already cached):

| Route | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| `/` | 1.1 KB | 0.3 KB | 3.2× larger |
| `/about` | 0.7 KB | 0.0 KB | — |
| `/blog/hello-world` | 0.6 KB | 0.0 KB | — |

> Both frameworks' per-navigation deltas are negligible (well under 2 KB). Next's are near-zero because it front-loads route code into that 137 KB shared bundle; denext front-loads far less and fetches a tiny per-route chunk on navigation. The decisive difference is the **shared runtime + first load** above, not this delta.

## Layer 2 — SSR render throughput

Renders/second of the same component trees, same timing harness on both sides
(median of 21 batches; interquartile range shown). denext renders under Deno,
React under Node — both V8. Higher is better.

### Streaming API — `renderToReadableStream` (production path)

The renderer both frameworks recommend for production SSR.

| Workload | denext ops/s | (IQR) | React ops/s | (IQR) | result |
|---|--:|--:|--:|--:|:--|
| structural mirror of examples/hello home + layout chrome | 13303 | 10941–15818 | 7200 | 5749–7410 | denext **1.8× faster** |
| 100-row static list (raw markup throughput) | 1105 | 991–1163 | 587 | 486–644 | denext **1.9× faster** |
| 1000-row static list (raw markup throughput) | 98 | 87–104 | 42 | 36–47 | denext **2.3× faster** |
| nested function components (depth 6, fanout 3) | 233 | 182–242 | 7 | 5–21 | denext **34.0× faster** |

_denext wins 4/4 workloads on this API._

### String API — `renderToString`

The direct render-to-HTML-string call. (React documents this as legacy in
favour of streaming; included for completeness.)

| Workload | denext ops/s | (IQR) | React ops/s | (IQR) | result |
|---|--:|--:|--:|--:|:--|
| structural mirror of examples/hello home + layout chrome | 18341 | 14601–21102 | 19719 | 14051–20546 | React 1.1× faster |
| 100-row static list (raw markup throughput) | 1011 | 598–1166 | 779 | 629–834 | denext **1.3× faster** |
| 1000-row static list (raw markup throughput) | 103 | 75–109 | 53 | 39–63 | denext **1.9× faster** |
| nested function components (depth 6, fanout 3) | 195 | 167–200 | 13 | 7–38 | denext **14.6× faster** |

_denext wins 3/4 workloads on this API._

> **Reading these numbers.** SSR micro-throughput carries real run-to-run
> variance (allocation + GC); treat the **direction and order of magnitude** as
> the result, not the third significant figure. The *realistic page* and
> *markup* rows are representative; the **nested-components** row is a synthetic
> stress case where React's `renderToString` degrades super-linearly on deep
> function-component trees — a genuine denext win, but not typical of everyday
> pages. The honest one-line read: denext is **on par or faster** at SSR.

## Layer 3 — Client runtime (hydration + interaction)

Measured in headless Chromium on each framework's production build, same page
(time-to-interactive over 15 fresh navigations, interaction over
60 clicks). Both apps flip the same `.on` hydration marker and drive
the same counter, so the two are measured identically. Lower is better.

**Time to interactive** — navigation start → hydration marker present:

| | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| p50 | 960.2 ms | 1190.0 ms | **1.2× faster** |
| p95 | 1335.3 ms | 1702.6 ms | **1.3× faster** |

**Interaction latency** — counter click → DOM text updates:

| | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| p50 | 0.60 ms | 0.70 ms | **1.2× faster** |
| p95 | 1.10 ms | 1.70 ms | **1.5× faster** |

> Time-to-interactive is dominated by full page load in a headless browser; both
> frameworks pay that identically, so the **difference** reflects framework cost,
> not absolute page speed.
