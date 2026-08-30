# @denext/pages-router — benchmark report

_Generated 2026-08-18T13:17:48.661Z_

**Machine:** Intel(R) Core(TM) i7-7700HQ CPU @ 2.80GHz · 8 cores · darwin/x86_64
**Runtime:** Deno 2.9.5 (V8 15.0.245.2-rusty)

All figures are for `@denext/pages-router` running on denext — no Next.js in the
loop — so they are reproducible with `deno task bench:pages`. SSR uses a modest
representative page (50-item list wrapped in `_app`).

## 1. SSR throughput

| Render path                                                             | renders/sec | ns/render | vs baseline |
| ----------------------------------------------------------------------- | ----------: | --------: | ----------: |
| `renderPage` (full document: `_app` + page + `__NEXT_DATA__` + scripts) |       8,510 |   117,507 |         +2% |
| denext `renderToString` (same tree, no document)                        |       8,667 |   115,383 |    baseline |

The full pages-router document render costs **+2%** over raw denext SSR of the
same tree — that delta is the document assembly (`<html>`/`<head>`, the
`__NEXT_DATA__` payload, and the hydration script), not per-component overhead.
Rendered document: 4.6 KB.

## 2. Client bytes (gzipped) — home route

| File                    |         raw |        gzip |
| ----------------------- | ----------: | ----------: |
| `entry_3.js`            |      0.6 KB |      0.4 KB |
| `chunk-V4O5PKLL.js`     |      1.6 KB |      0.8 KB |
| `chunk-UDNNKY3P.js`     |     41.4 KB |     14.3 KB |
| **total for the route** | **43.6 KB** | **15.5 KB** |

The shared `chunk-*.js` (the denext client runtime + `_app`) is downloaded once
and reused across every route and soft navigation, so a second route adds only
its own small entry.

## 3. Serve throughput (production server, warm)

Full production path: route match → prerendered/SSR HTML served for the home
page.

| Metric       |     Value |
| ------------ | --------: |
| Requests/sec | **3,043** |
| Latency p50  |  13.97 ms |
| Latency p95  |  25.23 ms |
| Latency p99  | 126.17 ms |
| Latency max  | 136.73 ms |
| Errors       |  0 / 4000 |

_Method: 4000 requests at concurrency 50 against the home page of
`examples/pages-router` built with `denext build` and served with
`denext start`, after a 200-request warmup. Localhost, single machine — absolute
numbers are machine-specific; use them for relative comparison across denext
versions._
