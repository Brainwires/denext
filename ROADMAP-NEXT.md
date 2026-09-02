# denext — Roadmap 3.0 (typed API surface)

> Status: internal engineering tracker for the **3.0** cycle. Like
> [ROADMAP.md](./ROADMAP.md), this lists only work that still needs doing; completed
> work lands in [FEATURES.md](./FEATURES.md) / [CHANGELOG.md](./CHANGELOG.md), honest
> gaps in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md), and the mission + its
> superiority pillars in [MISSION.md](./MISSION.md).
>
> **2.0 is the DX release** (unified CLI, universal migration, DevTools). **3.0 is the
> typed-API-surface release**: denext grows a first-class story for describing,
> validating, and publishing the server routes it already runs — an OpenAPI/Swagger
> surface and a GraphQL surface, delivered as first-party plugins. This roadmap is
> retired (deleted) when 3.0 ships. Do not start 3.0 engineering until 2.0 is cut.

---

## Keystone: a typed, self-documenting API surface

denext already serves App Router API routes — `route.ts` exporting plain
`GET`/`POST`/… functions over raw `Request`→`Response` (`src/server/types.ts:224`,
dispatched through `handleApi` at `src/server/api.ts:17`). Today those handlers are
**opaque**: no request validation, no response types, no machine-readable description.
3.0 closes that gap. The design target is the developer experience people praise in
NestJS's `@nestjs/swagger` — DTOs, validation, and generated OpenAPI — reached the
**Deno-idiomatic way**, not by porting NestJS's mechanism.

### Design decision — schema-first, not decorator-first (settled)

We evaluated replicating NestJS's approach and **rejected it deliberately**. NestJS's
OpenAPI generation depends on `emitDecoratorMetadata` + `reflect-metadata` `design:type`
inference and a `tsc` compiler-plugin. denext's toolchain supports **neither**: no
`experimentalDecorators`/`emitDecoratorMetadata` in any config, esbuild as the bundler
(structurally cannot emit decorator metadata), `@swc/wasm-web` used only as a parser
(`src/build/swc-ast.ts`, never `.transform`), and no `tsc` invocation to host a
ts-plugin. Recreating that path means bolting on a legacy-decorator transpile stage —
invasive, off-grain for a Deno-native, file-routed, function-handler framework, and it
_still_ couldn't run Nest's type-inference plugin.

Instead: **one schema per route, colocated with the handler**, from which we derive
runtime validation, static types, _and_ the OpenAPI document — a single source of
truth. This is the direction Hono (`@hono/zod-openapi`), Elysia (TypeBox), and
tRPC-openapi have converged on, and it's arguably a cleaner story than Nest's, which
validates and documents from separate declarations.

---

## WS1 — `@denext/openapi` (the anchor deliverable)

A first-party plugin that makes any denext API route describable and validated.

- **Route helper.** A `defineApi({ summary, params, query, body, response }, handler)`
  wrapper that carries a Standard-Schema validator (Zod / Valibot / TypeBox / ArkType)
  per method. TypeBox is the low-friction default — its schemas _are_ JSON Schema, so
  spec emission is near-free. Handlers receive parsed, typed `params`/`query`/`body`
  instead of a raw `Request`.
- **Validation seam.** Wrap `handleApi` (`src/server/api.ts:17`) — the single dispatch
  choke point — so a schema mismatch returns a structured 400 before user code runs.
  No core fork; the wrap is additive and no-op for un-annotated routes.
- **Spec generation.** Walk the route manifest (`src/router/manifest.ts`), read each
  route's attached schema, emit `openapi.json`. Delivered three ways via the plugin
  contract (`src/plugin/mod.ts`): `addRequestHandler` serves `/openapi.json` live,
  `addBuildStep` writes a static spec at `denext build`, and `addCommand` adds a
  `denext openapi` CLI verb (emit / diff / lint the spec in CI).
- **Docs UI.** Serve Swagger UI (or Scalar) at `/docs` via `addRequestHandler` — core
  routes always win, so it never shadows an app page.
- **Reference to follow:** `packages/pages-router` dogfoods the same seams (a whole
  alternate pipeline on `addRequestHandler`); the OpenAPI plugin is far smaller.

**Definition of done:** an unmodified app adds `@denext/openapi`, annotates a route
with `defineApi`, and gets request validation + a live `/openapi.json` + `/docs` with
**zero** config or toolchain change.

## WS2 — `@denext/graphql`

A first-party GraphQL surface, mounted through the same plugin seam.

- **Server.** `graphql-yoga` is a `(Request) => Response` handler — it drops straight
  into `addRequestHandler` as a one-line `/graphql` mount, GraphiQL UI included.
- **Schema.** **Pothos** (code-first, fully type-safe, **no decorators**) is the
  recommended builder. Explicitly avoid TypeGraphQL / `@nestjs/graphql` — both are
  decorator + `emitDecoratorMetadata`-based and hit the same blocker WS1 rejected.
- **Subscriptions.** Ride denext's existing SSE/Live infrastructure (Yoga supports
  GraphQL-over-SSE) rather than standing up a separate WebSocket server — keeps it on
  the framework's grain.
