# denext — Roadmap (2.2)

> Status: internal engineering tracker. **This file lists only work that still
> needs doing.** Completed work lives in [FEATURES.md](./FEATURES.md) and
> [CHANGELOG.md](./CHANGELOG.md); honest gaps in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the mission + its superiority
> pillars in [MISSION.md](./MISSION.md).
>
> `development` is **2.2.0** (the version line `deno task bump` rewrites). 2.1 — the
> typed, self-documenting API surface (`defineApi`, the typed client,
> `@denext/openapi`, `@denext/graphql`), plus scheduled tasks + cron, type-safe
> routing, and `@denext/content-collections` — shipped from it. **2.2 is the next
> engineering cycle.** What remains is the last build-time-purity items and the
> ecosystem router plugins. Everything below targets 2.2 unless marked otherwise.
> This roadmap is rewritten for the following cycle when 2.2 ships.

---

## Build-time deps → first-party JSR/WASM

The one remaining **runtime-purity** item — build-time only, so it never enters a
shipped bundle and the zero-npm **runtime** claim already holds. Migrate
`lightningcss` / `swc` / `esbuild` off npm via the Deno-native binder path:

- **Rust codecs** → [`denoland/wasmbuild`](https://github.com/denoland/wasmbuild)
  (`wasm-bindgen` glue, the `@denext/photon` recipe). **C codecs** → a
  WASI/Component-Model component +
  [`jco transpile`](https://bytecodealliance.github.io/jco/transpiling.html).
  Deno imports `.wasm` directly, so the glue stays thin; no hand-written
  marshalling, no npm.
- `lightningcss` / `swc` are already WASM builds with a single import site each
  (`src/build/css.ts`, `src/build/swc-ast.ts`) — a surgical repoint to
  `@denext/*` packages, **2.2**. `esbuild` (native-backed, large API surface,
  used by the next-compat build and the unbundled dev loop) is deferred furthest
  — see "Later" below.
- **Standing discipline:** track each vendored codec's upstream CVEs, rebuild
  SHA-256-pinned (like the Tailwind binary), and regenerate its
  `THIRD-PARTY-LICENSES.md` before re-publishing — Pillar 2 in maintenance form.

## Ecosystem router plugins

The plugin contract is **settled**: a router-class plugin imports from exactly
two places — `@denext/denext` (app API) and `@denext/denext/plugin-kit` (contract
seams + pipeline primitives: matchers, `bundleRoutes`, CSS, hydration /
Fast-Refresh, `PageCache`). `@denext/pages-router` and `@denext/react-router` dogfood it (both **shipped**;
react-router is framework mode via the route-synthesizer seam) and
`tests/plugin-kit.test.ts` guards it. Remaining build work:

- **`@denext/tanstack-router`** — the two depths (library mode → SPA today;
  TanStack Start-style SSR → `plugin-kit`), the same shape `@denext/react-router`
  proved out.
- A missing primitive goes into `plugin-kit` (the plugin-kit rule: a deliberate,
  tested semver addition — as `apiDefinitionOf`, `tapChannel`, `verifyOrigin` and
  `remixCodegen` were), never the private surface.

## Upstream watch — `deno bundle --define` (unblocks native-path DCE)

**Standing watch item, not keystone work.** The native `deno bundle` path has no
`--define`, so the define-fold dead-code elimination that powers
`classComponents` (bare-identifier guard → literal → dropped branch) works only on
the esbuild/next-compat path; on native builds optional runtime always ships.

- **Status (re-verified 2026-09-04).** Still absent on **Deno 2.9.6**, the latest
  release. Deno issue
  [#35347](https://github.com/denoland/deno/issues/35347) is closed as
  completed (2026-06-19) and awaits a release — a _when_, not an _if_.
- **What it unblocks** (profiled on the ~52 KB shared runtime): strip the class
  runtime (~3.1 KB) and the inert-in-prod devtools bridge (~2.2 KB) — ~5 KB raw /
  ~2 KB gz — from native builds that don't use them. A size win only (the
  next-compat path already DCEs them; `--define` extends the same `classComponents`
  gate to native), not a bug fix.
- **Action when it lands.** Add a `denoBundleSupportsDefine()` capability probe
  (extend `probeBundleSupport` in `src/build/bundle.ts`) and pass
  `--define __FLAG__=…`, **reusing the esbuild `classDefine()` map verbatim**
  (`src/build/next-compat.ts`) so both bundlers share one flag-authoring pattern.
  The probe must degrade cleanly on older Deno — never break a build.
- **Nothing blocks on this** — the bundle wins already shipped; it only raises the
  ceiling for native-path opt-outs.

## Guardrails (standing)

- **Zero-npm runtime is sacred** — never reintroduce an npm dependency into a
  shipped bundle (CI-enforced by the `no-npm-compat-guard` test). Build-time-only
  WASM/JSR tools are fine. OpenAPI/GraphQL libraries are **opt-in server-side**
  deps resolved through the merged-config re-exec (`src/build/module-config.ts`),
  the ORM-support precedent; prefer JSR / zero-dep options where they exist
  (`@denext/openapi` is zero-dep; `@denext/graphql` is a declared npm bridge like
  `@denext/effect`).
- **Never claim 100% React/Next parity** — compat is the on-ramp, never the
  headline. Do not market the typed API surface as "NestJS on Deno" either.
- **No decorator-metadata transpile stage.** A proposal for
  `experimentalDecorators` / `emitDecoratorMetadata` must clear a much higher bar
  than "it's how Nest does it."
- **Out of scope:** React Native / native rendering — Capacitor/WebView stays the
  mobile story; a true RN target is a separate future frontier.

## Candidate features (from the framework-gap survey)

Vetted gaps vs Next/Nuxt/Astro/SvelteKit/TanStack. Three picks from this survey have **shipped**:
scheduled tasks + cron (`tasks/` + `defineTask`, `scheduledTasks`, `Deno.cron` with a userland
fallback, `denext task`), **type-safe routing** (typed `{ pathname, params }`, `useParams<P>`,
schema-validated `useSearchParams`, typed `redirect`), and the **`@denext/content-collections`**
package (typed/validated/queryable MD/MDX/YAML/JSON content layer). See CHANGELOG/FEATURES. The
rest are kept here so they aren't lost; not yet scheduled.

- **Deploy adapter API + presets** (the larger, separate bet — Nitro / Next 16 Adapters):
  a typed build manifest (routes, prerenders, assets, cache rules) + a pluggable adapter
  seam with first-party presets. Achievable targets for a Deno-native framework: **static
  export, Deno Deploy, Node (deno node-compat), Docker**, with a documented third-party seam
  for Workers/Vercel. Highest ecosystem value, largest effort, one real Deno-fit tension
  (Workers runs workerd, not Deno). Builds on the existing plugin `addBuildStep` seam.

## Later (not committed to 2.2)

- Generated clients for **non-denext consumers** from the OpenAPI/GraphQL
  documents (other languages, other frontends) — denext apps already get typed
  calls to their own routes from `createApiClient`.
- `esbuild` off npm (above), once the two WASM repoints have shipped.
- **Node-stream `Writable` backpressure** for `renderToPipeableStream` /
  `renderToStaticNodeStream` (they buffer today — the first entry in
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)): make the core renderer
  pull-gated and resolve the `await allReady`-then-read deadlock the current
  eager drain avoids. An SSR-hot-path change with real regression risk and a
  narrow payoff; `renderToReadableStream` is the primary path.
- **`next/font` metric-matched fallback face** (`adjustFontFallback`:
  `size-adjust`/`ascent-override` on a local fallback to cut CLS) — needs a
  bundled font-metrics database; a guessed table would mis-size the fallback.
