# denext — Roadmap (strategy + ecosystem)

> Status: internal strategy document. Written 2026-08-15 (cutting 1.0.0), updated
> 2026-08-24. denext has shipped through **1.4.0**. For the full record of what's
> already shipped — the 1.1 capability flagships (Live Server Components,
> Resumability, first-party auth), 1.2 SPA mode, 1.3 desktop packaging + the
> production/security audit, and 1.4 rendering-strategy parity (streaming
> default-on, Flight-capable PPR, 6/6 Astro island directives) — see
> [FEATURES.md](./FEATURES.md).
>
> **This is a roadmap: it tracks what's still ahead — go-to-market strategy
> (Part A) and the pending engineering backlog (§A2.5 + Part B). Completed work is
> recorded in [FEATURES.md](./FEATURES.md), not re-catalogued here.** The larger 2.0
> DX plan lives in [ROADMAP-2.0.md](./ROADMAP-2.0.md).
>
> This file has two halves:
>
> - **Part A — Product / go-to-market** (formerly ROADMAP-FORWARD): positioning,
>   objections, the phased adoption plan, launch, and risk. Answers "why anyone
>   adopts it, and in what order we earn that."
> - **Part B — Ecosystem & zero-npm engineering** (formerly ROADMAP-ECOSYSTEM):
>   making the runtime literally zero-npm and growing a first-party JSR package
>   ecosystem (WASM codecs + a plugin architecture).
>
> Part A is grounded in four parallel research passes (Aug 2026); see the appendix.
> The retired ROADMAP-1.0 engineering checklist shipped — its deferred items live
> in §A2.5 below. [FEATURES.md](./FEATURES.md) is the source of truth for what's
> supported; [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) for the honest gaps.

---

# Mission

denext's mission is to **replace React and Next.js with a superior framework,
written in Deno** — smaller and auditable (zero-npm), secure by default (off Next's
CVE treadmill), doing what React structurally can't (Live Server Components /
resumability / islands), all behind one cargo-class tool for every React app. The
full statement and its five superiority pillars live in **[MISSION.md](./MISSION.md)**.

**What this roadmap is.** The gap between that mission and today — **what we still
need to add** under each pillar to make "superior replacement" true, plus the
go-to-market plan to earn the adoption. It is not a changelog: **completed work
lives in [FEATURES.md](./FEATURES.md), not here.** Part A is the product / GTM
strategy; Part B is the zero-npm engineering (Pillar 1); the 2.0 DX tool (Pillar 4)
has its own file, [ROADMAP-2.0.md](./ROADMAP-2.0.md).
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) tracks the honest gaps.

---

# Part A — Product / go-to-market

## A1. The one decision everything hangs on

**Stop selling "Next.js, but on Deno." Start selling "the Next.js you know, with
nothing from npm underneath it — plus capabilities Next structurally can't ship."**

The research is unambiguous on why the first half matters:

- **"Next.js compatibility on Deno" is a race we lose to real Next.js.** As of
  late 2024 Deno Deploy runs genuine Next.js SSR via npm compat, and `deno desktop`
  (2.9) compiles a real Next.js app to a binary. So the informed reader's first
  reaction to a compatibility pitch is _"why a clone when I can run the real thing
  on Deno with the real ecosystem?"_ Compatibility, framed as the headline, is a
  solution to a solved problem.
- **The one thing neither real-Next-on-Deno nor Fresh can offer is a zero-npm
  dependency tree.** Real-Next-on-Deno drags the full npm tree; Fresh ships
  Preact + npm-compat. denext's own-React reimplementation is the _only_ reason
  the zero-dependency claim is real — and 2025's npm supply-chain attacks
  (chalk/debug across ~2.6B weekly downloads; the Shai-Hulud worm) made it
  emotionally urgent, not just architecturally tidy.
- **Compatibility is the _on-ramp_, not the pitch.** Compatibility-as-migration is
  the single most reliable growth pattern in JS tooling (Vite off CRA's
  deprecation, Bun/Deno-2 off Node compat, Preact off the React alias). We keep it
  — as the thing that makes _trying_ denext free — while the wedge that makes
  people _want_ to is the auditable, tiny, dependency-free output.

