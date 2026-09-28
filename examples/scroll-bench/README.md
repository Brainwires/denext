# scroll-bench

A scroll benchmark with two apps that draw **the same data with the same row designs**: a
denext app in a Capacitor WebView (`web/`) and a bare React Native app (`native/`). An adb
harness (`harness/measure.ts`) drives every (app, list, kind, size) cell on an Android emulator
by deep link and records cold start, time to first content, PSS, SurfaceFlinger frame
intervals and gfxinfo jank. Phase 1 of the denext VirtualList plan: find where each list breaks.

```
shared/    plain TypeScript, no React: seeded lazy data (data.ts), row design numbers
           (theme.ts), the scenario catalogue + deep links + logcat markers (scenarios.ts)
web/       denext SPA (mode "spa", compat build for the npm list libraries) + Capacitor Android
ssr/       denext App Router app: server-rendered lists, islands, resumable, VirtualList islands
native/    React Native 0.87 CLI app (New Architecture, Hermes), its own package.json
harness/   measure.ts (adb), matrix.ts (planning/report), parse.ts (parsers), web-smoke.ts
           (headless Chromium check of the web impls), ssr-measure.ts + ssr-report.ts (the
           server-rendered bench in headless Chromium), unit tests
```

## Kinds and sizes

| kind       | rows                                                                                                                                                       | sizes                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `fixed`    | 56 px: avatar, title, subtitle, time                                                                                                                       | 1k, 10k, 100k, 1M, 10M |
| `chat`     | user/assistant messages: 1–40 lines of prose with bold/links/inline code, code blocks of 3–60 lines, occasional 120–300 char unbroken tokens (~20–2000 px) | 1k … 1M                |
| `images`   | a local placeholder image (4 aspect ratios, space reserved up front) + caption                                                                             | 1k … 1M                |
| `sections` | `fixed` rows under sticky headers every 20–200 rows                                                                                                        | 1k … 1M                |

Items are generated from `(seed, index)` on demand (`makeItems(kind, n, seed)` returns a lazy
`BenchList` with `count` + `getItem(i)`), so 10M rows cost nothing until drawn. Lists that need
a `data` array get `list.indexArray()` (virtual indices), built only when that list runs.

## Lists

| app    | id                    | library                                         | data                 | notes                                                                                            |
| ------ | --------------------- | ----------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| denext | `dom`                 | every row in the DOM                            | all                  | n ≤ 10k                                                                                          |
| denext | `cv`                  | every row + `content-visibility: auto`          | all                  | n ≤ 100k                                                                                         |
| denext | `legend`              | `@legendapp/list/react` 3.4                     | index array          | `recycleItems`, `getFixedItemSize` for fixed layouts                                             |
| denext | `tanstack`            | `@tanstack/react-virtual` 3.14                  | count                | sticky via `rangeExtractor`                                                                      |
| denext | `virtua`              | `virtua` 0.52 `VList`                           | count (`{ length }`) | no sticky headers                                                                                |
| denext | `rnw-flatlist-denext` | RN `FlatList` API → denext `VirtualList` engine | index array          | `import { FlatList } from "react-native"` in `reactNative` mode (`lists: "denext"`, the default) |
| denext | `rnw-flatlist-rnw`    | react-native-web 0.21's own `FlatList` engine   | index array          | the vendored original (`react-native-web/dist/vendor/react-native/FlatList`), same app           |
| denext | `denext`              | denext `VirtualList`                            | count                | `count` + `getItem`; `anchor="end"` for chat; sticky headers                                     |
| rn     | `flatlist`            | `FlatList`                                      | index array          | `getItemLayout` for fixed layouts                                                                |
| rn     | `flash`               | `@shopify/flash-list` 2.3                       | index array          |                                                                                                  |
| rn     | `legend`              | `@legendapp/list/react-native` 3.4              | index array          |                                                                                                  |
| rn     | `sectionlist`         | `SectionList`                                   | sections             | `sections` only                                                                                  |

**react-native-web on denext:** denext passes event handlers the native DOM event, and
react-native-web's `ScrollViewBase` calls `e.persist()` on every scroll, so the list throws
on its first scroll; denext's events now carry `persist()`, so no shim is installed.

**Which FlatList engine runs:** in `reactNative` mode denext replaces react-native-web's
`FlatList`, `SectionList` and `VirtualizedList` with adapters over its own `VirtualList`
(`reactNative.lists: "denext"`, the default), so `rnw-flatlist-denext` measures the RN API on
denext's engine. `rnw-flatlist-rnw` imports react-native-web's vendored original, the per-list
escape hatch, so both engines run in one app. `reactNative: { lists: "library" }` in
`web/denext.config.ts` would switch every list back app-wide.

## Running a cell

