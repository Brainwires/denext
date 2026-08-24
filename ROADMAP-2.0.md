# denext 2.0 — The DX Release

> **One power tool for all of React.**
>
> Status: internal strategy document. 2.0 is denext's **first major** version and is **entirely about
> developer experience**. 1.x proved the engine — the reconciler, every rendering strategy (SSR/SSG/ISR/
> CSR/streaming/PPR), resumability, Live Server Components, first-party auth, and a genuinely zero-npm
> runtime. 2.0 makes that engine _a joy to use_ and puts the entire workflow behind **one cargo-like
> binary**. See [ROADMAP.md](./ROADMAP.md) for 1.x strategy/positioning, [FEATURES.md](./FEATURES.md)
> for what's shipped, and [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) for the honest gaps.
>
> **Operating stance:** near-zero adoption today is a feature, not a problem — it lets us **break freely**
> and cut a clean 2.0 with no legacy baggage. And we **deliver before we advertise**: nobody adopts a
> powerful engine wrapped in rough DX, so 2.0 ships only when the whole loop actually feels great.

---

## 1. Thesis

The engine is done enough. The **experience** isn't. In 1.x, the power is real but it's spread across a
hand-rolled CLI, an npm-shaped migration story that only knows Next.js, a dev loop that full-reloads on a
CSS edit, and an error overlay that's a raw stack dump. 2.0 fixes the thing that actually decides
adoption: **how it feels to build with it, from `create` to `deploy` to a packaged desktop app — without
ever touching npx or an npm package.**

The north star is **"`cargo` for React"**: one binary that scaffolds, migrates, dev-serves, tests, lints,
builds, audits, deploys, and packages — for _any_ React app (Vite-style SPA, App Router, or an unmodified
Next app you migrate in one command) — with **zero npm in the shipped runtime**.

The competitive wedge stays what 1.x established: not "Next on Deno" (a solved problem), but **the only
stack whose entire toolchain and runtime you can audit because there's no npm tree underneath it** —
now with DX good enough that you'd choose it even without that.

## 2. Design principles

1. **One tool, many verbs.** Everything a React dev does in a day is a `denext` subcommand. No npx, no
   `create-*` packages, no inquirer, no separate test/lint/deploy tools.
2. **DX _is_ the product for 2.0.** Every pillar is judged by edit-to-outcome feel, not feature count.
3. **Deliver or don't ship.** A pillar lands only when it's genuinely better than the incumbent
   (Vite/Next) for that job. Half-working DX is worse than none.
4. **Break freely, migrate kindly.** Pre-adoption means we owe no back-compat to obsolete 1.x shapes.
   Where a break touches a real user, we ship an automatic `denext migrate` codemod — as a courtesy,
   not an obligation.
5. **Zero-npm runtime is sacred.** DX work never reintroduces an npm dependency into a shipped bundle.
   Build-time-only WASM/JSR tools are fine.
6. **Honest compatibility.** Compat is the on-ramp, never the headline. We **never claim 100%**
   React/Next parity (standing guardrail from ROADMAP.md); we make _trying_ denext free.
7. **Advertise last.** No launch push until the success criteria in §9 are met.

## 3. Pillar I — The Unified CLI ("the power tool")

Rebuild the CLI from an ad-hoc `switch` into a real command framework — the backbone every other pillar
plugs into.

- **Command/flag framework.** A subcommand registry with a declarative flag schema (replacing per-case
  `Deno.args.includes(...)` scanning in `cli.ts`). Uniform **global flags** (`--cwd`, `--config`,
  `--json`, `--verbose`, `--quiet`), **per-command `--help`**, **"did you mean" suggestions**, and
  **shell completions**.
- **Plugin-contributed commands.** Extend the existing plugin system (`src/plugin/mod.ts`) so plugins can
  register their own verbs, not just build hooks.
- **New/absorbed verbs** (the cargo surface):
  - `denext add` / `remove` / `update` — dependency + manifest UX the CLI owns (delegating to Deno
    underneath), instead of "now go run `deno install`."
  - `denext test` / `lint` / `fmt` / `check` — promote today's maintainer-only `deno task`s to
    first-class app-author verbs (wrapping the existing `src/testing/*` harness).
  - `denext deploy` — **absorbed from the 1.x backlog**; provider adapters.
  - `denext audit` — **absorbed**; SBOM (CycloneDX/SPDX), dependency-count proof, least-privilege
    permission derivation (leans on the already-real zero-npm guarantee).
  - `denext generate` — codegen for routes/components/layouts/server-actions/api.
  - `denext doctor` / `info` — environment + project diagnostics; folds in and supersedes `probe`.
  - `denext desktop build|run|package` — promote the scaffold-time desktop tasks to first-class verbs,
    and take packaging **beyond macOS-only**.

## 4. Pillar II — The Dev Loop (make editing instant)

Today: SSE live-reload with whole-route re-import; CSS/`.ts`/config edits full-reload; the config file
isn't even watched (`src/build/dev-server.ts`). 2.0 makes the inner loop feel instant.