**The second wedge — capabilities (new since 1.1).** Owning the whole stack (the
cache, the Flight boundary, the reconciler) lets denext ship two things the
React/Next architecture can't produce without a major rework:

- **Live Server Components** — the server re-renders a boundary under the viewer's
  own session and **pushes** it over a WebSocket when a cache tag is invalidated
  from anywhere. Next re-renders RSC only when the client asks; it has no
  first-party push. A Convex/Liveblocks-class real-time layer with zero npm.
- **Resumability** — `export const resumable = true`: interactive with no up-front
  hydration, plain components unchanged. Qwik pioneered it; React hydrates the whole
  tree and Next inherits that cost.

This is no longer "a smaller Next" — it's "a smaller Next that also does what Next
structurally can't." Lead with the size/supply-chain wedge to get in the door;
close with the capabilities to make it memorable.

**Positioning line to standardize** (README H1, JSR, the post):

> _A Next.js-compatible web framework for Deno with a zero-npm runtime — the
> familiar App Router API, ~8–9× smaller output, and a dependency tree you can
> actually audit. Plus Live Server Components and Resumability, which Next can't
> easily match. One unified stack, no Vercel lock-in._

Everything below serves this pivot.

## A2. Where we stand (honest baseline)

The engine is mature — own fiber reconciler, every rendering strategy shipped
(SSR/SSG/ISR/CSR/streaming/PPR), App Router, Server Actions, the 1.1 capability
flagships, 1.2 SPA mode, and security hardening — on ~915+ tests.
**[FEATURES.md](./FEATURES.md) is the source of truth for that shipped surface — it
is not re-catalogued here.** What this section tracks is the remaining gap between
that engine and adoption.

**The adoption blockers still open — the "product plumbing" a Next dev assumes.**
(Shipped plumbing — the `denextAuth` core, DB story, deploy recipes, app/component
testing, `denext probe`, the migration codemod, hosted docs — is in FEATURES.md.)

- **Auth: DB-backed session store + more provider presets.** The `denextAuth` core
  (OAuth 2.0 / OIDC + Credentials, signed `__Host-` sessions) shipped in 1.1; what
  remains is a database-backed session store and a wider preset library.
- **Plugin ecosystem: a real third-party plugin.** The `DenextPlugin` contract
  exists and `@denext/pages-router` proves it — but no _third-party_ plugin yet.

## A2.5 Post-1.0 engineering backlog

The single canonical engineering backlog — what remains, deferred and documented in
KNOWN-LIMITATIONS.md (Part B's engineering items fold in here; shipped work is in
[FEATURES.md](./FEATURES.md)):

- **DevTools depth** — hooks/state + context inspection, override hooks/props, the
  Profiler tab, source links/owner stacks (version-sensitive; hard to CI-test).
- **Build-time deps** — migrate `lightningcss`/`swc`/`esbuild` off npm to first-party
  JSR builds (build-time only; no runtime-claim impact — see Part B §B-Remaining).
- **`@denext/pages-router` minor gaps** — `router.events`, shallow routing, `<Link>`
  prefetch, i18n locale routing, legacy `getInitialProps`.
- **RSC / cache glass-box panel** — the cache-observability data ships today
  (`getCacheStats()`: page hit/miss/set + which `revalidateTag`/`revalidatePath` invalidated
  what, with timing). What remains is the **live panel** surface over it — why a boundary
  re-rendered, the RSC/Suspense waterfall, `<Live>` boundaries lighting up in real time.
  Turns objection #8 ("cloned the parts people hate") into a selling point. Medium.

## A3. The objections, and how the roadmap answers each

The real question isn't "why switch" — it's "why would someone bounce in the first
thirty seconds." Ranked by fatality, with the roadmap item that blunts it.

