# denext — Ecosystem & Zero-npm Roadmap

> A technical plan for making denext's runtime **literally zero-npm** and for
> growing a **first-party JSR ecosystem** (WASM codecs + plugins like a Pages
> Router). Sits alongside [ROADMAP-FORWARD.md](./ROADMAP-FORWARD.md) (product/GTM)
> and [ROADMAP-1.0.md’s successor §2.5](./ROADMAP-FORWARD.md) (engineering
> backlog). Written 2026-08-17.

## Why

denext's headline is **"zero runtime npm dependencies."** Today that's true for
the **core serving runtime, the client bundle, and the default `<Image>`** — but
three _optional_ runtime features lazily `import()` **npm** wasm wrappers:

| npm package         | wraps                            | used by                             | path           |
| ------------------- | -------------------------------- | ----------------------------------- | -------------- |
| `@cf-wasm/photon`   | photon-rs (Rust) — resize/encode | image optimizer                     | runtime, lazy  |
| `@jsquash/avif`     | libavif (C) — AVIF encode        | image optimizer                     | runtime, lazy  |
| `@cf-wasm/og`       | resvg + yoga + satori            | `next/og`                           | runtime, lazy  |
| `lightningcss-wasm` | LightningCSS (Rust)              | CSS build                           | **build-time** |
| `@swc/wasm-web`     | swc (Rust)                       | `use cache` / next-compat transform | **build-time** |
| `esbuild`           | esbuild (Go)                     | next-compat bundling                | **build-time** |

The npm part of each codec is just the **wrapper glue** — the actual codec is a
portable `.wasm`. So the runtime npm deps are removable. Two goals:

1. **Make the zero-npm claim literally true** (and CI-enforced over the _whole_
   runtime, not just `src/compat/`).
2. **Keep batteries-included** — no user friction for image optimization / OG —
   by owning the codecs as **first-party JSR packages** (JSR ≠ npm), built with a
   binder, not hand-rolled.

This also seeds a **plugin ecosystem**: things that don't belong in the core
package (e.g. a **Pages Router**) ship as their own JSR packages against a denext
plugin contract.

---

## Tooling decision — "is there a wasm-bindgen for Deno?"

**Yes — it exists; we do not build a binder.** We generate Deno-native bindings
from the codec source, per language:

