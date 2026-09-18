<p align="center">
  <img src="./assets/app-image-2.png" alt="denext" width="220">
</p>

# denext

[![JSR](https://jsr.io/badges/@denext/denext)](https://jsr.io/@denext/denext)
[![JSR Score](https://jsr.io/badges/@denext/denext/score)](https://jsr.io/@denext/denext)
[![CI](https://github.com/Brainwires/denext/actions/workflows/ci.yml/badge.svg)](https://github.com/Brainwires/denext/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Brainwires/denext/main/.github/badges/tests.json)](https://github.com/Brainwires/denext/actions/workflows/ci.yml)
[![fallow health](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Brainwires/denext/main/.github/badges/fallow.json)](./CONTRIBUTING.md#the-health-score)
[![Source](https://img.shields.io/badge/source-github-181717?logo=github)](https://github.com/Brainwires/denext)

**A Next.js-compatible web framework for [Deno](https://deno.com) with a zero-npm runtime** — the
familiar App Router API, ~7× smaller output, and a dependency tree you can actually audit. One
unified stack, no Vercel lock-in.

**Docs:** [denext.dev](https://denext.dev/) · **Package:** [jsr.io/@denext/denext](https://jsr.io/@denext/denext) · **Source:** [github.com/Brainwires/denext](https://github.com/Brainwires/denext) · **License:** [MIT](./LICENSE)

You already know the API — `app/`, `page.tsx`, `layout.tsx`, `"use client"`, Server Actions,
`<Link>`, `next/image`, middleware. denext reimplements that Next.js core — App Router, streaming
SSR, hydration, Suspense — as native Deno/TypeScript. What's different is **underneath**: it ships
its **own tiny React-equivalent** (JSX runtime, hooks, context, a fiber reconciler) instead of
React + ReactDOM + a framework runtime, so there's **nothing to install from npm** and **zero npm
in what you ship** (CI-enforced). The only third-party runtime code is a handful of audited `@std`
modules, Deno's built-in `node:sqlite` for the durable cache, and denext's own first-party JSR
wasm codecs (`@denext/photon`), loaded only by the opt-in image-optimization / `next/og` routes.

**And it's not just Next-shaped apps.** A first-class **SPA mode** (`mode: "spa"`) hosts _any_
client-only React app — **React but not Next** — on the same tiny runtime (**~4.5× less
JavaScript** than React + ReactDOM) and packages it as a single-binary desktop app; real Vite apps
come along unchanged, down to a 200k-LOC React 19 pnpm-workspace monorepo bundling on denext's
_single_ React. See [SPA mode](https://denext.dev/docs/spa) and [`examples/spa`](./examples/spa).

**And it does things stock React can't.** Because denext is React _at the reconciler level_, it
ships **Qwik-style resumability** (`export const resumable = true` — the page resumes from
serialized server state instead of replaying your tree) and **Astro-style islands** with full 6/6
directive parity (`client:load | idle | visible | interaction | media | only`). As far as we can
find, denext is the **only framework delivering Qwik-style resumability on React's own API**. See
[Resumability](https://denext.dev/docs/resumability) and [Islands](https://denext.dev/docs/islands).

```tsx
// app/page.tsx
import { useState } from "denext";

export const metadata = { title: "Home" };

export default function Home() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>;
}
```

```
deno run -A cli.ts dev examples/hello   # → http://localhost:3000
```

---

## Why not just run real Next.js on Deno?

Fair question — Deno can already run genuine Next.js through its npm compat. The reason to reach
for denext is the one thing that setup can't give you: **a zero-npm runtime dependency tree.**
Real-Next-on-Deno still drags the full npm graph into what it ships; denext's own-React
reimplementation is the only reason the "nothing from npm at runtime" claim holds. That's the
wedge, and it buys three concrete things:

- **A supply chain you can audit.** Zero runtime npm dependencies, enforced in CI — the
  "transitive dependency" advisories that fill `npm audit` on a typical React/Next project have
  nothing to land on, and an SBOM for a denext app is essentially empty.
- **~7× smaller output** (measured below), plus a genuinely small single binary through
  `deno compile` / `deno desktop`.
- **One unified stack on native Deno** — no bundler config, no `node_modules`, no unstable flags to
  serve, no Vercel lock-in.

**Compatibility is the on-ramp, not the whole pitch.** It's what makes _trying_ denext cheap: your
Next.js knowledge transfers directly, and an existing App Router app converts with `denext
migrate`. The reason to _stay_ is the auditable, tiny, dependency-free output.

---

## Tiny by default

denext ships its own small React-equivalent instead of React + ReactDOM + a framework runtime, so
the JavaScript a browser downloads is **close to an order of magnitude smaller** (≈7×) than a
comparable Next.js app. Measured on the example app (`examples/hello`, production, gzipped):

| What a browser downloads            | denext                             | React + ReactDOM alone | Next.js 16 (First Load JS)  |
| ----------------------------------- | ---------------------------------- | ---------------------- | --------------------------- |
| **First page load**                 | **~20 KB**                         | ~60 KB                 | ~137 KB                     |
| **Client runtime baseline**         | **~19 KB** (shared, cached once)   | ~60 KB                 | ~137 KB (shared)            |
| **Each navigation after the first** | **~0.6–1.1 KB** (route delta only) | —                      | route chunk (shared cached) |

The client runtime is bundled into **one shared chunk** every route references, so it's downloaded
once and cached — a client-side navigation then transfers only the new route's own code (~0.6 KB
gzip on the example), not another copy of the runtime. No legacy weight by default, either: denext
is **function-components-first**, and the Pages Router ships as an optional plugin
(`@denext/pages-router`), so none of it is in the core bundle unless you opt in. (Class components
work too: the class runtime is an on-demand chunk, fetched only when a page renders one, so a
function-only app never pays for it; `classComponents` in `denext.config.ts` forces it on or off.)

And a page with **no interactivity at all** — no hooks, no event handlers, no `dynamic()` island —
ships **zero JavaScript**: denext detects static routes at build time (scanning the route's whole
import graph) and skips their client bundle and hydration script entirely, while a `<Link>` on such
a page still works as a plain anchor. Content and marketing pages are pure HTML.

> These are framework-baseline numbers (your own components add on top of both). The Next.js column
> is a **like-for-like build of the same `examples/hello` routes** with **Next.js 16.3 + React
> 19.2** on Node 24, gzipped (older Next lands lower); denext's side is pinned by a bundle-budget
> regression test.

The gap holds on a **real, library-heavy app** (the same npm libraries compiled on both sides): a
recharts dashboard, a react-hook-form route and a Radix dialog each ship roughly **half or less**
of their Next.js equivalent, and denext isn't trading size for speed — hydration and SSR throughput
run on par or faster. Every number is reproducible via `bench/run.ts`; the results, the full
denext/Next/React comparison (bytes, SSR throughput, time-to-interactive) and the methodology live
in [`bench/REPORT.md`](./bench/REPORT.md), regenerated with every run. (Single-machine benchmark —
trust the ratios, not the absolute milliseconds.)

---

## Beyond parity: two things Next & React can't easily do

Because denext owns the whole stack — the cache, the Flight boundary, the reconciler — it ships two
capabilities the React/Next architecture can't produce without a major rework. Both are opt-in,
both need a Flight (RSC) route, and both tree-shake out of apps that don't use them.

- **Live Server Components.** Wrap a server-rendered subtree in `<Live tags={["orders"]}>` and
  denext re-renders **just that boundary** (under the viewer's own session) and **pushes** it over a
  WebSocket whenever a cache tag is invalidated from anywhere — a Server Action, a webhook, a cron.
  Next re-renders only when the _client_ asks. `useLive`, `usePresence` and `useLiveOptimistic` ride
  the same socket: see [Live](https://denext.dev/docs/live).
- **Resumability.** `export const resumable = true` makes a route interactive with **no up-front
  hydration**, and plain `useState` + `onClick` components work unchanged: each island wakes on
  first interaction (the event is replayed to the just-resumed handler) or on idle for effects, and
  `useSignal` state is adopted rather than recomputed. See
  [Resumability](https://denext.dev/docs/resumability).

---

## Features

The master list of everything denext ships — **and** the ledger of where denext beats React/Next,
with `file:line` mechanisms and `[default]`/`[opt-in]` labels — is [FEATURES.md](./FEATURES.md),
rendered at [denext.dev/docs/features](https://denext.dev/docs/features).

What a Next app normally installs is first-party here: **auth** — OAuth/OIDC, passwords, magic
links and one-time codes, email verification and reset, TOTP two-factor
([Auth](https://denext.dev/docs/auth)) — and **`denext ui`**, a loopback GUI over the project
with a comment-preserving config editor, a Cron page (every schedule, when it next fires, and the
run history when you turn it on), per-plugin option forms, a `docker-compose.yml` editor and a
Desktop panel that sets up code signing from the identities your keychain already holds
([Project UI](https://denext.dev/docs/ui)).

## Desktop & mobile

Ship the same app to the web, the desktop (via
[`deno desktop`](https://docs.deno.com/runtime/desktop/) — one native binary, no Chromium) and
iOS/Android (via [Capacitor](https://capacitorjs.com)); both native targets serve denext's static
export. Scaffold with `denext create --desktop --capacitor`, then `deno task desktop` /
`deno task mobile:ios` — see [Desktop & mobile](https://denext.dev/docs/desktop) and
[`examples/native`](./examples/native). Inside the shell, `denext/mobile` covers what a native
app needs from the page — safe areas, the keyboard inset, the back swipe, app resume and
opening links in the system browser — with no `@capacitor/*` dependency.

## React & Next.js compatibility

Compatibility is the **on-ramp**: your Next.js knowledge transfers directly, and much of the
React/Next ecosystem runs on denext unmodified because denext is React **at the reconciler level**.
`denext migrate` converts an existing App Router (or Remix, or Vite SPA) project in one pass; the
import map, the `next/*` and `next-intl` surface, the `better-sqlite3` shim and the honest limits
are in [Migrating from Next.js](https://denext.dev/docs/migrating).

## Requirements

**Deno ≥ 2.9** (`denext doctor` checks it). `build`/`dev` bundle client code by shelling out to
Deno's own `deno bundle` — an experimental, still-evolving subcommand — so a Deno 2.x `deno` binary
must be reachable. denext checks the version up front and fails with a clear message on an older or
missing binary; point it at a specific Deno with `DENO_BIN=/path/to/deno`. A build-output smoke test
guards against `deno bundle` output-shape drift between Deno releases.

## Quick start

The fastest way is the scaffolder — it writes `deno.json`, an `app/`, and an example page for you:

```
deno run -A jsr:@denext/denext/cli create my-app   # new project (prompts for options)
cd my-app
deno task dev
```

On a terminal, `create`/`init` present the options as a single multi-select (↑/↓ move · space
toggle · enter confirm):

```text
  Select features  (↑/↓ move · space toggle · enter confirm)
› ◉ Tailwind CSS
  ◯ src/ directory layout
  ◯ Auto-memo compiler
  ◉ Native desktop app (deno desktop)
  ◯ iOS / Android (Capacitor)
```

`denext create <dir>` scaffolds a new/empty directory; `denext init` scaffolds into the current
directory without overwriting existing files. Both accept `--tailwind`, `--src-dir`, `--compiler`,
`--desktop`, `--capacitor` and `--yes` (flags pre-check the matching options; `--yes` skips the
prompt).

To wire a project up by hand instead, put an `app/` directory (`layout.tsx`, `page.tsx`,
`api/hello/route.ts`, …) and a `public/` folder for static files next to a `deno.json` carrying the
denext JSX toolchain and import map:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "denext",
    "lib": ["deno.window", "dom", "dom.iterable", "dom.asynciterable"]
  },
  "imports": {
    "denext": "jsr:@denext/denext@^2.5.0",
    "denext/jsx-runtime": "jsr:@denext/denext@^2.5.0/jsx-runtime",
    "denext/server": "jsr:@denext/denext@^2.5.0/server",
    "denext/client": "jsr:@denext/denext@^2.5.0/client"
  }
}
```

The version on the `denext` import is the project's **pin** — the `denext` binary defers to it,
and `denext create` writes one. An unversioned `jsr:@denext/denext` is a pin to the latest
published version, which is reproducible only until the next release.

Then run the CLI — with `denext` installed (see [The `denext` command](#the-denext-command)):

```
denext dev .      # dev server + live reload
denext build .    # produce .denext/ bundles
denext export .   # static export (SSG) to out/
denext start .    # serve the production build
```

Without installing anything, the same four verbs are
`deno run -A jsr:@denext/denext/cli <verb> .`.

See [`examples/hello`](./examples/hello) for a complete working app.

## The `denext` command

Get a real `denext` command instead of typing `deno run -A .../cli.ts` every time:

**1. Install the released binary** (macOS and Linux; no Deno needed to _install_ it):

```
curl -fsSL https://denext.dev/install.sh | sh
denext --version        # reports "(binary)" so you know which one ran
```

It lands in `~/.denext/bin/denext`; add that to your `PATH` (the script tells you how). Pick a
version with `DENEXT_VERSION=v2.5.0`, or a location with `DENEXT_INSTALL=/opt/denext`. With no
`DENEXT_VERSION` it resolves the **latest stable** release: a release candidate is a GitHub
prerelease and is never "latest", so `curl | sh` needs a published non-prerelease release to
exist. The installer verifies the archive against the release's `SHA256SUMS` (or the per-archive
`<archive>.sha256`) and refuses to install without a checksum — `DENEXT_INSECURE=1` is the one
loud override; a mismatch is never installed. On macOS it strips the quarantine attribute. Gatekeeper
is not part of this path by design: a `curl` download never carries the attribute, and a bare
executable cannot be stapled, so the CLI binary runs whether or not the release was signed — it
_is_ code-signed and notarised when the release was built with the Apple Developer ID secrets,
and ships unsigned otherwise. **Windows:** there is no installer script; download
`denext-x86_64-pc-windows-msvc.zip` from the [release page](https://github.com/Brainwires/denext/releases)
or use route 2.

**2. Install it globally with Deno** (a thin launcher that uses your installed Deno; every platform):

```
deno install -A -g -n denext jsr:@denext/denext/cli
denext dev        # in a project folder with app/ + deno.json
```

**3. Compile it yourself** from a checkout:

```
deno task compile        # produces ./denext  (deno compile -A --output denext cli.ts)
```

> Note: the binary is a **CLI, not a second copy of the framework**. Inside a project, every verb
> that loads your app (`dev`, `build`, `export`, `start`, `task`, `doctor`, …) re-execs the denext
> that project pins, so `denext build` produces exactly what `deno task build` would — and those
> verbs therefore need a reachable `deno` (via `DENO_BIN`, `~/.deno/bin/deno`, or `PATH`). The
> pin is read the way `deno run` would resolve it — `deno.json` or `deno.jsonc`, a separate
> `importMap` file, a workspace member's root config — and an unversioned `jsr:@denext/denext`
> means "latest". A directory that pins no denext is refused with a message naming the fix.
> `create`, `init`, `commands`, `completions` and `--version` run inside the binary and need
> nothing else; `ui` starts without Deno too, but its panels spawn `deno` for every
> project-touching operation (discovering verbs, the doctor, `deno task`, `deno add`, starting
> `denext dev`), so those need one. Shutdown signals are forwarded to the re-exec'd child.
> Browser bundling shells out to `deno bundle`; see
> [Known limitations](./KNOWN-LIMITATIONS.md).

**4. A project task** — add these to your app's `deno.json` `tasks` (what `examples/hello` does),
then `deno task dev` / `build` / `start`:

```
"dev":   "deno run -A jsr:@denext/denext@^2/cli dev ."
"build": "deno run -A jsr:@denext/denext@^2/cli build ."
"start": "deno run -A jsr:@denext/denext@^2/cli start ."
```

## Using denext as a package

denext publishes to [JSR](https://jsr.io) as `@denext/denext` with these entry points:

| Import                            | Contents                                                 |
| --------------------------------- | -------------------------------------------------------- |
| `@denext/denext`                  | components, hooks, `renderToString`, `Link`, …           |
| `@denext/denext/server`           | `serve`, `createApp`, middleware helpers, server types   |
| `@denext/denext/client`           | `hydrateRoot`, `createRoot`, hooks, navigation           |
| `@denext/denext/jsx-runtime`      | the JSX runtime (`jsxImportSource` target)               |
| `@denext/denext/cli`              | the `create`/`dev`/`build`/`start` CLI                   |
| `@denext/denext/lint-plugin`      | the `deno lint` plugin                                   |
| `@denext/denext/compiler-runtime` | the auto-memo compiler's runtime target (generated code) |

A consuming project's `deno.json` maps the bare `denext` specifiers used in app code and generated
bundles to the package — the `compilerOptions` + `imports` from [Quick start](#quick-start), plus
the hook-rule lint plugin (`"lint": { "plugins": ["jsr:@denext/denext/lint-plugin"] }`) and your
tasks. That's the whole install: no `node_modules`, no lockfile churn.

> Published from this repo with `deno publish`. Newly-published versions are subject to Deno's
> minimum-dependency-age policy — pass `--min-dep-age=0` (or wait ~24h) to import one immediately.

## Patching packages — and denext itself

`denext patch` is patch-package for npm dependencies **and for denext itself**, straight from JSR:
edit it where it lives, record the edit as a reviewable `patches/<name>+<version>.patch`, and every
`dev`/`build`/`start`/`export` re-applies it. See [Patching](https://denext.dev/docs/patches).

## Project configuration

An optional `denext.config.ts` (not `next.config.js`) carries redirects, rewrites, headers, i18n,
images, Tailwind, CSP, caching, `cacheComponents`, streaming, Live, `reactCompiler`, `features`,
plugins, and `mode: "spa"`. Every field is documented at [Configuration](https://denext.dev/docs/config).

## API surface

Every export of `denext`, `denext/server`, `denext/client`, `denext/live` and the rest is in the
[API reference](https://denext.dev/docs/api).

## Documentation

The full documentation is at [denext.dev](https://denext.dev/docs/getting-started). Each doc owns one job, so the same fact lives in exactly one place.

**Learn it** — [Getting started](https://denext.dev/docs/getting-started) · [Routing](https://denext.dev/docs/routing) · [Data & caching](https://denext.dev/docs/data) · [Rendering strategies](https://denext.dev/docs/rendering) · [Server Actions](https://denext.dev/docs/server-actions) · [SPA mode](https://denext.dev/docs/spa)

**Move an app over** — [Migrating from Next.js](https://denext.dev/docs/migrating) · [Migrating from Remix](https://denext.dev/docs/migrating-remix) · [Patching packages](https://denext.dev/docs/patches)

**Ship it** — [Deployment & ops](https://denext.dev/docs/deploy) · [Databases](https://denext.dev/docs/database) · [Auth](https://denext.dev/docs/auth) · [Testing](https://denext.dev/docs/testing) · [Desktop & mobile](https://denext.dev/docs/desktop) · [Security posture](https://denext.dev/docs/security)

**Reference** — [Configuration](https://denext.dev/docs/config) · [API](https://denext.dev/docs/api) · [Writing a plugin](https://denext.dev/docs/plugins) · [MCP server](https://denext.dev/docs/mcp) · [DevTools](https://denext.dev/docs/devtools) · [Project UI](https://denext.dev/docs/ui) · [Changelog](https://denext.dev/docs/changelog)

**Under the hood & honest limits** — [Features](https://denext.dev/docs/features) · [FEATURES.md](./FEATURES.md) · [Architecture](https://denext.dev/docs/architecture) · [Deliberate differences](https://denext.dev/docs/differences) · [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md) · [Known limitations](https://denext.dev/docs/limitations) · [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)

**The project** — [MISSION.md](./MISSION.md) · [POLICIES.md](./POLICIES.md) (guardrails + security policy) · [ROADMAP.md](./ROADMAP.md) · [CONTRIBUTING.md](./CONTRIBUTING.md) · [CHANGELOG.md](./CHANGELOG.md) · [AGENTS.md](./AGENTS.md) (the guide coding agents read)

## License

MIT