| #  | "Not interested" reason                            | Fatality | Neutralized by                                                                                        |
| -- | -------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| 1  | It's a React _reimplementation_, not React (trust) | Fatal    | Parity-test matrix + honesty docs (Phase 3)                                                           |
| 2  | Deno already runs _real_ Next.js — why a clone?    | Fatal    | Positioning pivot §A1 + zero-npm demo — **and capabilities real Next can't ship** (Live/resumability) |
| 3  | Compatibility is a promise only partly kept        | High     | Tested compat matrix (Phase 0) + measured punch-list (§A3.5)                                          |
| 4  | No auth / DB / deploy recipes (batteries)          | High     | **Shipped:** `denextAuth` (1.1), DB story, deploy recipes; adapters next                              |
| 5  | Solo / bus-factor / longevity                      | High     | Normalize + de-risk structurally (§A5)                                                                |
| 6  | Deno itself is a gate (small market)               | High     | Ride Deno-2 growth; don't bet on it replacing Node                                                    |
| 7  | LLMs write Next, not denext                        | Med-High | `llms.txt` + model-ingestible docs (Phase 3)                                                          |
| 8  | We cloned the parts people hate (RSC/caching)      | Med      | Make caching/RSC _observable_ (Phase 3) — **and `<Live>` turns RSC into a real-time superpower**      |
| 9  | No hiring pool / Googleability                     | Med      | Time + docs + community (Phase 4)                                                                     |
| 10 | Migration is really greenfield                     | Med      | `denext migrate` + punch-list make it real (§A3.5, Phase 2)                                           |

Note the trap: denext structurally resembles the frameworks that _failed_ (Aleph =
"the Next for Deno," one dev, archived July 2025 pointing users to Fresh) on two
axes — runtime lock-in and a tautological "X for Deno" pitch. The escape from
Aleph's fate is exactly Deno-2's npm bridge + our compatibility on-ramp: we are not
asking anyone to abandon their ecosystem.

## A3.5 Drop-in reality check — measured, then delivered

We built a reproducible harness (`examples/next-compat-feasibility/`) and drove a
real third-party App Router app — **`shadcn-ui/next-template`** (Radix +
next-themes + Tailwind + lucide) — through migrate → build → start/dev → render.

**Drop-in is REAL for App Router apps.** The next-compat pipeline is integrated
into denext core (`denext build`/`start`/`dev` + a `denext migrate` CLI). An
unmodified shadcn-ui/next-template SSR-renders and hydrates on denext's **single**
React (server bundle: 0 real-React signatures; client bundle: 0 real-React +
`hydrateRoot`), with the full `next/*` surface, correct metadata, and the full
denext suite green. The last boundary — **RSC/Flight preserved in compat** — is
closed: a compat route reaching a `"use client"` island renders its Server
Components server-side only and hydrates just the islands via a
react→denext-rewritten flight bundle, so async data-fetching Server Components
(`await db.query()`) work in a compat route.

**The honest caveat:** `deno check` on a compat app can still surface cross-library
`@types/react` conflicts (runtime rendering is unaffected). See
[README-NEXT-MIGRATION.md](./README-NEXT-MIGRATION.md) for the current caveat list.
The "point it at your Next repo and it runs" framing is now true for App Router at
runtime — but never claim a type-check-clean drop-in.

## A4. Phased plan

### Phase 0 — Before the post or the 1.0 cut (days)

Cheap moves that neutralize instant-dismissal objections.

1. **Adopt the positioning pivot (§A1)** in README hero, JSR description, and the
   r/Deno post. Demote "compatible" to the on-ramp line; lead the capabilities
   (Live/resumability) as the second wedge.
