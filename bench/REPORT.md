# denext benchmark report

Layered comparison of **denext** against **React + Next.js** on the same
`examples/hello` application (and, for bytes, the unmodified Next app migrated onto denext) and equivalent SSR workloads. Every number below
was produced by `bench/run.ts` in the environment recorded here.

| | |
|---|---|
| Generated | 2026-10-23T00:13:24.359Z |
| Deno | 3.0.0-rc.3 (V8 15.0.245.2-rusty) |
| Node | v24.18.0 |
| Next.js | 16.4.2 |
| React | 19.3.1 |
| OS / arch | darwin / x86_64 |
| CPU | Intel(R) Core(TM) i7-7700HQ CPU @ 2.80GHz (8 cores) |
| Load (1-min, at start) | 256.16 |

> The machine was loaded (1-minute load above), so this run is **bytes-only**: file
> sizes are deterministic and unaffected by load, but no timing is reported.
> Re-run `bench/run.ts` to reproduce.

## Summary

Bottom line: **denext ships materially less JavaScript than React + Next.js** —
on the hello app, on the same Next app migrated onto denext, and on a real app
with real class-component libraries.

| Layer | Result |
|---|---|
| **Bytes over the wire** | denext ships **~5.5× less** JavaScript (hello first load: 25.4 KB vs 139.2 KB) |
| **Same Next app, migrated** | first load of `/` 32.1 KB gz on denext vs 139.2 KB on Next.js (**4.3× less**) |
| **Real library app** | denext **~1.7–3.4× smaller** across recharts / react-hook-form / Radix routes |

## Layer 1 — Bytes over the wire (raw and gzip)

The JavaScript a browser actually downloads for each route. Files are discovered
empirically (loaded in a real headless Chromium via Resource Timing, so this is
bundler-agnostic — webpack, Turbopack, or `deno bundle` alike), then measured from
disk: raw bytes, and gzip with one identical compressor so no server's own encoding
skews the comparison. Three builds are compared:

- **denext (native)** — `examples/hello`, written against `denext`.
- **Next app on denext (migrated)** — the unmodified `bench/fixtures/next-hello` Next.js
  app, run through `denext migrate` (imports unchanged, aliased) and built and served by denext.
- **Next.js** — the same `bench/fixtures/next-hello` app built and served by Next.js.

**Shared client runtime** (JS loaded on every route, then cached across navigations):

| | denext (native) | Next app on denext (migrated) | Next.js |
|---|--:|--:|--:|
| Shared runtime | 63.1 KB raw · 23.9 KB gz | 69.2 KB raw · 27.1 KB gz | 459.1 KB raw · 138.8 KB gz |

**First load** per route (all JS the route pulls):

| | denext (native) | Next app on denext (migrated) | Next.js |
|---|--:|--:|--:|
| `/` | 65.5 KB raw · 25.4 KB gz | 79.1 KB raw · 32.1 KB gz | 459.5 KB raw · 139.2 KB gz |
| `/about` | 64.5 KB raw · 24.8 KB gz | 69.2 KB raw · 27.1 KB gz | 459.1 KB raw · 138.8 KB gz |
| `/blog/hello-world` | 64.4 KB raw · 24.7 KB gz | 69.2 KB raw · 27.1 KB gz | 459.1 KB raw · 138.8 KB gz |

**Per client-side navigation** (route-specific JS only; shared already cached):

| | denext (native) | Next app on denext (migrated) | Next.js |
|---|--:|--:|--:|
| `/` | 2.4 KB raw · 1.4 KB gz | 9.9 KB raw · 5.0 KB gz | 0.4 KB raw · 0.3 KB gz |
| `/about` | 1.5 KB raw · 0.8 KB gz | 0.0 KB raw · 0.0 KB gz | 0.0 KB raw · 0.0 KB gz |
| `/blog/hello-world` | 1.4 KB raw · 0.7 KB gz | 0.0 KB raw · 0.0 KB gz | 0.0 KB raw · 0.0 KB gz |

> Per-navigation deltas are small on every build (a few KB at most). The decisive difference is the **shared runtime + first load** above, not this delta.

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
| `/` — recharts dashboard (class components) | 139.1 KB | 232.7 KB | **1.7× smaller** |
| `/form` — react-hook-form + lucide | 41.4 KB | 142.5 KB | **3.4× smaller** |
| `/ui` — Radix dialog + lucide | 44.7 KB | 144.6 KB | **3.2× smaller** |

> The recharts route is the closest race: recharts itself (~100 KB gzip) dominates both sides, so the gap narrows to the framework runtime alone. Where the payload is mostly runtime (form, UI), denext's tiny React vs React + ReactDOM opens a ~3× gap — on a real app, with real class-component libraries, denext still ships far less.

## Layers not re-run in this report

2 (SSR throughput) and 3 (client runtime) were not run here: timings are only valid on a quiet machine (1-minute load < 2) and this
run was bytes-only. The last full timing run is in `bench/results/` (2026-09-04, Next.js 16.3.0).