Web: `(cd web && deno task dev)` then `/?list=legend&kind=chat&n=100000`. Without a query the
page lists every cell. Android: `adb shell am start -a android.intent.action.VIEW -d
'denextscrollbench://run?list=legend&kind=chat&n=100000' com.brainwires.denext.scrollbench`
(RN: `rnscrollbench://…`, `com.brainwires.rnscrollbench`). While a cell runs,
`<scheme>://action?op=append&k=20` (also `prepend`, `scrollToIndex&i=…`, `scrollToEnd`,
`scrollToStart`, `fps&on=1`) drives it; the web app also exposes the same operations as
`window.__bench`. Each app logs `SCROLLBENCH_READY {…}` / `SCROLLBENCH_ACTION {…}` /
`SCROLLBENCH_SKIPPED {…}` / `SCROLLBENCH_ERROR {…}` to logcat.

## Building the APKs

`./build-apks.sh [host] [out-dir]` exports the web app here and builds both release APKs on a
Linux host over SSH (JDK 21, `~/Android/Sdk`), x86_64 only, signed with a throwaway key made on
the host. The placeholder images come from `deno task images` (committed).

## Measuring

```sh
deno run -A harness/measure.ts doctor
deno run -A harness/measure.ts install --apks <dir with scroll-bench-*-release.apk>
deno run -A harness/measure.ts matrix --dry-run                  # the plan, no adb
deno run -A harness/measure.ts matrix --only rn-flash-chat,denext-legend-chat
deno run -A harness/measure.ts matrix --config my-matrix.json --resume results/<stamp>
deno run -A harness/measure.ts coldstart --runs 5
```

The method, and what each number does and does not mean, is in the header of
`harness/measure.ts`. Checks without a device: `deno task test` (parsers, matrix, data) and
`deno task smoke` (every web impl in headless Chromium after `cd web && deno task export`).

## Server-rendered lists (`ssr/`)

`ssr/` asks a different question: for a list of mostly static rows on a server-rendered page,
at what size should the page stop sending every row as plain HTML (no JS, and Ctrl+F, SEO,
accessibility, selection and printing all work) and switch to `VirtualList`? It is a denext
App Router app (not SPA mode) that draws the same data with the same rows (`shared/`, plus
`web/src/rows.tsx` and `styles.ts`). Each impl is a route, `/list/<impl>?kind=fixed|chat|images&n=1000`:

| impl                     | what the server sends                                                                    | per-row control (a like button)                                          |
| ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `static`                 | every row as HTML (Server Components)                                                    | none                                                                     |
| `static-cv`              | the same + `content-visibility: auto; contain-intrinsic-size: auto <estimate>px` per row | none                                                                     |
| `static-cv-islands`      | `static-cv`                                                                              | one `client:load` island per row                                         |
| `static-cv-resumable`    | `static-cv` in a `resumable` route                                                       | the same component per row, resumed on its first click                   |
| `static-cv-delegated`    | `static-cv`                                                                              | plain HTML buttons + ONE `client:load` island with a delegated listener  |
| `static-cv-script`       | `static-cv`                                                                              | plain HTML buttons + the same listener as a `public/` script (no island) |
| `virtual-island`         | `VirtualList` as one `client:load` island: the server renders its first window           | a row component inside the list                                          |
| `virtual-island-visible` | the same below a 1.5-viewport intro, `client:visible`                                    | the same                                                                 |
| `virtual-island-find`    | `virtual-island` with `findInPage`                                                       | the same                                                                 |
| `virtual-spa`            | reference: the SPA's `denext` impl (`web/out`)                                           | none                                                                     |

The virtual islands receive only `kind`, `n` and `seed` as props and generate the rows on the
client, so no row data crosses the Flight boundary. The report lists what shipping the rows as
props would add.

```sh
(cd ssr && deno task build)                  # production build; `deno task dev` to browse
(cd ssr && deno task test)                   # every route renders its cell (no browser)
deno task ssr-measure --smoke                # one run per impl at 100 and 1k rows
deno task ssr-measure                        # the matrix → results/ssr-<date>/results.{md,json}
deno task ssr-measure --impls islands --kinds fixed,chat --out results/ssr-2026-09-27
                                             # re-run the island pages' cells (also: static,
                                             # virtual, or impl ids); the report is rebuilt
                                             # from every cell in --out
```

`harness/ssr-measure.ts` runs `denext start` behind a gzip proxy and loads every (profile,
impl, kind, n) cell three times, each in a cold headless Chromium. `desktop` is 1280×800;
`mobile` is 412×915 at DPR 2.625 with touch, 4× CPU throttling and a 9/1.5 Mbps, 60 ms
network. Each run records TTFB, FCP, LCP, time to interactive, total blocking time, the HTML
and JS bytes, DOM elements, JS heap, renderer memory, rAF frame intervals during a scripted
fling, click-to-paint latency of a row's control, whether `window.find` reaches row n−1, and
the `listitem` count of the accessibility tree. `--max-load` (default 4) waits until the
1-minute load average is below it. The method is in the header of `harness/ssr-measure.ts`,
and its pure half (`harness/ssr-report.ts`) is unit-tested. The findings feed the
[Lists docs](https://denext.dev/docs/lists#server-rendered-lists-and-islands-vs-virtuallist).
