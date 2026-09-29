# Server-rendered lists vs VirtualList (2026-09-27)

## Findings

Time to interactive (TTI) is the deciding load metric. FCP and LCP follow it for the HTML
lists and stay flat for the virtual ones.

- **Crossover, 56 px rows.** `static-cv` becomes interactive as fast as `virtual-island` or
  faster up to 1k rows on desktop (90 vs 111 ms) and up to 2k on mobile (304 vs 657 ms). At 5k
  they tie on mobile (712 vs 643 ms). Past that the island wins everywhere: its TTI is flat,
  about 100 ms on desktop and 650 ms on mobile, from 100 to 100k rows. At 10k, `static-cv`
  takes 861 / 1265 ms and 148 / 145 MB of renderer memory against the island's 103 MB.
- **Crossover, chat rows.** Up to 500 rows on desktop (110 vs 96 ms) and 2k on mobile (633 vs
  652 ms).
- **Below the crossover, HTML costs nothing else.** 0 ms total blocking time up to 5k rows on
  desktop and 2k on mobile, within 5 MB of the island's memory up to 2k rows, every row found by
  `window.find` and present in the accessibility tree. The island exposes only its window: 18
  rows on desktop and 29 on mobile for 56 px rows, 4 and 9 for chat.
- **Scrolling.** A desktop fling (wheel, main-thread frames) through `static-cv` drops frames
  from 5k rows (p90 33 ms) and more at 10k (67 ms). Plain `static` stays at 16.7 ms up to 10k
  but uses 1.7–2.6× the memory. Every virtual impl stays at 16.7 ms at every size. The mobile
  touch fling runs on the compositor, so the HTML lists show main-thread jank only from 50k.
- **`content-visibility` is required past a few thousand rows.** Without it, 10k chat rows
  take 9.6 s to become interactive on mobile (3.1 s with it) and 425 MB of memory (162 MB).
  At 50k plain `static` takes 31–44 s on mobile.
- **Unusable.** On mobile, the HTML impls go past 30 s TTI at 50k or 100k rows, except
  `static-cv` with 56 px rows (21.8 s at 100k). The larger sizes after that were skipped (see
  Failures).
- **Per-row controls, extra TTI per 1k rows over `static-cv` (desktop / mobile, 56 px rows at
  10k).**
  - A `client:load` island per row costs 57 / 321 ms.
  - The same component in a `resumable` route costs 6 / 178 ms, and its first click waits about
    180–360 ms on mobile for the row's code.
  - One delegated island costs 5 / 130 ms.
  - The same delegated listener as a plain `public/` script (no island) costs about 0 / 108 ms.
  - First click to paint up to 5k rows is 11–31 ms on desktop for all of them.
- **The Flight fix (ffb9491f) and what it changed.** Before it, any client component inlined
  the page's whole Server Component tree as `__denext_flight` JSON. Now a page whose only
  client components are islands inlines `null`. The island cells were re-measured after the
  fix; the other cells did not change (they have no island). For `static-cv-delegated` at 10k
  fixed rows:

  |                       | before         | after                             |
  | --------------------- | -------------- | --------------------------------- |
  | decoded HTML          | 10.4 MB        | 4.0 MB (same as the plain script) |
  | JS heap               | 106 MB         | 1.0 MB                            |
  | TTI, desktop / mobile | 1856 / 6381 ms | 908 / 2570 ms                     |

  Per-row islands (`static-cv-islands`) still carry one island entry per row: 6.0 MB of HTML
  and 36 MB of heap at 10k, against 12.6 MB and 121 MB before.
- **`findInPage`.** `virtual-island-find` puts row n−1 in the DOM (as a `hidden="until-found"`
  stub) up to 2k rows, the default `findInPage.limit`, and not beyond. `window.find` does not
  search those stubs, so the find table shows `no (1 in DOM)` there. Whether the browser's find
  bar reveals them (`beforematch`) cannot be driven from CDP and was not measured. It adds up
  to about 380 ms of TTI on mobile and up to 30 MB of memory.
- **`client:visible`.** Below the fold, the island loads 29 KB of JS instead of 54 KB and hydrates
  only when scrolled to. Its FCP matches `virtual-island`'s.
- **SPA reference (`virtual-spa`).** It has the same flat curve: 93–108 ms desktop and
  518–578 ms mobile TTI, with LCP about 90 ms desktop and 520 ms mobile, because nothing paints
  before the script runs.

Machine: biscuits (linux x86_64, AMD EPYC-Milan Processor, 8 logical CPUs, 16 GB). Chromium Chrome/125.0.6400.0/@1d4d04a8e93f58a3782211b5b36381d41c2e93d1 (headless). Load average at start 1.23 (static/islands session) and 0.45 (virtual session), at end 1.36; the 1-minute load at the end of each cell had a median of 1.86 and a maximum of 7.83. Medians of 3 runs per cell, each a cold browser (fresh profile, empty cache).

- **desktop**: 1280×800 viewport, DPR 1, no CPU or network throttling
- **mobile**: 412×915 viewport, DPR 2.625, touch, CPU throttled 4×, network 9 Mbps down / 1.5 Mbps up / 60 ms RTT

- The ssr/ app runs under `denext start` (production build), each request rendered uncached (`dynamic = "force-dynamic"`), behind a gzip proxy (denext does not compress dynamic HTML itself; a CDN or reverse proxy would).
- Every list scrolls in its own full-viewport scroller and starts at row 0 (also chat). The virtual-spa reference is the SPA's `denext` impl (web/out), where chat starts at its end.
- Scroll: requestAnimationFrame intervals during the fling, i.e. main-thread frames. The mobile fling is a touch gesture that Chromium scrolls on the compositor thread, so a page whose main thread has nothing to do on scroll (static HTML) stays at 16.7 ms there even when its raster falls behind; a VirtualList re-rendering its window shows up.
- Time to interactive: from FCP, the end of the last long task followed by 500 ms without one, and not before the last island the page waits for is hydrated (every row island for static-cv-islands, the one island for the delegated and virtual impls).
- Three sessions on the same machine: the static impls; the virtual impls and the SPA reference after the VirtualList engine commits 5c10d144 and d3dbd8a8 (0858f134); the island impls (static-cv-islands, -resumable, -delegated) after the Flight fix ffb9491f.

`FAIL`: every run failed (the failures are listed at the end). `skip`: a smaller size of the same impl already failed, or took over 30 s to become interactive. `—`: not measured or not applicable (no row control, no scroll).

## desktop · fixed

### TTFB (ms)

| impl                   | 100 | 500 | 1k |  2k |  5k | 10k |  50k | 100k |
| ---------------------- | --: | --: | -: | --: | --: | --: | ---: | ---: |
| static                 |  22 |  28 | 46 |  80 | 248 | 420 | 1993 | 3834 |
| static-cv              |  10 |  26 | 34 |  71 | 199 | 510 | 2077 | 4891 |
| static-cv-islands      |  18 |  37 | 67 | 118 | 283 | 577 | 2702 | 5563 |
| static-cv-resumable    |  15 |  44 | 70 |  94 | 235 | 498 | 3526 | 5646 |
| static-cv-delegated    |  16 |  33 | 53 |  96 | 212 | 471 | 2420 | 4533 |
| static-cv-script       |  13 |  30 | 49 |  88 | 270 | 457 | 2448 | 5260 |
| virtual-island         |  16 |   9 | 12 |  11 |  10 |   9 |   12 |    9 |
| virtual-island-visible |   9 |  10 |  9 |   8 |   8 |   8 |   13 |    9 |
| virtual-island-find    |   9 |  12 |  8 |  10 |   8 |   9 |    8 |    8 |
| virtual-spa            |   5 |   4 |  4 |   4 |   4 |   4 |    4 |    4 |

### FCP (ms)

| impl                   | 100 | 500 |  1k |  2k |  5k | 10k |  50k | 100k |
| ---------------------- | --: | --: | --: | --: | --: | --: | ---: | ---: |
| static                 |  78 | 118 | 189 | 247 | 374 | 535 | 2084 | 3972 |
| static-cv              |  55 |  75 |  90 | 136 | 277 | 588 | 2164 | 4981 |
| static-cv-islands      |  69 | 106 | 154 | 201 | 373 | 656 | 2782 | 5648 |
| static-cv-resumable    |  69 | 146 | 159 | 171 | 302 | 581 | 3594 | 5749 |
| static-cv-delegated    |  74 |  93 | 123 | 181 | 298 | 553 | 2507 | 4630 |
| static-cv-script       |  72 |  87 | 125 | 163 | 353 | 539 | 2528 | 5346 |
| virtual-island         |  63 |  63 |  62 |  58 |  67 |  67 |   72 |   60 |
| virtual-island-visible |  67 |  59 |  60 |  52 |  65 |  61 |   84 |   67 |
| virtual-island-find    |  63 |  62 |  62 |  65 |  62 |  61 |   63 |   69 |
| virtual-spa            |  51 |  52 |  51 |  51 |  57 |  60 |   57 |   60 |

### LCP (ms)

| impl                   | 100 | 500 |  1k |  2k |  5k | 10k |  50k | 100k |
| ---------------------- | --: | --: | --: | --: | --: | --: | ---: | ---: |
| static                 |  78 | 118 | 189 | 247 | 374 | 535 | 2084 | 3972 |
| static-cv              |  55 |  75 |  90 | 136 | 277 | 588 | 2164 | 4981 |
| static-cv-islands      |  69 | 106 | 154 | 201 | 373 | 656 | 2782 | 5648 |
| static-cv-resumable    |  69 | 146 | 159 | 171 | 302 | 581 | 3594 | 5749 |
| static-cv-delegated    |  74 |  93 | 123 | 181 | 298 | 553 | 2507 | 4630 |
| static-cv-script       |  72 |  87 | 125 | 163 | 353 | 539 | 2528 | 5346 |
| virtual-island         |  63 |  63 |  62 |  58 |  67 |  67 |   72 |   60 |
| virtual-island-visible |  67 |  59 |  60 |  52 |  65 |  61 |   84 |   67 |
| virtual-island-find    |  63 |  62 |  62 |  65 |  62 |  61 |   63 |   69 |
| virtual-spa            |  94 |  89 |  92 |  90 |  91 | 110 |   97 |   97 |

### Time to interactive (ms)

| impl                   | 100 | 500 |  1k |  2k |  5k |  10k |  50k |  100k |
| ---------------------- | --: | --: | --: | --: | --: | ---: | ---: | ----: |
| static                 |  78 | 118 | 189 | 250 | 713 | 1163 | 3038 | 10448 |
| static-cv              |  55 |  75 |  90 | 136 | 339 |  861 | 3078 |  7014 |
| static-cv-islands      | 112 | 178 | 249 | 372 | 811 | 1428 | 6979 | 14637 |
| static-cv-resumable    |  73 | 197 | 177 | 222 | 494 |  918 | 5409 | 11796 |
| static-cv-delegated    |  93 | 121 | 160 | 230 | 488 |  908 | 4232 |  8917 |
| static-cv-script       |  72 |  87 | 126 | 178 | 456 |  795 | 4103 |  8408 |
| virtual-island         | 111 | 108 | 111 | 102 | 114 |  110 |  124 |    95 |
| virtual-island-visible |  67 |  61 |  62 |  56 |  65 |   62 |  110 |    70 |
| virtual-island-find    | 104 | 108 | 110 | 167 | 154 |  137 |  174 |   148 |
| virtual-spa            |  93 |  98 |  94 |  96 | 101 |  108 |  102 |   102 |

### Total blocking time (ms)

| impl                   | 100 | 500 | 1k | 2k |  5k | 10k |  50k | 100k |
| ---------------------- | --: | --: | -: | -: | --: | --: | ---: | ---: |
| static                 |   0 |   0 |  0 |  0 |   0 |  22 | 2137 | 1714 |
| static-cv              |   0 |   0 |  0 |  0 |   0 |   3 |  597 |  809 |
| static-cv-islands      |   0 |   0 |  2 | 24 | 127 | 290 | 2506 | 5146 |
| static-cv-resumable    |   0 |   0 |  0 |  0 |   0 |  12 |  596 | 1869 |
| static-cv-delegated    |   0 |   0 |  0 |  0 |   0 |   0 |  423 |  908 |
| static-cv-script       |   0 |   0 |  0 |  0 |   0 |   0 |  422 |  918 |
| virtual-island         |   0 |   0 |  0 |  0 |   0 |   0 |    0 |    0 |
| virtual-island-visible |   0 |   0 |  0 |  0 |   0 |   0 |    0 |    0 |
| virtual-island-find    |   0 |   0 |  0 |  9 |   2 |   4 |   17 |    9 |
| virtual-spa            |   0 |   0 |  0 |  0 |   0 |   0 |    0 |    0 |

### Load event (ms)

