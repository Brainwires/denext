# denext — Roadmap (remaining engineering)

> Status: internal engineering tracker. **This file lists only work that still needs
> doing.** Completed work lives in [FEATURES.md](./FEATURES.md) and
> [CHANGELOG.md](./CHANGELOG.md); honest gaps in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); product / go-to-market strategy in
> [STRATEGY.md](./STRATEGY.md); the mission + its superiority pillars in
> [MISSION.md](./MISSION.md).
>
> denext has shipped through **1.4.0**; `development` is **2.0.0-rc.1** — the DX
> release (unified CLI, universal migration, scaffolding/codegen, an instant dev
> loop, and first-party DevTools) has landed. What remains before cutting 2.0 is
> below. **This roadmap is retired (deleted) when 2.0 ships.**

---

## Remaining before 2.0

- **Cut the release.** Bump the version in `deno.json` **and** `mod.ts` to `2.0.0`,
  then cut `v2.0.0` (tag-triggered JSR publish) from `development`. Gated on an
  explicit maintainer go — the DX engineering is done; this is a release action, not
  more engineering.
- **Graduate experimental flags.** Drop the interim `experimental.*` toggles that
  guarded now-default 1.4 features (streaming default-on, Flight-capable PPR, the 6/6
  island directives). Breaking; ship a `denext migrate` codemod where a break would
  hit a real user (courtesy, not contract).
- **Config coherence pass.** Unify/rename `denext.config` fields where it genuinely
  improves clarity and export a config schema — a pre-2.0 breaking-changes cleanup
  (optional; do it only where it earns its keep).
- **`@denext/htmx` addon.** First-class HTMX as a self-contained first-party plugin
  package (`packages/htmx`): the runtime served zero-npm from `'self'`, `hx-*` JSX
  attribute types, `HX-*` request/response helpers, a `<Htmx/>` component, an example,
  and docs. No core engine change (a pure-`hx-*` page already ships 0 KB denext JS).
  Open decisions (vendor vs Deno/TS port of htmx) + design live in the working plan;
  the package's starting version **matches the htmx version it wraps** (current
  htmx 2.0.x).

## Build-time deps → first-party JSR/WASM

The one remaining **runtime-purity** item — build-time only, so it never enters a
shipped bundle and the zero-npm **runtime** claim already holds. Migrate
`lightningcss` / `swc` / `esbuild` off npm via the Deno-native binder path:

- **Rust codecs** (lightningcss, …) → **[`denoland/wasmbuild`](https://github.com/denoland/wasmbuild)**
  (`wasm-bindgen` glue). **C codecs** → a WASI/Component-Model component +
  **[`jco transpile`](https://bytecodealliance.github.io/jco/transpiling.html)**.
  Deno 2.1+ imports `.wasm` directly, so the glue stays thin. No hand-written
  marshalling, no npm.
- `lightningcss` / `swc` are already WASM builds with a single import site each
  (`src/build/css.ts`, `src/build/swc-ast.ts`) — a surgical repoint, teed up but
  **publish-gated** (the same status as the shipped `@denext/*` codec packages).
  `esbuild` (native-backed, large API surface, isolated to `src/build/next-compat.ts`)
  is the largest and is deferred furthest — see
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) → "2.0 DX — items deferred to
  post-2.0".
- **Standing discipline:** track each vendored codec's upstream CVEs and rebuild
  (SHA-256-pinned, like the Tailwind binary) — Pillar 2 (secure by default) in
  maintenance form.

## Open questions (ecosystem)

- **Scope name** for ecosystem packages: `@denext/*` (cohesion) vs a neutral scope?
- **Codec licenses:** confirm each upstream license permits redistributing the built
  `.wasm` (photon-rs, libavif, resvg, yoga) and ship the notices.
- **Plugin contract surface:** how much of `src/router` / `src/build` / `src/server`
  must become semver-stable public API for a router-class plugin — kept narrow enough
  to evolve the core freely?

## Guardrails (standing)

- **Zero-npm runtime is sacred** — never reintroduce an npm dependency into a shipped
  bundle (CI-enforced by the `no-npm-compat-guard` test). Build-time-only WASM/JSR
  tools are fine.
- **Never claim 100% React/Next parity** — compat is the on-ramp, never the headline.
- **Out of scope for 2.0:** React Native / native rendering — Capacitor/WebView stays
  the mobile story; a true RN target is a separate future frontier.
