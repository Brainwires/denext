# denext — Roadmap

> Status: internal engineering tracker. **This file lists only work that still
> needs doing.** Completed work lives in [FEATURES.md](./FEATURES.md) and
> [CHANGELOG.md](./CHANGELOG.md); honest gaps in
> [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); the mission + its superiority
> pillars in [MISSION.md](./MISSION.md); the standing engineering guardrails and the
> security policy in [POLICIES.md](./POLICIES.md).
>
> `development` is on the **2.5 rc series** (the version line `deno task bump` rewrites).
> rc.1 carried `denext ui`, the auth flexibility cut + database adapter + bearer tokens, and
> the DevTools completeness pass; rc.2 added the emailed auth flows and TOTP two-factor, the
> rest of the `denext ui` list and the last three DevTools items; rc.3 onwards is hardening —
> all in [CHANGELOG.md](./CHANGELOG.md). What remains is the 2.6 candidates, the last
> build-time-purity item, the TanStack Start depth of the router plugins, and the
> unscheduled candidates. Items target the next minor unless marked otherwise; this file is
> rewritten each cycle.

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

## Upstream watch — `deno bundle` hooks (the last npm build tool)

**Standing watch item, not keystone work.** One dependency and one small polish item share
a single cause: `deno bundle` — esbuild under the hood — exposes none of esbuild's plugin
surface. Until it does, denext keeps `npm:esbuild` at build time and the native path
cannot fold a few runtime guards to literals. Neither touches the zero-npm **runtime**
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
- **What `--define` would still buy on native builds (small).** The size problem this
  section once tracked — the class runtime and the devtools bridge always shipping on
  native builds because their `classComponents` define-fold needs `--define` — is
  **solved without it**: both are import-gated behind entry-emitted installs (2.1.0-rc.3,
  −5.7 KB on the shared chunk; `tests/integration/build-smoke.test.ts` asserts the
  markers are absent) and the class runtime is an on-demand chunk loaded only when the
  server stamped `#__denext_classes` (2.4.0). What remains define-dependent is bytes,
  not KB: the `__DENEXT_CLASS_COMPONENTS__` guards in the reconciler read a runtime
  global on native instead of folding to a literal, and the `denext/feature` fold
  reaches only component modules there (a `feature()` call in a plain `.ts` util is
  seeded correctly via `globalThis.__DENEXT_FEATURES__` but not dead-code-eliminated).
  The compat/SPA esbuild paths fold both. A polish item, not a size win.
- **What we are waiting for, in order of how much it unblocks.** (1) A **resolver/loader
  plugin API** for `deno bundle` (or a package-wide alias that applies inside npm
  packages) — that alone retires `npm:esbuild` for the alias half and lets the source
  transforms be ported one hook at a time; (2) **`--define`** — folds the residual
  native guards above. Status (re-verified 2026-09-13): **Deno 2.9.6** has neither. `--define`
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
  **reusing the esbuild `classDefine()` map and the `__DENEXT_FEATURES__` define verbatim**
  (`src/build/next-compat.ts`) so both bundlers share one flag-authoring pattern; the
  `featureSeedBlock` in `bundle.ts` then becomes redundant on Deno versions that fold.
  The probe must degrade cleanly on older Deno — never break a build.
- **Action when plugins land.** Port `appResolverPlugin`/`denextRuntimePlugin` first
  (the alias half is small and is the whole "two Reacts" fix), keep esbuild for the
  remaining transforms, then move those one hook at a time; the compat e2es
  (`tests/e2e/next-compat-*`, `spa-compat`, `unbundled-*`) are the gate.

## After 2.5 (2.6 candidates)

**Auth:**

- **Passkeys / WebAuthn** over the adapter's credential tables.
- A **`next-auth` compat shim** so a drop-in Next app that imports `next-auth` runs.
- A standalone **`denext/auth` subpath** (today the surface lives in `denext/server`).
- **OAuth `response_mode=form_post`** — a POST callback plus a `SameSite=None` transaction
  cookie for it (a `Lax` cookie never rides a cross-site POST, so the callback would always
  fail `invalid_state`). It is what Apple needs to hand over a user's name and email; Apple
  stays `openid`-only until then.
- **An optional magic-link confirm page**: the GET renders a form that POSTs the token,
  closing link-scanner burns and login CSRF.
- **`totpQrSvg()`** — a dependency-free QR renderer for the `otpauth://` URI `enrollTotp` /
  `totpAuthUri` return (2.5 ships the URI, not the picture).
- **Optional adapter `deleteCredential?` / `deleteMfa?`**, so disabling TOTP and a
  pre-account-hijacking eviction delete instead of overwrite (today: an empty, unconfirmed
  MFA record and a password hash of a random secret).
- **A public helper that spends the MFA attempt budget from a Server Action.** The limiter the
  `/mfa*` endpoints spend is internal, so an action calling `verifySecondFactor` or
  `confirmTotp` throttles itself (`examples/auth` carries its own).