- **True granular HMR** — module-graph-aware, per-component boundary, hook-state-preserving; **CSS
  hot-swap without a reload.**
- **Watch the whole graph** — including `denext.config.ts` and imported `src/` modules; hot-reload
  config where safe.
- **A world-class error overlay** — code frames, **source-mapped clickable frames**, editor-open links,
  and **server-side render errors surfaced in the browser overlay** (not just the terminal).
- **Faster cold start & incremental rebuilds.**

## 5. Pillar III — Universal Migration ("bring any React app")

The `migrate`/`codemod` specifier-rewrite engine is well-built but **Next-only**. Generalize it into the
adoption on-ramp for the _whole_ React population.

- **`denext migrate --from <framework>`** — `next` (App + Pages, today), **`cra`**, **`vite`**,
  **`generic-react`**, and Remix under evaluation.
- **Config transforms** — translate `next.config.js` / `vite.config.ts` / CRA conventions (`public/`,
  `REACT_APP_*` env, entry HTML) into `denext.config.ts` + `mode: "spa"` where appropriate.
- **One-command "it runs"** — a Vite or CRA dev migrates and boots on denext with a single command,
  landing in SPA mode; a Next app lands in App Router. This is the single biggest reach-expansion in 2.0.

## 6. Pillar IV — Scaffolding & Codegen

Replace hardcoded string-generators (`src/build/scaffold.ts`) with a real, extensible system.

- **Template registry** — a `templates/` tree plus remote/community templates; `denext create
  --template <name>`.
- **`denext generate`** — scaffold routes, components, server actions, and API handlers into an existing
  app.
- **Richer onboarding** — interactive framework picker beyond boolean flags; post-create install + a
  verify step so a fresh app is confirmed-green before you touch it.

## 7. Pillar VI — Observability & DevTools (absorbed backlog)

- **Component inspector — hooks & state.** A first-party denext DevTools panel that inspects a mounted
  component's **props, hooks, state, and context**, and lets you **edit state live**. The stock React
  DevTools extension **cannot attach** — denext runs its own reconciler and hooks, not React's fiber — so
  this is either a native denext panel or a React-DevTools-**backend shim** that speaks the extension's
  wire protocol. Foundational: the RSC/islands inspectors below build on the same instrumentation.
- **RSC glass-box panel** — a UI showing what's static vs dynamic vs streamed and the Flight
  boundaries. (Cache observability — page hit/miss/set counts + an invalidation log with timing —
  already ships via `getCacheStats()`; what remains is the render-mode/Flight-boundary panel over it.)

## 8. Breaking changes we're taking

Pre-adoption, we optimize for the right end-state, not for continuity:

- **Restructured CLI surface** — new command framework; some current commands/flags change shape or move
  (e.g. `probe` folds into `doctor`).
- **Config coherence pass** — unify/rename fields where it improves clarity; export a schema.
- **Graduate experimental toggles** — once 1.4 lands streaming-default-on / Flight-PPR / 6/6 island
  directives, drop the interim `experimental.*` flags that guarded them.
- **No obligation to keep 1.x paths** that don't serve the DX vision. Where a break would hit a real
  user, ship a `denext migrate` codemod — courtesy, not contract.

## 9. Success criteria ("deliver before we advertise")

2.0 ships — and only then do we launch — when **all** of these are true:

1. A CRA / Vite / Next app **migrates with one command and runs.**
2. The full workflow — `create → dev → test → build → deploy → package(desktop)` — is **one binary**,
   no npx, no npm package in the loop.
3. The edit-to-paint dev loop **feels instant** (granular HMR; CSS hot-swap; no full reload on a
   component edit).
4. Errors are **legible** — code frames, clickable source-mapped frames, server errors in the overlay.
5. The shipped runtime is **still zero-npm**, and `denext audit` proves it.

## 10. Explicitly out of scope for 2.0

- **React Native / native rendering.** Capacitor/WebView stays the mobile story; a true RN target is a
  separate future frontier, not part of 2.0.
- **100% React/Next compatibility claims** — standing guardrail; compat remains the on-ramp.
- **Anything reintroducing npm into the shipped runtime.**

## 11. Relationship to 1.x & release mechanics

- **Builds on a finished 1.4.** 1.4 completes rendering-strategy parity (streaming default-on,
  Flight-capable PPR, 6/6 Astro island directives). 2.0 assumes that engine is done and turns to DX.
- **Unifies the 1.x DX/CLI backlog.** `denext deploy`, `denext audit`, typed routes, typed Server
  Actions/RPC, RSC+cache devtools, and `llms.txt` (ROADMAP.md §A2.5) are pulled into **one coherent 2.0
  release** rather than scattered across point releases.
- **A decisive major cut.** First major bump: update the version in both `deno.json` **and** `mod.ts`;
  land pillars incrementally on `development`; cut `v2.0.0` (tag-triggered JSR publish) once §9 is met —
  not a long alpha.
