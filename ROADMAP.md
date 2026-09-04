# denext — Roadmap (remaining engineering)

> Status: internal engineering tracker. **This file lists only work that still
> needs doing.** Completed work lives in [FEATURES.md](./FEATURES.md) and
> [CHANGELOG.md](./CHANGELOG.md); honest gaps in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the mission + its superiority
> pillars in [MISSION.md](./MISSION.md).
>
> denext has shipped through **1.4.0**; `development` is **2.0.0-rc.7** — the DX
> release (unified CLI, universal migration, scaffolding/codegen, an instant dev
> loop, and first-party DevTools) has landed. What remains before cutting 2.0 is
> below. **This roadmap is retired (deleted) when 2.0 ships.**

---

## Remaining before 2.0

- **Cut the release.** Bump the version in `deno.json` **and** `mod.ts` to
  `2.0.0`, then cut `v2.0.0` (tag-triggered JSR publish) from `development`.
  Gated on an explicit maintainer go — the DX engineering is done; this is a
  release action, not more engineering.
- ~~**Graduate experimental flags.**~~ **Closed** — and smaller than this item
  once implied. The island directives never had a flag; `streaming` and `live`
  have been top-level since 1.4, so 2.0 only deletes their vestigial
  `experimental.streaming` / `experimental.live` aliases (a dev warning names
  the new key; no codemod needed). Cache Components graduated to a **stable,
  opt-in** top-level `cacheComponents` — not kept experimental, not default-on;
  the legacy `experimental.cacheComponents` still works with a dev warning.
  What remains under `experimental` (`compiler`, `asyncContext`, `nodeResolve`)
  is genuinely incomplete and stays.
- ~~**Config coherence pass.**~~ **Closed.** The schema is exported:
  `denext.config.schema.json` (repo root) is generated from the `DenextConfig`
  type by `deno task docs:api` (a zero-dependency script over `deno doc --json`
  — the TS type stays the single source; no Zod, no npm), alongside
  `src/server/config-keys.generated.ts`
  (the exhaustive key list the runtime validator and config loader share;
  `experimental.*` sub-keys now get did-you-mean warnings too). Field renames
  were evaluated and **none made**: `compatibilityMode` was just renamed from
  `nextCompat` (a second rename is exactly the churn to avoid), and `mode`/`spa`,
  `classComponents`, `streaming`, `live`, `basePath`, `assetPrefix`,
  `trailingSlash` read cleanly and match their Next analogs — don't re-litigate.

## Build-time deps → first-party JSR/WASM

The one remaining **runtime-purity** item — build-time only, so it never enters
a shipped bundle and the zero-npm **runtime** claim already holds. Migrate
`lightningcss` / `swc` / `esbuild` off npm via the Deno-native binder path:

- **Rust codecs** (lightningcss, …) →
  **[`denoland/wasmbuild`](https://github.com/denoland/wasmbuild)**
  (`wasm-bindgen` glue). **C codecs** → a WASI/Component-Model component +
  **[`jco transpile`](https://bytecodealliance.github.io/jco/transpiling.html)**.
  Deno 2.1+ imports `.wasm` directly, so the glue stays thin. No hand-written
  marshalling, no npm.
- `lightningcss` / `swc` are already WASM builds with a single import site each
  (`src/build/css.ts`, `src/build/swc-ast.ts`) — a surgical repoint, teed up but
  **publish-gated** (the same status as the shipped `@denext/*` codec packages).
  `esbuild` (native-backed, large API surface, isolated to
  `src/build/next-compat.ts`) is the largest and is deferred furthest — see
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) → "Post-2.0 (deferred, not
  gaps)".
- **Standing discipline:** track each vendored codec's upstream CVEs and rebuild
  (SHA-256-pinned, like the Tailwind binary) — Pillar 2 (secure by default) in
  maintenance form.

## Ecosystem decisions (settled)

Both former open questions are closed; the answers are policy from here on.

