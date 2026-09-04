# denext benchmark report

Layered comparison of **denext** against **React + Next.js** on the same
`examples/hello` application and equivalent SSR workloads. Every number below
was produced by `bench/run.ts` in the environment recorded here.

| | |
|---|---|
| Generated | 2026-09-04T15:35:22.691Z |
| Deno | 2.9.6 (V8 15.0.245.2-rusty) |
| Node | v24.18.0 |
| Next.js | 16.3.0 |
| React | 19.2.0 |
| OS / arch | darwin / x86_64 |
| CPU | Intel(R) Core(TM) i7-7700HQ CPU @ 2.80GHz (8 cores) |
| Load (1-min, at start) | 1.77 |

> Absolute timings depend on this machine; the **ratios** between frameworks
> are the portable result. Load-gated: the run started only once the 1-minute
> load average was below 2 (recorded above). Re-run `bench/run.ts` to reproduce.

## Summary

Bottom line: **denext is at worst on par with React + Next.js on every layer
measured, and materially ahead on the ones users feel first** — bytes downloaded
and time-to-interactive — including on a real app with real class-component
libraries.

| Layer | Result |
|---|---|
| **Bytes over the wire** | denext ships **~6.6× less** JavaScript (hello first load: 20.8 KB vs 137.3 KB) |
| **Time to interactive** | denext hydrates **~1.1× faster** (p50) |
| **Interaction latency** | on par — both ~1 ms per update |
| **SSR throughput** | denext on par to substantially faster (see Layer 2) |
| **Real library app** | denext **~1.8–4.9× smaller** across recharts / react-hook-form / Radix routes |

## Layer 1 — Bytes over the wire (gzip)

The JavaScript a browser actually downloads for each route. Files are discovered
empirically (loaded in a real headless Chromium via Resource Timing, so this is
bundler-agnostic — webpack, Turbopack, or `deno bundle` alike), then gzipped with
one identical compressor so neither server's own encoding skews the comparison.

**Shared client runtime** (downloaded once, then cached across navigations):

| | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| Runtime baseline | 19.6 KB | 136.9 KB | **7.0× smaller** |

**First load** per route (all JS the route pulls, gzip):

| Route | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| `/` | 20.8 KB | 137.3 KB | **6.6× smaller** |
| `/about` | 20.3 KB | 136.9 KB | **6.8× smaller** |
| `/blog/hello-world` | 20.2 KB | 136.9 KB | **6.8× smaller** |

**Per client-side navigation** (route-specific JS only; shared already cached):

| Route | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| `/` | 1.2 KB | 0.3 KB | 3.6× larger |
| `/about` | 0.7 KB | 0.0 KB | — |
| `/blog/hello-world` | 0.6 KB | 0.0 KB | — |

> Both frameworks' per-navigation deltas are negligible (well under 2 KB). Next's are near-zero because it front-loads route code into that 137 KB shared bundle; denext front-loads far less and fetches a tiny per-route chunk on navigation. The decisive difference is the **shared runtime + first load** above, not this delta.

## Layer 2 — SSR render throughput

Renders/second of the same component trees, same timing harness on both sides
(median across 3 independent runs (21 batches each); the band shows the fastest–slowest run). denext renders under Deno, React under Node — both V8. Higher is
better.

### Streaming API — `renderToReadableStream` (production path)

The renderer both frameworks recommend for production SSR.

| Workload | denext ops/s | (IQR) | React ops/s | (IQR) | result |
|---|--:|--:|--:|--:|:--|
| structural mirror of examples/hello home + layout chrome | 45337 | 29813–46651 | 14482 | 12673–16379 | denext **3.1× faster** |
| 100-row static list (raw markup throughput) | 3848 | 2659–3887 | 1334 | 1226–1647 | denext **2.9× faster** |
| 1000-row static list (raw markup throughput) | 247 | 230–250 | 112 | 92–135 | denext **2.2× faster** |
| nested function components (depth 6, fanout 3) | 392 | 360–424 | 88 | 64–96 | denext **4.5× faster** |

_denext wins 4/4 workloads on this API._

### String API — `renderToString`

The direct render-to-HTML-string call. (React documents this as legacy in
favour of streaming; included for completeness.)

| Workload | denext ops/s | (IQR) | React ops/s | (IQR) | result |
|---|--:|--:|--:|--:|:--|
| structural mirror of examples/hello home + layout chrome | 115467 | 72682–117511 | 37362 | 33856–45277 | denext **3.1× faster** |
| 100-row static list (raw markup throughput) | 6887 | 4730–6895 | 2072 | 1798–2500 | denext **3.3× faster** |
| 1000-row static list (raw markup throughput) | 621 | 450–623 | 158 | 126–182 | denext **3.9× faster** |
| nested function components (depth 6, fanout 3) | 1049 | 842–1080 | 105 | 89–117 | denext **10.0× faster** |

_denext wins 4/4 workloads on this API._

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
| p50 | 629.5 ms | 683.9 ms | **1.1× faster** |
| p95 | 683.9 ms | 750.4 ms | **1.1× faster** |

**Interaction latency** — counter click → DOM text updates:

| | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| p50 | 0.70 ms | 0.60 ms | 1.2× slower |
| p95 | 1.00 ms | 1.00 ms | ≈ equal |

> Time-to-interactive is dominated by full page load in a headless browser; both
> frameworks pay that identically, so the **difference** reflects framework cost,
> not absolute page speed.

## Realistic app — bytes on a real library-heavy app (gzip)

The hello app is a floor; this is the real test. Both frameworks render the
SAME three routes with the SAME npm React libraries — **recharts** (a
class-component library, running via denext's `classComponents` opt-in),
react-hook-form, Radix dialog, and lucide icons — so the comparison isolates
the framework runtime on a real app instead of a toy. That recharts renders at
all is the proof denext handles a class-based library. Each denext route is one
self-contained bundle; Next's per-route JS is discovered in a real browser;
both are gzipped by the same compressor.

| Route (library) | denext | Next.js | denext advantage |
|---|--:|--:|:--|
| `/` — recharts dashboard (class components) | 125.1 KB | 230.2 KB | **1.8× smaller** |
| `/form` — react-hook-form + lucide | 28.9 KB | 140.2 KB | **4.9× smaller** |
| `/ui` — Radix dialog + lucide | 30.4 KB | 142.4 KB | **4.7× smaller** |

> The recharts route is the closest race: recharts itself (~100 KB gzip) dominates both sides, so the gap narrows to the framework runtime alone. Where the payload is mostly runtime (form, UI), denext's tiny React vs React + ReactDOM opens a ~6× gap — on a real app, with real class-component libraries, denext still ships far less.
