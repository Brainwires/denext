# denext benchmarks

A layered, reproducible comparison of **denext** against **React + Next.js**,
built to answer one question honestly: is denext at least on par, and where is
it ahead? Every layer runs the _same_ application (`examples/hello`) or
_equivalent_ workloads on both frameworks, and reports the ratio between them.

The latest results live in [`REPORT.md`](./REPORT.md).

> **denext itself has zero npm dependencies.** Everything under `bench/` that is
> not denext — React, Next.js, their `node_modules`, and any `.next` build — is
> benchmark-only tooling, git-ignored, and never published (see `deno.json`'s
> `publish.exclude`). Installing it here does not add a dependency to denext.

## The three layers

| Layer                       | What it measures                             | How                                                                                                                                 | Noise                 |
| --------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **1 — Bytes over the wire** | Compressed JS a browser downloads per route  | Load each route in headless Chromium, read Resource Timing to discover the files, gzip them from disk with one identical compressor | none (deterministic)  |
| **2 — SSR throughput**      | Renders/second of equivalent component trees | One portable timing harness; denext under Deno, React under Node (both V8); streaming + string APIs                                 | moderate (GC)         |
| **3 — Client runtime**      | Time-to-interactive and interaction latency  | Headless Chromium on each production build; the same `.on` hydration marker and counter drive both                                  | high (report p50/p95) |

**Run it on an idle machine.** `deno task bench` refuses to start while the 1-minute load
average is 2.0 or higher (it polls every 10 s, up to 30 min) — a run made behind a test
suite or a build depresses both frameworks' absolute numbers and pollutes the committed
baseline. `--max-load=N` changes the threshold; `--no-wait` skips the check (the load is
still recorded in the report's provenance table). Never commit a `REPORT.md` whose
"Load (1-min, at start)" is above 2.

Plus a **load & memory tier** (`load/run.ts`, run via `deno task bench:load`):
fires a high-volume burst of concurrent requests (default **5000** at
concurrency **100**) at each framework's production server and reports
**throughput** (req/s), **latency** (p50/p95/p99/max), **error rate**, and the
server process's **resident memory** (RSS, idle vs. peak-under-load). Each
server runs in its own process; the load generator lives in a separate process
and samples the server's RSS via `ps`, so the memory figure is the server's
alone. denext is always measured; Next.js is included when its fixture is built.
Tune with `BENCH_LOAD_TOTAL`, `BENCH_LOAD_CONCURRENCY`, `BENCH_LOAD_PATH`. This
tier is standalone (not part of `deno task bench`) since a saturating load run
is noisy and machine-specific.

Plus a **realistic-app tier** (`realapp/run.ts`): the three layers above run on
the tiny hello app (a floor); this tier re-measures bytes on two apps that
render the SAME real npm React libraries — recharts (a **class-component**
library, via denext's `classComponents` opt-in), react-hook-form, Radix dialog,
lucide — so the comparison holds on a real app, not a toy.

### Why these choices are fair

- **Same behavior, not same source.** denext ships its own React-equivalent, so
  the fixtures are built to render and hydrate identically (same routes, same
  interactivity boundaries, same `ssr:false` island), and are compared by
  observable behavior — not line-for-line code.
- **Bytes: bundler-agnostic discovery, uniform compression.** File discovery is
  empirical (what the browser actually fetches), so
  webpack/Turbopack/`deno
  bundle` internals don't matter. Compression is
  applied by _us_, identically, so neither server's own gzip setting skews the
  result.
- **SSR: one harness, native runtimes.** The identical measurement loop runs on
  each framework in the runtime it actually deploys to. Ratios are the result;
  absolute ns/op are machine-specific.
- **Runtime: one marker for both.** Both apps flip the same `.on` class when
  hydrated and drive the same counter, so the two are instrumented identically.

## Running it

Prerequisites: `deno`, `node`, and a one-time install + Next build.

```sh
# 1. install benchmark-only deps (React + Next.js + real libs) under bench/
cd bench && npm install && cd ..

# 2. build the Next.js hello fixture once (reused across runs)
cd bench/fixtures/next-hello && ../../node_modules/.bin/next build && cd ../../..

# 3. install the denext real-app's npm deps (esbuild resolves them from node_modules)
cd bench/fixtures/denext-app && \
  deno cache --allow-scripts --node-modules-dir=auto \
    npm:recharts@2.15.0 npm:react-hook-form@7.54.2 npm:lucide-react@0.469.0 \
    npm:@radix-ui/react-dialog@1.1.6 && cd ../../..

# 4. run all layers + the realistic-app tier and (re)generate REPORT.md
deno run -A --config deno.json bench/run.ts

# subsets and knobs:
deno run -A --config deno.json bench/run.ts --layers=1,3      # hello bytes + runtime only
deno run -A --config deno.json bench/run.ts --layers=real     # just the real-app tier
BENCH_SSR_RUNS=1 deno run -A --config deno.json bench/run.ts  # faster SSR (default 3 runs, aggregated)
```

Outputs:

- `bench/REPORT.md` — the human-readable report (overwritten each run).
- `bench/results/report-<timestamp>.md` — timestamped copies.
- `bench/results/raw-<timestamp>.json` — the raw measurements.

### Running a single layer directly

```sh
# Layer 1 + 3 (browser): serves both builds, drives headless Chromium
deno run -A --config deno.json bench/browser/run.ts

# Layer 2 (SSR): each side prints a JSON result array
deno run -A --config deno.json --v8-flags=--expose-gc bench/layer2-ssr/run-denext.ts
( cd bench/layer2-ssr && node --expose-gc run-react.mjs )
```

## Layout

```
bench/
  run.ts                 # orchestrator → REPORT.md
  lib/                   # provenance, portable microbench, gzip, serve, report
  browser/run.ts         # Layers 1 & 3 on the hello app (headless Chromium)
  layer2-ssr/            # Layer 2: shared workloads + per-framework runners
  realapp/run.ts         # Realistic-app tier: bytes on a real library-heavy app
  fixtures/next-hello/   # the like-for-like Next.js hello app
  fixtures/denext-app/   # real-library denext app (recharts/rhf/radix, classComponents)
  fixtures/next-real-app/# the matching Next.js real-library app
  results/               # timestamped reports + raw json (git-ignored)
```

(All fixtures' `node_modules`, `.next`, and `.denext` build output are
git-ignored.)

## Caveats (read before quoting a number)

- **Absolute numbers are machine-specific.** The provenance header pins the
  runtime versions and CPU; quote the **ratios**, and re-run to reproduce.
- **SSR has run-to-run variance.** Layer 2 reports medians with an interquartile
  range; treat direction and order of magnitude as the finding.
- **The nested-components SSR workload is a synthetic stress case.** It exposes
  a real super-linear slowdown in React's `renderToString` on deep
  function-component trees, but is not representative of everyday pages — the
  realistic-page and markup rows are.
- **Time-to-interactive is dominated by page load** in a headless browser; both
  frameworks pay that equally, so read the _difference_, not the absolute ms.