| impl                   | 100 | 500 |  1k |  2k |  5k |  10k |  50k |  100k |
| ---------------------- | --: | --: | --: | --: | --: | ---: | ---: | ----: |
| static                 |  45 |  48 | 181 | 254 | 718 | 1172 | 3499 | 10704 |
| static-cv              |  23 |  65 |  80 | 133 | 343 |  851 | 3001 |  7131 |
| static-cv-islands      |  74 | 113 | 166 | 250 | 580 | 1006 | 4857 | 10091 |
| static-cv-resumable    |  68 | 197 | 178 | 224 | 498 |  925 | 5501 | 12003 |
| static-cv-delegated    |  67 |  98 | 132 | 201 | 444 |  841 | 3933 |  8211 |
| static-cv-script       |  67 |  88 | 127 | 179 | 460 |  802 | 4181 |  8557 |
| virtual-island         |  70 |  59 |  63 |  64 |  62 |   64 |   77 |    56 |
| virtual-island-visible |  62 |  61 |  62 |  57 |  60 |   62 |  110 |    63 |
| virtual-island-find    |  60 |  61 |  67 |  61 |  57 |   61 |   59 |    52 |
| virtual-spa            |  45 |  43 |  46 |  48 |  40 |   50 |   39 |    51 |

### HTML transferred

| impl                   |  100 |   500 |    1k |    2k |     5k |    10k |    50k |   100k |
| ---------------------- | ---: | ----: | ----: | ----: | -----: | -----: | -----: | -----: |
| static                 | 6 KB | 18 KB | 33 KB | 65 KB | 159 KB | 315 KB | 1.5 MB | 3.1 MB |
| static-cv              | 6 KB | 18 KB | 33 KB | 65 KB | 159 KB | 315 KB | 1.5 MB | 3.1 MB |
| static-cv-islands      | 7 KB | 23 KB | 44 KB | 85 KB | 209 KB | 414 KB | 2.0 MB | 4.0 MB |
| static-cv-resumable    | 7 KB | 24 KB | 45 KB | 86 KB | 211 KB | 417 KB | 2.0 MB | 4.1 MB |
| static-cv-delegated    | 6 KB | 19 KB | 35 KB | 66 KB | 162 KB | 321 KB | 1.6 MB | 3.1 MB |
| static-cv-script       | 6 KB | 19 KB | 34 KB | 66 KB | 162 KB | 321 KB | 1.6 MB | 3.1 MB |
| virtual-island         | 4 KB |  4 KB |  4 KB |  4 KB |   4 KB |   4 KB |   4 KB |   4 KB |
| virtual-island-visible | 4 KB |  4 KB |  4 KB |  4 KB |   4 KB |   4 KB |   4 KB |   4 KB |
| virtual-island-find    | 4 KB |  4 KB |  4 KB |  4 KB |   4 KB |   4 KB |   4 KB |   4 KB |
| virtual-spa            | 1 KB |  1 KB |  1 KB |  1 KB |   1 KB |   1 KB |   1 KB |   1 KB |

### HTML decoded

| impl                   |   100 |    500 |     1k |     2k |     5k |    10k |     50k |    100k |
| ---------------------- | ----: | -----: | -----: | -----: | -----: | -----: | ------: | ------: |
| static                 | 36 KB | 160 KB | 316 KB | 629 KB | 1.5 MB | 3.1 MB | 15.3 MB | 30.7 MB |
| static-cv              | 36 KB | 160 KB | 316 KB | 629 KB | 1.5 MB | 3.1 MB | 15.3 MB | 30.7 MB |
| static-cv-islands      | 65 KB | 308 KB | 613 KB | 1.2 MB | 3.0 MB | 6.0 MB | 30.0 MB | 60.2 MB |
| static-cv-resumable    | 67 KB | 317 KB | 631 KB | 1.2 MB | 3.1 MB | 6.2 MB | 30.9 MB | 62.0 MB |
| static-cv-delegated    | 46 KB | 211 KB | 416 KB | 829 KB | 2.0 MB | 4.0 MB | 20.2 MB | 40.4 MB |
| static-cv-script       | 46 KB | 210 KB | 416 KB | 828 KB | 2.0 MB | 4.0 MB | 20.2 MB | 40.4 MB |
| virtual-island         | 19 KB |  19 KB |  19 KB |  19 KB |  19 KB |  19 KB |   19 KB |   19 KB |
| virtual-island-visible | 20 KB |  20 KB |  20 KB |  20 KB |  20 KB |  20 KB |   20 KB |   20 KB |
| virtual-island-find    | 19 KB |  19 KB |  19 KB |  19 KB |  19 KB |  19 KB |   19 KB |   19 KB |
| virtual-spa            |  1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |    1 KB |    1 KB |

### JS transferred

| impl                   |   100 |   500 |    1k |    2k |    5k |   10k |   50k |  100k |
| ---------------------- | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: |
| static                 |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |
| static-cv              |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |
| static-cv-islands      | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB |
| static-cv-resumable    | 29 KB | 29 KB | 29 KB | 29 KB | 29 KB | 29 KB | 29 KB | 29 KB |
| static-cv-delegated    | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB |
| static-cv-script       |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |
| virtual-island         | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB |
| virtual-island-visible | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB |
| virtual-island-find    | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB |
| virtual-spa            | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB |

### JS decoded

| impl                   |    100 |    500 |     1k |     2k |     5k |    10k |    50k |   100k |
| ---------------------- | -----: | -----: | -----: | -----: | -----: | -----: | -----: | -----: |
| static                 |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |
| static-cv              |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |
| static-cv-islands      | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB |
| static-cv-resumable    |  72 KB |  72 KB |  72 KB |  72 KB |  72 KB |  72 KB |  72 KB |  72 KB |
| static-cv-delegated    | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB |
| static-cv-script       |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |
| virtual-island         | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB |
| virtual-island-visible |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |
| virtual-island-find    | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB |
| virtual-spa            | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB |

### DOM elements

| impl                   | 100 |   500 |    1k |     2k |     5k |    10k |     50k |    100k |
| ---------------------- | --: | ----: | ----: | -----: | -----: | -----: | ------: | ------: |
| static                 | 710 | 3,510 | 7,010 | 14,010 | 35,010 | 70,010 | 350,010 | 700,010 |
| static-cv              | 710 | 3,510 | 7,010 | 14,010 | 35,010 | 70,010 | 350,010 | 700,010 |
| static-cv-islands      | 914 | 4,514 | 9,014 | 18,014 | 45,014 | 90,014 | 450,014 | 900,014 |
| static-cv-resumable    | 914 | 4,514 | 9,014 | 18,014 | 45,014 | 90,014 | 450,014 | 900,014 |
| static-cv-delegated    | 815 | 4,015 | 8,015 | 16,015 | 40,015 | 80,015 | 400,015 | 800,015 |
| static-cv-script       | 811 | 4,011 | 8,011 | 16,011 | 40,011 | 80,011 | 400,011 | 800,011 |
| virtual-island         | 278 |   278 |   278 |    278 |    278 |    278 |     278 |     278 |
| virtual-island-visible | 281 |   281 |   281 |    281 |    281 |    281 |     281 |     281 |
| virtual-island-find    | 350 |   750 | 1,250 |  2,250 |  2,250 |  2,250 |   2,250 |   2,250 |
| virtual-spa            | 229 |   229 |   229 |    229 |    229 |    229 |     229 |     229 |

### JS heap used

| impl                   |     100 |     500 |      1k |      2k |      5k |     10k |      50k |     100k |
| ---------------------- | ------: | ------: | ------: | ------: | ------: | ------: | -------: | -------: |
| static                 |  663 KB |  439 KB |  439 KB |  662 KB |  445 KB |  444 KB |   442 KB |   442 KB |
| static-cv              |  662 KB |  663 KB |  662 KB |  438 KB |  441 KB |  446 KB |   444 KB |   441 KB |
| static-cv-islands      |  1.5 MB |  3.8 MB |  6.2 MB |  9.1 MB | 23.0 MB | 35.7 MB | 235.8 MB | 415.3 MB |
| static-cv-resumable    | 1008 KB |  1.4 MB |  1.4 MB |  1.6 MB |  3.0 MB |  4.9 MB |  20.8 MB |  41.1 MB |
| static-cv-delegated    |  1.0 MB |  1.0 MB |  1.0 MB |  830 KB |  988 KB |  988 KB |   832 KB |   835 KB |
| static-cv-script       |  668 KB |  668 KB |  668 KB |  447 KB |  446 KB |  445 KB |   452 KB |   451 KB |
| virtual-island         |  1.9 MB |  2.2 MB |  2.1 MB |  2.4 MB |  3.7 MB |  3.6 MB |   8.2 MB |   2.0 MB |
| virtual-island-visible | 1013 KB | 1013 KB | 1014 KB | 1014 KB | 1013 KB | 1014 KB |  1014 KB |  1014 KB |
| virtual-island-find    |  2.1 MB |  3.4 MB |  4.0 MB |  5.6 MB |  5.8 MB |  7.9 MB |  15.0 MB |   5.5 MB |
| virtual-spa            |  2.0 MB |  2.1 MB |  2.2 MB |  2.5 MB |  2.8 MB |  3.5 MB |   8.2 MB |   2.0 MB |

### Renderer memory (private resident)

| impl                   |     100 |      500 |       1k |       2k |       5k |      10k |      50k |      100k |
| ---------------------- | ------: | -------: | -------: | -------: | -------: | -------: | -------: | --------: |
| static                 | 90.7 MB | 102.0 MB | 114.4 MB | 134.8 MB | 195.5 MB | 257.7 MB | 957.6 MB | 1864.9 MB |
| static-cv              | 89.2 MB |  91.8 MB |  94.3 MB | 100.5 MB | 117.5 MB | 148.0 MB | 367.9 MB |  622.5 MB |
| static-cv-islands      | 94.3 MB | 104.5 MB | 116.3 MB | 137.1 MB | 183.6 MB | 277.7 MB | 933.1 MB | 1672.1 MB |
| static-cv-resumable    | 91.5 MB |  95.4 MB | 100.0 MB | 108.7 MB | 136.3 MB | 182.6 MB | 455.1 MB |  840.8 MB |
| static-cv-delegated    | 91.6 MB |  94.3 MB |  97.8 MB | 104.6 MB | 125.7 MB | 160.5 MB | 372.5 MB |  678.1 MB |
| static-cv-script       | 90.0 MB |  92.7 MB |  96.0 MB | 103.3 MB | 124.1 MB | 160.1 MB | 381.5 MB |  675.4 MB |
| virtual-island         | 93.6 MB |  94.5 MB |  94.9 MB |  96.1 MB |  98.3 MB | 102.8 MB | 130.5 MB |   93.6 MB |
| virtual-island-visible | 90.6 MB |  90.6 MB |  90.6 MB |  90.4 MB |  90.5 MB |  90.6 MB |  90.8 MB |   90.7 MB |
| virtual-island-find    | 94.5 MB |  98.2 MB | 102.3 MB | 110.9 MB | 112.3 MB | 116.2 MB | 132.5 MB |  111.0 MB |
| virtual-spa            | 93.5 MB |  94.4 MB |  95.1 MB |  96.4 MB |  98.6 MB | 102.8 MB | 129.4 MB |   93.1 MB |

### Scroll: p90 frame interval (ms) / missed frames

| impl                   |     100 |       500 |         1k |        2k |         5k |        10k |         50k |        100k |
| ---------------------- | ------: | --------: | ---------: | --------: | ---------: | ---------: | ----------: | ----------: |
| static                 | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% |    17 / 0% |  17 / 3.7% | 117 / 55.8% | 300 / 68.2% |
| static-cv              | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% | 33 / 21.6% | 67 / 93.1% | 350 / 82.4% | 767 / 91.7% |
| static-cv-islands      | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% | 33 / 64.9% | 67 / 91.7% | 483 / 81.3% | 833 / 91.7% |
| static-cv-resumable    | 17 / 0% |   17 / 0% | 33 / 11.3% |   17 / 0% | 33 / 37.3% | 67 / 90.9% | 600 / 76.9% | 783 / 90.9% |
| static-cv-delegated    | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% | 33 / 35.7% | 67 / 91.9% | 383 / 82.4% | 767 / 90.9% |
| static-cv-script       | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% | 33 / 41.4% | 67 / 92.6% | 367 / 82.4% | 800 / 91.7% |
| virtual-island         | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% |    17 / 0% |    17 / 0% |     17 / 0% |     17 / 0% |
| virtual-island-visible | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% |    17 / 0% |    17 / 0% |     17 / 0% |     17 / 0% |
| virtual-island-find    | 17 / 0% | 17 / 0.5% |    17 / 0% | 17 / 0.5% |    17 / 1% |    17 / 0% |   17 / 0.5% |     17 / 1% |
| virtual-spa            | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% |    17 / 0% |    17 / 0% |     17 / 0% |     17 / 0% |

### Scroll: worst frame (ms)

