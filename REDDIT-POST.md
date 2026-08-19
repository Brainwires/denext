<!--
Finished r/Deno post, current as of 2026-08-15 (denext cutting 1.0.0).
Framing reflects the positioning pivot in MARKETING.md / ROADMAP-FORWARD.md:
lead with the zero-npm wedge, be honest that unmodified drop-in isn't automatic
yet. Fill in [REPO LINK] before posting. Numbers are from bench/REPORT.md.
-->

# denext: a Next.js-compatible web framework for Deno — with a zero-npm runtime

After ~10 years writing React and running Next in production since version 13, I wanted
an App-Router framework with a supply-chain surface I could actually audit — so I
built **denext**: the familiar Next.js App Router API, built on the Deno standard
library, with **zero runtime npm dependencies**. The point isn't "Next.js, but on
Deno" (Deno already runs real Next.js) — it's _the Next.js you know with nothing
from npm underneath it_. It's one unified stack: instead of React + ReactDOM +
Next + a bundler, each its own package and dependency tree, denext is a single
codebase from the JSX runtime and its own fiber reconciler up through SSR, the
router, the build, and the CLI. That own-React reimplementation (hooks, context,
async transitions, transition-aware Suspense, streaming SSR) is what makes the
zero-dependency claim real. It's **App-Router-only by design** (no legacy
`pages/`), and it tracks the _current_ Next surface — Server Actions, RSC/Flight
soft navigation, **PPR and `use cache`**, `next/image` (AVIF), plus Fast Refresh
and a dev error overlay.

Because there's no React/ReactDOM in the client bundle, the output is
dramatically smaller — and the interesting comparison isn't a toy counter, it's a
real app with the _same_ npm React libraries on both sides (recharts,
react-hook-form, Radix, lucide). That recharts renders at all is the proof denext
runs a real class-component library; that it's still smaller is the payoff:

| Route (real npm libs)                 | denext | Next.js |
| ------------------------------------- | -----: | ------: |
| recharts dashboard (class components) | 120 KB |  230 KB |
| react-hook-form route                 |  24 KB |  140 KB |
| Radix dialog route                    |  26 KB |  142 KB |

(gzip, discovered in a real headless Chromium.) The bare-framework floor is ~8.5×
— a hello first-load is **16 KB vs 137 KB** — and denext hydrates ~1.1× faster
(p50). It's a single-machine benchmark, so trust the
**ratios**, not the absolute ms; `bench/run.ts` reproduces all of it, and both
sides of every byte comparison are gzipped.

A note on those numbers, because it's the part I'm actually proud of: they're not
marketing runs. When the SSR bench first showed my `renderToString` _losing_ to
React (~1.1× slower on a realistic page), I rewrote it to an append-only buffer
with a synchronous fast-path, output locked byte-identical by a golden test so
hydration couldn't drift — and it's now several times faster with lower variance.
I also caught the prod server shipping JS uncompressed while `next start` gzips,
so the build now precompresses assets (native `CompressionStream`, still
zero-dep). Owning the whole stack is what makes an end-to-end fix like that a
one-person afternoon. It's all backed by ~915 tests across ~160 files.

On honest scope: it's **not React internally** — anything reaching for
`react-reconciler` or React's own fiber internals is out of scope by design — and
it's **App-Router-only**. And to be straight about migration: `denext migrate`
converts an app's `package.json` to a `deno.json`, and the next-compat build
rewrites `react`→denext even inside npm packages (server modules included), so an
_unmodified_ Next App Router app now builds and runs on denext's single React. The
one honest caveat: `deno check` still reports cross-library `@types/react` type
conflicts (runtime rendering is unaffected) — so it's a runtime drop-in, not a
type-check-clean one yet. Everywhere denext behaves differently from React is
catalogued in `KNOWN-LIMITATIONS.md`.
MIT, cutting 1.0.0, on JSR as `@denext/denext`. Repo: **[REPO LINK]** · scaffold
a new app with `deno run -A jsr:@denext/denext/cli create my-app`. Would love
feedback — especially from anyone who's hit the wall running Next on Deno.
