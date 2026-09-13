# denext — Roadmap (2.4)

> Status: internal engineering tracker. **This file lists only work that still
> needs doing.** Completed work lives in [FEATURES.md](./FEATURES.md) and
> [CHANGELOG.md](./CHANGELOG.md); honest gaps in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the mission + its superiority
> pillars in [MISSION.md](./MISSION.md).
>
> `development` is **2.4.1** (the version line `deno task bump` rewrites). 2.1 — the
> typed, self-documenting API surface (`defineApi`, the typed client,
> `@denext/openapi`, `@denext/graphql`), plus scheduled tasks + cron, type-safe
> routing, and `@denext/content-collections` — shipped from it. **2.4 is the next
> engineering cycle.** What remains is the last build-time-purity items and the
> ecosystem router plugins. Everything below targets 2.4 unless marked otherwise.
> This roadmap is rewritten for the following cycle when 2.4 ships.

---

## Build-time deps → first-party JSR/WASM

Reducing the build-time npm surface (build-time only, so the zero-npm **runtime**
claim already holds regardless). **`lightningcss` and `swc` are done** — replaced
by first-party `@denext/lightningcss` + `@denext/swc` (JSR, built via `wasmbuild`
from the core crates; see CHANGELOG). What remains npm at build time: **`esbuild`**
(the item below) plus the opt-in `sass` / `@mdx-js/mdx` / `ws`.

- **`esbuild`** stays until Deno grows the bundler hooks it stands in for — see
  _Upstream watch_ below for what exactly we are waiting on. The Deno-native binder
  path for anything else is proven: **Rust codecs** →
  [`denoland/wasmbuild`](https://github.com/denoland/wasmbuild) (`wasm-bindgen`
  glue, the `@denext/photon` / `@denext/lightningcss` / `@denext/swc` recipe);
  **C codecs** → a WASI/Component-Model component +
  [`jco transpile`](https://bytecodealliance.github.io/jco/transpiling.html).
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

- **TanStack Router, Start depth** — library mode is served: a stock file-based
  TanStack Router app runs in SPA mode with no plugin (`examples/tanstack-router`,
  the shape `denext migrate` writes), so no `@denext/tanstack-router` package at
  that depth (a package wrapping zero seams would be API surface with no payoff).
  What remains is TanStack Start-style SSR through `plugin-kit`, the same shape
  `@denext/react-router` proved out; its named unknown is the route tree, which
  TanStack generates with its Vite plugin (`routeTree.gen.ts`) — out-of-band
  `tsr generate` covers library mode, a Start plugin must own the generation.
- A missing primitive goes into `plugin-kit` (the plugin-kit rule: a deliberate,
  tested semver addition — as `apiDefinitionOf`, `tapChannel`, `verifyOrigin` and
  `remixCodegen` were), never the private surface.

## Upstream watch — `deno bundle` hooks (the last npm build tool, and native-path DCE)

**Standing watch item, not keystone work.** One dependency and one missing size win share
a single cause: `deno bundle` — esbuild under the hood — exposes none of esbuild's plugin
surface. Until it does, denext keeps `npm:esbuild` at build time and the native path
ships a little optional runtime it cannot strip. Neither touches the zero-npm **runtime**
guardrail; both are build-time.

- **Why `esbuild` is still here.** The next-compat and SPA-compat builds (apps that bring
  npm React: Next drop-ins, Vite migrations) and the unbundled dev loop's `@dep`
  pre-bundle must rewrite imports **inside `node_modules`**, not just in the app's own
  files. An import map — which `deno bundle --import-map` honours — reaches only the
  app's bare specifiers; when an npm library does its own `import "react"`, Node
  resolution hands it the real React and the page runs two Reacts. esbuild resolver
  plugins (`appResolverPlugin`, `denextRuntimePlugin` in `src/build/next-compat.ts`)
  redirect `react`/`react-dom`/`next/*` for every module in the graph — the "two
  Reacts" fix FEATURES.md describes. The same plugin seam then grew the transforms the
  compat path needs and `deno bundle` has no hook for: Vite `?url`/asset imports, the
  CSS shim redirect, MDX compile, the `"use cache"` transform, Node-builtin browser
  stubs, `import.meta.env` defines, pnpm `catalog:`/`workspace:` resolution, Prisma
  externals, and the Deno loader for `jsr:` specifiers (~20 plugins). The native App
  Router path needs none of this and already builds with `deno bundle`, npm-free.
- **Why native builds carry ~5 KB they don't use.** The define-fold dead-code
  elimination behind `classComponents` (bare-identifier guard → literal → dropped
  branch) needs `--define`, which `deno bundle` lacks; on native builds the class
  runtime (~3.1 KB) and the inert-in-prod devtools bridge (~2.2 KB) — ~2 KB gz together,
  profiled on the ~52 KB shared runtime — always ship. A size win only; the compat path
  already DCEs them.
- **What we are waiting for, in order of how much it unblocks.** (1) A **resolver/loader
  plugin API** for `deno bundle` (or a package-wide alias that applies inside npm
  packages) — that alone retires `npm:esbuild` for the alias half and lets the source
  transforms be ported one hook at a time; (2) **`--define`** — that alone closes the
  native DCE gap. Status (re-verified 2026-09-13): **Deno 2.9.6** has neither. `--define`
  is tracked in [denoland/deno#35347](https://github.com/denoland/deno/issues/35347),
  closed as completed 2026-06-19 and awaiting a release — a _when_. A plugin API has no
  committed issue; watch the `deno bundle` release notes.
- **The fallback we are not taking yet.** esbuild compiled to wasm and published as
  `@denext/esbuild` (the `@denext/swc` recipe) would remove the npm download today, but
  runs several times slower than the native binary on every compat build and every
  unbundled dev session — a hygiene win paid for in DX. Revisit only if the plugin API
  stalls for a long time or a wasm build closes the speed gap.
- **Action when `--define` lands.** Add a `denoBundleSupportsDefine()` capability probe
  (extend `probeBundleSupport` in `src/build/bundle.ts`) and pass `--define __FLAG__=…`,
  **reusing the esbuild `classDefine()` map verbatim** (`src/build/next-compat.ts`) so
  both bundlers share one flag-authoring pattern. The probe must degrade cleanly on
  older Deno — never break a build.
- **Action when plugins land.** Port `appResolverPlugin`/`denextRuntimePlugin` first
  (the alias half is small and is the whole "two Reacts" fix), keep esbuild for the
  remaining transforms, then move those one hook at a time; the compat e2es
  (`tests/e2e/next-compat-*`, `spa-compat`, `unbundled-*`) are the gate.

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

## Later (not committed to 2.4)

- Generated clients for **non-denext consumers** in **other languages** from the
  OpenAPI/GraphQL documents. TypeScript consumers are served: `denext openapi types`
  emits an import-free `ApiSchema` that `createApiClient<ApiSchema>({ base })` from
  JSR types from any project, so no fetch wrapper is generated for TS.
- `esbuild` off npm — blocked on Deno, not on us; see _Upstream watch_ above for
  the exact hooks we are waiting for and the wasm fallback we are deliberately not taking.
- **Node-stream `Writable` backpressure** for `renderToPipeableStream` /
  `renderToStaticNodeStream` (they buffer today — the first entry in
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)): make the core renderer
  pull-gated and resolve the `await allReady`-then-read deadlock the current
  eager drain avoids. An SSR-hot-path change with real regression risk and a
  narrow payoff; `renderToReadableStream` is the primary path.
