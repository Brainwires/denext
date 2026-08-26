<p align="center">
  <img src="./assets/app-image-2.png" alt="denext" width="220">
</p>

# denext

[![JSR](https://jsr.io/badges/@denext/denext)](https://jsr.io/@denext/denext)
[![JSR Score](https://jsr.io/badges/@denext/denext/score)](https://jsr.io/@denext/denext)
[![CI](https://github.com/Brainwires/denext/actions/workflows/ci.yml/badge.svg)](https://github.com/Brainwires/denext/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Brainwires/denext/main/.github/badges/tests.json)](https://github.com/Brainwires/denext/actions/workflows/ci.yml)
[![Source](https://img.shields.io/badge/source-github-181717?logo=github)](https://github.com/Brainwires/denext)

**A Next.js-compatible web framework for [Deno](https://deno.com) with a zero-npm
runtime** — the familiar App Router API, ~8–9× smaller output, and a dependency
tree you can actually audit. One unified stack, no Vercel lock-in.

- **Docs:** [denext.dev](https://denext.dev/)
- **Package:** [jsr.io/@denext/denext](https://jsr.io/@denext/denext)
- **Source:**
  [github.com/Brainwires/denext](https://github.com/Brainwires/denext)
- **License:** [MIT](./LICENSE)

You already know the API — `app/`, `page.tsx`, `layout.tsx`, `"use client"`,
Server Actions, `<Link>`, `next/image`, middleware. denext reimplements that
Next.js core — App Router, streaming SSR, hydration, Suspense — as native
Deno/TypeScript. What's different is **underneath**: it ships its **own tiny
React-equivalent** (JSX runtime, hooks, context, a fiber reconciler) instead of
React + ReactDOM + a framework runtime, so there's **nothing to `npm install`**
and **zero npm in what you ship** (CI-enforced). The only third-party runtime code
is a handful of audited `@std` modules and denext's own first-party JSR codec
(`@denext/photon` for images) plus Deno's built-in `node:sqlite` for the durable
cache; the optional image-optimization and `next/og` routes load a wasm codec you
opt into.

**And it's not just Next-shaped apps.** A first-class **SPA mode**
(`mode: "spa"`) hosts _any_ client-only React app — **React but not Next** — on
the same tiny runtime: bring your own router (TanStack Router, React Router, …)
and data layer, and denext bundles it, swaps in its own React so the browser
downloads **~4.5× less JavaScript** than React + ReactDOM
([reproducible bench](./examples/spa)), and packages it as a **single-binary
desktop app** via `deno desktop`. Because denext is React **at the reconciler
level**, real Vite apps come along unchanged: a **200k-LOC React 19 SPA** —
TanStack Router, Effect, Base UI, Lexical, a WebAssembly terminal, Web Workers,
in a **pnpm-workspace monorepo** — bundles **end-to-end on denext's _single_
React** (one reconciler, not two), with Vite `?url`/`?worker` asset imports and
pnpm `catalog:`/`workspace:` resolution handled for you. Your existing app; a
fraction of the bytes; a native binary. See [SPA mode](#features) and
[`examples/spa`](./examples/spa).

**And it does things stock React can't.** Because denext is React _at the
reconciler level_, it ships two capabilities the React/Next architecture can't
offer without a rewrite. **Qwik-style resumability:** `export const resumable = true`
and a page resumes from serialized server state instead of replaying your component
tree on load — you still write ordinary `useState`/`onClick`, with `qrl()` lazy
handlers and `useSignal`/`useStore` signals rounding out the model. **Astro-style
islands:** per-component lazy hydration with full 6/6 directive parity
(`client:load | idle | visible | interaction | media | only`) where each island stays
inert server HTML until its strategy fires — real `IntersectionObserver` /
`requestIdleCallback` / `matchMedia` — so an interaction island ships
**zero JS until you touch it**. As far as we can find, denext is the **only framework
delivering Qwik-style resumability on React's own API** (Qwik isn't React; Next, Remix,
Astro-React and friends all hydrate). See
[Resumability](https://denext.dev/docs/resumability) and
[Rendering strategies](https://denext.dev/docs/rendering).

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

Fair question — Deno can already run genuine Next.js through its npm compat. The
reason to reach for denext is the one thing that setup can't give you: **a
zero-npm dependency tree.** Real-Next-on-Deno still drags the full npm graph;
denext's own-React reimplementation is the only reason the "nothing from npm"
claim holds. That's the wedge, and it buys three concrete things:

- **A supply chain you can audit.** Zero runtime npm dependencies, enforced in
  CI — so the "transitive dependency" advisories that fill `npm audit` on a
  typical React/Next project have nothing to land on, and an SBOM for a denext
  app is essentially empty. (A _positive_ architecture story — fewer moving
  parts — not a knock on anyone else.)
- **~8–9× smaller output** (measured below), plus a genuinely small single
  binary through `deno compile` / `deno desktop`.
- **One unified stack on native Deno** — no bundler config, no `node_modules`,
  no unstable flags to serve, no Vercel lock-in.

**Compatibility is the on-ramp, not the whole pitch.** It's what makes _trying_
denext cheap: your Next.js knowledge transfers directly, and an existing App
Router app converts with `denext migrate`. The reason to _stay_ is the auditable,
tiny, dependency-free output.

---

## Tiny by default

denext ships its own small React-equivalent instead of React + ReactDOM + a
framework runtime, so the JavaScript a browser downloads is **close to an order
of magnitude smaller** (≈8–9×) than a comparable Next.js app. Measured on the
example app (`examples/hello`, production build, gzipped):

| What a browser downloads            | denext                             | React + ReactDOM alone | Next.js 16 (First Load JS)  |
| ----------------------------------- | ---------------------------------- | ---------------------- | --------------------------- |
| **First page load**                 | **~16 KB**                         | ~60 KB                 | ~137 KB                     |
| **Client runtime baseline**         | **~15 KB** (shared, cached once)   | ~60 KB                 | ~137 KB (shared)            |
| **Each navigation after the first** | **~0.6–1.1 KB** (route delta only) | —                      | route chunk (shared cached) |

The client runtime is bundled into **one shared chunk** every route references,
so it's downloaded once and cached — a client-side navigation then transfers
only the new route's own code (~0.6 KB gzip on the example), not another copy of
the runtime. No legacy weight by default, either: denext is
**function-components-first**, and the Pages Router ships as an optional plugin
(`@denext/pages-router`), so none of it is in the core bundle unless you opt in.
(Class components are supported for running real npm React libraries via the
[next-compat build](#react--nextjs-compatibility), opt-in through `classComponents`
and dead-code-eliminated there when unused.)

And a page with **no interactivity at all** — no hooks, no event handlers, no
`dynamic()` island — ships **zero JavaScript**. denext detects static routes at
build time (scanning the route's whole import graph) and skips their client
bundle and hydration script entirely; a `<Link>` on such a page still works as a
plain anchor. Content and marketing pages are pure HTML.

> These are framework-baseline numbers (your own components add on top of both).
> The Next.js column is a **like-for-like build of the same `examples/hello`
> routes** (home counter + lazy island, static about, dynamic blog) with
> **Next.js 16.3 + React 19.2** on Node 24, gzipped — its shared First Load JS
> is ~137 KB, dominated by react-dom plus the Next.js runtime and
> shared/turbopack chunks. Older Next (14/15) lands lower. The `examples/hello`
> bundle budget is enforced by a regression test, so denext's side can't
> silently regress.

The gap holds on a **real, library-heavy app** (the same npm libraries compiled
on both sides, gzipped): a recharts dashboard is **120 KB vs 230 KB**, a
react-hook-form route **24 KB vs 140 KB**, a Radix dialog **26 KB vs 142 KB**.
And denext isn't trading size for speed — it hydrates **~1.1× faster** (p50), and
its SSR throughput runs on par to several times faster.

**Full comparison:** an [interactive benchmark chart](https://claude.ai/code/artifact/5488b1a2-83a5-45b5-9a8e-c073671c0df6)
plots denext against Next.js / React across bytes over the wire, SSR throughput,
time-to-interactive, and the real library-heavy app. Every number is reproducible
via `bench/run.ts`; the raw results and methodology live in
[`bench/REPORT.md`](./bench/REPORT.md). (Single-machine benchmark — trust the
ratios, not the absolute milliseconds.)

---

## Beyond parity: two things Next & React can't easily do

Zero-npm and small bundles are one wedge. The other is **capability**: because
denext owns the whole stack — the cache, the Flight boundary, the reconciler — it
ships two features the React/Next architecture can't produce without a major
rework. Both are opt-in and tree-shake out of apps that don't use them.

- **Live Server Components.** Wrap a server-rendered subtree in
  `<Live tags={["orders"]}>` and denext re-renders **just that boundary** — under
  the viewer's own session — and **pushes** it over a WebSocket whenever one of
  its cache tags is invalidated from anywhere (a Server Action, a webhook, a
  cron). No polling, no client-side data fetching, and every other component's
  state is preserved. Next re-renders RSC segments only when the _client_ asks (a
  navigation, `router.refresh()`); it has no first-party way to push an update to
  idle clients when the data changes elsewhere. The real-time family — `useLive`,
  `usePresence`, `useLiveOptimistic` — rides the same socket: a
  Convex/Liveblocks-class layer with zero npm and zero extra infra.
- **Resumability.** Add `export const resumable = true` to a route and it's
  interactive with **no up-front hydration** — and **plain components work
  unchanged** (`useState` + `onClick`, no special API). Each island wakes on
  first interaction (the triggering event is replayed to the just-resumed
  handler) or on idle for effects; only the touched island resumes, and
  `useSignal` state is adopted rather than recomputed. Qwik pioneered this
  model; React hydrates the whole tree up front and Next inherits that cost.

Both require a Flight (RSC) route. See [Features](#features) below and the full
ledger in [FEATURES.md](./FEATURES.md).

---

## Features

- **App Router** — folder-based `app/` routing with `page`, `layout`, `route`
  (API), and the special files `loading`, `error`, `not-found`. Static, dynamic
  `[slug]`, catch-all `[...rest]`, optional catch-all `[[...rest]]`, route
  groups `(group)`, **parallel `@slot`** and **intercepting
  `(.)`/`(..)`/`(...)`** routes.
- **SPA mode** — for a client-only app ("React but **not** Next"), set
  `mode: "spa"` in `denext.config.ts`: denext bundles a single client entry, wraps
  it in an HTML shell, and serves that shell for every navigation (history-API
  fallback) — no `app/` directory, no SSR. Bring your own router (TanStack, etc.)
  and data layer; you still get the Deno-native bundler, the CSS pipeline, live
  reload, and single-binary `deno desktop` packaging. The on-ramp for hosting an
  existing Vite-style React SPA on denext's small, zero-npm runtime. See
  [`examples/spa`](./examples/spa).
- **i18n routing** — optional default-locale prefix (`/about` = default,
  `/fr/about` = `fr`); the locale lands in `params.locale` and in the
  `useLocale()` hook, with `Accept-Language`/cookie negotiation via
  `localeMiddleware`.
- **Server-side rendering** — a self-contained JSX runtime renders function
  components (sync **and** async) to HTML, with correct escaping, context, and
  metadata.
- **Client hydration** — a small virtual-DOM reconciler hydrates server markup
  in place with real hooks (`useState`, `useEffect`, `useReducer`, `useMemo`,
  `useRef`, `useContext`) and keyed reconciliation.
- **React DevTools** — the reconciler registers with the React DevTools
  extension and reports its tree as fibers, so the extension recognizes a denext
  app and shows the component tree (a cheap no-op when the extension isn't
  installed; guarded so it can never affect rendering).
- **React & Next.js compatibility** — reconciler-level fidelity
  (context-preserving portals, real refs, `react-is`, Radix `asChild`/`Slot`,
  React event semantics) plus `next/*`, full `NextRequest`/`NextResponse`,
  `next-intl`, `next/font`, and a `better-sqlite3` shim — all via import
  aliases, no npm added to the runtime (see
  [React & Next.js compatibility](#react--nextjs-compatibility)).
- **Concurrent rendering (fiber)** — a resumable, double-buffered fiber
  reconciler: `useTransition`/`useDeferredValue` renders are **time-sliced**
  (yield to paint/input) and **interruptible** (an urgent update restarts them),
  committed atomically off-DOM. Effects split into a synchronous layout phase
  and a scheduled passive phase. The default (sync) lane stays synchronous.
- **Suspense + streaming** — `<Suspense>`, `use()`, and `createResource()` with
  streaming SSR (`renderToReadableStream`) that flushes fallbacks first and
  streams resolved content progressively.
- **Error boundaries & 404s** — `error.tsx` boundaries with `reset()`, and
  `notFound()` → real `404`. `useErrorBoundary()` (`captureError`/`reset`) plus
  automatic catching of errors thrown in **event handlers and form actions** —
  things React can't catch.
- **Middleware** — root `middleware.ts` (or `proxy.ts`) as a single handler **or
  an ordered array** (composed chain) with `redirect`, `rewrite`, `next` +
  header injection, and a path `matcher`.
- **Client navigation** — `<Link>` (with hover/viewport **prefetch**),
  `useRouter`, `usePathname`, `useSearchParams`, `useParams`, and SPA soft
  navigation with history support.
- **Server Actions** — `serverAction(id, handler)` dispatched over a secure,
  **same-origin-enforced** RPC endpoint; usable as a `<form action>` with no-JS
  progressive enhancement or via `useActionState`.
- **Authentication** — first-party `denextAuth`: OAuth 2.0 / OIDC (Authorization
  Code + PKCE) with Google / GitHub / generic-OIDC presets plus an email-password
  **Credentials** provider, on signed `__Host-` cookie sessions (no tokens stored).
  Add it as a plugin and the `/auth/*` endpoints mount automatically — read the
  session with `auth()`, gate routes with `requireAuth()`, and use
  `useSession`/`signIn`/`signOut` on the client. `id_token`s are JWKS/RS256-verified,
  provider calls go through the SSRF-safe `safeFetch`, and the `redirect_uri` is
  pinned to a canonical origin. Zero npm.
- **Caching & ISR** — `cache()`, `unstable_cache`,
  `revalidatePath`/`revalidateTag`, route segment config
  (`export const dynamic`/`revalidate`), and a per-route production page cache
  (opt-in; default pages stay dynamic). The in-memory default is process-local;
  swap it for a durable backend:

  ```ts
  import { setCacheStore, sqliteCacheStore } from "denext/server";

  // Durable across restarts, single-node, and NO unstable flag. The recommended
  // store for self-hosted deployments. Backed by Deno's built-in `node:sqlite`
  // (real, native SQLite — zero npm, no setup).
  setCacheStore(sqliteCacheStore({ path: ".denext/cache.db" }));
  ```

  `sqliteCacheStore` uses Deno's built-in `node:sqlite` (real native SQLite, zero
  npm, no unstable flag). For **multi-replica** deployments (e.g. Deno Deploy,
  where there's no durable local disk) the default resolver falls back to the
  in-memory store per replica; for a cache shared across replicas — so
  `revalidateTag`/`revalidatePath` reach every instance — implement the
  `CacheStore` interface against a shared backend (Redis, etc.).
- **Live Server Components** — wrap a server-rendered subtree in
  `<Live tags={["orders"]}>`; when one of its cache tags is invalidated
  (`revalidateTag`/`updateTag`, from **anywhere** — a Server Action, a webhook, a
  cron), the server re-renders just that boundary **under the viewer's own session**
  and pushes it over a WebSocket, reconciled in place — no polling, no client-side
  data fetching, and all other component state preserved. Next.js re-renders RSC
  segments too, but only when the client asks (a navigation, `router.refresh()`, the
  user's own action) — it has no first-party way to **push** an update to idle clients
  when the data changes elsewhere. Opt-in via
  `@denext/denext/live`; the socket only opens once a `<Live>` boundary mounts, so
  apps that don't use it bundle none of the transport. Requires a Flight (RSC)
  route. The same socket carries the **real-time data family** — `useLive(action,
  args, { tags })` (subscribe to a server function's result, re-run under the
  viewer's session on tag invalidation), `usePresence(room)` (who's-online /
  cursors), and `useLiveOptimistic` — a Convex/Liveblocks-class layer with zero
  npm and zero extra infra.
- **Resumability** — opt a route in with `export const resumable = true` and it's
  interactive with **no up-front hydration**: plain `useState` + `onClick`
  components work unchanged, each island wakes on first interaction (the event is
  replayed to the just-resumed handler) or on idle for effects, and `useSignal`
  state is adopted rather than recomputed. Finer control is available per island
  via `client:load|idle|visible|interaction` directives, per-handler via `qrl()`
  code-split handlers, and reactive serializable state via `useSignal`/`useStore`.
  Off by default (a route keeps React-style hydration until it opts in) and the
  whole runtime tree-shakes out of apps that don't use it. Requires a Flight (RSC)
  route; see [FEATURES.md](./FEATURES.md).
- **SEO** — `app/sitemap.ts`, `robots.ts`, `manifest.ts`, `favicon.ico`,
  `generateMetadata`, and React 19 in-tree `<title>`/`<meta>`/`<link>` hoisting.
- **Assets** — `<Image>` (with opt-in, allowlisted remote optimization),
  `<Script>` strategies, and self-hosted fonts (`localFont`, plus
  `next/font/local` and `next/font/google` under
  [next-compat](#react--nextjs-compatibility)).
- **Scaffolding** — `denext create` / `denext init` generate a ready-to-run
  project (with prompts for Tailwind, a `src/` layout, the compiler, and native
  **desktop**/**mobile** targets).
- **Desktop & mobile** — scaffold a native desktop app (Deno 2.9 `deno desktop`)
  and/or iOS/Android (Capacitor) from the same codebase; both ship the static
  export. See [Desktop & mobile](#desktop--mobile).
- **Tailwind, built in** — denext downloads and runs the Tailwind v4 standalone
  binary itself (zero npm); just point `denext.config.ts` at your input/output.
- **Memoization** — a context-aware reconciler bailout, `memo()`,
  `useMemoCache`, and an **experimental auto-memo compiler**
  (React-Compiler-style, opt-in) that keeps unchanged subtrees stable.
- **Toolchain** — `create`/`dev` (live reload)/`build`/`start`/`export`, powered by
  `deno bundle` (and esbuild on the next-compat / SPA-compat path, for running
  unmodified npm-React apps). No webpack, no bundler config to write, no
  `node_modules` for a denext-native app.

## Desktop & mobile

Ship the same denext app to the web, the desktop, and mobile. Both native
targets serve denext's static export (`deno task export` → `out/`). Scaffold
them up front:

```
deno run -A jsr:@denext/denext/cli create my-app --desktop --capacitor
```

**Desktop** (via [`deno desktop`](https://docs.deno.com/runtime/desktop/), Deno
2.9+): a generated `desktop.ts` is a `Deno.serve()` over the export that
`deno desktop` wraps in a native WebView window (single self-contained binary —
no Chromium).

```
deno task desktop           # export + open a native window
deno task desktop:package   # export + build a distributable (./dist/)
```

**Mobile** (via [Capacitor](https://capacitorjs.com)): a generated
`capacitor.config.ts` bundles the export (`webDir: "out"`) into native
iOS/Android shells.

```
deno install                # Capacitor's CLI + platforms are npm packages
deno task mobile:sync       # export + copy assets into the native projects
deno task mobile:ios        # open in Xcode   (deno task mobile:android → Android Studio)
```

A complete project wired for all three is in
[`examples/native`](./examples/native). Native builds are experimental
(`deno
desktop`) and need the platform toolchains (Xcode / Android Studio) for
mobile.

## React & Next.js compatibility

Compatibility is the **on-ramp**: your Next.js knowledge transfers directly, and
much of the React/Next ecosystem runs on denext unmodified because denext is
React **at the reconciler level**, not merely a name-match. Bringing an existing
App Router app over? `denext migrate` converts its `package.json` to a `deno.json`
(react/next aliases, dep classification) so `denext build && denext start` runs
it on denext's single React — see [Migrating from Next.js](./README-NEXT-MIGRATION.md)
and the honest caveats in [Status & limitations](#status--limitations).

Turn compat on per project by aliasing the specifiers in your import map
(`denext create --compatibility` or `denext migrate` writes these for you):

```jsonc
// deno.json
{
  "imports": {
    "react": "jsr:@denext/denext/react",
    "react-dom": "jsr:@denext/denext/react-dom",
    "react-dom/client": "jsr:@denext/denext/react-dom/client",
    "react/jsx-runtime": "jsr:@denext/denext/react/jsx-runtime",
    "react-is": "jsr:@denext/denext/react-is",
    "next/": "jsr:@denext/denext/next/",
    "next-intl": "jsr:@denext/denext/next-intl",
    "next-intl/": "jsr:@denext/denext/next-intl/",
    "better-sqlite3": "jsr:@denext/denext/better-sqlite3"
  }
}
```

**React.** `@denext/denext/react` re-exports denext's hooks and helpers under
their React names — `createElement`, `Fragment`, every `use*` hook (incl.
`useEffectEvent`), `memo`, `createContext`, `Suspense`, `lazy` (= `dynamic`),
plus `forwardRef`, `Children`, `cloneElement`, `isValidElement`, and a default
`React` object. `@denext/denext/react-dom` provides
`createRoot`/`hydrateRoot`/`flushSync`, legacy `render`/`hydrate`, and a **real
`createPortal`** — backed by a first-class reconciler portal, so the portaled
subtree keeps its place in the **context** tree (context providers and error
boundaries above the call are visible across the portal, exactly like React).
With denext's [React DevTools](#features) support, the ecosystem — and your
tools — see denext as React.

**Reconciler-level primitives** the component ecosystem (Radix UI / shadcn/ui,
react-hook-form, emotion) leans on:

- **`react-is`** classifies denext elements and branded
  `forwardRef`/`memo`/`lazy`/ `Suspense`/portal/fragment components
  (`isForwardRef`, `isMemo`, `typeOf`, …).
- **`Slot`/`Slottable` + `composeRefs`** (`@denext/denext/slot`,
  `/compose-refs`) implement Radix's **`asChild`** pattern — merge props onto a
  single child element (className joins, event handlers compose, refs merge),
  with no wrapper element.
- **Real refs** — object and callback refs, forwarded through components,
  detached on unmount, with React-19 cleanup-returning callback refs honored.
- **React event semantics** — `onChange` maps to the DOM `input` event, and
  `on*Capture` registers capture-phase listeners.

**Next.js.** `next/*` maps App-Router APIs to denext: `next/link`, `next/image`,
`next/script`, `next/dynamic`, `next/navigation`, `next/headers`, `next/cache`,
`next/og`, and `next/server` — where **`NextRequest`** (`nextUrl`, `cookies`,
`ip`/`geo`) and **`NextResponse`** (a `Response` subclass with a `.cookies`
writer) are full implementations that interoperate with denext's middleware
runner. `next/font/local` and `next/font/google` self-host fonts and return the
usual `{ className, style, variable }` handle.

**next-intl** is covered end-to-end —
`useTranslations`/`useLocale`/`useFormatter`/ `NextIntlClientProvider`, the
`next-intl/server` getters, locale-aware `next-intl/navigation`, and
`next-intl/middleware` — over a compact ICU MessageFormat built on the standard
`Intl.*` APIs.

**Data.** `better-sqlite3` runs via a shim over Deno's built-in `node:sqlite`
(the native npm addon can't load under Deno), covering
`prepare`/`get`/`all`/`run`, `pluck`/`raw`, `pragma`, and transactions (nesting
via savepoints).

Every one of these rides Deno built-ins, `@std/*`, `Intl.*`, or `node:sqlite`, and
image optimization / the durable cache ride denext's own first-party `@denext/*`
JSR wasm codecs — **no npm is added to denext's runtime**, and a CI guard now
enforces that across the entire runtime (not just the compat layer).

**Honest limits.** denext is function-components-first, but React **class
components** are supported — full lifecycle, `setState` batching,
`getDerivedStateFromProps`, `shouldComponentUpdate`/`PureComponent`,
`getSnapshotBeforeUpdate`, error boundaries, and legacy `contextType` — so real
npm libraries built on classes (e.g. recharts) run. The class runtime is always
on in the standard build; the next-compat build gates it behind
`classComponents` for zero-cost dead-code elimination when unused. The compat
modules match React/Next **behavior and shapes**, and denext now has its own
fiber reconciler (time-sliced, interruptible concurrent rendering), but it is
not React internally — anything reaching for `react-reconciler`,
`react-dom/server` streaming internals, or React's own fiber data structures is
out of scope. Running an **npm** package's own `import "react"` on denext needs
that specifier rewritten to denext even _inside_ the package (Deno's managed npm
resolution doesn't follow a top-level import-map alias into `node_modules`); the
next-compat build does this for both client and server modules, so an unmodified
App Router app **builds and runs** on denext's single React. The honest caveat:
`deno check` on such an app still reports cross-library `@types/react` conflicts
(npm libs ship their own React types) — **runtime rendering is unaffected**, but
type-checking isn't clean. And the ICU subset covers interpolation,
plural/selectordinal, select, number/date formatting, and apostrophe escaping —
not the entire spec.

## Requirements

- **Deno 2.x** (developed against 2.9). `build`/`dev` bundle client code by
  shelling out to Deno's own `deno bundle` — an experimental, still-evolving
  subcommand — so a Deno 2.x `deno` binary must be reachable. denext checks the
  version up front and fails with a clear message on an older or missing binary;
  point it at a specific Deno with `DENO_BIN=/path/to/deno`. A build-output
  smoke test in the suite guards against `deno bundle` output-shape drift
  between Deno releases.

## Quick start

The fastest way is the scaffolder — it writes `deno.json`, an `app/`, and an
example page for you:

```
deno run -A jsr:@denext/denext/cli create my-app   # new project (prompts for options)
cd my-app
deno task dev
```

On a terminal, `create`/`init` present the options as a single multi-select (↑/↓
move · space toggle · enter confirm):

```text
  Select features  (↑/↓ move · space toggle · enter confirm)
› ◉ Tailwind CSS
  ◯ src/ directory layout
  ◯ Auto-memo compiler (experimental)
  ◉ Native desktop app (deno desktop)
  ◯ iOS / Android (Capacitor)
```

`denext create <dir>` scaffolds a new/empty directory; `denext init` scaffolds
into the current directory without overwriting existing files. Both accept
`--tailwind`, `--src-dir`, `--compiler`, `--desktop`, `--capacitor`, and `--yes`
(flags pre-check the corresponding options and, with `--yes`, skip the prompt
entirely).

To wire a project up by hand instead, create an `app/` directory next to a
`deno.json`:

```
my-app/
├─ deno.json
├─ app/
│  ├─ layout.tsx
│  ├─ page.tsx
│  └─ api/hello/route.ts
└─ public/
```

`deno.json` needs the denext JSX toolchain and import map:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "denext",
    "lib": ["deno.window", "dom", "dom.iterable", "dom.asynciterable"]
  },
  "imports": {
    "denext": "jsr:@denext/denext",
    "denext/jsx-runtime": "jsr:@denext/denext/jsx-runtime",
    "denext/server": "jsr:@denext/denext/server",
    "denext/client": "jsr:@denext/denext/client"
  }
}
```

Then run the CLI (see [The `denext` command](#the-denext-command) for nicer ways
to invoke it):

```
deno run -A jsr:@denext/denext/cli dev .      # dev server + live reload
deno run -A jsr:@denext/denext/cli build .    # produce .denext/ bundles
deno run -A jsr:@denext/denext/cli export .   # static export (SSG) to out/
deno run -A jsr:@denext/denext/cli start .    # serve the production build
```

See [`examples/hello`](./examples/hello) for a complete working app.

## The `denext` command

Instead of typing `deno run -A .../cli.ts` every time, get a real `denext`
command one of these ways:

**1. Install it globally** (a thin launcher that still uses your installed
Deno):

```
deno install -A -g -n denext jsr:@denext/denext/cli
denext dev        # in a project folder with app/ + deno.json
```

**2. Compile a standalone binary** (bundles the Deno runtime — no Deno needed to
_run_ it):

```
deno task compile        # produces ./denext  (deno compile -A --output denext cli.ts)
./denext build .
./denext start .         # fully standalone: serves prebuilt bundles
```

> Note: `dev` and `build` produce browser bundles by shelling out to
> `deno bundle`, so those two subcommands still require a `deno` binary on the
> machine (found via `DENO_BIN`, `~/.deno/bin/deno`, or `PATH`). `start` only
> serves already-built output, so a compiled `denext start` needs nothing else.
> Set `DENO_BIN=/path/to/deno` to point at a specific Deno.

**3. A project task** — add to your app's `deno.json` (what `examples/hello`
does):

```json
{
  "tasks": {
    "dev": "deno run -A jsr:@denext/denext/cli dev .",
    "build": "deno run -A jsr:@denext/denext/cli build .",
    "start": "deno run -A jsr:@denext/denext/cli start ."
  }
}
```

Then `deno task dev`, `deno task build`, `deno task start`.

## Using denext as a package

denext publishes to [JSR](https://jsr.io) as `@denext/denext` with these entry
points:

| Import                            | Contents                                                 |
| --------------------------------- | -------------------------------------------------------- |
| `@denext/denext`                  | components, hooks, `renderToString`, `Link`, …           |
| `@denext/denext/server`           | `serve`, `createApp`, middleware helpers, server types   |
| `@denext/denext/client`           | `hydrateRoot`, `startClient`, navigation                 |
| `@denext/denext/jsx-runtime`      | the JSX runtime (`jsxImportSource` target)               |
| `@denext/denext/cli`              | the `create`/`dev`/`build`/`start` CLI                   |
| `@denext/denext/lint-plugin`      | the `deno lint` plugin                                   |
| `@denext/denext/compiler-runtime` | the auto-memo compiler's runtime target (generated code) |

A consuming project's `deno.json` maps the bare `denext` specifiers used in app
code and generated bundles to the package:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "denext",
    "lib": ["deno.window", "dom", "dom.iterable", "dom.asynciterable"]
  },
  "imports": {
    "denext": "jsr:@denext/denext",
    "denext/jsx-runtime": "jsr:@denext/denext/jsx-runtime",
    "denext/server": "jsr:@denext/denext/server",
    "denext/client": "jsr:@denext/denext/client"
  },
  "lint": { "plugins": ["jsr:@denext/denext/lint-plugin"] },
  "tasks": { "dev": "deno run -A jsr:@denext/denext/cli dev ." }
}
```

That's the whole install: no `node_modules`, no lockfile churn — Deno fetches
the package on first run.

> Published from this repo with `deno publish`. Newly-published versions are
> subject to Deno's minimum-dependency-age policy — pass `--min-dep-age=0` (or
> wait ~24h) to import one immediately.

## Project configuration (`denext.config.ts`)

Optional config, loaded once at startup (as a default export or named exports):

```ts
import type { DenextConfig } from "denext/server";

export default {
  // Tailwind CSS — denext downloads/manages the v4 standalone binary (zero npm)
  // and compiles input → output automatically on dev/build.
  tailwind: { input: "styles/tailwind.css", output: "app/globals.css" },

  // Remote image optimization is off by default (local-only, SSRF-safe). Allowlist
  // hosts to enable it for the /_denext/image endpoint.
  images: {
    domains: ["cdn.example.com"],
    remotePatterns: [{
      protocol: "https",
      hostname: "*.example.com",
      pathname: "/img/",
    }],
  },

  // Experimental auto-memo compiler (default off).
  experimental: { compiler: true },
} satisfies DenextConfig;
```

**Tailwind.** Point `tailwind.input` at a stylesheet containing
`@import
"tailwindcss";` and import the compiled `output` from your layout.
denext runs the standalone binary for you; override it with `TAILWIND_BIN` or
pin a version with `DENEXT_TAILWIND_VERSION`. `denext create --tailwind` sets
all of this up.

**`src/` directory.** If a `src/app` directory exists, denext puts `app/`,
`middleware`, and `instrumentation` under `src/` (Next.js parity); `public/`,
config, and `.denext` stay at the project root. `denext create --src-dir`
scaffolds it.

**Operational hooks.** `serve()` / `createApp()` accept `onRequest(info)` for
per-request logging/metrics — `info` carries `method`, `path`, `status`,
`durationMs`, and a `requestId` (which is also echoed as the `x-request-id`
response header on an error, for correlation). Or set `DENEXT_LOG=1` for a compact
one-line-per-request logger, or `DENEXT_LOG=json` for one structured JSON object
per request (with a `statusClass` field), ready to ingest into a log pipeline.
`requestTimeout` (ms) responds `503` when exceeded.

**OpenTelemetry recipe.** Wire `onRequest` to a histogram and `onRequestError`
(from `instrumentation.ts`) to your tracer/error sink:

```ts
// instrumentation.ts
export function onRequestError(err, request, ctx) {
  tracer.recordException(err, { "http.route": ctx.routePath, "http.url": request.url });
}
// serve.ts
serve({
  getManifest,
  onRequest: (i) =>
    httpDuration.record(i.durationMs, {
      "http.method": i.method,
      "http.status_code": i.status,
      "http.status_class": `${Math.floor(i.status / 100)}xx`,
    }),
});
```

**Ops runbook (essentials).**

- **Health:** `cacheStoreHealthy()` probes the active cache backend without throwing
  — expose it on a `/healthz` route for readiness checks.
- **Correlate an error:** a `500` returns an `x-request-id` header; grep the logs
  (`DENEXT_LOG=json`) for that `requestId` to find the full server-side error and
  digest.
- **Runaway request:** bounded by `requestTimeout` (default 30s → `503`); the render
  is signal-aware, so a client disconnect or timeout actually cancels the work.
- **Graceful shutdown:** on `SIGINT`/`SIGTERM` the server stops accepting connections
  and drains in-flight requests before exiting (abort the `serve()` signal to trigger).
- **Cache backend down:** reads/writes are best-effort — requests serve uncached and
  errors are logged (rate-limited per operation), never surfaced as `500`s.

## Memoization & the auto-memo compiler

denext's reconciler bails out of re-rendering a component whose props are
shallow-equal and whose visible context is unchanged — context changes still
reach deep consumers correctly. Use `memo(Component, areEqual?)` for an explicit
custom comparator, and `useMemoCache` as a low-level stable-cache primitive.

The **experimental auto-memo compiler** (`experimental: { compiler: true }`, or
`denext create --compiler`) goes further: a build-time pass lifts JSX component
elements into `useMemoCache`-guarded memo calls so unchanged subtrees keep a
stable reference and skip re-rendering — the same idea as the React Compiler. It
transforms only the client bundle (server output is unchanged, so SSR/hydration
stay aligned), bails to identity on anything it cannot analyze, and is off by
default.

## Routing conventions

| File                          | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `app/page.tsx`                | Page at `/`                                                          |
| `app/about/page.tsx`          | Page at `/about`                                                     |
| `app/blog/[slug]/page.tsx`    | Dynamic page; `params.slug`                                          |
| `app/docs/[...path]/page.tsx` | Catch-all; `params.path` is `"a/b/c"`                                |
| `app/layout.tsx`              | Wraps this segment and everything beneath it                         |
| `app/template.tsx`            | Like a layout, but conceptually re-mounted                           |
| `app/loading.tsx`             | Suspense fallback for the segment                                    |
| `app/error.tsx`               | Error boundary (`{ error, reset }`)                                  |
| `app/global-error.tsx`        | Root error boundary — replaces the whole tree                        |
| `app/not-found.tsx`           | Not-found UI (`notFound()` or unmatched routes)                      |
| `app/forbidden.tsx`           | 403 UI (`forbidden()`)                                               |
| `app/unauthorized.tsx`        | 401 UI (`unauthorized()`)                                            |
| `app/api/x/route.ts`          | API endpoint exporting `GET`/`POST`/…                                |
| `app/(group)/…`               | Route group — folder name omitted from the URL                       |
| `app/@slot/page.tsx`          | Parallel route — rendered into the layout as a named prop            |
| `app/(.)x/page.tsx`           | Intercepting route — matches on soft-nav only (`(.)`/`(..)`/`(...)`) |
| `middleware.ts` / `proxy.ts`  | Runs before routing (single handler or ordered array)                |

## API surface

```ts
// Components & rendering
import {
  createContext,
  createResource,
  ErrorBoundary,
  Link,
  notFound,
  renderToReadableStream,
  renderToString,
  startTransition,
  Suspense,
  use,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  usePathname,
  useReducer,
  useRef,
  useRouter,
  useSearchParams,
  useState,
  useSyncExternalStore,
  useTransition,
} from "denext";
// Context is also usable directly as a provider: <MyContext value={v}>…</MyContext>

// Server helpers & types
import {
  createApp,
  next,
  redirect,
  renderPage,
  rewrite, // middleware helpers
  serve,
} from "denext/server";
import type { ApiContext, LayoutProps, Metadata, PageProps } from "denext/server";

// Client runtime
import { createRoot, hydrateRoot, startClient } from "denext/client";
```

### Pages, layouts, API

```tsx
// app/blog/[slug]/page.tsx — async server component
export default async function Post({ params }: PageProps) {
  const post = await db.get(params.slug); // runs on the server
  return (
    <article>
      <h1>{post.title}</h1>
    </article>
  );
}

// app/api/hello/route.ts
export function GET(req: Request, ctx: ApiContext) {
  return Response.json({ hello: ctx.params });
}
```

> Page components receive `{ params, searchParams }` — **not** the raw
> `Request`. Read per-request data (cookies, headers) with `cookies()` /
> `headers()` from `denext/server`; both mark the render dynamic, so a
> personalized page is never shared from the ISR cache. (Route handlers still
> get the `Request` directly.)

### Middleware

```ts
// middleware.ts  (proxy.ts also works)
import { next, redirect } from "denext/server";

export default function middleware(req, ctx) {
  if (!ctx.url.pathname.startsWith("/app")) return next();
  return req.headers.get("cookie") ? next() : redirect("/login");
}

export const config = { matcher: "/app/:path*" };
```

## Linting

denext ships a **Deno-native lint plugin** (`src/lint/denext-plugin.ts`) — no
ESLint, no npm. Enable it in your `deno.json`:

```json
{ "lint": { "plugins": ["<path-to-denext>/src/lint/denext-plugin.ts"] } }
```

Then `deno lint` enforces React/denext hook rules:

| Rule                        | Catches                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `denext/rules-of-hooks`     | Hooks called conditionally (in `if`/loops) — order must be stable |
| `denext/hooks-in-component` | Hooks called outside a component/`useX` hook (e.g. in callbacks)  |
| `denext/no-hooks-in-async`  | Hooks in an async server component (never hydrates)               |

```tsx
function Comp() {
  if (cond) {
    const [n] = useState(0); // ✗ denext/rules-of-hooks
  }
}
```

## Architecture

```
src/
├─ jsx/        JSX runtime, renderToString, renderToReadableStream (streaming)
├─ runtime/    hooks, context, Suspense, error boundaries
├─ router/     segment parsing/matching + filesystem manifest scanner
├─ server/     request handler, page pipeline, API dispatch, static, middleware
├─ client/     virtual-DOM reconciler, hydration, soft navigation
└─ build/      deno-bundle integration, dev server, prod server, CLI wiring
cli.ts         dev | build | start | export | create | migrate | version
mod.ts         public "denext" entry point
```

- **No React.** `src/jsx` + `src/runtime` + `src/client` are a compact
  React-equivalent (function components, the common hooks, context, Suspense,
  hydration, keyed diffing).
- **No bundler dependency.** `deno bundle` transpiles JSX and bundles each route
  into a single browser module.

## Development

```
deno task test           # run the test suite
deno task lint           # deno lint (incl. the denext hook rules)
deno task fmt            # format the codebase
deno task check:fix      # fmt + lint --fix, then report what's left
deno task check          # fmt --check + lint + test
deno task release-check  # check + doc-lint + publish --dry-run
```

`check:fix` is the write counterpart to `check`: it runs `deno fmt` and
`deno lint --fix` to apply every auto-fixable formatting and lint change, then a
final report-only `deno lint` surfaces the rules that have no auto-fix so you can
handle them by hand.

An **opt-in** pre-commit hook runs `check:fix` before each commit (fast — format
and lint only, no tests; the suite stays in CI). Enable it once per clone:

```
deno task hooks:install  # git config core.hooksPath .githooks
```

Contributing and releasing are documented in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

The suite covers the JSX runtime, SSR (string + streaming), the router and
manifest scanner, the request handler, static serving, the client reconciler
(hydration, keyed reordering, effects, context), Suspense, error boundaries,
middleware, client navigation, and the lint plugin.

### Formatting

Formatting is Deno's built-in `deno fmt` (no Prettier/npm), configured in
`deno.json`:

```json
{
  "fmt": {
    "useTabs": false,
    "lineWidth": 100,
    "indentWidth": 2,
    "semiColons": true,
    "singleQuote": false,
    "proseWrap": "preserve",
    "exclude": [".denext/", "examples/*/.denext/", "dist/"]
  }
}
```

Adjust these to taste — e.g. `"singleQuote": true`, `"lineWidth": 80`, or
`"useTabs": true` — then run `deno fmt`. Your own denext projects get the same
knobs in their own `deno.json`.

## Security

denext ships hardened by default — same-origin/POST-only Server Actions,
SSRF-pinned image optimization, strict attribute escaping, path-traversal-safe
static serving, a default CSP, and hardening response headers, several of which
close Next.js CVE classes. The **full threat-by-threat posture** lives in
[CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md) (the canonical security doc), and
the mechanism-by-mechanism ledger (`file:line`, `[default]/[opt-in]` labels) is
[FEATURES.md](./FEATURES.md) §"Where denext beats Next/React → Security".

What's still **your responsibility** at the app/edge layer:

- **Fetching a user-supplied URL? Use `safeFetch`, not `fetch`.** For link
  previews, "import from URL", avatar-by-URL, webhooks, etc., `safeFetch` (from
  `denext/server`) resolves + validates the host, refuses internal addresses,
  pins the connection (closing DNS rebinding), and bounds time/size:

  ```ts
  import { safeFetch, SafeFetchError } from "denext/server";

  try {
    const res = await safeFetch(userUrl, {
      allowedHosts: ["*.trusted-cdn.com"], // optional; omit = any public host
      maxBytes: 5_000_000,
      signal: AbortSignal.timeout(8000), // or an AbortController's signal
    });
  } catch (e) {
    if (e instanceof SafeFetchError) { /* e.code: "blocked-address", … */ }
  }
  ```

  Keep using `fetch`/`cachedFetch` for your _own_ backends (internal services,
  `localhost`) — those are addresses `safeFetch` deliberately blocks.
- **`dangerouslySetInnerHTML` and `metadata.head` emit raw HTML** — never pass
  unsanitized user/CMS content to them.
- **Redirecting to a user-controlled target? Validate it first.** Config-driven
  `redirects()` and the middleware `redirect()` helper both normalize their
  location through `safeRedirectLocation` (a `//host` or `/\host` prefix can't
  escape your origin). But an **explicit absolute URL is passed through verbatim**
  (that's intended — you asked to leave the origin), so
  `redirect("https://" + userInput)` is still an open redirect. Allowlist a
  user-controlled destination before redirecting to it.
- **`absoluteUrl`/`requestOrigin` derive the origin from the `Host` header** by
  default (forwarded headers are ignored unless you opt in with
  `trustForwardedHeaders`). A client can spoof `Host`, so for a fixed public
  origin set `canonicalOrigin` — it overrides the header and is the robust
  choice for canonical/`og:image` URLs.
- **Gating paths with a middleware `matcher` under i18n? Include the locale.** A
  matcher like `/admin` does not match a locale-prefixed request (`/fr/admin`),
  so a path-restricted middleware can be bypassed by adding a locale prefix.
  Either omit the path matcher (middleware then runs on every request — denext's
  default) and peel the locale inside your handler, or write a locale-aware
  matcher. denext does run middleware on locale-prefixed paths; the gap is only
  in the matcher you author.
- **Don't build a redirect/rewrite destination _host_ from request input.** A
  config rule like `{ destination: "https://:host/..." }` substitutes a URL
  param into the host — an open redirect. (A `rewrite` to an external host is
  _not_ an SSRF in denext — rewrites re-route by pathname against your local
  manifest and never proxy — but it is still a misconfiguration.) Keep params in
  the path.
- **Run production with least privilege.** The example tasks use `-A` for
  convenience; in production grant only what `denext start` needs — it serves
  prebuilt output and does not bundle, so it never needs `--allow-run`:

  ```sh
  deno run --allow-net --allow-read=. --allow-env jsr:@denext/denext/cli start .
  ```

  (`dev`/`build`/`export` re-exec a child bundler; that child now inherits the
  parent's actual grants instead of a blanket `-A`, so narrowing the parent
  narrows the child too.)
- **Bound request sizes and rate-limit at your edge/proxy** — denext caps action
  bodies and image sources, but a proxy-level limit and rate limiting are still
  the right place for broad DoS protection.

## Status & limitations

denext is a from-scratch implementation of the Next.js core. It is
function-components-first; the App Router is the core, with the legacy `pages/`
router available as an optional first-party plugin (`@denext/pages-router`). Its client
reconciler is **fiber-based**: transition-lane renders are time-sliced,
interruptible, and committed atomically; effects are split into a synchronous
layout phase and a scheduled passive phase; and the sync lane stays synchronous
(see the migration guide's §10). Class components are supported for running real
npm React libraries through the next-compat build (opt-in via
`classComponents`), not in the default function-component runtime. Client-side
navigation is a soft nav that reconciles the new route in place on the retained
reconciler root (no full-page reload): a **Flight** route (one with a
`"use client"`/`"use server"` boundary) transfers just its RSC/Flight payload and
re-runs no route bundle, while an isomorphic (non-Flight) route still re-fetches
the full HTML document and re-runs its route bundle — see
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

The **dev server bundles each route independently and lazily** for fast rebuilds,
whereas `denext build` runs a single code-split pass that hoists the client runtime
into one shared chunk. A production page shares exactly one runtime instance across
route entries; the dev server does not guarantee that. The production build is the
source of truth for runtime-singleton behavior, so verify a release against
`denext build` output, not only the dev server. Contributions and issues welcome.

## Documentation

Each doc owns one job, so the same fact lives in exactly one canonical place:

- [FEATURES.md](./FEATURES.md) — the master list of everything denext ships, **and**
  the ledger of where denext beats React/Next (with `file:line` mechanisms and
  `[default]/[opt-in]` labels). The canonical home for the feature/enhancement set.
- [README-NEXT-MIGRATION.md](./README-NEXT-MIGRATION.md) — migrating a Next.js app to
  denext; the canonical home for next-compat, `classComponents`, and the concurrency model.
- [DEPLOYMENT.md](./DEPLOYMENT.md) — production deployment & the operational
  responsibilities denext leaves to your edge (concurrency, SSRF-pinning, CSP, proxy origin).
- [DATABASE.md](./DATABASE.md) — databases & ORMs on denext. [PLUGINS.md](./PLUGINS.md) — the plugin contract.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — how denext differs _underneath_ the React
  surface (own reconciler, async SSR, soft-nav, Pages-Router-as-plugin) — design choices, not limitations.
- [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) — the genuine React/Next surface gaps,
  the bounded scope of denext's own experimental features, and the honest React DevTools scope.
- [CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md) — the canonical, threat-by-threat security posture vs the ecosystem's CVEs.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — the check/lint gate, conventions, and the JSR release flow.
- [STRATEGY.md](./STRATEGY.md) — product / go-to-market strategy (positioning, objections, launch).
- [ROADMAP.md](./ROADMAP.md) — the pending zero-npm / ecosystem engineering backlog.
- [CHANGELOG.md](./CHANGELOG.md) — release history.

## License

MIT
