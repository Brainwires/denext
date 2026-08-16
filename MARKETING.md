# denext — Marketing & Positioning Playbook

> The messaging companion to [ROADMAP-FORWARD.md](./ROADMAP-FORWARD.md).
> ROADMAP-FORWARD is _what we build and in what order_; this is _what we say, to
> whom, and how we answer the pushback_. Written 2026-08-15 (cutting 1.0.0),
> grounded in four research passes (see the roadmap's appendix for provenance).

---

## 1. The positioning pivot (read this first)

**Do not sell "Next.js, but on Deno." Sell "the Next.js you know, with nothing
from npm underneath it."**

Why: Deno already runs _real_ Next.js (Deno Deploy SSR via npm compat since late
2024; `deno desktop` compiles a Next app to a binary). So a compatibility-first
pitch invites the fatal question _"why a clone when I can run the real thing?"_
The one thing neither real-Next-on-Deno nor Fresh (Preact + npm-compat) can
offer is a **zero-npm dependency tree** — and denext's own-React reimplementation
is the only reason that claim is real. 2025's npm supply-chain attacks
(chalk/debug across ~2.6B weekly downloads; the Shai-Hulud worm) made it urgent,
not just tidy.

**Compatibility is the on-ramp, not the pitch.** Compatibility-as-migration is
the most reliable growth pattern in JS tooling (Vite off CRA, Bun/Deno-2 off Node
compat, Preact off the React alias). We keep it — it makes _trying_ denext cheap
— while the wedge that makes people _want_ to is the auditable, tiny,
dependency-free output.

**Canonical one-liner:**

> A Next.js-compatible web framework for Deno with a zero-npm runtime — the
> familiar App Router API, ~10× smaller output, and a dependency tree you can
> actually audit. One unified stack, no Vercel lock-in.

---

## 2. Target audience (who we're actually for)

Ranked by fit:

1. **Greenfield, Deno-friendly teams** who want a Next-shaped DX without the npm
   tree. Primary.
2. **Security- / compliance-conscious teams** (SBOM, auditability, supply-chain
   posture). Zero-npm is a genuine tiebreaker here, and it's where the wedge is
   sharpest. High-value, underserved.
3. **Bundle-size- / perf-sensitive builds** that still need real React
   interactivity (so not Astro's zero-JS crowd, who leave React entirely).
4. **Teams migrating an existing Next App Router app.** `denext migrate` +
   `denext build` now converts and runs an unmodified app on denext's single React
   (see §5) — lead with the runtime win, and be upfront that `deno check` still
   shows `@types/react` conflicts (runtime unaffected). Pages Router is out.

---

## 3. Proof points (lead with numbers, always back them)

This audience is benchmark-skeptical — an unbacked number gets torn apart. Every
number below is reproducible via `bench/run.ts` (single machine → cite ratios,
not absolute ms).

- **Bundle size, real app** (same npm libs both sides, gzip): recharts dashboard
  **118 KB vs 230 KB**; react-hook-form route **22 KB vs 140 KB**; Radix dialog
  **24 KB vs 142 KB**.
- **Bare-framework floor:** hello first-load **16 KB vs 137 KB (~8.7×)**.
- **Hydration:** TTI p50 **992 ms vs 1267 ms (~1.3× faster)**.
- **Zero runtime npm dependencies** (CI-enforced) — the headline.
- **~915 tests / ~160 files**, ~1 test per ~30 LOC; the SSR renderer's output is
  locked byte-identical by a golden test.
- **Currency:** ships PPR + `use cache` — Next's newest, still-stabilizing
  surface.

**The credibility story** (use it — it's worth more than any single number):
_the SSR renderer was measured losing to React (~1.1× slower), rewritten to an
append-only buffer with a byte-identical golden test, and is now several times
faster._ Measure → find you're losing → fix with a named technique → lock
correctness → re-measure. That is the "seasoned engineer, not vibe-coder" proof —
tell the process, never the bare multiplier.

---

## 4. Objection handling (the "why I'm not interested" list)

The real battle isn't "why switch" — it's not bouncing in the first 30 seconds.
Ranked by fatality, with the rebuttal.

| #  | Objection                                                     | Rebuttal / how we disarm it                                                                                                                         |
| -- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | "It's a React _reimplementation_, not React — untrustworthy." | Own it. Point to `KNOWN-LIMITATIONS.md`, the parity-test count, and the byte-identical golden test. Precision > reassurance.                        |
| 2  | "Deno already runs real Next.js — why a clone?"               | The positioning pivot (§1): we're not competing on compatibility, we're the zero-npm/auditable/tiny-binary version.                                 |
| 3  | "Compatibility is a promise only partly kept."                | Publish a tested compat matrix (exact libs@versions, e2e-verified) + the measured drop-in verifier. Replace "a fair amount" with a list.            |
| 4  | "No auth / DB / deploy recipes."                              | Honest: batteries are in progress (roadmap Phase 2). Don't overclaim; ship the examples.                                                            |
| 5  | "Solo project — will it exist in 2 years?"                    | Normalize (10 of top-30 npm pkgs have bus factor 1, incl. Express) + de-risk: MIT (forkable), zero-npm _reduces_ bus factor, public cadence.        |
| 6  | "Deno is a gate / niche runtime."                             | Frame denext as riding Deno-2's growth + npm bridge, not betting on Deno replacing Node.                                                            |
| 7  | "LLMs write Next, not denext."                                | Ship `llms.txt` + model-ingestible docs (roadmap Phase 3). Growing fast — take it seriously.                                                        |
| 8  | "You cloned the parts people hate (RSC/caching)."             | Don't claim 'simpler.' Differentiate on _observability_ — a dev overlay for cache layers / PPR holes.                                               |
| 9  | "No hiring pool / Googleability."                             | Time + docs + community. Don't fight it head-on; it fades with adoption.                                                                            |
| 10 | "Migration is really greenfield."                             | Shipped (§5): `denext migrate` + `denext build` convert and run an unmodified App Router app; be honest about the `@types/react` type-check caveat. |

---

## 5. The migration story — shipped, with honest caveats

`denext migrate` ships as a real CLI command, and the next-compat build rewrites
`react`→denext for **server-loaded** modules too (closing the dual-React-at-SSR
gap that was the last blocker).

- **What's true today:** `denext migrate <app>` converts `package.json` →
  `deno.json` (react/next aliasing, denext self-specifiers, tsconfig `paths`, dep
  classification/flagging), and an **unmodified Next.js App Router app builds and
  runs** on denext's single React (`denext build && denext start`, and
  `denext dev`).
- **The honest caveat — do not claim 100%:** `deno check` on a compat app still
  surfaces cross-library `@types/react` conflicts (npm libs ship their own React
  types) — **runtime rendering is unaffected**, but type-checking isn't clean.
  Pages Router is unsupported by design. Full details in
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) → "Next.js drop-in".
- **Honest line that sells:** _"`denext migrate` your Next App Router repo, then
  `denext build` — it runs on denext's single React, ~10× smaller, with a short,
  documented list of type-check caveats."_

The reproducible verifier (`examples/next-compat-feasibility/`) still shows,
per-app, exactly where drop-in holds.

---

## 6. Launch playbook

Technical quality is table stakes (every framework that _failed_ was excellent);
execution is the differentiator.

1. **Lead with ONE felt-pain number in the title, ship the benchmark repo the
   same day.** (Preact = "3kB"; Astro = "ship less JS.") The number is the wow;
   the reproducible repo is the credibility.
2. **Answer "why not just use real Next?" on the first screen** — the guaranteed
   top comment. Rebuttal: _familiar Next API, ~10× smaller output, zero npm
   runtime deps, native Deno, no Vercel lock-in._
3. **Sequence the channels:** warm crowd first (**r/Deno**), then a **Show HN**
   (plain factual title, live demo in seconds, be present replying as a human for
   the first ~2 hours, Tue–Thu US morning, never solicit upvotes).
4. **Own the solo-builder narrative** — it reportedly drives ~3× the engagement
   of a dry technical post. Your background is an asset; state it once as
   motivation, never as a credential shield ("I'm not a noob" reads defensive).
5. **Be the evangelist.** Every breakout framework had a visible, responsive
   maintainer; the excellent ones that died (Marko, Aleph) didn't.
6. **Start the durability flywheel immediately:** public roadmap, visible
   release/changelog cadence, and 1–3 named early-adopter sites ASAP.

---

## 7. Competitive framing

- **vs. real Next.js (on Node or Deno):** we lose on ecosystem/maturity; we win
  on bundle size, zero-npm supply-chain surface, no Vercel lock-in, one unified
  stack. Never fight on "more compatible."
- **vs. Fresh (official Deno framework):** Fresh is islands-first + Preact + stuck
  in a long 2.0 alpha; denext targets full App-Router compatibility on a real
  React-equivalent. Answer "why not Fresh?" with that, respectfully.
- **vs. Aleph (the prior "Next for Deno"):** archived July 2025 — the cautionary
  tale. We escape its fate via Deno-2's npm bridge + our compatibility on-ramp
  (we don't ask anyone to abandon their ecosystem).

---

## 8. Messaging do / don't

**Do:**

- Lead with zero-npm + the auditable/tiny-binary payoff.
- Cite reproducible numbers as ratios.
- Tell the renderToString measure→fix→remeasure story.
- Be explicit about scope (App-Router-only, not React internally) — honesty _is_
  the credibility play with this audience.
- Point to `KNOWN-LIMITATIONS.md` proactively.

**Don't:**

- Don't say "simpler than Next" (we reproduce the APIs people call complex).
- Don't lead with Next-security-FUD ("all their security issues") — it reads as
  fearmongering. Zero-npm is a _positive_ architecture story.
- Don't claim a **type-check-clean** drop-in — an unmodified app builds and runs,
  but `deno check` still shows `@types/react` conflicts (§5). Be upfront about it.
- Don't claim 100% React/Next compatibility.
- Don't state credentials defensively; let the specifics carry it.
- Don't stall in a long pre-1.0 — cut 1.0 (Fresh's endless alpha is the warning).

---

## 9. Assets & where they live

- **The post:** [REDDIT-POST.md](./REDDIT-POST.md)
- **Strategy / execution plan:** [ROADMAP-FORWARD.md](./ROADMAP-FORWARD.md)
- **Honesty catalogue (link proactively):** [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)
- **Benchmarks (reproducible):** `bench/run.ts`, `bench/REPORT.md`
- **Drop-in verifier / migration proof:** `examples/next-compat-feasibility/`
- **Still to build for launch:** compat matrix, `llms.txt`, a killer size-diff
  demo (see roadmap). (`denext migrate` has shipped.)
