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
native/    React Native 0.87 CLI app (New Architecture, Hermes), its own package.json
harness/   measure.ts (adb), matrix.ts (planning/report), parse.ts (parsers), web-smoke.ts
           (headless Chromium check of the web impls), unit tests
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

| app    | id             | library                                | data                 | notes                                                |
| ------ | -------------- | -------------------------------------- | -------------------- | ---------------------------------------------------- |
| denext | `dom`          | every row in the DOM                   | all                  | n ≤ 10k                                              |
| denext | `cv`           | every row + `content-visibility: auto` | all                  | n ≤ 100k                                             |
| denext | `legend`       | `@legendapp/list/react` 3.4            | index array          | `recycleItems`, `getFixedItemSize` for fixed layouts |
| denext | `tanstack`     | `@tanstack/react-virtual` 3.14         | count                | sticky via `rangeExtractor`                          |
| denext | `virtua`       | `virtua` 0.52 `VList`                  | count (`{ length }`) | no sticky headers                                    |
| denext | `rnw-flatlist` | react-native-web 0.21 `FlatList`       | index array          | `reactNative: true` mode; see the persist shim below |
| denext | `denext`       | denext VirtualList                     | —                    | Phase 2 slot: reports "not yet implemented"          |
| rn     | `flatlist`     | `FlatList`                             | index array          | `getItemLayout` for fixed layouts                    |
| rn     | `flash`        | `@shopify/flash-list` 2.3              | index array          |                                                      |
| rn     | `legend`       | `@legendapp/list/react-native` 3.4     | index array          |                                                      |
| rn     | `sectionlist`  | `SectionList`                          | sections             | `sections` only                                      |

**react-native-web on denext:** denext passes event handlers the native DOM event, and
react-native-web's `ScrollViewBase` calls `e.persist()` on every scroll, so the list throws
on its first scroll. `web/src/impls/rnw-flatlist.tsx` installs a no-op
`Event.prototype.persist` (only when that impl loads) and every ready marker of the impl says
so in its notes.

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