- **Scope name — `@denext/*` for every first-party package.** The question was
  whether the _codecs_ (`@denext/photon`, `@denext/avif`, `@denext/og`) should
  live under a neutral scope, since they are plain Deno libraries any project can
  use, while the framework, its router plugins (`@denext/pages-router`,
  `@denext/htmx`) and bridges (`@denext/effect`) obviously belong to `@denext`.
  Decided: one scope. (1) They are already published and consumed under
  `@denext/*` — a rename means deprecating live packages and changing the image
  optimizer's specifiers for no functional gain. (2) [MISSION.md](./MISSION.md)
  sells "first-party Rust→WASM, built from source _we_ own and audit" as a denext
  claim; the scope _is_ that provenance signal. (3) One scope is one publish
  workflow, one token set and one supply-chain surface to guard — a second scope
  doubles what an attacker can phish. (4) A JSR scope is a namespace, not a
  dependency: nothing in the codecs imports the framework, and each package
  README says whether it depends on denext (codecs: no). Future packages
  (`@denext/openapi`, `@denext/graphql`, `@denext/react-router`, …) follow the
  same rule.
- **Codec licenses — verified; notices ship in every codec package.** Each
  upstream is permissive and allows redistributing the built `.wasm`/bundle,
  subject to notice retention, which the packages now satisfy:

  | Package          | Vendors                                                                             | Upstream licenses                                                                           | Notice file                                                                         |
  | ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `@denext/photon` | photon-rs 0.3.3 + 96 transitive Rust crates                                         | Apache-2.0; MIT/Apache-2.0 dual, BSD-3-Clause (instant), Unicode-3.0 (unicode-ident)        | `THIRD-PARTY-LICENSES.md`, generated by `deno task licenses:photon` on each rebuild |
  | `@denext/avif`   | libavif 1.0.x + libaom 3.7.0, via `@jsquash/avif@2.1.1` (Squoosh build); emscripten | BSD-2-Clause (+ Alliance for Open Media Patent License 1.0 for libaom); Apache-2.0; MIT     | `THIRD-PARTY-LICENSES.md` (hand-kept; refresh when the vendored codec changes)      |
  | `@denext/og`     | satori 0.29 + resvg-wasm 2.4.1 + yoga + Noto Sans, via `@cf-wasm/og@0.5.0`          | MPL-2.0 (satori, resvg — unmodified, source pointers at pinned versions), MIT, ISC, OFL-1.1 | `THIRD-PARTY-LICENSES.md` (since 0.1.0)                                             |

  The only non-trivial terms: libaom's BSD grant rides on the AOM patent license
  (its patent grant ends for anyone who litigates AV1 patents), and MPL-2.0 is a
  per-file copyleft satisfied by shipping the components unmodified with source
  pointers. Standing discipline: a codec rebuild regenerates/refreshes its notice
  file before the package is re-published (the package READMEs say how).

## Ecosystem router plugins

The plugin contract surface is **settled** (was an open question): a
router-class plugin imports from exactly two places — `@denext/denext` (app API)
and `@denext/denext/plugin-kit` (contract seams + the pipeline primitives:
matchers, `bundleRoutes`, CSS, hydration/Fast-Refresh, `PageCache`). Everything
else in `src/router` / `src/build` / `src/server` stays private and free to
change. The kit is stable by _signature_, not by internal location;
`@denext/pages-router` dogfoods it and `tests/plugin-kit.test.ts` guards it. See
[PLUGINS.md](./PLUGINS.md) → "Stability — the three tiers". Remaining build work
(soon, not now):

- **`@denext/react-router`** — React Router on denext. **Client mode** works
  today via SPA mode (shell + client entry); the plugin is config sugar.
  **Framework mode** (loaders + streaming SSR) via the `plugin-kit` surface — no
  core change needed.
- **`@denext/tanstack-router`** — same two depths (TanStack Router library mode
  → SPA today; TanStack Start-style SSR → `plugin-kit`).
- If a real router surfaces a primitive the kit lacks, **add it to
  `plugin-kit`** (a deliberate, tested semver addition) rather than widening the
  private surface.

## Guardrails (standing)

- **Zero-npm runtime is sacred** — never reintroduce an npm dependency into a
  shipped bundle (CI-enforced by the `no-npm-compat-guard` test).
  Build-time-only WASM/JSR tools are fine.
- **Never claim 100% React/Next parity** — compat is the on-ramp, never the
  headline.
- **Out of scope for 2.0:** React Native / native rendering — Capacitor/WebView
  stays the mobile story; a true RN target is a separate future frontier.