| impl                   | 100 | 500 | 1k | 2k | 5k | 10k | 50k | 100k |
| ---------------------- | --: | --: | -: | -: | -: | --: | --: | ---: |
| static                 |  17 |  17 | 17 | 17 | 17 |  33 | 167 |  333 |
| static-cv              |  17 |  17 | 17 | 17 | 33 |  67 | 417 |  817 |
| static-cv-islands      |  17 |  17 | 17 | 17 | 50 |  83 | 550 |  867 |
| static-cv-resumable    |  17 |  17 | 33 | 17 | 50 |  67 | 617 |  800 |
| static-cv-delegated    |  17 |  17 | 17 | 17 | 50 |  83 | 383 |  867 |
| static-cv-script       |  17 |  17 | 17 | 17 | 50 |  83 | 383 |  833 |
| virtual-island         |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |
| virtual-island-visible |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |
| virtual-island-find    |  17 |  33 | 17 | 33 | 33 |  17 |  33 |   33 |
| virtual-spa            |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |

### Row control: first click / second click → paint (ms)

| impl                   |     100 |     500 |      1k |      2k |      5k |     10k |       50k |      100k |
| ---------------------- | ------: | ------: | ------: | ------: | ------: | ------: | --------: | --------: |
| static                 |       — |       — |       — |       — |       — |       — |         — |         — |
| static-cv              |       — |       — |       — |       — |       — |       — |         — |         — |
| static-cv-islands      |  7 / 15 |  8 / 15 | 12 / 11 | 14 / 20 | 21 / 18 | 40 / 39 | 286 / 223 | 421 / 543 |
| static-cv-resumable    | 19 / 14 | 31 / 11 | 31 / 14 | 27 / 27 | 29 / 24 | 51 / 37 | 234 / 221 | 342 / 685 |
| static-cv-delegated    | 11 / 12 |   6 / 4 | 17 / 15 | 20 / 15 | 15 / 26 | 13 / 27 | 209 / 207 | 227 / 435 |
| static-cv-script       | 16 / 15 | 15 / 15 | 15 / 14 | 14 / 15 | 13 / 13 | 26 / 25 | 112 / 107 | 223 / 396 |
| virtual-island         |  6 / 15 | 14 / 11 | 19 / 16 | 17 / 17 | 13 / 15 |  13 / 9 |   19 / 15 |     8 / 5 |
| virtual-island-visible |   9 / 7 | 10 / 15 |  11 / 8 | 15 / 11 | 13 / 11 | 15 / 11 |    13 / 9 |   13 / 11 |
| virtual-island-find    |  7 / 19 | 16 / 13 | 21 / 15 | 24 / 25 | 39 / 30 | 39 / 31 |   40 / 29 |   30 / 30 |
| virtual-spa            |       — |       — |       — |       — |       — |       — |         — |         — |

### Find row n−1 (window.find; DOM hits)