- **`activeAuthConfig()`** so `requireBearer`'s first argument becomes optional.
- **Richer events**: API-token issue/revoke events, a `signInFailed.reason` union, and an
  `AuthEvents.ip` for audit trails.

**`denext ui`:**

- **Third-party plugin option schemas.** Options forms come only from the first-party
  catalog; a JSR plugin found by the search is added and wired, but its options are set by
  hand.
- **Export the UI's form components** (`FormField`, `Control`, `Field`, `OpButton`, `Widget`)
  and retire the form renderer's remaining string API.

**DevTools:**

- **Per-element `__source`** (a true JSX owner stack instead of the render-parent chain).
- **Profiler export / compare** across commits, plus component filters.
- A **Live / channel + state inspector** tab (subscriptions, channel pushes, cache entries).
- **On-demand snapshot pull** over the reload stream, so the MCP tools can ask for a fresh
  tree instead of reading the last pushed one.

**Docs:** align the [deployment guide](https://denext.dev/docs/deploy)'s hand-written
Dockerfile with what `denext generate docker` emits — the dependency-cache layer, the
least-privilege run flags, and `PORT` vs `--port` differ today. The guide now points at the
generator as the source of truth; the remaining work is making the two byte-comparable (a test
that diffs the guide's fenced block against the template would keep them that way).

## 3.0

- **Agent control of `denext ui`** — an MCP front end over the UI's operations. Every panel
  already answers a JSON twin built for exactly this (the two file writers answer
  `{ ok, applied, diff }`; the others answer their own panel's shape — see
  [the Project UI guide](https://denext.dev/docs/ui)), so the wire would not have to change.
  Committing to an agent-driveable write surface is a 3.0 decision, not a 2.6 one.

## Candidate features (from the framework-gap survey)

Vetted gaps vs Next/Nuxt/Astro/SvelteKit/TanStack (the three picks that shipped — scheduled
tasks, type-safe routing, `@denext/content-collections` — are in CHANGELOG/FEATURES). The rest
are kept here so they aren't lost; not yet scheduled.

- **Dev server attach for desktop and Capacitor apps (the Metro model).** A packaged desktop
  window or a phone running the app should be able to attach to `denext dev` and get HMR, the
  way a React Native app attaches to Metro. Today it cannot: every `/_denext/*` asset is
  refused for a non-loopback host (see [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)). The
  work, smallest first:
  - **A user-facing `allowedDevOrigins`** — a `denext.config.ts` key plus
    `denext dev --allowed-dev-origin`, in the generated config schema and documented. It is a
    programmatic `DevServerOptions` field only today.
  - **Auto-allow an explicitly bound `--host`**, and stop `.denext/dev.json` rewriting
    `0.0.0.0` to `127.0.0.1` when the bind was deliberate.
  - **`denext dev --lan`** — pick the LAN IPv4, bind it, allow it, print the URL and an ASCII
    QR code (no dependency).
  - **Capacitor live reload** — a `mobile:dev` task that writes `server.url` into the
    Capacitor config so the phone's page origin _is_ the dev server (which is what makes the
    existing SSE reload and the origin checks work unchanged).
  - **`denext desktop dev`** — a window over a loopback reverse proxy to the dev server
    (reusing `src/build/dev-proxy.ts`), so `location.origin` stays loopback and neither the CSP
    nor the origin gate has to be relaxed.
  - **A dev-vs-release packaging permission split** — `migrate --desktop` bakes
    `--allow-net=127.0.0.1,localhost` into the compiled task, which a dev attach would have to
    widen; the scaffold and package paths use `-A`. Pick one story per mode.
  - Optional: a spike on `deno desktop --inspect-renderer` (CDP into the window, which
    `src/profile/browser.ts` already knows how to drive).
- **Deploy adapter API + presets** (the larger, separate bet — Nitro / Next 16 Adapters):
  a typed build manifest (routes, prerenders, assets, cache rules) + a pluggable adapter
  seam with first-party presets. Achievable targets for a Deno-native framework: **static
  export, Deno Deploy, Node (deno node-compat), Docker**, with a documented third-party seam
  for Workers/Vercel. Highest ecosystem value, largest effort, one real Deno-fit tension
  (Workers runs workerd, not Deno). Builds on the existing plugin `addBuildStep` seam.

## Later (unscheduled)

- Generated clients for **non-denext consumers** in **other languages** from the
  OpenAPI/GraphQL documents. TypeScript consumers are served: `denext openapi types`
  emits an import-free `ApiSchema` that `createApiClient<ApiSchema>({ base })` from
  JSR types from any project, so no fetch wrapper is generated for TS.
- **Node-stream `Writable` backpressure** for `renderToPipeableStream` /
  `renderToStaticNodeStream` (they buffer today — the first entry in
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)): make the core renderer
  pull-gated and resolve the `await allReady`-then-read deadlock the current
  eager drain avoids. An SSR-hot-path change with real regression risk and a
  narrow payoff; `renderToReadableStream` is the primary path.
