# denext — Roadmap (engineering backlog)

> Status: internal engineering tracker. Written 2026-08-15 (cutting 1.0.0), updated
> 2026-08-24. denext has shipped through **1.4.0**. For the full record of what's
> already shipped — the 1.1 capability flagships (Live Server Components,
> Resumability, first-party auth), 1.2 SPA mode, 1.3 desktop packaging + the
> production/security audit, and 1.4 rendering-strategy parity (streaming
> default-on, Flight-capable PPR, 6/6 Astro island directives) — see
> [FEATURES.md](./FEATURES.md).
>
> **This is a roadmap: it tracks the pending engineering backlog and nothing else.**
> The product / go-to-market strategy (positioning, objections, the phased adoption
> plan, launch, risk) now lives in its own permanent home,
> [STRATEGY.md](./STRATEGY.md). Completed work is recorded in
> [FEATURES.md](./FEATURES.md), not re-catalogued here. The larger 2.0 DX plan lives
> in [ROADMAP-2.0.md](./ROADMAP-2.0.md).
>
> This file has two parts:
>
> - **Engineering backlog** — the canonical list of what remains, deferred and
>   documented in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).
> - **Part B — Ecosystem & zero-npm engineering** (formerly ROADMAP-ECOSYSTEM):
>   making the runtime literally zero-npm and growing a first-party JSR package
>   ecosystem (WASM codecs + a plugin architecture).
>
> The retired ROADMAP-1.0 engineering checklist shipped — its deferred items live in
> the backlog below. [FEATURES.md](./FEATURES.md) is the source of truth for what's
> supported; [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) for the honest gaps.

---

# Mission

denext's mission is to **replace React and Next.js with a superior framework,
written in Deno** — smaller and auditable (zero-npm), secure by default (off Next's
CVE treadmill), doing what React structurally can't (Live Server Components /
resumability / islands), all behind one cargo-class tool for every React app. The
full statement and its five superiority pillars live in **[MISSION.md](./MISSION.md)**.

**What this roadmap is.** The gap between that mission and today — **the engineering
we still need to add** under each pillar to make "superior replacement" true. It is
not a changelog: **completed work lives in [FEATURES.md](./FEATURES.md), not here.**
The product / GTM strategy is in [STRATEGY.md](./STRATEGY.md); Part B below is the
zero-npm engineering (Pillar 1); the 2.0 DX tool (Pillar 4) has its own file,
[ROADMAP-2.0.md](./ROADMAP-2.0.md). [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)
tracks the honest gaps.

---

# Engineering backlog

The single canonical engineering backlog — what remains, deferred and documented in
KNOWN-LIMITATIONS.md (Part B's engineering items fold in here; shipped work is in
[FEATURES.md](./FEATURES.md)):

- **DevTools depth** — the first-party inspector ships (`denext/devtools`): the live
  component tree with per-node props, **hooks/state + context inspection**, and **live
  state editing**, behind an opt-in in-page glass-box panel (see
  [FEATURES.md](./FEATURES.md)). Still open: a Profiler tab, override-props, and source
  links / owner stacks (version-sensitive; hard to CI-test).
- **Build-time deps** — migrate `lightningcss`/`swc`/`esbuild` off npm to first-party
  JSR builds (build-time only; no runtime-claim impact — see Part B §B-Remaining).
- **RSC render-mode waterfall** — the devtools panel now shows the client boundaries
  (the island hydration waterfall — strategy + timing) alongside the component tree, and
  the opt-in `DevPanel` (`denext/server`) shows the page-cache snapshot
  (`getCacheStats()`). What remains is the **server-emitted per-boundary detail** —
  static vs dynamic vs streamed and the postpone/Flight timing (why a boundary
  re-rendered, the RSC/Suspense timeline, `<Live>` boundaries lighting up in real time).
  Turns objection #8 in [STRATEGY.md](./STRATEGY.md) ("cloned the parts people hate")
  into a selling point.

# Part B — Ecosystem & zero-npm engineering

A technical plan for making denext's runtime **literally zero-npm** and for growing
a **first-party JSR ecosystem** (WASM codecs + plugins like a Pages Router). The
engineering backlog items surfaced here are folded into the single canonical
[Engineering backlog](#engineering-backlog) above.

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

## B-Open questions

- **Scope name** for ecosystem packages: `@denext/*` (cohesion) vs a neutral scope?
- **Codec licenses:** confirm each upstream license permits redistribution of the
  built `.wasm` (photon-rs, libavif, resvg, yoga) and ship the notices.
- **Plugin contract surface:** how much of `src/router` / `src/build` / `src/server`
  internals must become semver-stable public API for a router plugin — and can we keep
  it narrow enough to evolve the core freely?