| impl                   |            100 |            500 |             1k |             2k |             5k |            10k |            50k |           100k |
| ---------------------- | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: |
| static                 | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv              | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv-islands      | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv-resumable    | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv-delegated    | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv-script       | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| virtual-island         |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |
| virtual-island-visible |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |
| virtual-island-find    |  no (1 in DOM) |  no (1 in DOM) |  no (1 in DOM) |  no (1 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |
| virtual-spa            |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |

### Rows in the accessibility tree

| impl                   | 100 | 500 |    1k |    2k |    5k |    10k |    50k |    100k |
| ---------------------- | --: | --: | ----: | ----: | ----: | -----: | -----: | ------: |
| static                 | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv              | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-islands      | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-resumable    | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-delegated    | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-script       | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| virtual-island         |  18 |  18 |    18 |    18 |    18 |     18 |     18 |      18 |
| virtual-island-visible |  18 |  18 |    18 |    18 |    18 |     18 |     18 |      18 |
| virtual-island-find    |  39 |  39 |    39 |    39 |    18 |     18 |     18 |      18 |
| virtual-spa            |  18 |  18 |    18 |    18 |    18 |     18 |     18 |      18 |

## desktop · chat

### TTFB (ms)

| impl                   | 100 | 500 |  1k |  2k |  5k |  10k |  50k |  100k |
| ---------------------- | --: | --: | --: | --: | --: | ---: | ---: | ----: |
| static                 |  18 |  50 |  84 | 197 | 443 |  977 | 5327 | 12112 |
| static-cv              |  20 |  55 | 130 | 233 | 617 | 1168 | 5514 | 12951 |
| static-cv-islands      |  27 |  74 | 108 | 200 | 426 |  918 | 5062 |  8818 |
| static-cv-resumable    |  21 |  68 | 105 | 149 | 416 |  883 | 4154 |  9026 |
| static-cv-delegated    |  18 |  52 |  88 | 156 | 393 |  751 | 4152 |  8683 |
| static-cv-script       |  17 |  61 | 115 | 197 | 545 | 1089 | 6011 | 14300 |
| virtual-island         |  10 |   9 |   8 |   9 |  10 |    9 |    9 |     7 |
| virtual-island-visible |  11 |   9 |   9 |   9 |   9 |    7 |    8 |     9 |
| virtual-island-find    |   8 |   7 |   7 |   8 |   7 |    8 |    8 |     9 |
| virtual-spa            |   4 |   5 |   5 |   4 |   4 |    6 |    4 |     4 |

### FCP (ms)

| impl                   | 100 | 500 |  1k |  2k |  5k |  10k |  50k |  100k |
| ---------------------- | --: | --: | --: | --: | --: | ---: | ---: | ----: |
| static                 |  71 | 188 | 256 | 361 | 595 | 1112 | 5484 | 12278 |
| static-cv              |  66 | 110 | 200 | 302 | 694 | 1237 | 5584 | 12988 |
| static-cv-islands      |  90 | 151 | 192 | 285 | 513 | 1010 | 5142 |  8906 |
| static-cv-resumable    |  73 | 139 | 179 | 227 | 501 |  968 | 4235 |  9102 |
| static-cv-delegated    |  75 | 120 | 167 | 220 | 481 |  824 | 4228 |  8770 |
| static-cv-script       |  74 | 133 | 199 | 269 | 614 | 1176 | 6104 | 14374 |
| virtual-island         |  69 |  65 |  66 |  58 |  70 |   60 |   65 |    61 |
| virtual-island-visible |  72 |  66 |  68 |  71 |  66 |   55 |   64 |    57 |
| virtual-island-find    |  64 |  70 |  64 |  66 |  63 |   65 |   66 |    68 |
| virtual-spa            |  58 | 115 |  67 |  50 |  63 |   81 |   57 |    56 |

### LCP (ms)

| impl                   | 100 | 500 |  1k |  2k |  5k |  10k |  50k |  100k |
| ---------------------- | --: | --: | --: | --: | --: | ---: | ---: | ----: |
| static                 |  71 | 188 | 256 | 361 | 595 | 1112 | 5484 | 12278 |
| static-cv              |  66 | 110 | 200 | 302 | 694 | 1237 | 5584 | 12988 |
| static-cv-islands      |  90 | 151 | 192 | 285 | 513 | 1010 | 5142 |  8906 |
| static-cv-resumable    |  73 | 139 | 179 | 227 | 501 |  968 | 4235 |  9102 |
| static-cv-delegated    |  75 | 120 | 167 | 220 | 481 |  824 | 4228 |  8770 |
| static-cv-script       |  74 | 133 | 199 | 269 | 614 | 1176 | 6104 | 14374 |
| virtual-island         |  69 |  65 |  66 |  58 |  70 |   60 |   65 |    61 |
| virtual-island-visible |  72 |  66 |  68 |  71 |  66 |   55 |   64 |    57 |
| virtual-island-find    |  64 |  70 |  64 |  66 |  63 |   65 |   66 |    68 |
| virtual-spa            |  99 | 195 | 107 |  83 |  90 |  126 |   92 |   106 |

### Time to interactive (ms)

| impl                   | 100 | 500 |  1k |  2k |   5k |  10k |   50k |  100k |
| ---------------------- | --: | --: | --: | --: | ---: | ---: | ----: | ----: |
| static                 |  71 | 188 | 291 | 546 | 1304 | 2218 |  7130 | 22847 |
| static-cv              |  66 | 110 | 210 | 336 |  821 | 1542 |  7073 | 16555 |
| static-cv-islands      | 133 | 217 | 329 | 493 |  985 | 1999 | 10114 | 18423 |
| static-cv-resumable    |  83 | 145 | 200 | 296 |  728 | 1525 |  6004 | 13942 |
| static-cv-delegated    | 108 | 142 | 204 | 311 |  657 | 1308 |  6473 | 13459 |
| static-cv-script       |  74 | 133 | 204 | 293 |  777 | 1573 |  7860 | 19028 |
| virtual-island         | 114 |  96 | 103 |  95 |   96 |   94 |   100 |    85 |
| virtual-island-visible |  79 |  80 |  68 |  86 |   66 |   57 |    65 |    69 |
| virtual-island-find    |  93 |  98 | 110 | 204 |  180 |  183 |   176 |   185 |
| virtual-spa            | 131 | 222 | 133 | 127 |  127 |  157 |   132 |   138 |

### Total blocking time (ms)

| impl                   | 100 | 500 | 1k | 2k | 5k | 10k |  50k | 100k |
| ---------------------- | --: | --: | -: | -: | -: | --: | ---: | ---: |
| static                 |   0 |   0 |  0 |  0 | 66 | 384 | 5689 | 6206 |
| static-cv              |   0 |   0 |  0 |  0 |  0 |   1 |  345 | 1005 |
| static-cv-islands      |   0 |   0 |  2 | 28 | 88 | 429 | 2770 | 5554 |
| static-cv-resumable    |   0 |   0 |  0 |  0 |  0 |  57 |  836 | 1732 |
| static-cv-delegated    |   0 |   0 |  0 |  0 |  0 |   0 |  651 | 1287 |
| static-cv-script       |   0 |   0 |  0 |  0 |  0 |   2 |  504 | 1284 |
| virtual-island         |   0 |   0 |  0 |  0 |  0 |   0 |    0 |    0 |
| virtual-island-visible |   0 |   0 |  0 |  0 |  0 |   0 |    0 |    0 |
| virtual-island-find    |   0 |   0 |  0 | 36 | 30 |  36 |   30 |   28 |
| virtual-spa            |   0 |  13 |  0 |  0 |  0 |   0 |    0 |    0 |

### Load event (ms)

| impl                   | 100 | 500 |  1k |  2k |   5k |  10k |  50k |  100k |
| ---------------------- | --: | --: | --: | --: | ---: | ---: | ---: | ----: |
| static                 |  41 | 151 | 283 | 519 | 1311 | 2301 | 7767 | 23495 |
| static-cv              |  34 |  85 | 208 | 336 |  824 | 1552 | 7080 | 16569 |
| static-cv-islands      |  94 | 162 | 241 | 362 |  723 | 1496 | 7701 | 14007 |
| static-cv-resumable    |  83 | 145 | 201 | 298 |  734 | 1440 | 6118 | 14147 |
| static-cv-delegated    |  75 | 118 | 186 | 285 |  614 | 1232 | 6098 | 12799 |
| static-cv-script       |  63 | 130 | 205 | 294 |  781 | 1583 | 7950 | 19241 |
| virtual-island         |  72 |  59 |  62 |  53 |   63 |   57 |   58 |    55 |
| virtual-island-visible |  80 |  80 |  64 |  87 |   63 |   58 |   65 |    69 |
| virtual-island-find    |  58 |  56 |  59 |  64 |   62 |   60 |   55 |    65 |
| virtual-spa            |  56 |  88 |  58 |  37 |   45 |   64 |   40 |    43 |

### HTML transferred

| impl                   |   100 |   500 |     1k |     2k |     5k |    10k |    50k |    100k |
| ---------------------- | ----: | ----: | -----: | -----: | -----: | -----: | -----: | ------: |
| static                 | 18 KB | 83 KB | 158 KB | 309 KB | 765 KB | 1.5 MB | 7.5 MB | 15.0 MB |
| static-cv              | 18 KB | 83 KB | 158 KB | 309 KB | 765 KB | 1.5 MB | 7.5 MB | 15.0 MB |
| static-cv-islands      | 20 KB | 90 KB | 171 KB | 336 KB | 831 KB | 1.6 MB | 8.2 MB | 16.3 MB |
| static-cv-resumable    | 20 KB | 90 KB | 172 KB | 337 KB | 833 KB | 1.6 MB | 8.2 MB | 16.3 MB |
| static-cv-delegated    | 19 KB | 84 KB | 160 KB | 315 KB | 777 KB | 1.5 MB | 7.6 MB | 15.2 MB |
| static-cv-script       | 19 KB | 84 KB | 160 KB | 314 KB | 777 KB | 1.5 MB | 7.6 MB | 15.2 MB |
| virtual-island         |  5 KB |  5 KB |   5 KB |   5 KB |   5 KB |   5 KB |   5 KB |    5 KB |
| virtual-island-visible |  5 KB |  5 KB |   5 KB |   5 KB |   5 KB |   5 KB |   5 KB |    5 KB |
| virtual-island-find    |  5 KB |  5 KB |   5 KB |   5 KB |   5 KB |   5 KB |   5 KB |    5 KB |
| virtual-spa            |  1 KB |  1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |    1 KB |

### HTML decoded

| impl                   |    100 |    500 |      1k |     2k |     5k |    10k |     50k |    100k |
| ---------------------- | -----: | -----: | ------: | -----: | -----: | -----: | ------: | ------: |
| static                 |  73 KB | 357 KB |  696 KB | 1.3 MB | 3.3 MB | 6.7 MB | 33.4 MB | 66.7 MB |
| static-cv              |  73 KB | 357 KB |  696 KB | 1.3 MB | 3.3 MB | 6.7 MB | 33.4 MB | 66.7 MB |
| static-cv-islands      | 103 KB | 504 KB |  992 KB | 1.9 MB | 4.8 MB | 9.6 MB | 48.1 MB | 96.2 MB |
| static-cv-resumable    | 105 KB | 514 KB | 1011 KB | 2.0 MB | 4.9 MB | 9.8 MB | 49.0 MB | 98.0 MB |
| static-cv-delegated    |  84 KB | 407 KB |  796 KB | 1.5 MB | 3.8 MB | 7.7 MB | 38.3 MB | 76.4 MB |
| static-cv-script       |  83 KB | 407 KB |  795 KB | 1.5 MB | 3.8 MB | 7.7 MB | 38.3 MB | 76.4 MB |
| virtual-island         |  14 KB |  14 KB |   14 KB |  14 KB |  14 KB |  14 KB |   14 KB |   14 KB |
| virtual-island-visible |  14 KB |  14 KB |   14 KB |  14 KB |  14 KB |  14 KB |   14 KB |   14 KB |
| virtual-island-find    |  14 KB |  14 KB |   14 KB |  14 KB |  14 KB |  14 KB |   14 KB |   14 KB |
| virtual-spa            |   1 KB |   1 KB |    1 KB |   1 KB |   1 KB |   1 KB |    1 KB |    1 KB |

### JS transferred

| impl                   |   100 |   500 |    1k |    2k |    5k |   10k |   50k |  100k |
| ---------------------- | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: |
| static                 |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |
| static-cv              |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |
| static-cv-islands      | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB |
| static-cv-resumable    | 29 KB | 29 KB | 29 KB | 29 KB | 28 KB | 29 KB | 29 KB | 29 KB |
| static-cv-delegated    | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 50 KB |
| static-cv-script       |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |
| virtual-island         | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB |
| virtual-island-visible | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB |
| virtual-island-find    | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB |
| virtual-spa            | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB |

### JS decoded

| impl                   |    100 |    500 |     1k |     2k |     5k |    10k |    50k |   100k |
| ---------------------- | -----: | -----: | -----: | -----: | -----: | -----: | -----: | -----: |
| static                 |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |
| static-cv              |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |
| static-cv-islands      | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB |
| static-cv-resumable    |  72 KB |  72 KB |  72 KB |  72 KB |  71 KB |  72 KB |  72 KB |  72 KB |
| static-cv-delegated    | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB |
| static-cv-script       |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |
| virtual-island         | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB |
| virtual-island-visible |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |
| virtual-island-find    | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB |
| virtual-spa            | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB |

### DOM elements

| impl                   |   100 |   500 |     1k |     2k |     5k |     10k |     50k |      100k |
| ---------------------- | ----: | ----: | -----: | -----: | -----: | ------: | ------: | --------: |
| static                 |   893 | 4,477 |  8,962 | 17,624 | 44,297 |  88,937 | 443,750 |   886,223 |
| static-cv              |   893 | 4,477 |  8,962 | 17,624 | 44,297 |  88,937 | 443,750 |   886,223 |
| static-cv-islands      | 1,097 | 5,481 | 10,966 | 21,628 | 54,301 | 108,941 | 543,754 | 1,086,227 |
| static-cv-resumable    | 1,097 | 5,481 | 10,966 | 21,628 | 54,301 | 108,941 | 543,754 | 1,086,227 |
| static-cv-delegated    |   998 | 4,982 |  9,967 | 19,629 | 49,302 |  98,942 | 493,755 |   986,228 |
| static-cv-script       |   994 | 4,978 |  9,963 | 19,625 | 49,298 |  98,938 | 493,751 |   986,224 |
| virtual-island         |   124 |   124 |    124 |    124 |    124 |     124 |     124 |       124 |
| virtual-island-visible |   127 |   127 |    127 |    127 |    127 |     127 |     127 |       127 |
| virtual-island-find    |   216 |   616 |  1,116 |  2,116 |  2,116 |   2,116 |   2,116 |     2,116 |
| virtual-spa            |   118 |   131 |    134 |    123 |    111 |     113 |     136 |        93 |

### JS heap used

| impl                   |     100 |     500 |      1k |      2k |      5k |     10k |      50k |     100k |
| ---------------------- | ------: | ------: | ------: | ------: | ------: | ------: | -------: | -------: |
| static                 |  662 KB |  440 KB |  662 KB |  444 KB |  445 KB |  445 KB |   442 KB |   443 KB |
| static-cv              |  663 KB |  663 KB |  662 KB |  440 KB |  438 KB |  446 KB |   444 KB |   441 KB |
| static-cv-islands      |  1.5 MB |  3.8 MB |  6.2 MB |  8.2 MB | 24.2 MB | 35.7 MB | 235.5 MB | 416.1 MB |
| static-cv-resumable    | 1008 KB |  1.4 MB |  1.4 MB |  1.8 MB |  824 KB |  4.7 MB |  20.8 MB |  41.0 MB |
| static-cv-delegated    |  1.0 MB |  1.0 MB |  1.0 MB |  829 KB |  988 KB |  987 KB |   834 KB |   835 KB |
| static-cv-script       |  668 KB |  668 KB |  667 KB |  447 KB |  445 KB |  450 KB |   452 KB |   452 KB |
| virtual-island         |  1.7 MB |  1.7 MB |  1.6 MB |  1.6 MB |  1.6 MB |  1.6 MB |   1.7 MB |   1.8 MB |
| virtual-island-visible | 1013 KB | 1014 KB | 1014 KB | 1014 KB | 1014 KB | 1014 KB |  1013 KB |  1013 KB |
| virtual-island-find    |  2.1 MB |  4.2 MB |  5.8 MB | 11.6 MB | 12.5 MB | 12.5 MB |  12.1 MB |  11.6 MB |
| virtual-spa            |  2.0 MB |  2.1 MB |  2.2 MB |  2.0 MB |  1.9 MB |  2.0 MB |   2.1 MB |   1.8 MB |

### Renderer memory (private resident)

| impl                   |     100 |      500 |       1k |       2k |       5k |      10k |       50k |      100k |
| ---------------------- | ------: | -------: | -------: | -------: | -------: | -------: | --------: | --------: |
| static                 | 92.5 MB | 111.4 MB | 128.3 MB | 160.5 MB | 265.9 MB | 388.2 MB | 1706.8 MB | 3460.0 MB |
| static-cv              | 89.3 MB |  92.4 MB |  96.4 MB | 104.2 MB | 127.1 MB | 164.6 MB |  418.0 MB |  758.5 MB |
| static-cv-islands      | 93.8 MB | 105.4 MB | 117.9 MB | 140.5 MB | 187.9 MB | 274.7 MB |  970.5 MB | 1770.4 MB |
| static-cv-resumable    | 91.3 MB |  96.6 MB | 101.9 MB | 112.5 MB | 143.9 MB | 177.9 MB |  495.3 MB |  931.7 MB |
| static-cv-delegated    | 91.8 MB |  95.3 MB |  99.5 MB | 108.3 MB | 135.7 MB | 181.2 MB |  444.0 MB |  772.9 MB |
| static-cv-script       | 90.0 MB |  93.8 MB |  97.8 MB | 107.1 MB | 135.2 MB | 180.9 MB |  429.5 MB |  766.5 MB |
| virtual-island         | 92.9 MB |  92.5 MB |  92.6 MB |  92.3 MB |  92.6 MB |  92.6 MB |   92.6 MB |   92.5 MB |
| virtual-island-visible | 89.8 MB |  89.8 MB |  90.1 MB |  90.0 MB |  90.1 MB |  90.1 MB |   90.0 MB |   90.0 MB |
| virtual-island-find    | 94.8 MB | 102.0 MB | 108.7 MB | 123.5 MB | 123.4 MB | 123.1 MB |  122.8 MB |  122.0 MB |
| virtual-spa            | 93.2 MB |  93.3 MB |  93.5 MB |  93.1 MB |  92.7 MB |  93.3 MB |   93.0 MB |   92.7 MB |

### Scroll: p90 frame interval (ms) / missed frames

| impl                   |     100 |     500 |        1k |      2k |         5k |         10k |         50k |        100k |
| ---------------------- | ------: | ------: | --------: | ------: | ---------: | ----------: | ----------: | ----------: |
| static                 | 17 / 0% | 17 / 0% |   17 / 0% | 17 / 0% |    17 / 0% |     17 / 0% | 100 / 45.6% | 333 / 77.3% |
| static-cv              | 17 / 0% | 17 / 0% |   17 / 0% | 17 / 0% | 33 / 19.3% |  83 / 74.3% | 433 / 81.3% |  933 / 100% |
| static-cv-islands      | 17 / 0% | 17 / 0% |   17 / 0% | 17 / 0% | 33 / 43.3% |  83 / 81.1% |   533 / 80% |   983 / 90% |
| static-cv-resumable    | 17 / 0% | 17 / 0% |   17 / 0% | 17 / 0% | 33 / 32.9% | 100 / 81.8% | 467 / 88.2% | 933 / 88.9% |
| static-cv-delegated    | 17 / 0% | 17 / 0% |   17 / 0% | 17 / 0% | 33 / 40.3% |  67 / 82.3% | 483 / 81.3% | 950 / 90.9% |
| static-cv-script       | 17 / 0% | 17 / 0% |   17 / 0% | 17 / 0% | 33 / 22.6% |  83 / 82.5% | 467 / 76.5% | 933 / 90.9% |
| virtual-island         | 17 / 0% | 17 / 0% |   17 / 0% | 17 / 0% |    17 / 0% |     17 / 0% |     17 / 0% |     17 / 0% |
| virtual-island-visible | 17 / 0% | 17 / 0% |   17 / 0% | 17 / 0% |    17 / 0% |     17 / 0% |     17 / 0% |     17 / 0% |
| virtual-island-find    | 17 / 0% | 17 / 0% | 17 / 0.5% | 17 / 5% |  17 / 4.9% |   17 / 4.4% |   17 / 4.9% |   17 / 4.9% |
| virtual-spa            | 17 / 0% | 17 / 0% |   17 / 0% | 17 / 0% |    17 / 0% |     17 / 0% |     17 / 0% |     17 / 0% |

### Scroll: worst frame (ms)

| impl                   | 100 | 500 | 1k | 2k | 5k | 10k | 50k | 100k |
| ---------------------- | --: | --: | -: | -: | -: | --: | --: | ---: |
| static                 |  17 |  17 | 17 | 17 | 17 |  17 | 150 |  367 |
| static-cv              |  17 |  17 | 17 | 17 | 50 |  83 | 483 |  933 |
| static-cv-islands      |  17 |  17 | 17 | 17 | 67 | 100 | 600 |  983 |
| static-cv-resumable    |  17 |  17 | 17 | 17 | 50 | 117 | 500 |  967 |
| static-cv-delegated    |  17 |  17 | 17 | 17 | 50 | 100 | 483 | 1000 |
| static-cv-script       |  17 |  17 | 17 | 17 | 50 | 100 | 500 |  967 |
| virtual-island         |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |
| virtual-island-visible |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |
| virtual-island-find    |  17 |  17 | 33 | 67 | 67 |  67 |  50 |   67 |
| virtual-spa            |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |

### Row control: first click / second click → paint (ms)

| impl                   |     100 |     500 |      1k |      2k |      5k |      10k |       50k |      100k |
| ---------------------- | ------: | ------: | ------: | ------: | ------: | -------: | --------: | --------: |
| static                 |       — |       — |       — |       — |       — |        — |         — |         — |
| static-cv              |       — |       — |       — |       — |       — |        — |         — |         — |
| static-cv-islands      | 14 / 12 | 10 / 11 | 20 / 12 | 11 / 13 | 18 / 23 |  46 / 53 | 402 / 251 | 702 / 733 |
| static-cv-resumable    |  24 / 6 | 17 / 12 | 22 / 18 | 20 / 13 | 29 / 21 | 115 / 49 | 284 / 250 | 579 / 805 |
| static-cv-delegated    |  9 / 11 | 14 / 10 |  6 / 15 | 17 / 10 | 25 / 26 |  28 / 34 | 226 / 237 | 471 / 663 |
| static-cv-script       | 16 / 16 | 15 / 15 | 15 / 15 | 14 / 14 | 11 / 13 |  26 / 41 | 136 / 149 | 323 / 651 |
| virtual-island         |   5 / 6 |   7 / 7 | 17 / 15 | 14 / 12 | 12 / 11 |   11 / 9 |     7 / 6 |   10 / 13 |
| virtual-island-visible |   8 / 8 |  16 / 7 |  12 / 8 | 16 / 14 | 13 / 11 |   8 / 16 |   14 / 12 |     8 / 7 |
| virtual-island-find    |  8 / 15 | 21 / 19 | 22 / 24 | 41 / 31 | 49 / 30 |  35 / 23 |   43 / 25 |   44 / 31 |
| virtual-spa            |       — |       — |       — |       — |       — |        — |         — |         — |

### Find row n−1 (window.find; DOM hits)

| impl                   |            100 |            500 |             1k |             2k |             5k |            10k |            50k |           100k |
| ---------------------- | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: |
| static                 | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv              | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv-islands      | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv-resumable    | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv-delegated    | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv-script       | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| virtual-island         |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |
| virtual-island-visible |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |
| virtual-island-find    |  no (1 in DOM) |  no (1 in DOM) |  no (1 in DOM) |  no (1 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |
| virtual-spa            |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |

### Rows in the accessibility tree

| impl                   | 100 | 500 |    1k |    2k |    5k |    10k |    50k |    100k |
| ---------------------- | --: | --: | ----: | ----: | ----: | -----: | -----: | ------: |
| static                 | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv              | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-islands      | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 |       — |
| static-cv-resumable    | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 |       — |
| static-cv-delegated    | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-script       | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| virtual-island         |   4 |   4 |     4 |     4 |     4 |      4 |      4 |       4 |
| virtual-island-visible |   4 |   4 |     4 |     4 |     4 |      4 |      4 |       4 |
| virtual-island-find    |   4 |   4 |     4 |     4 |     4 |      4 |      4 |       4 |
| virtual-spa            |  12 |   6 |     6 |     6 |     6 |      6 |      6 |       6 |

## mobile · fixed

### TTFB (ms)

| impl                   | 100 | 500 | 1k |  2k |  5k | 10k |  50k | 100k |
| ---------------------- | --: | --: | -: | --: | --: | --: | ---: | ---: |
| static                 |  14 |  24 | 38 |  77 | 280 | 464 | 2514 | 3921 |
| static-cv              |  11 |  19 | 34 |  60 | 222 | 446 | 1984 | 4422 |
| static-cv-islands      |  16 |  33 | 63 | 105 | 354 | 610 | 2662 | 5444 |
| static-cv-resumable    |  17 |  36 | 67 | 139 | 305 | 623 | 2701 | 5042 |
| static-cv-delegated    |  39 |  50 | 78 | 121 | 306 | 598 | 2589 | 5263 |
| static-cv-script       |  13 |  33 | 61 |  97 | 343 | 604 | 2859 | 5914 |
| virtual-island         |  10 |  10 | 10 |   8 |  10 |  10 |   10 |    8 |
| virtual-island-visible |  23 |   8 |  8 |   8 |   8 |   9 |    9 |   10 |
| virtual-island-find    |   8 |   9 |  9 |  10 |   8 |   9 |    7 |    9 |
| virtual-spa            |   5 |   4 |  4 |   4 |   4 |   4 |    4 |    4 |

### FCP (ms)

| impl                   | 100 | 500 |  1k |  2k |  5k | 10k |  50k | 100k |
| ---------------------- | --: | --: | --: | --: | --: | --: | ---: | ---: |
| static                 | 188 | 209 | 197 | 183 | 423 | 628 | 2810 | 4042 |
| static-cv              | 147 | 151 | 157 | 156 | 317 | 535 | 2081 | 4513 |
| static-cv-islands      | 184 | 176 | 169 | 215 | 469 | 714 | 2777 | 5568 |
| static-cv-resumable    | 187 | 185 | 193 | 275 | 450 | 744 | 2810 | 5161 |
| static-cv-delegated    | 184 | 220 | 192 | 249 | 420 | 707 | 2730 | 5369 |
| static-cv-script       | 189 | 196 | 197 | 240 | 459 | 721 | 3060 | 6060 |
| virtual-island         | 167 | 164 | 214 | 162 | 163 | 316 |  170 |  160 |
| virtual-island-visible | 397 | 156 | 156 | 160 | 160 | 173 |  173 |  168 |
| virtual-island-find    | 171 | 146 | 169 | 171 | 160 | 154 |  159 |  155 |
| virtual-spa            | 332 | 314 | 317 | 330 | 320 | 331 |  324 |  334 |

### LCP (ms)

| impl                   | 100 | 500 |  1k |  2k |  5k | 10k |  50k | 100k |
| ---------------------- | --: | --: | --: | --: | --: | --: | ---: | ---: |
| static                 | 188 | 209 | 197 | 183 | 423 | 628 | 2810 | 4042 |
| static-cv              | 147 | 151 | 157 | 156 | 317 | 535 | 2081 | 4513 |
| static-cv-islands      | 184 | 176 | 169 | 215 | 469 | 714 | 2777 | 5568 |
| static-cv-resumable    | 187 | 185 | 193 | 275 | 450 | 744 | 2810 | 5161 |
| static-cv-delegated    | 184 | 220 | 192 | 249 | 420 | 707 | 2730 | 5369 |
| static-cv-script       | 189 | 196 | 197 | 240 | 459 | 721 | 3060 | 6060 |
| virtual-island         | 167 | 164 | 214 | 162 | 163 | 316 |  170 |  160 |
| virtual-island-visible | 397 | 156 | 156 | 160 | 160 | 173 |  173 |  168 |
| virtual-island-find    | 171 | 146 | 169 | 171 | 160 | 154 |  159 |  155 |
| virtual-spa            | 527 | 503 | 533 | 524 | 514 | 531 |  521 |  528 |

### Time to interactive (ms)

| impl                   | 100 | 500 |  1k |   2k |   5k |  10k |   50k |  100k |
| ---------------------- | --: | --: | --: | ---: | ---: | ---: | ----: | ----: |
| static                 | 188 | 307 | 469 |  929 | 1246 | 1755 | 31442 | 48483 |
| static-cv              | 147 | 152 | 235 |  304 |  712 | 1265 |  7929 | 21772 |
| static-cv-islands      | 635 | 732 | 877 | 1217 | 2424 | 4477 | 24783 | 57162 |
| static-cv-resumable    | 290 | 359 | 489 |  710 | 1385 | 3043 | 14145 | 34422 |
| static-cv-delegated    | 601 | 715 | 717 |  957 | 1464 | 2570 | 14072 | 34647 |
| static-cv-script       | 256 | 343 | 406 |  643 | 1136 | 2347 | 13275 | 32920 |
| virtual-island         | 666 | 641 | 717 |  657 |  643 |  862 |   662 |   630 |
| virtual-island-visible | 569 | 265 | 279 |  276 |  269 |  285 |   291 |   279 |
| virtual-island-find    | 656 | 688 | 784 |  899 |  884 |  866 |   855 |   884 |
| virtual-spa            | 541 | 518 | 552 |  543 |  529 |  545 |   531 |   534 |

### Total blocking time (ms)

| impl                   | 100 | 500 |  1k |  2k |   5k |  10k |   50k |  100k |
| ---------------------- | --: | --: | --: | --: | ---: | ---: | ----: | ----: |
| static                 |   0 |  33 |   1 |   0 | 1038 | 2497 |  2505 |  4483 |
| static-cv              |   0 |   0 |   0 |   0 |  116 |  398 |  1534 |  3274 |
| static-cv-islands      |   4 |  46 | 134 | 235 |  879 | 1974 | 10866 | 22147 |
| static-cv-resumable    |   0 |   0 |   0 |  10 |  211 |  735 |  3173 |  6162 |
| static-cv-delegated    |   0 |   0 |   0 |   0 |   85 |  365 |  2365 |  4801 |
| static-cv-script       |   0 |   0 |   0 |   0 |   83 |  356 |  2442 |  4966 |
| virtual-island         |  29 |   9 |  21 |   8 |   19 |   44 |    30 |    12 |
| virtual-island-visible |   0 |   0 |   0 |   0 |    0 |    0 |     0 |     0 |
| virtual-island-find    |  23 |  16 |  92 | 214 |  201 |  200 |   185 |   196 |
| virtual-spa            |  23 |  15 |  37 |  25 |   25 |   29 |    26 |    30 |

### Load event (ms)

| impl                   | 100 | 500 |  1k |  2k |   5k |  10k |   50k |  100k |
| ---------------------- | --: | --: | --: | --: | ---: | ---: | ----: | ----: |
| static                 | 184 | 234 | 435 | 933 | 1437 | 2375 | 31506 | 48834 |
| static-cv              | 144 | 155 | 240 | 310 |  689 | 1213 |  8082 | 21994 |
| static-cv-islands      | 298 | 346 | 410 | 631 | 1331 | 2519 | 14917 | 38295 |
| static-cv-resumable    | 291 | 363 | 496 | 721 | 1405 | 2603 | 14495 | 35119 |
| static-cv-delegated    | 299 | 412 | 418 | 656 | 1133 | 2176 | 12681 | 31360 |
| static-cv-script       | 257 | 345 | 413 | 655 | 1155 | 2415 | 13637 | 33720 |
| virtual-island         | 279 | 276 | 329 | 283 |  275 |  420 |   280 |   267 |
| virtual-island-visible | 571 | 265 | 280 | 276 |  270 |  286 |   292 |   280 |
| virtual-island-find    | 281 | 265 | 282 | 283 |  270 |  263 |   266 |   266 |
| virtual-spa            | 331 | 310 | 315 | 318 |  317 |  329 |   315 |   331 |

### HTML transferred

| impl                   |  100 |   500 |    1k |    2k |     5k |    10k |    50k |   100k |
| ---------------------- | ---: | ----: | ----: | ----: | -----: | -----: | -----: | -----: |
| static                 | 6 KB | 18 KB | 33 KB | 65 KB | 159 KB | 315 KB | 1.5 MB | 3.1 MB |
| static-cv              | 6 KB | 18 KB | 33 KB | 65 KB | 159 KB | 315 KB | 1.5 MB | 3.1 MB |
| static-cv-islands      | 7 KB | 23 KB | 44 KB | 85 KB | 209 KB | 414 KB | 2.0 MB | 4.0 MB |
| static-cv-resumable    | 7 KB | 24 KB | 45 KB | 86 KB | 210 KB | 417 KB | 2.0 MB | 4.1 MB |
| static-cv-delegated    | 6 KB | 19 KB | 35 KB | 66 KB | 162 KB | 321 KB | 1.6 MB | 3.1 MB |
| static-cv-script       | 6 KB | 19 KB | 34 KB | 66 KB | 162 KB | 321 KB | 1.6 MB | 3.1 MB |
| virtual-island         | 4 KB |  4 KB |  4 KB |  4 KB |   4 KB |   4 KB |   4 KB |   4 KB |
| virtual-island-visible | 4 KB |  4 KB |  4 KB |  4 KB |   4 KB |   4 KB |   4 KB |   4 KB |
| virtual-island-find    | 4 KB |  4 KB |  4 KB |  4 KB |   4 KB |   4 KB |   4 KB |   4 KB |
| virtual-spa            | 1 KB |  1 KB |  1 KB |  1 KB |   1 KB |   1 KB |   1 KB |   1 KB |

### HTML decoded

| impl                   |   100 |    500 |     1k |     2k |     5k |    10k |     50k |    100k |
| ---------------------- | ----: | -----: | -----: | -----: | -----: | -----: | ------: | ------: |
| static                 | 36 KB | 160 KB | 316 KB | 629 KB | 1.5 MB | 3.1 MB | 15.3 MB | 30.7 MB |
| static-cv              | 36 KB | 160 KB | 316 KB | 629 KB | 1.5 MB | 3.1 MB | 15.3 MB | 30.7 MB |
| static-cv-islands      | 65 KB | 308 KB | 613 KB | 1.2 MB | 3.0 MB | 6.0 MB | 30.0 MB | 60.2 MB |
| static-cv-resumable    | 67 KB | 317 KB | 631 KB | 1.2 MB | 3.1 MB | 6.2 MB | 30.9 MB | 62.0 MB |
| static-cv-delegated    | 46 KB | 211 KB | 416 KB | 829 KB | 2.0 MB | 4.0 MB | 20.2 MB | 40.4 MB |
| static-cv-script       | 46 KB | 210 KB | 416 KB | 828 KB | 2.0 MB | 4.0 MB | 20.2 MB | 40.4 MB |
| virtual-island         | 19 KB |  19 KB |  19 KB |  19 KB |  19 KB |  19 KB |   19 KB |   19 KB |
| virtual-island-visible | 20 KB |  20 KB |  20 KB |  20 KB |  20 KB |  20 KB |   20 KB |   20 KB |
| virtual-island-find    | 19 KB |  19 KB |  19 KB |  19 KB |  19 KB |  19 KB |   19 KB |   19 KB |
| virtual-spa            |  1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |    1 KB |    1 KB |

### JS transferred

| impl                   |   100 |   500 |    1k |    2k |    5k |   10k |   50k |  100k |
| ---------------------- | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: |
| static                 |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |
| static-cv              |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |
| static-cv-islands      | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB |
| static-cv-resumable    | 29 KB | 29 KB | 29 KB | 29 KB | 29 KB | 29 KB | 29 KB | 28 KB |
| static-cv-delegated    | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB |
| static-cv-script       |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |
| virtual-island         | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB |
| virtual-island-visible | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB |
| virtual-island-find    | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB |
| virtual-spa            | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB |

### JS decoded

| impl                   |    100 |    500 |     1k |     2k |     5k |    10k |    50k |   100k |
| ---------------------- | -----: | -----: | -----: | -----: | -----: | -----: | -----: | -----: |
| static                 |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |
| static-cv              |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |
| static-cv-islands      | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB |
| static-cv-resumable    |  72 KB |  72 KB |  72 KB |  72 KB |  72 KB |  72 KB |  72 KB |  71 KB |
| static-cv-delegated    | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB |
| static-cv-script       |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |
| virtual-island         | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB |
| virtual-island-visible |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |
| virtual-island-find    | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB |
| virtual-spa            | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB |

### DOM elements

| impl                   | 100 |   500 |    1k |     2k |     5k |    10k |     50k |    100k |
| ---------------------- | --: | ----: | ----: | -----: | -----: | -----: | ------: | ------: |
| static                 | 710 | 3,510 | 7,010 | 14,010 | 35,010 | 70,010 | 350,010 | 700,010 |
| static-cv              | 710 | 3,510 | 7,010 | 14,010 | 35,010 | 70,010 | 350,010 | 700,010 |
| static-cv-islands      | 914 | 4,514 | 9,014 | 18,014 | 45,014 | 90,014 | 450,014 | 900,014 |
| static-cv-resumable    | 914 | 4,514 | 9,014 | 18,014 | 45,014 | 90,014 | 450,014 | 900,014 |
| static-cv-delegated    | 815 | 4,015 | 8,015 | 16,015 | 40,015 | 80,015 | 400,015 | 800,015 |
| static-cv-script       | 811 | 4,011 | 8,011 | 16,011 | 40,011 | 80,011 | 400,011 | 800,011 |
| virtual-island         | 278 |   278 |   278 |    278 |    278 |    278 |     278 |     278 |
| virtual-island-visible | 281 |   281 |   281 |    281 |    281 |    281 |     281 |     281 |
| virtual-island-find    | 350 |   750 | 1,250 |  2,250 |  2,250 |  2,250 |   2,250 |   2,250 |
| virtual-spa            | 229 |   229 |   229 |    229 |    229 |    229 |     229 |     229 |

### JS heap used

| impl                   |    100 |    500 |     1k |     2k |      5k |     10k |      50k |     100k |
| ---------------------- | -----: | -----: | -----: | -----: | ------: | ------: | -------: | -------: |
| static                 | 752 KB | 514 KB | 515 KB | 510 KB |  514 KB |  511 KB |   514 KB |   516 KB |
| static-cv              | 753 KB | 752 KB | 752 KB | 752 KB |  514 KB |  513 KB |   513 KB |   514 KB |
| static-cv-islands      | 1.6 MB | 3.8 MB | 6.1 MB | 8.2 MB | 25.1 MB | 45.6 MB | 241.7 MB | 396.7 MB |
| static-cv-resumable    | 1.0 MB | 1.5 MB | 1.4 MB | 1.7 MB |  2.8 MB |  4.3 MB |  20.8 MB |   692 KB |
| static-cv-delegated    | 1.1 MB | 1.1 MB | 1.1 MB | 1.1 MB |  852 KB |  855 KB |   856 KB |   859 KB |
| static-cv-script       | 757 KB | 757 KB | 757 KB | 755 KB |  520 KB |  522 KB |   521 KB |   523 KB |
| virtual-island         | 2.0 MB | 2.2 MB | 2.1 MB | 2.5 MB |  3.7 MB |  3.3 MB |   8.4 MB |   2.1 MB |
| virtual-island-visible | 1.0 MB | 1.0 MB | 1.0 MB | 1.0 MB |  1.0 MB |  1.0 MB |   1.0 MB |   1.0 MB |
| virtual-island-find    | 2.2 MB | 3.4 MB | 3.8 MB | 5.5 MB |  5.9 MB |  8.1 MB |  15.9 MB |   5.4 MB |
| virtual-spa            | 2.1 MB | 2.1 MB | 2.5 MB | 2.5 MB |  3.5 MB |  5.5 MB |   5.2 MB |   2.0 MB |

### Renderer memory (private resident)

| impl                   |     100 |      500 |       1k |       2k |       5k |      10k |      50k |      100k |
| ---------------------- | ------: | -------: | -------: | -------: | -------: | -------: | -------: | --------: |
| static                 | 90.6 MB | 100.1 MB | 110.8 MB | 127.9 MB | 186.6 MB | 292.0 MB | 982.6 MB | 1923.2 MB |
| static-cv              | 89.6 MB |  92.1 MB |  95.2 MB | 100.8 MB | 118.1 MB | 145.4 MB | 370.5 MB |  584.3 MB |
| static-cv-islands      | 94.3 MB | 104.7 MB | 117.0 MB | 136.5 MB | 184.3 MB | 282.0 MB | 893.0 MB | 1628.0 MB |
| static-cv-resumable    | 91.8 MB |  96.3 MB | 101.0 MB | 110.0 MB | 136.0 MB | 178.6 MB | 441.6 MB |  738.4 MB |
| static-cv-delegated    | 92.1 MB |  94.8 MB |  98.1 MB | 105.4 MB | 125.3 MB | 158.2 MB | 365.1 MB |  637.3 MB |
| static-cv-script       | 90.4 MB |  93.4 MB |  96.8 MB | 104.3 MB | 124.0 MB | 157.4 MB | 363.0 MB |  642.4 MB |
| virtual-island         | 93.3 MB |  94.6 MB |  94.8 MB |  95.7 MB |  98.1 MB | 102.5 MB | 129.1 MB |   93.1 MB |
| virtual-island-visible | 90.3 MB |  90.2 MB |  90.2 MB |  90.2 MB |  90.4 MB |  90.3 MB |  90.2 MB |   90.2 MB |
| virtual-island-find    | 94.4 MB |  98.1 MB | 101.5 MB | 110.5 MB | 111.7 MB | 115.8 MB | 132.3 MB |  109.9 MB |
| virtual-spa            | 93.4 MB |  94.5 MB |  94.8 MB |  95.8 MB |  98.0 MB | 101.9 MB | 127.9 MB |   93.1 MB |

### Scroll: p90 frame interval (ms) / missed frames

| impl                   |        100 |     500 |      1k |      2k |        5k |       10k |        50k |       100k |
| ---------------------- | ---------: | ------: | ------: | ------: | --------: | --------: | ---------: | ---------: |
| static                 |    17 / 0% | 17 / 0% | 17 / 0% | 17 / 0% | 17 / 0.4% | 17 / 0.4% |  17 / 1.4% |  17 / 0.9% |
| static-cv              |    17 / 0% | 17 / 0% | 17 / 0% | 17 / 0% | 17 / 0.4% | 17 / 0.9% | 67 / 98.8% | 117 / 100% |
| static-cv-islands      |    17 / 0% | 17 / 0% | 17 / 0% | 17 / 0% | 17 / 0.9% | 17 / 1.3% |  67 / 100% | 150 / 100% |
| static-cv-resumable    |    17 / 0% | 17 / 0% | 17 / 0% | 17 / 0% | 17 / 0.9% | 17 / 1.4% | 67 / 98.7% | 150 / 100% |
| static-cv-delegated    |    17 / 0% | 17 / 0% | 17 / 0% | 17 / 0% | 17 / 0.9% | 17 / 1.3% | 67 / 98.5% | 617 / 100% |
| static-cv-script       |    17 / 0% | 17 / 0% | 17 / 0% | 17 / 0% | 17 / 0.9% | 17 / 1.3% | 67 / 98.7% | 167 / 100% |
| virtual-island         |    17 / 0% | 17 / 0% | 17 / 0% | 17 / 0% |   17 / 0% |  33 / 10% |    17 / 0% |    17 / 0% |
| virtual-island-visible | 33 / 16.1% | 17 / 0% | 17 / 0% | 17 / 0% |   17 / 0% |   17 / 0% |    17 / 0% |    17 / 0% |
| virtual-island-find    |    17 / 0% | 17 / 0% | 17 / 0% | 17 / 0% |   17 / 0% |   17 / 0% |    17 / 0% |    17 / 0% |
| virtual-spa            |    17 / 0% | 17 / 0% | 17 / 0% | 17 / 0% |   17 / 0% |   17 / 0% |    17 / 0% |    17 / 0% |

### Scroll: worst frame (ms)

| impl                   | 100 | 500 | 1k | 2k | 5k | 10k | 50k | 100k |
| ---------------------- | --: | --: | -: | -: | -: | --: | --: | ---: |
| static                 |  17 |  17 | 17 | 17 | 83 |  67 | 167 |  383 |
| static-cv              |  17 |  17 | 17 | 17 | 50 | 100 | 450 |  950 |
| static-cv-islands      |  17 |  17 | 17 | 17 | 33 |  83 | 550 |  800 |
| static-cv-resumable    |  17 |  17 | 17 | 17 | 33 | 117 | 583 |  183 |
| static-cv-delegated    |  17 |  17 | 17 | 17 | 33 |  67 | 650 |  933 |
| static-cv-script       |  17 |  17 | 17 | 17 | 33 | 100 | 483 |  267 |
| virtual-island         |  17 |  17 | 17 | 17 | 17 |  33 |  17 |   17 |
| virtual-island-visible |  50 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |
| virtual-island-find    |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |
| virtual-spa            |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |

### Row control: first click / second click → paint (ms)

| impl                   |     100 |      500 |       1k |       2k |        5k |       10k |         50k |        100k |
| ---------------------- | ------: | -------: | -------: | -------: | --------: | --------: | ----------: | ----------: |
| static                 |       — |        — |        — |        — |         — |         — |           — |           — |
| static-cv              |       — |        — |        — |        — |         — |         — |           — |           — |
| static-cv-islands      | 14 / 15 |  20 / 16 |  24 / 27 |  40 / 31 |   59 / 52 | 235 / 179 | 1210 / 1236 | 2398 / 3229 |
| static-cv-resumable    | 166 / 9 | 182 / 23 | 178 / 44 | 181 / 43 | 213 / 128 | 360 / 207 |  822 / 1408 | 1828 / 3323 |
| static-cv-delegated    |  17 / 4 |  10 / 21 |  17 / 28 |  18 / 38 |  119 / 85 | 191 / 174 |  881 / 1185 | 2277 / 3332 |
| static-cv-script       | 12 / 14 |  12 / 13 |  11 / 25 |  25 / 26 |  73 / 117 | 107 / 106 |  1143 / 943 | 1085 / 1962 |
| virtual-island         | 23 / 15 |  14 / 12 |   21 / 8 |  20 / 12 |   17 / 14 |    38 / 8 |     29 / 15 |       7 / 9 |
| virtual-island-visible | 50 / 21 |  18 / 15 |  15 / 16 |  19 / 17 |   31 / 16 |   19 / 22 |     26 / 20 |     17 / 12 |
| virtual-island-find    | 28 / 22 |  48 / 35 |  79 / 46 | 129 / 84 | 181 / 127 |  172 / 66 |   154 / 114 |    125 / 78 |
| virtual-spa            |       — |        — |        — |        — |         — |         — |           — |           — |

### Find row n−1 (window.find; DOM hits)

| impl                   |            100 |            500 |             1k |             2k |             5k |            10k |            50k |           100k |
| ---------------------- | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: |
| static                 | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |
| static-cv              | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |
| static-cv-islands      | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |
| static-cv-resumable    | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |
| static-cv-delegated    | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |
| static-cv-script       | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |
| virtual-island         |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |
| virtual-island-visible |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |
| virtual-island-find    |  no (1 in DOM) |  no (1 in DOM) |  no (1 in DOM) |  no (1 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |
| virtual-spa            |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |

### Rows in the accessibility tree

| impl                   | 100 | 500 |    1k |    2k |    5k |    10k |    50k |    100k |
| ---------------------- | --: | --: | ----: | ----: | ----: | -----: | -----: | ------: |
| static                 | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv              | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-islands      | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-resumable    | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-delegated    | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-script       | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| virtual-island         |  29 |  29 |    29 |    29 |    29 |     29 |     29 |      29 |
| virtual-island-visible |  29 |  29 |    29 |    29 |    29 |     29 |     29 |      29 |
| virtual-island-find    |  51 |  51 |    51 |    51 |    29 |     29 |     29 |      29 |
| virtual-spa            |  29 |  29 |    29 |    29 |    29 |     29 |     29 |      29 |

## mobile · chat

### TTFB (ms)

| impl                   | 100 | 500 |  1k |  2k |   5k |  10k |  50k |  100k |
| ---------------------- | --: | --: | --: | --: | ---: | ---: | ---: | ----: |
| static                 |  22 |  49 |  94 | 242 |  510 | 1094 | 5755 |  skip |
| static-cv              |  19 |  52 |  86 | 255 |  540 |  999 | 5332 | 11662 |
| static-cv-islands      |  19 |  77 | 107 | 212 | 1125 |  886 | 4875 |  skip |
| static-cv-resumable    |  19 |  74 |  75 | 155 |  404 |  962 | 4410 |  9497 |
| static-cv-delegated    |  21 |  65 |  95 | 184 |  426 |  879 | 4300 |  9458 |
| static-cv-script       |  22 |  46 | 105 | 260 |  659 | 1306 | 6159 | 15509 |
| virtual-island         |   9 |   8 |   7 |   8 |    8 |    8 |    8 |     8 |
| virtual-island-visible |   7 |   7 |   8 |   7 |    8 |    8 |    8 |     8 |
| virtual-island-find    |   7 |   7 |   7 |   8 |    8 |    7 |    7 |     7 |
| virtual-spa            |   4 |   4 |   4 |   4 |    4 |    4 |    4 |     4 |

### FCP (ms)

| impl                   | 100 | 500 |  1k |  2k |   5k |  10k |  50k |  100k |
| ---------------------- | --: | --: | --: | --: | ---: | ---: | ---: | ----: |
| static                 | 214 | 235 | 257 | 404 |  637 | 1251 | 5905 |  skip |
| static-cv              | 147 | 153 | 201 | 345 |  639 | 1116 | 5428 | 11761 |
| static-cv-islands      | 169 | 232 | 231 | 343 | 1425 |  993 | 4986 |  skip |
| static-cv-resumable    | 178 | 198 | 199 | 258 |  509 | 1081 | 4530 |  9602 |
| static-cv-delegated    | 177 | 200 | 216 | 312 |  526 | 1011 | 4418 |  9582 |
| static-cv-script       | 181 | 164 | 219 | 364 |  773 | 1400 | 6268 | 15638 |
| virtual-island         | 162 | 161 | 169 | 169 |  159 |  165 |  162 |   178 |
| virtual-island-visible | 164 | 169 | 165 | 160 |  155 |  155 |  165 |   157 |
| virtual-island-find    | 157 | 154 | 155 | 174 |  172 |  169 |  157 |   159 |
| virtual-spa            | 327 | 327 | 312 | 323 |  329 |  324 |  317 |   322 |

### LCP (ms)

| impl                   | 100 | 500 |  1k |  2k |   5k |  10k |  50k |  100k |
| ---------------------- | --: | --: | --: | --: | ---: | ---: | ---: | ----: |
| static                 | 214 | 235 | 257 | 404 |  637 | 1251 | 5905 |  skip |
| static-cv              | 147 | 153 | 201 | 345 |  639 | 1116 | 5428 | 11761 |
| static-cv-islands      | 169 | 232 | 231 | 343 | 1425 |  993 | 4986 |  skip |
| static-cv-resumable    | 178 | 198 | 199 | 258 |  509 | 1081 | 4530 |  9602 |
| static-cv-delegated    | 177 | 200 | 216 | 312 |  526 | 1011 | 4418 |  9582 |
| static-cv-script       | 181 | 164 | 219 | 364 |  773 | 1400 | 6268 | 15638 |
| virtual-island         | 162 | 161 | 169 | 169 |  159 |  165 |  162 |   178 |
| virtual-island-visible | 164 | 169 | 165 | 160 |  155 |  155 |  165 |   157 |
| virtual-island-find    | 157 | 154 | 155 | 174 |  172 |  169 |  157 |   159 |
| virtual-spa            | 535 | 535 | 517 | 519 |  533 |  529 |  535 |   533 |

### Time to interactive (ms)

| impl                   | 100 | 500 |   1k |   2k |   5k |  10k |   50k |  100k |
| ---------------------- | --: | --: | ---: | ---: | ---: | ---: | ----: | ----: |
| static                 | 214 | 505 |  890 | 1543 | 2103 | 9625 | 43989 |  skip |
| static-cv              | 147 | 199 |  319 |  633 | 1576 | 3065 | 15611 | 35523 |
| static-cv-islands      | 623 | 835 | 1055 | 1586 | 4847 | 5841 | 33022 |  skip |
| static-cv-resumable    | 285 | 406 |  503 |  769 | 1829 | 3878 | 19766 | 55586 |
| static-cv-delegated    | 588 | 684 |  829 | 1132 | 2077 | 3901 | 21168 | 53966 |
| static-cv-script       | 261 | 313 |  439 |  764 | 1889 | 3861 | 18757 | 52327 |
| virtual-island         | 633 | 638 |  666 |  652 |  651 |  647 |   629 |   660 |
| virtual-island-visible | 274 | 280 |  276 |  278 |  273 |  270 |   281 |   270 |
| virtual-island-find    | 642 | 733 |  803 | 1033 |  955 |  932 |   974 |   927 |
| virtual-spa            | 575 | 578 |  550 |  552 |  576 |  568 |   575 |   563 |

### Total blocking time (ms)

| impl                   | 100 | 500 |  1k |  2k |   5k |  10k |   50k | 100k |
| ---------------------- | --: | --: | --: | --: | ---: | ---: | ----: | ---: |
| static                 |   0 |  30 |  29 | 336 | 2167 |  324 |  6668 | skip |
| static-cv              |   0 |   0 |   0 |   0 |    0 |  136 |  1826 | 4386 |
| static-cv-islands      |   0 |  78 | 148 | 362 | 1656 | 2276 | 12169 | skip |
| static-cv-resumable    |   0 |   0 |   0 |  17 |   95 |  578 |  3812 | 8175 |
| static-cv-delegated    |   0 |   0 |   0 |  12 |   45 |  417 |  3005 | 6542 |
| static-cv-script       |   0 |   0 |   0 |   0 |   96 |  310 |  2641 | 6059 |
| virtual-island         |   4 |  10 |  22 |  11 |   19 |   18 |     6 |   16 |
| virtual-island-visible |   0 |   0 |   0 |   0 |    0 |    0 |     0 |    0 |
| virtual-island-find    |  14 |  59 | 136 | 342 |  270 |  264 |   283 |  252 |
| virtual-spa            |  31 |  31 |  23 |  14 |   21 |   26 |    15 |   28 |

### Load event (ms)

| impl                   | 100 | 500 |  1k |   2k |   5k |  10k |   50k |  100k |
| ---------------------- | --: | --: | --: | ---: | ---: | ---: | ----: | ----: |
| static                 | 212 | 440 | 898 | 1593 | 2342 | 9629 | 44344 |  skip |
| static-cv              | 143 | 202 | 323 |  639 | 1586 | 3071 | 15671 | 35900 |
| static-cv-islands      | 277 | 415 | 560 |  950 | 3205 | 3722 | 22544 |  skip |
| static-cv-resumable    | 286 | 408 | 508 |  777 | 1768 | 3787 | 20221 | 56545 |
| static-cv-delegated    | 285 | 380 | 532 |  836 | 1714 | 3481 | 19547 | 49842 |
| static-cv-script       | 262 | 315 | 443 |  775 | 1916 | 3839 | 19307 | 53293 |
| virtual-island         | 270 | 270 | 281 |  283 |  270 |  273 |   269 |   277 |
| virtual-island-visible | 275 | 281 | 277 |  279 |  273 |  271 |   282 |   270 |
| virtual-island-find    | 267 | 270 | 264 |  279 |  283 |  272 |   265 |   269 |
| virtual-spa            | 326 | 325 | 311 |  320 |  323 |  323 |   315 |   320 |

### HTML transferred

| impl                   |   100 |   500 |     1k |     2k |     5k |    10k |    50k |    100k |
| ---------------------- | ----: | ----: | -----: | -----: | -----: | -----: | -----: | ------: |
| static                 | 18 KB | 83 KB | 158 KB | 309 KB | 764 KB | 1.5 MB | 7.5 MB |    skip |
| static-cv              | 18 KB | 83 KB | 158 KB | 309 KB | 764 KB | 1.5 MB | 7.5 MB | 15.0 MB |
| static-cv-islands      | 20 KB | 90 KB | 171 KB | 336 KB | 831 KB | 1.6 MB | 8.2 MB |    skip |
| static-cv-resumable    | 20 KB | 90 KB | 172 KB | 337 KB | 833 KB | 1.6 MB | 8.2 MB | 16.3 MB |
| static-cv-delegated    | 19 KB | 84 KB | 160 KB | 315 KB | 777 KB | 1.5 MB | 7.6 MB | 15.3 MB |
| static-cv-script       | 18 KB | 84 KB | 160 KB | 314 KB | 777 KB | 1.5 MB | 7.6 MB | 15.2 MB |
| virtual-island         |  5 KB |  5 KB |   5 KB |   5 KB |   5 KB |   5 KB |   5 KB |    5 KB |
| virtual-island-visible |  5 KB |  5 KB |   5 KB |   5 KB |   5 KB |   5 KB |   5 KB |    5 KB |
| virtual-island-find    |  5 KB |  5 KB |   5 KB |   5 KB |   5 KB |   5 KB |   5 KB |    5 KB |
| virtual-spa            |  1 KB |  1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |    1 KB |

### HTML decoded

| impl                   |    100 |    500 |      1k |     2k |     5k |    10k |     50k |    100k |
| ---------------------- | -----: | -----: | ------: | -----: | -----: | -----: | ------: | ------: |
| static                 |  73 KB | 357 KB |  696 KB | 1.3 MB | 3.3 MB | 6.7 MB | 33.4 MB |    skip |
| static-cv              |  73 KB | 357 KB |  696 KB | 1.3 MB | 3.3 MB | 6.7 MB | 33.4 MB | 66.7 MB |
| static-cv-islands      | 103 KB | 504 KB |  992 KB | 1.9 MB | 4.8 MB | 9.6 MB | 48.1 MB |    skip |
| static-cv-resumable    | 105 KB | 514 KB | 1011 KB | 2.0 MB | 4.9 MB | 9.8 MB | 49.0 MB | 98.0 MB |
| static-cv-delegated    |  84 KB | 407 KB |  796 KB | 1.5 MB | 3.8 MB | 7.7 MB | 38.3 MB | 76.4 MB |
| static-cv-script       |  83 KB | 407 KB |  795 KB | 1.5 MB | 3.8 MB | 7.7 MB | 38.3 MB | 76.4 MB |
| virtual-island         |  14 KB |  14 KB |   14 KB |  14 KB |  14 KB |  14 KB |   14 KB |   14 KB |
| virtual-island-visible |  14 KB |  14 KB |   14 KB |  14 KB |  14 KB |  14 KB |   14 KB |   14 KB |
| virtual-island-find    |  14 KB |  14 KB |   14 KB |  14 KB |  14 KB |  14 KB |   14 KB |   14 KB |
| virtual-spa            |   1 KB |   1 KB |    1 KB |   1 KB |   1 KB |   1 KB |    1 KB |    1 KB |

### JS transferred

| impl                   |   100 |   500 |    1k |    2k |    5k |   10k |   50k |  100k |
| ---------------------- | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: |
| static                 |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  skip |
| static-cv              |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |  0 KB |
| static-cv-islands      | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB | 50 KB |  skip |
| static-cv-resumable    | 29 KB | 29 KB | 29 KB | 29 KB | 29 KB | 29 KB | 28 KB | 28 KB |
| static-cv-delegated    | 50 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 49 KB | 50 KB |
| static-cv-script       |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |  1 KB |
| virtual-island         | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB |
| virtual-island-visible | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB | 28 KB |
| virtual-island-find    | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB | 53 KB |
| virtual-spa            | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB | 82 KB |

### JS decoded

| impl                   |    100 |    500 |     1k |     2k |     5k |    10k |    50k |   100k |
| ---------------------- | -----: | -----: | -----: | -----: | -----: | -----: | -----: | -----: |
| static                 |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   skip |
| static-cv              |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |   0 KB |
| static-cv-islands      | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB | 128 KB |   skip |
| static-cv-resumable    |  72 KB |  72 KB |  72 KB |  72 KB |  72 KB |  72 KB |  71 KB |  71 KB |
| static-cv-delegated    | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB | 127 KB |
| static-cv-script       |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |   1 KB |
| virtual-island         | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB |
| virtual-island-visible |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |  70 KB |
| virtual-island-find    | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB | 135 KB |
| virtual-spa            | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB | 211 KB |

### DOM elements

| impl                   |   100 |   500 |     1k |     2k |     5k |     10k |     50k |      100k |
| ---------------------- | ----: | ----: | -----: | -----: | -----: | ------: | ------: | --------: |
| static                 |   893 | 4,477 |  8,962 | 17,624 | 44,297 |  88,937 | 443,750 |      skip |
| static-cv              |   893 | 4,477 |  8,962 | 17,624 | 44,297 |  88,937 | 443,750 |   886,223 |
| static-cv-islands      | 1,097 | 5,481 | 10,966 | 21,628 | 54,301 | 108,941 | 543,754 |      skip |
| static-cv-resumable    | 1,097 | 5,481 | 10,966 | 21,628 | 54,301 | 108,941 | 543,754 | 1,086,227 |
| static-cv-delegated    |   998 | 4,982 |  9,967 | 19,629 | 49,302 |  98,942 | 493,755 |   986,228 |
| static-cv-script       |   994 | 4,978 |  9,963 | 19,625 | 49,298 |  98,938 | 493,751 |   986,224 |
| virtual-island         |   124 |   124 |    124 |    124 |    124 |     124 |     124 |       124 |
| virtual-island-visible |   127 |   127 |    127 |    127 |    127 |     127 |     127 |       127 |
| virtual-island-find    |   216 |   616 |  1,116 |  2,116 |  2,116 |   2,116 |   2,116 |     2,116 |
| virtual-spa            |   118 |   131 |    134 |     85 |    111 |     113 |     136 |        93 |

### JS heap used

| impl                   |    100 |    500 |     1k |      2k |      5k |     10k |      50k |    100k |
| ---------------------- | -----: | -----: | -----: | ------: | ------: | ------: | -------: | ------: |
| static                 | 751 KB | 514 KB | 516 KB |  515 KB |  512 KB |  515 KB |   514 KB |    skip |
| static-cv              | 753 KB | 752 KB | 752 KB |  510 KB |  748 KB |  757 KB |   754 KB |  516 KB |
| static-cv-islands      | 1.5 MB | 3.8 MB | 6.1 MB |  8.2 MB | 25.1 MB | 46.4 MB | 190.4 MB |    skip |
| static-cv-resumable    | 1.0 MB | 1.5 MB | 1.4 MB |  1.7 MB |  2.8 MB |  4.3 MB |   693 KB |  695 KB |
| static-cv-delegated    | 1.1 MB | 1.1 MB | 1.1 MB |  853 KB |  856 KB |  858 KB |   858 KB |  860 KB |
| static-cv-script       | 757 KB | 757 KB | 756 KB |  516 KB |  522 KB |  525 KB |   525 KB |  524 KB |
| virtual-island         | 1.7 MB | 1.8 MB | 1.6 MB |  1.6 MB |  1.6 MB |  1.6 MB |   1.8 MB |  1.8 MB |
| virtual-island-visible | 1.0 MB | 1.0 MB | 1.0 MB |  1.0 MB |  1.0 MB |  1.0 MB |   1.0 MB |  1.0 MB |
| virtual-island-find    | 2.1 MB | 3.9 MB | 5.5 MB | 12.0 MB | 12.1 MB | 12.0 MB |  12.1 MB | 11.9 MB |
| virtual-spa            | 2.1 MB | 2.1 MB | 2.2 MB |  1.8 MB |  2.0 MB |  2.0 MB |   2.2 MB |  1.9 MB |

### Renderer memory (private resident)

| impl                   |     100 |      500 |       1k |       2k |       5k |      10k |       50k |     100k |
| ---------------------- | ------: | -------: | -------: | -------: | -------: | -------: | --------: | -------: |
| static                 | 91.6 MB | 107.0 MB | 125.9 MB | 157.6 MB | 254.2 MB | 425.2 MB | 1648.9 MB |     skip |
| static-cv              | 89.3 MB |  92.7 MB |  96.6 MB | 104.0 MB | 126.0 MB | 162.2 MB |  408.4 MB | 725.4 MB |
| static-cv-islands      | 93.5 MB | 104.9 MB | 118.2 MB | 140.0 MB | 193.3 MB | 280.6 MB |  899.6 MB |     skip |
| static-cv-resumable    | 91.2 MB |  96.4 MB | 102.2 MB | 112.9 MB | 146.6 MB | 173.4 MB |  466.0 MB | 847.2 MB |
| static-cv-delegated    | 91.5 MB |  95.3 MB |  99.9 MB | 108.4 MB | 132.1 MB | 175.2 MB |  413.2 MB | 751.2 MB |
| static-cv-script       | 90.1 MB |  93.9 MB |  98.2 MB | 107.3 MB | 134.7 MB | 175.6 MB |  413.8 MB | 777.6 MB |
| virtual-island         | 92.3 MB |  92.3 MB |  92.1 MB |  92.3 MB |  92.0 MB |  92.2 MB |   92.3 MB |  92.3 MB |
| virtual-island-visible | 89.8 MB |  89.8 MB |  89.8 MB |  89.8 MB |  89.7 MB |  89.8 MB |   89.8 MB |  90.0 MB |
| virtual-island-find    | 94.4 MB | 100.8 MB | 107.7 MB | 121.6 MB | 121.3 MB | 121.4 MB |  121.6 MB | 121.5 MB |
| virtual-spa            | 93.0 MB |  93.1 MB |  93.4 MB |  92.1 MB |  92.8 MB |  92.8 MB |   93.0 MB |  92.6 MB |

### Scroll: p90 frame interval (ms) / missed frames

| impl                   |     100 |       500 |      1k |        2k |         5k |       10k |        50k |       100k |
| ---------------------- | ------: | --------: | ------: | --------: | ---------: | --------: | ---------: | ---------: |
| static                 | 17 / 0% |   17 / 0% | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% |  17 / 0.4% |       skip |
| static-cv              | 17 / 0% |   17 / 0% | 17 / 0% |   17 / 0% |  17 / 0.4% | 17 / 0.4% | 67 / 98.8% | 133 / 100% |
| static-cv-islands      | 17 / 0% | 17 / 0.4% | 17 / 0% |   17 / 0% | 33 / 22.5% | 17 / 1.3% | 67 / 98.5% |       skip |
| static-cv-resumable    | 17 / 0% |   17 / 0% | 17 / 0% |   17 / 0% |  17 / 0.9% | 17 / 1.3% | 67 / 98.5% | 150 / 100% |
| static-cv-delegated    | 17 / 0% |   17 / 0% | 17 / 0% | 17 / 0.4% |  17 / 0.9% | 17 / 1.3% | 67 / 98.6% | 133 / 100% |
| static-cv-script       | 17 / 0% |   17 / 0% | 17 / 0% |   17 / 0% |  17 / 0.9% | 17 / 0.9% | 83 / 98.4% | 133 / 100% |
| virtual-island         | 17 / 0% |   17 / 0% | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% |  17 / 0.9% |    17 / 0% |
| virtual-island-visible | 17 / 0% |   17 / 0% | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% |    17 / 0% |    17 / 0% |
| virtual-island-find    | 17 / 0% |   17 / 0% | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% |    17 / 0% |    17 / 0% |
| virtual-spa            | 17 / 0% |   17 / 0% | 17 / 0% |   17 / 0% |    17 / 0% |   17 / 0% |    17 / 0% |    17 / 0% |

### Scroll: worst frame (ms)

| impl                   | 100 | 500 | 1k | 2k | 5k | 10k | 50k | 100k |
| ---------------------- | --: | --: | -: | -: | -: | --: | --: | ---: |
| static                 |  17 |  17 | 17 | 17 | 17 |  17 | 117 | skip |
| static-cv              |  17 |  17 | 17 | 17 | 50 |  83 | 450 |  900 |
| static-cv-islands      |  17 |  33 | 17 | 17 | 67 |  83 | 550 | skip |
| static-cv-resumable    |  17 |  17 | 17 | 17 | 33 | 100 | 650 |  967 |
| static-cv-delegated    |  17 |  17 | 17 | 33 | 33 |  83 | 633 |  233 |
| static-cv-script       |  17 |  17 | 17 | 17 | 33 |  83 | 500 |  233 |
| virtual-island         |  17 |  17 | 17 | 17 | 17 |  17 |  33 |   17 |
| virtual-island-visible |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |
| virtual-island-find    |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |
| virtual-spa            |  17 |  17 | 17 | 17 | 17 |  17 |  17 |   17 |

### Row control: first click / second click → paint (ms)

| impl                   |      100 |      500 |       1k |       2k |        5k |       10k |         50k |        100k |
| ---------------------- | -------: | -------: | -------: | -------: | --------: | --------: | ----------: | ----------: |
| static                 |        — |        — |        — |        — |         — |         — |           — |        skip |
| static-cv              |        — |        — |        — |        — |         — |         — |           — |           — |
| static-cv-islands      |   15 / 5 |  24 / 20 |  29 / 28 |  49 / 38 | 163 / 138 | 233 / 214 | 1128 / 1473 |        skip |
| static-cv-resumable    | 171 / 21 | 172 / 22 | 172 / 29 | 187 / 54 | 240 / 123 | 395 / 254 |  853 / 1388 | 2126 / 3967 |
| static-cv-delegated    |   8 / 15 |  13 / 20 |  23 / 17 |  49 / 46 |  78 / 117 | 246 / 216 | 1279 / 1641 | 3131 / 4077 |
| static-cv-script       |  13 / 14 |  12 / 12 |  25 / 12 |  26 / 27 |   69 / 71 | 120 / 194 | 1177 / 1597 | 1973 / 3060 |
| virtual-island         |  20 / 13 |  25 / 11 |  15 / 15 |   20 / 9 |   21 / 13 |   27 / 14 |     25 / 18 |     15 / 12 |
| virtual-island-visible |  25 / 17 |   23 / 9 |  20 / 10 |  25 / 15 |   19 / 20 |   20 / 13 |     26 / 18 |     22 / 16 |
| virtual-island-find    |  27 / 29 |  57 / 46 |  84 / 64 | 255 / 88 | 159 / 101 | 187 / 113 |   193 / 127 |   213 / 103 |
| virtual-spa            |        — |        — |        — |        — |         — |         — |           — |           — |

### Find row n−1 (window.find; DOM hits)

| impl                   |            100 |            500 |             1k |             2k |             5k |            10k |            50k |          100k |
| ---------------------- | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: | -------------: | ------------: |
| static                 | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |          skip |
| static-cv              | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |  — (— in DOM) |
| static-cv-islands      | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |          skip |
| static-cv-resumable    | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |  — (— in DOM) |
| static-cv-delegated    | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |  — (— in DOM) |
| static-cv-script       | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) | yes (1 in DOM) |   — (— in DOM) |  — (— in DOM) |
| virtual-island         |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) | no (0 in DOM) |
| virtual-island-visible |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) | no (0 in DOM) |
| virtual-island-find    |  no (1 in DOM) |  no (1 in DOM) |  no (1 in DOM) |  no (1 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) | no (0 in DOM) |
| virtual-spa            |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) |  no (0 in DOM) | no (0 in DOM) |