- **Rust codecs** (photon-rs, resvg, lightningcss) →
  **[`denoland/wasmbuild`](https://github.com/denoland/wasmbuild)**, the Deno
  team's build tool that runs `wasm-bindgen` and emits Deno-ready glue (`.js` +
  `.d.ts`). It _is_ "wasm-bindgen for Deno." (`wasm-bindgen --target deno` is the
  raw flag it wraps — see the
  [wasm-bindgen deployment guide](https://rustwasm.github.io/docs/wasm-bindgen/reference/deployment.html).)
- **C codecs** (libavif, yoga) → compile to a **WASI/Component-Model component**
  and transpile with **[`jco transpile`](https://bytecodealliance.github.io/jco/transpiling.html)**
  (Bytecode Alliance) → ESM Deno imports like any module. `jco` is the
  cross-language path; the Component Model + WASI 0.3 matured through late 2025.
  (An emscripten `MODULARIZE`/ESM build is the fallback.)
- **Deno 2.1+** has first-class WASM (direct `.wasm` ESM imports), so the glue is
  thin and the binaries load without a bundler.

**Consequence:** we regenerate each codec's bindings targeting Deno, vendor the
`.wasm`, and publish to JSR. No hand-written marshalling glue, no npm.

---

## Workstream A — Zero-npm runtime (the 1.0 move)

**A1. Peer-dep the optional codecs — the interim fix (mirrors `rsqlite-wasm`).**
This is exactly how `sqliteCacheStore` already works: denext does **not** bundle
`rsqlite-wasm`; the user adds it to their import map and denext lazily `import()`s
it, throwing a guided error if it's absent (`src/server/sqlite-cache.ts`).

Apply the same to `@cf-wasm/photon` / `@jsquash/avif` / `@cf-wasm/og`:

- Remove them from denext's `deno.json` `imports`.
- Wrap each lazy `import()` (`src/server/image-optimizer.ts:472,589`,
  `src/server/image-response.ts:86`) so a missing codec throws a guided
  "add `<pkg>` to your import map to enable AVIF / image optimization / `next/og`"
  error instead of an opaque resolution failure.
- **Extend `tests/no-npm-compat-guard.test.ts`** beyond `src/compat/` to assert
  the core runtime (`src/jsx`, `src/runtime`, `src/client`, and `src/server`
  minus the three documented lazy image/og imports) contains **no** `npm:`
  specifier — so "CI-enforced" is honest for the whole runtime.
- **Fix the claim wording** in README / MARKETING: "zero npm in the core runtime
  and everything shipped to the browser; the optional image-optimization and
  `next/og` routes load a wasm codec you opt into." (README currently says "the
  only third-party code is a handful of `@std` modules" — untrue given the npm
  build/optional deps.)

Result: `deno info jsr:@denext/denext` shows **zero npm**, today. Cost: users who
opt into image-opt / OG add one import-map line. **This is the move for the 1.0
cut** (or the first patch after).

**A2. Restore batteries-included via first-party JSR codecs (Workstream B).**
Once `@denext/*` codec packages exist, denext depends on **those** (JSR, not npm)
instead of peer-depping — no user friction, still zero npm. A1 is the bridge; B
is the destination.

---

## Workstream B — First-party JSR WASM codec packages

Publish denext-owned JSR packages that wrap each codec's `.wasm` with
Deno-generated bindings. denext then lazily imports the JSR package (still
zero-npm; JSR deps are fine and on-brand with the `@std`/JSR story).

Candidate packages (scope TBD — `@denext/*` for cohesion):

| Package                           | Source codec          | Binder              | Replaces          |
| --------------------------------- | --------------------- | ------------------- | ----------------- |
| `@denext/photon` (resize/webp) ✅ | photon-rs (Rust)      | wasmbuild           | `@cf-wasm/photon` |
| `@denext/avif` ✅                 | libavif (C)           | emscripten-ESM fork | `@jsquash/avif`   |
| `@denext/og` ✅                   | satori + yoga + resvg | esbuild bundle      | `@cf-wasm/og`     |

Per-package pipeline (repeatable):

1. Vendor/fork the codec source (or its prebuilt `.wasm`); pin a version + record
   the upstream commit/license (MIT/Apache/BSD — verify each; ship `LICENSE`s).
2. Build → Deno bindings (`wasmbuild` for Rust, `jco transpile` for C/component).
3. Thin denext-facing TS API (the small surface `image-optimizer.ts` /
   `image-response.ts` actually call — resize, encode(webp/avif), SVG→PNG).
4. `deno publish` to JSR with provenance; **doc-lint clean** (same gate as core).
5. Point denext's lazy `import()` at the JSR package; drop the peer-dep note.

**Order of attack (all landed):** `@denext/photon` + `@denext/avif` first (small,
well-scoped — they unblocked the default optimizer with zero setup), then
`@denext/og` last as its own milestone. `@denext/og` turned out **not** to need a
satori port: esbuild bundles `@cf-wasm/og`'s `node` entry (satori + yoga + resvg,
wasm inline) into one self-contained ESM that runs under Deno unchanged, so denext
owns a pinned artifact without reimplementing satori.

**Security note:** owning the codecs means denext tracks their upstream CVEs and
rebuilds. Document a codec-update process (same discipline as the Tailwind
binary — which should also be **pinned by SHA-256**, see the 1.0 audit).

---

## Workstream C — Plugin architecture + Pages Router

Goal: features that don't belong in the core package ship as **separate JSR
packages** against a stable denext **plugin contract**. First target: a **Pages
Router** (`pages/`-style routing) as `@denext/pages-router` — explicitly _not_
part of the main package.

**C1. Define the plugin contract.** A minimal, versioned interface a plugin
registers against — enough for a router plugin:

- **Route contribution:** hook into the manifest/router (`src/router/`) to add
  route sources + a matcher (Pages Router = a second filesystem convention).
- **Request pipeline:** a place in `src/server/app.ts`'s handler chain
  (before/after the App-Router match) to claim a request.
- **Build hooks:** contribute entries to `src/build` (bundle a `pages/` tree,
  emit its client entries) — reuse the existing per-route bundling.
- **Config:** a typed `plugins: [...]` field in `denext.config.ts`; plugins are
  imported from JSR and registered at startup.
- Keep the contract **narrow and semver-stable** — it's a public API the moment a
  third party writes against it.

**C2. Build `@denext/pages-router` as the reference plugin.** Proves the contract
and delivers the feature the "Won't do (App Router only)" note in
KNOWN-LIMITATIONS deliberately excluded from core — now available opt-in, at zero
cost to apps that don't use it.

**C3. Publish the plugin-author guide** (how to write a denext plugin, the
contract's stability guarantees). This is what turns "a framework" into "an
ecosystem" (per ROADMAP-FORWARD Phase 2/§ecosystem-seeding).

---

## Repo / workspace structure

These are separate JSR packages but want shared CI/tooling. Options:

- **Deno workspace (monorepo):** a `deno.json` `workspace: [...]` with
  `packages/image`, `packages/avif`, `packages/og`, `packages/pages-router`,
  each independently published to JSR, sharing lint/fmt/test config. Preferred —
  one repo, coordinated releases, one CI.
- Alternative: separate repos under the org (more overhead; only if independent
  release cadence demands it).

Each package: its own `deno.json` (name/version/exports), doc-lint clean,
provenance publish via a `v<pkg>-*` tag or a per-package workflow.

---

## Sequencing — status (updated 2026-08-17)

- **✅ DONE — Workstream A1** (pre-1.0): AVIF (`@jsquash/avif`) and `next/og`
  (`@cf-wasm/og`) are now opt-in peer codecs; the npm guard scans the whole runtime
  and resolves import-map aliases (not just literal `npm:`); the claim wording is
  trued up. The runtime carries zero npm.
- **✅ DONE — Workstream B, first two packages** (pre-1.0):
  - **`@denext/photon`** — photon-rs → wasm via `wasmbuild`, replacing the npm
    `@cf-wasm/photon`. (Named `@denext/photon`, **not** the earlier `@denext/image`,
    to avoid colliding with the `<Image>` component.) Version tracks photon-rs (0.3.3).
  - **`@denext/sqlite`** — a Deno-native build of the `rsqlite-wasm` crate (with its
    `node:fs` backend), replacing the npm `rsqlite-wasm` peer dep as the durable
    cache backend and un-dormanting the SQLite cache suite. Version tracks the crate
    (0.1.2).
  - Both live in a new `packages/` Deno workspace; each vendors its `.wasm` + glue.
- **✅ DONE — Workstream B, `@denext/avif`** (post-1.0, 2026-08-17): a Deno-native
  fork of `@jsquash/avif@2.1.1`'s **prebuilt single-threaded libavif wasm**, driven
  through emscripten's `instantiateWasm` hook (compile from
  `fetch(new URL("./lib/avif_enc.wasm", import.meta.url))`). Replaces the opt-in
  `@jsquash/avif` peer dep in the image optimizer, which now passes `quality` (0–100)
  straight through (dropping the lossy `cqLevel` round-trip). `@denext/avif@0.1.0`
  (independent semver); AVIF output now needs zero setup. `image-next16`'s AVIF test
  un-dormanted and runs on CI.

- **✅ DONE — Workstream B, `@denext/og`** (post-1.0, 2026-08-17): a Deno-native
  `ImageResponse` that vendors the **full satori + yoga + resvg stack** as a single
  self-contained esbuild bundle (`lib/og.bundle.js`) of `@cf-wasm/og@0.5.0`'s `node`
  entry — `yoga.wasm`, `resvg.wasm`, and the default Noto Sans font all inlined as
  base64, so plain-Latin rendering needs zero npm deps and **no runtime permissions**.
  Replaces the opt-in `@cf-wasm/og` peer dep in `next/og`; passes options through
  verbatim (fonts/emoji/headers). `@denext/og@0.1.0` (independent semver);
  `THIRD-PARTY-LICENSES.md` inventories the bundled MIT/MPL-2.0/ISC/OFL-1.1
  components. `image-response` test un-dormanted and runs on CI. The internal
  `peer-codec.ts` loader was removed. **No opt-in peer codecs remain** — all four
  codecs (`@denext/photon`, `@denext/avif`, `@denext/og`, `@denext/sqlite`) are
  first-party JSR packages.

- **✅ DONE — Workstream C (contract + reference plugin), post-1.0 (2026-08-17):**
  - **C1 — `DenextPlugin` contract** (`src/plugin/mod.ts`, public via
    `@denext/denext/server`): three seams — `addRouteSynthesizer` (route contribution,
    the existing hook, now async), `addRequestHandler` (a claim-hook run after core
    matching — `app.ts` `matchExternal`), and `addBuildStep`. Config `plugins?:
    DenextPlugin[]`; `applyPlugins` wired before `scanRoutes` at all four entry points
    (build/prod/dev/export). Zero-cost when no plugin is used. Also promoted the segment
    primitives (`parsePattern`/`matchSegments`/…) to public API. Committed `b2df855`.
  - **C2 — `@denext/pages-router`** (`packages/pages-router/`): a Next.js Pages
    Router as a plugin. `pages/` file routing (incl. `[slug]`/`[...all]`/`[[...opt]]`),
    `getServerSideProps`/`getStaticProps`/`getStaticPaths`, `_app`/`_document`
    (`next/document` primitives), `pages/api/*` (`req`/`res`), `useRouter`, `Link`.
    - **v0.1 (`7181034`)** — SSR-complete.
    - **v0.2** — client-side hydration + code-split soft (SPA) navigation: per-route
      entries bundled via the new public `@denext/denext/bundle` (`deno bundle`, no
      npm) with a shared runtime chunk; a JSON data endpoint runs gSSP/gSP on soft
      nav; a build step (seam 3) pre-bundles into `.denext/pages-client/`. Verified by
      a headless-Chromium e2e (`tests/e2e/pages-router.e2e.test.ts`). Remaining:
      SSG output, `next/head`, CSS imports in `pages/`.
  - **C3 — plugin-author guide** ([PLUGINS.md](./PLUGINS.md)).

### Deferred (tracked — not in the pre-1.0 batch)

- **Build-time deps** — migrate `lightningcss`/`swc`/`esbuild` to first-party JSR
  builds (lower priority — build-time only, no runtime-claim impact).
- **PPR on Flight / client-island routes** — tracked in ROADMAP-FORWARD §2.5; a
  two-pass Postpone-aware Flight renderer + client hole reconciliation.
- **`@denext/pages-router`** — ✅ v0.2 client hydration + soft nav done; remaining:
  build-time SSG output, `next/head`, CSS imports inside `pages/`.

**Reserved JSR scope names** (built, publish-pending — need JSR token): `@denext/avif`,
`@denext/og`, `@denext/pages-router`.

## Open questions

- **Scope name** for the ecosystem packages: `@denext/*` (cohesion) vs a neutral
  scope (broader reuse)?
- ~~**`@denext/og`:** vendor the whole satori+resvg+yoga stack, or ship a reduced
  renderer?~~ **Resolved:** vendored the full stack (esbuild bundle of `@cf-wasm/og`'s
  `node` entry) for bit-for-bit compatibility.
- **Codec licenses:** confirm each upstream license permits redistribution of the
  built `.wasm` (photon-rs, libavif, resvg, yoga) and ship the notices.
- **Plugin contract surface:** how much of `src/router` / `src/build` /
  `src/server` internals must become semver-stable public API for a router plugin
  — and can we keep it narrow enough to evolve the core freely?
