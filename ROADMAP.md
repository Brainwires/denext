# denext — Roadmap (2.1)

> Status: internal engineering tracker. **This file lists only work that still
> needs doing.** Completed work lives in [FEATURES.md](./FEATURES.md) and
> [CHANGELOG.md](./CHANGELOG.md); honest gaps in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the mission + its superiority
> pillars in [MISSION.md](./MISSION.md).
>
> `development` is **2.0.0** (the version line `deno task bump` rewrites).
> 2.0 — the DX release (unified CLI, universal migration, scaffolding/codegen, an
> instant dev loop, first-party DevTools, end-to-end typed routes and actions) —
> shipped from it. **2.1 is the next engineering cycle**: a typed,
> self-documenting API surface, the last build-time purity items, and the
> ecosystem router plugins. Everything below targets 2.1 unless marked otherwise.
> This roadmap is rewritten for the following cycle when 2.1 ships.

---

## 2.1 keystone — a typed, self-documenting API surface

**Where 2.0 leaves it.** API routes are `route.ts` files exporting plain
`GET`/`POST`/… functions over `Request → Response`, dispatched through
`handleApi` (`src/server/api.ts`). 2.0 already gives them **static** end-to-end
types: `TypedResponse<T>` / `TypedRequest<B>` (`denext/server`) feed the generated
`.denext/api.ts`, and `createApiClient` type-checks every call to your own API;
`defineAction` validates `FormData` through any Standard-Schema validator with its
`Out` type flowing into `useActionState`. **Still missing:** runtime request
validation for route handlers (a malformed body reaches user code), a
machine-readable description (no OpenAPI), a docs UI, and a GraphQL surface. 2.1
closes that gap with first-party plugins on the settled plugin contract — the
developer experience people praise in NestJS's `@nestjs/swagger`, reached the
Deno-idiomatic way.

**Approach (decided — CHANGELOG, 2.0.0):** schema-first, not decorator-first —
one schema per route, colocated with the handler, from which validation, static
types and the OpenAPI document derive.

### WS1 — `@denext/openapi` (the anchor deliverable)

- **Route helper.** `defineApi({ summary, params, query, body, response }, handler)`
  — the route-handler twin of `defineAction`: one Standard-Schema validator (Zod /
  Valibot / TypeBox / ArkType) per method; handlers receive parsed, typed
  `params` / `query` / `body` instead of a raw `Request`. It must compose with
  `TypedResponse` and the generated `.denext/api.ts`, so a schema authored once
  feeds the static client types, the runtime validation **and** the spec.
- **Validation seam.** Wrap `handleApi` — the single dispatch choke point — so a
  schema mismatch returns a structured `400` before user code runs. Additive, and
  a no-op for un-annotated routes.
- **Spec generation.** Walk the route manifest (`src/router/manifest.ts`), read
  each route's attached schema, emit `openapi.json` three ways through the plugin
  contract (`src/plugin/mod.ts`): `addRequestHandler` serves `/openapi.json` live,
  `addBuildStep` writes a static spec at `denext build`, `addCommand` adds
  `denext openapi` (emit / diff / lint the spec in CI).
- **Docs UI.** Serve Swagger UI or Scalar at `/docs` via `addRequestHandler` —
  core routes always win, so it never shadows an app page.
- **Reference to follow:** `packages/pages-router` dogfoods the same seams with a
  whole alternate pipeline; this plugin is far smaller.

**Definition of done:** an unmodified app adds `@denext/openapi`, annotates one
route with `defineApi`, and gets request validation + a live `/openapi.json` +
`/docs` with **zero** config or toolchain change — and `createApiClient` still
type-checks the call.

### WS2 — `@denext/graphql`

- **Server.** `graphql-yoga` is a `(Request) => Response` handler — a one-line
  `/graphql` mount through `addRequestHandler`, GraphiQL included.
- **Schema.** **Pothos** (code-first, type-safe, **no decorators**) is the
  recommended builder. TypeGraphQL / `@nestjs/graphql` are out: both are
  decorator-metadata-based and hit the blocker WS1 rejected.
- **Subscriptions.** GraphQL-over-SSE on denext's existing SSE/Live transport, not
  a separate WebSocket server.
- **CLI.** `denext graphql` (`addCommand`) to print the SDL / run codegen in CI.

**Definition of done:** `@denext/graphql` + a Pothos schema serves a working
`/graphql` endpoint with subscriptions over the Live transport, no core change.

### WS3 — plugin-kit additions (only if needed)