### Rows in the accessibility tree

| impl                   | 100 | 500 |    1k |    2k |    5k |    10k |    50k |    100k |
| ---------------------- | --: | --: | ----: | ----: | ----: | -----: | -----: | ------: |
| static                 | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 |    skip |
| static-cv              | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-islands      | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 |    skip |
| static-cv-resumable    | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 |       — |
| static-cv-delegated    | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| static-cv-script       | 100 | 500 | 1,000 | 2,000 | 5,000 | 10,000 | 50,000 | 100,000 |
| virtual-island         |   9 |   9 |     9 |     9 |     9 |      9 |      9 |       9 |
| virtual-island-visible |   9 |   9 |     9 |     9 |     9 |      9 |      9 |       9 |
| virtual-island-find    |  15 |  15 |    15 |    15 |     9 |      9 |      9 |       9 |
| virtual-spa            |  11 |  11 |    11 |    11 |    11 |     11 |     11 |      11 |

## Failures

- static-chat-100k-mobile: skipped: static-chat-50k-mobile was unusable (time to interactive 44 s)
- static-cv-islands-chat-100k-mobile: skipped: static-cv-islands-chat-50k-mobile was unusable (time to interactive 33 s)

## Row data as island props

The virtual impls generate rows from the seed on the client, so no row data crosses the Flight boundary. An app that passes its rows to the island as props ships their JSON on top (uncompressed):

| kind  |   100 |    500 |     1k |     2k |     5k |    10k |     50k |    100k |
| ----- | ----: | -----: | -----: | -----: | -----: | -----: | ------: | ------: |
| fixed | 15 KB |  74 KB | 148 KB | 297 KB | 745 KB | 1.5 MB |  7.3 MB | 14.7 MB |
| chat  | 70 KB | 362 KB | 711 KB | 1.4 MB | 3.4 MB | 6.9 MB | 34.3 MB | 68.5 MB |