- **CLI.** `denext graphql` (`addCommand`) to print the SDL / run codegen in CI.

**Definition of done:** `@denext/graphql` + a Pothos schema serves a working `/graphql`
endpoint with subscriptions over denext's Live transport, no core change.

## WS3 — shared plugin-kit primitives (only if needed)

Both plugins should build entirely on the **settled** public contract
(`@denext/denext` + `@denext/denext/plugin-kit`, see [PLUGINS.md](./PLUGINS.md) →
"Stability — the three tiers"). If either surfaces a genuinely missing primitive
(e.g. a typed accessor for a route's attached schema on the manifest), **add it to
`plugin-kit`** as a deliberate, tested semver addition — never widen the private
`src/router` / `src/server` surface. Guard any addition in `tests/plugin-kit.test.ts`.

---

## Guardrails (standing — carried from 2.0)

- **Zero-npm runtime is sacred, and these features respect it.** OpenAPI/GraphQL libs
  are **opt-in server-side** deps resolved through the merged-config re-exec
  (`src/build/module-config.ts`) — exactly the ORM-support precedent (Drizzle/Prisma).
  They **never enter a shipped client bundle**; the `no-npm-compat-guard` test still
  holds. Prefer JSR / Deno-native / zero-dep options where they exist; a first-party
  zero-dep OpenAPI emitter is a stretch goal, not a gate.
- **Compat is the on-ramp, never the headline** — do not market this as "NestJS on
  Deno." It is denext's own typed-API surface that happens to feel familiar.
- **No decorator-metadata transpile stage.** WS1's rejection of the NestJS mechanism is
  a standing constraint: if a future contributor proposes `experimentalDecorators` /
  `emitDecoratorMetadata`, it must clear a much higher bar than "it's how Nest does it."

## Open questions

- **Validator baseline.** Ship TypeBox as the blessed default (JSON-Schema-native) but
  accept any Standard-Schema validator? Or stay validator-agnostic from day one?
- **Scope + naming.** `@denext/openapi` / `@denext/graphql` under the existing scope
  (cohesion) — confirm against the still-open scope-name question in
  [ROADMAP.md](./ROADMAP.md) → "Open questions (ecosystem)".
- **Docs UI vendor.** Swagger UI (familiar) vs Scalar (lighter, nicer default) — and
  whether the UI assets ship vendored or are fetched at build.

## Upstream watch — `deno bundle --define` (unblocks native-path DCE)

**Standing watch item, not 3.0-keystone work.** denext's client-bundle
minimization has one structural gap: the native `deno bundle` path has **no
`--define`**, so the `define`-fold dead-code-elimination that powers
`classComponents` (bare-identifier guard → literal → dropped branch) works **only**
on the esbuild/next-compat path. On native builds the guard stays a runtime `true`,
so optional runtime always ships.

- **Status (verified 2026-09-02).** `deno bundle --define` errors with "unexpected
  argument" on **v2.9.6** — the latest release _and_ the installed binary; also
  rejected under `--unstable-bundle` and by `deno compile`. **But** Deno issue
  [#35347](https://github.com/denoland/deno/issues/35347) ("Support deno bundle
  --define / deno compile --define") is **closed as "completed"** (2026-06-19) —
  merged to `main`, awaiting a release. So this is a _when_, not an _if_.
- **What it unblocks (profiled on the ~52 KB shared runtime).** Two optional lumps
  are stuck in every native app today purely for lack of `--define`:
  `compat/class-component.ts` (**~3.1 KB / 6.2%**) and the `client/devtools.ts`
  bridge (**~2.2 KB / 4.5%**, inert in prod) — ~5 KB raw / ~2 KB gz. It also fixes
  a **correctness gap**: `classComponents: false` is documented to remove the class
  runtime but is a **silent no-op on the native path** today.
- **Action when it lands.** Add a `denoBundleSupportsDefine()` capability probe
  (extend `probeBundleSupport`, `src/build/bundle.ts:137`) and pass
  `--define __FLAG__=…` to `deno bundle`, **reusing the esbuild `classDefine()` map
  verbatim** (`src/build/next-compat.ts:142`) so both bundlers share one flag
  authoring pattern. Retire any interim fallback (a pre-bundle identifier→literal
  transform, or `import()`-split). The probe must degrade cleanly on older deno —
  never break a build. Then `classComponents` works on native, and the devtools
  bridge + future opt-out flags become removable there.
- **No denext code blocks on this** — Phase 0/1 bundle wins already shipped without
  it; this only raises the ceiling for native-path opt-outs.

## Beyond the keystone (3.0 candidates — not yet committed)

Placeholders to be triaged once WS1/WS2 are scoped; listed so the file is honest about
being keystone-anchored, not the whole release:

- End-to-end typed client generation from the OpenAPI/GraphQL surface (fetch client +
  React hooks), so the server schema types the browser for free.
- The ecosystem router plugins deferred from 2.0 (`@denext/react-router`,
  `@denext/tanstack-router`) if not shipped in the 2.x line.