Both plugins build entirely on the **settled** public contract (`@denext/denext`

- `@denext/denext/plugin-kit`; [PLUGINS.md](./PLUGINS.md) → "Stability — the
  three tiers"). If either surfaces a genuinely missing primitive (e.g. a typed
  accessor for a route's attached schema on the manifest), **add it to
  `plugin-kit`** as a deliberate, tested semver addition guarded in
  `tests/plugin-kit.test.ts` — never widen the private `src/router` / `src/build` /
  `src/server` surface.

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
  `@denext/*` packages, **2.1**. `esbuild` (native-backed, large API surface,
  used by the next-compat build and the unbundled dev loop) is deferred furthest
  — see "Later" below.
- **Standing discipline:** track each vendored codec's upstream CVEs, rebuild
  SHA-256-pinned (like the Tailwind binary), and regenerate its
  `THIRD-PARTY-LICENSES.md` before re-publishing — Pillar 2 in maintenance form.

## Ecosystem router plugins

The plugin contract is **settled**: a router-class plugin imports from exactly
two places — `@denext/denext` (app API) and `@denext/denext/plugin-kit` (contract
seams + pipeline primitives: matchers, `bundleRoutes`, CSS, hydration /
Fast-Refresh, `PageCache`). `@denext/pages-router` dogfoods it and
`tests/plugin-kit.test.ts` guards it. Remaining build work:

- **`@denext/react-router`** — **client mode** works today via SPA mode (shell +
  client entry); the plugin is config sugar. **Framework mode** (loaders +
  streaming SSR) via `plugin-kit` — no core change needed.
- **`@denext/tanstack-router`** — same two depths (library mode → SPA today;
  TanStack Start-style SSR → `plugin-kit`).
- A missing primitive goes into `plugin-kit` (WS3 rule), never the private
  surface.

## Upstream watch — `deno bundle --define` (unblocks native-path DCE)

**Standing watch item, not keystone work.** The native `deno bundle` path has no
`--define`, so the define-fold dead-code elimination that powers
`classComponents` (bare-identifier guard → literal → dropped branch) works only on
the esbuild/next-compat path; on native builds optional runtime always ships.

- **Status (re-verified 2026-09-04).** Still absent on **Deno 2.9.6**, the latest
  release. Deno issue
  [#35347](https://github.com/denoland/deno/issues/35347) is closed as
  completed (2026-06-19) and awaits a release — a _when_, not an _if_.
- **What it unblocks** (profiled on the ~52 KB shared runtime): the class
  runtime (~3.1 KB) and the inert-in-prod devtools bridge (~2.2 KB) — ~5 KB raw /
  ~2 KB gz — plus a **correctness gap**: `classComponents: false` is documented to
  remove the class runtime but is a silent no-op on the native path today.
- **Action when it lands.** Add a `denoBundleSupportsDefine()` capability probe
  (extend `probeBundleSupport` in `src/build/bundle.ts`) and pass
  `--define __FLAG__=…`, **reusing the esbuild `classDefine()` map verbatim**
  (`src/build/next-compat.ts`) so both bundlers share one flag-authoring pattern.
  The probe must degrade cleanly on older Deno — never break a build.
- **Nothing blocks on this** — the bundle wins already shipped; it only raises the
  ceiling for native-path opt-outs.

## Open questions (2.1)

- **Validator baseline.** Ship TypeBox as the blessed default (JSON-Schema-native,
  so spec emission is near-free) but accept any Standard-Schema validator? Or stay
  validator-agnostic from day one, as `defineAction` is?
- **Docs UI vendor.** Swagger UI (familiar) vs Scalar (lighter, nicer default) —
  and whether the UI assets ship vendored (zero-npm, offline) or are fetched at
  build.

## Guardrails (standing)

- **Zero-npm runtime is sacred** — never reintroduce an npm dependency into a
  shipped bundle (CI-enforced by the `no-npm-compat-guard` test). Build-time-only
  WASM/JSR tools are fine. OpenAPI/GraphQL libraries are **opt-in server-side**
  deps resolved through the merged-config re-exec (`src/build/module-config.ts`),
  the ORM-support precedent; prefer JSR / zero-dep options where they exist — a
  first-party zero-dep OpenAPI emitter is a stretch goal, not a gate.
- **Never claim 100% React/Next parity** — compat is the on-ramp, never the
  headline. Do not market the typed API surface as "NestJS on Deno" either.
- **No decorator-metadata transpile stage.** A proposal for
  `experimentalDecorators` / `emitDecoratorMetadata` must clear a much higher bar
  than "it's how Nest does it."
- **Out of scope:** React Native / native rendering — Capacitor/WebView stays the
  mobile story; a true RN target is a separate future frontier.

## Later (not committed to 2.1)

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
- **Real `Activity` offscreen scheduling** (deferred pre-render, hidden-subtree
  state preservation) and `ViewTransition` per-element `name`/`enter`/`exit`
  markers — today both are documented passthroughs.