2. **Publish a tested compatibility matrix** ("these exact libraries@versions,
   verified by e2e") to replace "a fair amount of Radix/shadcn." Precision kills the
   "I won't know until it breaks" objection.

### Phase 1 — Make the wedge concrete and demoable (the 1.0 story)

The wedge only lands if it's _shown_. Lead with one felt-pain number, backed by a
reproducible repo — the number is the wow, the repo is the credibility.

1. **The supply-chain / single-binary demo.** `deno compile` / `deno desktop` → a
   signed, tiny binary with an essentially-zero dependency tree, side-by-side against
   the same app on real Next.js (which drags the full npm tree). The size +
   dependency-count **delta** is the proof point (`deno desktop` gives competitors a
   single-binary story too, so the delta, not the capability, is what's defensible).
   The productized form is a **`denext deploy` command with pluggable adapters**.
2. **A public, reproducible benchmark repo** — a real Next app ported to denext with
   the size/cold-start diff. This audience tears unbacked numbers apart; the repo is
   non-negotiable before the "~8–9×" claim goes in a title.
3. **The auditable narrative:** generate an SBOM / dependency count for a denext app
   vs. a Next app ("0 runtime npm deps vs. N hundred"). Productize as **`denext
   audit`**: walk the resolved module graph, emit an SBOM (CycloneDX/SPDX) + a
   plain dependency-count headline, and flag anything reaching npm/remote hosts.
4. **Least-privilege by default:** ship and document a tight `deno run --allow-...`
   profile for `denext start`. `denext audit` also derives this set from the module
   graph and diffs it against what's granted.
5. **The capabilities demo (new).** A live page where a `<Live>` boundary updates
   when a webhook/cron invalidates a tag, and a resumable route that's interactive
   with no hydration cost — the "Next can't do this" moment. Record it for the launch.

### Phase 2 — Close the adoption blockers (the batteries)

| Priority | Gap                               | Minimum viable close                                                                                                                                                |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1**   | Auth: session store               | DB-backed session store + a wider provider-preset library. The `denextAuth` core (OAuth 2.0 / OIDC (PKCE) + Credentials, signed `__Host-` sessions) shipped in 1.1. |
| **P0**   | Deploy adapters + `denext deploy` | Pluggable deploy adapters behind one command (single static binary, Docker, Deno Deploy, systemd) with the concurrency ceiling + least-privilege set baked in.      |
| **P0**   | Drop-in demo                      | A one-command "port this Next app in minutes" flow (StackBlitz or CLI) with a live size diff. The single highest-leverage adoption move.                            |
| **P1**   | Data layer                        | Prove _one_ real Postgres path with an example (done: `examples/postgres-load`); position Deno KV as an app data store, not just cache.                             |
| **P2**   | Docs coverage                     | Keep the live, static-exported [denext.dev](https://denext.dev) docs expanding with the feature set (hosting is done; coverage is the ongoing work).                |
| **P2**   | Ecosystem seeding                 | Opinionated starters, `denext add`-style integrations, a showcase page, the first third-party plugin.                                                               |

### Phase 3 — Blunt the structural objections (ongoing)

- **Trust in the reimplementation (#1):** grow parity tests _named after_ the APIs
  we advertise; where feasible, run React's own test patterns against denext.
- **LLM-writability (#7):** publish `llms.txt` and a compact, model-ingestible API
  reference + a "denext for LLMs" doc.
- **The "cloned the parts people hate" trap (#8):** make caching/RSC **observable**
  (the glass-box devtools, §A2.5) — same semantics, better visibility, with `<Live>`
  boundaries lighting up. A genuine edge.
- **Longevity (#5):** see §A5.

### Phase 4 — Go-to-market / launch

Technical quality is table stakes — every framework that _failed_ was technically
excellent. Execution is the differentiator.

1. **Lead with ONE felt-pain number in the title**, ship the benchmark repo the
   same day. (Preact = "3kB"; Astro = "ship less JS"; Bun = speed.)
2. **Answer "why not just use real Next?" on the first screen** — the guaranteed top
   comment. One-line rebuttal: _familiar Next API, ~8–9× smaller output, zero npm
   runtime deps, native Deno with no Vercel lock-in — plus Live Server Components and
   resumability real Next can't ship._ Never claim 100% compatibility.
3. **Launch to a known recipe.** Warm crowd first (r/Deno), then a Show HN: plain
   factual title, working demo in seconds, present replying as a human for the first
   ~2 hours, Tue–Thu US morning, never solicit upvotes. Own the solo-builder
   narrative — it drives ~3× the engagement of a dry technical post.
4. **Target the honest market:** greenfield, Deno-friendly, bundle-size- and
   supply-chain-conscious teams, plus a **security/enterprise** angle (SBOM,
   auditability) where zero-npm is a compliance tiebreaker.
5. **Be the evangelist.** Every winner had a visible, responsive maintainer-evangelist;
   the quality frameworks that died (Marko, Aleph) did not.
6. **Start the durability flywheel immediately:** public roadmap, a visible
   release/changelog cadence, and 1–3 named early-adopter sites as fast as possible.

## A5. The biggest single risk — and how to neutralize it

**The bus-factor / "solo + niche runtime + why-not-real-Next" trust cluster** — the
exact combination that killed Aleph. Don't hide it; disarm it:

- **Normalize it.** Single-maintainer critical infra is the norm — ~10 of the top 30
  npm projects have a bus factor of one (Express included).
- **De-risk structurally.** MIT (forkable if you vanish); **zero npm runtime deps is
  itself a bus-factor _reduction_** — fewer external points of failure; public
  roadmap; visible cadence; a personal-stake narrative.
- **Cap-the-ceiling counter.** Frame denext as riding Deno-2's growth and its npm
  bridge — _not_ betting on Deno replacing Node.

## A6. What NOT to do

- Don't lead with "simpler than Next" — we reproduce the very APIs (RSC, four-layer
  caching, `use client`) people call complex; that claim is unwinnable.
- Don't lead with Next-security-FUD — it reads as fearmongering. Zero-npm is a
  _positive_ architecture story, not an attack.
- Don't ship the "~8–9×" number without the reproducible repo behind it.
- Don't claim 100% React/Next compatibility — compat layers never reach parity.
- Don't claim a type-check-clean drop-in (an unmodified App Router app runs; `deno
  check` may still show `@types/react` conflicts).
- Don't stall in a long alpha/beta — momentum dies in perpetual pre-1.0 (Fresh 2.0's
  multi-year alpha is the cautionary tale). Cut releases.

## A7. Success signals to watch (not vanity metrics)

- **Trying → the repo/StackBlitz "port in minutes" flow gets run.**
- **Named early-adopter sites** (the durability flywheel).
- **Issue-response cadence** and release regularity (consistency > promises).
- **Inbound "does X library work?"** — answer each with a test, not prose.
- **A security/enterprise inbound** citing SBOM/audit — proof the wedge landed.
- **Inbound about `<Live>` / resumability** — proof the capabilities wedge landed.

---

# Part B — Ecosystem & zero-npm engineering

A technical plan for making denext's runtime **literally zero-npm** and for growing
a **first-party JSR ecosystem** (WASM codecs + plugins like a Pages Router). The
engineering backlog items surfaced here are folded into the single canonical
backlog in §A2.5.

## B1. Why

denext's headline is **"zero runtime npm dependencies."** That is now true for the
core serving runtime, the client bundle, the default `<Image>`, and the optional
image/OG/SQLite codecs (shipped as first-party JSR packages). The remaining npm
surface is **build-time only** (`lightningcss`, `swc`, `esbuild`) and never enters a
shipped bundle. Two goals sustained this:

1. **Make the zero-npm claim literally true** (and CI-enforced over the _whole_
   runtime, not just `src/compat/`).
2. **Keep batteries-included** — no user friction for image optimization / OG — by
   owning the codecs as **first-party JSR packages** (JSR ≠ npm), built with a
   binder, not hand-rolled.

This also seeds a **plugin ecosystem**: things that don't belong in the core package
(e.g. a **Pages Router**) ship as their own JSR packages against a denext plugin
contract.

## B2. Tooling decision — "is there a wasm-bindgen for Deno?"

**Yes — it exists; we do not build a binder.** We generate Deno-native bindings from
the codec source, per language:

- **Rust codecs** (photon-rs, resvg, lightningcss) →
  **[`denoland/wasmbuild`](https://github.com/denoland/wasmbuild)**, the Deno team's
  build tool that runs `wasm-bindgen` and emits Deno-ready glue (`.js` + `.d.ts`).
- **C codecs** (libavif, yoga) → compile to a **WASI/Component-Model component** and
  transpile with **[`jco transpile`](https://bytecodealliance.github.io/jco/transpiling.html)**
  → ESM Deno imports. (An emscripten `MODULARIZE`/ESM build is the fallback.)
- **Deno 2.1+** has first-class WASM (direct `.wasm` ESM imports), so the glue is
  thin and the binaries load without a bundler.

**Consequence:** we regenerate each codec's bindings targeting Deno, vendor the
`.wasm`, and publish to JSR. No hand-written marshalling glue, no npm.

## B3. Workstreams A–C — shipped (recorded here only as the base to build on)

The three engineering workstreams that made the runtime literally zero-npm have
shipped; the full design record is in [FEATURES.md](./FEATURES.md). In brief, so the
pending items below have context:

- **Zero-npm runtime** — the `no-npm-compat-guard` test asserts the whole runtime
  (`src/jsx`/`runtime`/`client`/`server`, minus the documented lazy image/OG imports)
  carries no `npm:` specifier.
- **First-party JSR codec packages** — `@denext/photon` (resize/WebP), `@denext/avif`,
  `@denext/og`, and `@denext/sqlite` replaced the former npm peer-deps; denext lazily
  imports the JSR package, so batteries-included stays zero-npm.
- **Plugin architecture + Pages Router** — the `DenextPlugin` contract (route
  contribution, a request-pipeline slot, build hooks, typed `plugins: [...]`) ships,
  with `@denext/pages-router` as the proof plugin. Guide: [PLUGINS.md](./PLUGINS.md).

**Ongoing, not one-off:** the **codec-update discipline** these created is a standing
responsibility — denext tracks each vendored codec's upstream CVEs and rebuilds (the
same SHA-256-pinned discipline as the Tailwind binary). This is Pillar 2 (secure by
default) in maintenance form.

## B6. Repo / workspace structure

The packages are separate JSR publishes but share CI/tooling via a **Deno workspace
(monorepo):** a root `deno.json` `workspace: [...]` with `packages/photon`,
`packages/avif`, `packages/og`, `packages/sqlite`, `packages/pages-router`, each
independently published to JSR on its own tag prefix (see
[CONTRIBUTING.md](./CONTRIBUTING.md) → Releasing), sharing lint/fmt/test config.

## B-Remaining — engineering items still open

- **Build-time deps** — migrate `lightningcss`/`swc`/`esbuild` to first-party JSR
  builds (lower priority — build-time only, no runtime-claim impact). Uses the B2
  wasmbuild/`jco` method.
- **`@denext/pages-router` minor gaps** — `router.events`, shallow routing, `<Link>`
  prefetch, i18n locale routing, legacy `getInitialProps`.

## B-Open questions

- **Scope name** for ecosystem packages: `@denext/*` (cohesion) vs a neutral scope?
- **Codec licenses:** confirm each upstream license permits redistribution of the
  built `.wasm` (photon-rs, libavif, resvg, yoga) and ship the notices.
- **Plugin contract surface:** how much of `src/router` / `src/build` / `src/server`
  internals must become semver-stable public API for a router plugin — and can we keep
  it narrow enough to evolve the core freely?

---

## Appendix — research provenance (Part A)

Four parallel research passes (Aug 2026):

1. _Why devs leave/stay with Next.js_ — the loud complaints (complexity, caching,
   RSC) rarely convert; migration is tipped by one concrete, measured pain (build
   clock, hosting bill, p95). denext's real wedges are operational.
2. _Deno platform + Fresh landscape_ — zero-npm is the only claim unique vs. both
   real-Next-on-Deno and Fresh; prove it via `deno compile`/`deno desktop`. Aleph
   (the prior "Next for Deno") archived July 2025.
3. _denext gap inventory_ — auth, DB, deploy recipes, app-testing were the adoption
   blockers (now largely shipped); core rendering/compat/security/types are mature.
4. _What drives adoption_ — one sharp felt-pain number; a migration on-ramp; a visible
   evangelist; a reason-to-believe-it'll-last; interactive onboarding; ecosystem
   seeding; a coordinated launch. Anti-patterns: solving an unfelt pain, the uncanny
   valley, broken escape hatch, bus factor, runtime lock-in, endless betas.
