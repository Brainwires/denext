<p align="center">
  <img src="./app-image.png" alt="denext" width="220">
</p>

# denext

[![JSR](https://jsr.io/badges/@denext/denext)](https://jsr.io/@denext/denext)
[![JSR Score](https://jsr.io/badges/@denext/denext/score)](https://jsr.io/@denext/denext)
[![CI](https://github.com/Brainwires/denext/actions/workflows/ci.yml/badge.svg)](https://github.com/Brainwires/denext/actions/workflows/ci.yml)
[![Source](https://img.shields.io/badge/source-github-181717?logo=github)](https://github.com/Brainwires/denext)

**A Next.js-style web framework for [Deno](https://deno.com), built on the standard library with
zero runtime npm dependencies.**

- **Package:** [jsr.io/@denext/denext](https://jsr.io/@denext/denext)
- **Source:** [github.com/Brainwires/denext](https://github.com/Brainwires/denext)
- **License:** [MIT](./LICENSE)

denext reimplements the core of Next.js — file-based App Router, server-side rendering, client
hydration, Suspense, middleware — as native Deno/TypeScript. It ships its **own tiny
React-equivalent** (JSX runtime, hooks, context, reconciler), so there is no React dependency and
nothing to `npm install`. The only third-party code is a handful of `@std` modules; transpilation
and bundling use Deno's own `deno bundle`.

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

## Tiny by default

denext ships its own small React-equivalent instead of React + ReactDOM + a
framework runtime, so the JavaScript a browser downloads is **an order of
magnitude smaller** than a comparable Next.js app. Measured on the example app
(`examples/hello`, production build, gzipped):

| What a browser downloads            | denext                             | React + ReactDOM alone | Next.js 16 (First Load JS)  |
| ----------------------------------- | ---------------------------------- | ---------------------- | --------------------------- |
| **First page load**                 | **~10 KB**                         | ~60 KB                 | ~126 KB                     |
| **Client runtime baseline**         | **~9.5 KB** (shared, cached once)  | ~60 KB                 | ~126 KB (shared)            |
| **Each navigation after the first** | **~0.6–0.9 KB** (route delta only) | —                      | route chunk (shared cached) |

The client runtime is bundled into **one shared chunk** every route references,
so it's downloaded once and cached — a client-side navigation then transfers only
the new route's own code (~0.6 KB gzip on the example), not another copy of the
runtime. No legacy weight by default, either: denext is **function-components-first
with no Pages Router**, so none of that ships. (Class components are supported for
running real npm React libraries via the [next-compat build](#nextjs-drop-in-compat),
opt-in through `classComponents` and dead-code-eliminated there when unused.)

And a page with **no interactivity at all** — no hooks, no event handlers, no
`dynamic()` island — ships **zero JavaScript**. denext detects static routes at
build time (scanning the route's whole import graph) and skips their client bundle
and hydration script entirely; a `<Link>` on such a page still works as a plain
anchor. Content and marketing pages are pure HTML.

> These are framework-baseline numbers (your own components add on top of both).
> The Next.js column is a **like-for-like build of the same `examples/hello` routes**
> (home counter + lazy island, static about, dynamic blog) with **Next.js 16.3 +
> React 19.2** on Node 24, gzipped — its shared First Load JS breaks down as ~70 KB
> react-dom + ~46 KB Next runtime + ~11 KB shared/turbopack. Older Next (14/15) lands
> ~90–110 KB. The `examples/hello` bundle budget is enforced by a regression test, so
> denext's side can't silently regress.

---

## Features

- **App Router** — folder-based `app/` routing with `page`, `layout`, `route` (API), and the special
  files `loading`, `error`, `not-found`. Static, dynamic `[slug]`, catch-all `[...rest]`, optional
  catch-all `[[...rest]]`, route groups `(group)`, **parallel `@slot`** and **intercepting
  `(.)`/`(..)`/`(...)`** routes.
- **i18n routing** — optional default-locale prefix (`/about` = default, `/fr/about` = `fr`); the
  locale lands in `params.locale` and in the `useLocale()` hook, with `Accept-Language`/cookie
  negotiation via `localeMiddleware`.
- **Server-side rendering** — a self-contained JSX runtime renders function components (sync **and**
  async) to HTML, with correct escaping, context, and metadata.
- **Client hydration** — a small virtual-DOM reconciler hydrates server markup in place with real
  hooks (`useState`, `useEffect`, `useReducer`, `useMemo`, `useRef`, `useContext`) and keyed
  reconciliation.
- **React DevTools** — the reconciler registers with the React DevTools extension and reports its
  tree as fibers, so the extension recognizes a denext app and shows the component tree (a cheap
  no-op when the extension isn't installed; guarded so it can never affect rendering).
- **React & Next.js compatibility** — reconciler-level fidelity (context-preserving
  portals, real refs, `react-is`, Radix `asChild`/`Slot`, React event semantics) plus
  `next/*`, full `NextRequest`/`NextResponse`, `next-intl`, `next/font`, and a
  `better-sqlite3` shim — all via import aliases, no npm added to the runtime (see
  [React & Next.js compatibility](#react--nextjs-compatibility)).
- **Suspense + streaming** — `<Suspense>`, `use()`, and `createResource()` with streaming SSR
  (`renderToReadableStream`) that flushes fallbacks first and streams resolved content
  progressively.
- **Error boundaries & 404s** — `error.tsx` boundaries with `reset()`, and `notFound()` → real
  `404`. `useErrorBoundary()` (`captureError`/`reset`) plus automatic catching of errors thrown in
  **event handlers and form actions** — things React can't catch.
- **Middleware** — root `middleware.ts` (or `proxy.ts`) as a single handler **or an ordered array**
  (composed chain) with `redirect`, `rewrite`, `next` + header injection, and a path `matcher`.
- **Client navigation** — `<Link>` (with hover/viewport **prefetch**), `useRouter`, `usePathname`,
  `useSearchParams`, `useParams`, and SPA soft navigation with history support.
- **Server Actions** — `serverAction(id, handler)` dispatched over a secure, **same-origin-enforced**
  RPC endpoint; usable as a `<form action>` with no-JS progressive enhancement or via `useActionState`.
- **Caching & ISR** — `cache()`, `unstable_cache`, `revalidatePath`/`revalidateTag`, route segment
  config (`export const dynamic`/`revalidate`), and a per-route production page cache (opt-in; default
  pages stay dynamic). The in-memory default is process-local; swap it for a durable backend:

  ```ts
  import { setCacheStore, sqliteCacheStore } from "denext/server";

  // Durable across restarts, single-node, and NO unstable flag. The recommended
  // store for self-hosted deployments. Backed by a local SQLite file (rsqlite-wasm).
  setCacheStore(sqliteCacheStore({ path: ".denext/cache.db" }));
  ```

  For **multi-replica** deployments (e.g. Deno Deploy, where there's no durable local disk), use the
  Deno KV backend instead, so ISR renders + cached data are shared across replicas and
  `revalidateTag`/`revalidatePath` reach every instance:

  ```ts
  import { denoKvCacheStore, setCacheStore } from "denext/server";

  setCacheStore(denoKvCacheStore()); // requires --unstable-kv
  ```

  `sqliteCacheStore` needs `rsqlite-wasm` in your import map
  (`"rsqlite-wasm": "npm:rsqlite-wasm@^0.1.2"`). Implement the `CacheStore` interface for any other
  backend (e.g. Redis).
- **SEO** — `app/sitemap.ts`, `robots.ts`, `manifest.ts`, `favicon.ico`, `generateMetadata`, and React
  19 in-tree `<title>`/`<meta>`/`<link>` hoisting.
- **Assets** — `<Image>` (with opt-in, allowlisted remote optimization), `<Script>` strategies, and
  self-hosted fonts (`localFont`, plus `next/font/local` and `next/font/google` under
  [next-compat](#react--nextjs-compatibility)).
- **Scaffolding** — `denext create` / `denext init` generate a ready-to-run project (with prompts for
  Tailwind, a `src/` layout, the compiler, and native **desktop**/**mobile** targets).
- **Desktop & mobile** — scaffold a native desktop app (Deno 2.9 `deno desktop`) and/or iOS/Android
  (Capacitor) from the same codebase; both ship the static export. See [Desktop & mobile](#desktop--mobile).
- **Tailwind, built in** — denext downloads and runs the Tailwind v4 standalone binary itself (zero
  npm); just point `denext.config.ts` at your input/output.
- **Memoization** — a context-aware reconciler bailout, `memo()`, `useMemoCache`, and an **experimental
  auto-memo compiler** (React-Compiler-style, opt-in) that keeps unchanged subtrees stable.
- **Toolchain** — `create`/`dev` (live reload)/`build`/`start`, all powered by `deno bundle`. No
  webpack, no esbuild config, no `node_modules`.

## Desktop & mobile

Ship the same denext app to the web, the desktop, and mobile. Both native targets
serve denext's static export (`deno task export` → `out/`). Scaffold them up front:

```
deno run -A jsr:@denext/denext/cli create my-app --desktop --capacitor
```

**Desktop** (via [`deno desktop`](https://docs.deno.com/runtime/desktop/), Deno 2.9+):
a generated `desktop.ts` is a `Deno.serve()` over the export that `deno desktop`
wraps in a native WebView window (single self-contained binary — no Chromium).

```
deno task desktop           # export + open a native window
deno task desktop:package   # export + build a distributable (./dist/)
```

**Mobile** (via [Capacitor](https://capacitorjs.com)): a generated `capacitor.config.ts`
bundles the export (`webDir: "out"`) into native iOS/Android shells.

```
deno install                # Capacitor's CLI + platforms are npm packages
deno task mobile:sync       # export + copy assets into the native projects
deno task mobile:ios        # open in Xcode   (deno task mobile:android → Android Studio)
```

A complete project wired for all three is in
[`examples/native`](./examples/native). Native builds are experimental (`deno
desktop`) and need the platform toolchains (Xcode / Android Studio) for mobile.

## React & Next.js compatibility

denext aims to be React **at the reconciler level**, not merely to match import
names — so much of the React/Next ecosystem runs on it unmodified. Turn it on per
project by aliasing the specifiers in your import map (`denext create --next-compat`
writes these for you):

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

**React.** `@denext/denext/react` re-exports denext's hooks and helpers under their
React names — `createElement`, `Fragment`, every `use*` hook (incl. `useEffectEvent`),
`memo`, `createContext`, `Suspense`, `lazy` (= `dynamic`), plus `forwardRef`,
`Children`, `cloneElement`, `isValidElement`, and a default `React` object.
`@denext/denext/react-dom` provides `createRoot`/`hydrateRoot`/`flushSync`, legacy
`render`/`hydrate`, and a **real `createPortal`** — backed by a first-class
reconciler portal, so the portaled subtree keeps its place in the **context** tree
(context providers and error boundaries above the call are visible across the
portal, exactly like React). With denext's [React DevTools](#features) support, the
ecosystem — and your tools — see denext as React.

**Reconciler-level primitives** the component ecosystem (Radix UI / shadcn/ui,
react-hook-form, emotion) leans on:

- **`react-is`** classifies denext elements and branded `forwardRef`/`memo`/`lazy`/
  `Suspense`/portal/fragment components (`isForwardRef`, `isMemo`, `typeOf`, …).
- **`Slot`/`Slottable` + `composeRefs`** (`@denext/denext/slot`, `/compose-refs`)
  implement Radix's **`asChild`** pattern — merge props onto a single child element
  (className joins, event handlers compose, refs merge), with no wrapper element.
- **Real refs** — object and callback refs, forwarded through components, detached
  on unmount, with React-19 cleanup-returning callback refs honored.
- **React event semantics** — `onChange` maps to the DOM `input` event, and
  `on*Capture` registers capture-phase listeners.

**Next.js.** `next/*` maps App-Router APIs to denext: `next/link`, `next/image`,
`next/script`, `next/dynamic`, `next/navigation`, `next/headers`, `next/cache`,
`next/og`, and `next/server` — where **`NextRequest`** (`nextUrl`, `cookies`,
`ip`/`geo`) and **`NextResponse`** (a `Response` subclass with a `.cookies` writer)
are full implementations that interoperate with denext's middleware runner.
`next/font/local` and `next/font/google` self-host fonts and return the usual
`{ className, style, variable }` handle.

**next-intl** is covered end-to-end — `useTranslations`/`useLocale`/`useFormatter`/
`NextIntlClientProvider`, the `next-intl/server` getters, locale-aware
`next-intl/navigation`, and `next-intl/middleware` — over a compact ICU
MessageFormat built on the standard `Intl.*` APIs.

**Data.** `better-sqlite3` runs via a shim over Deno's built-in `node:sqlite` (the
native npm addon can't load under Deno), covering `prepare`/`get`/`all`/`run`,
`pluck`/`raw`, `pragma`, and transactions (nesting via savepoints).

Every one of these rides Deno built-ins, `@std/*`, `Intl.*`, or `node:sqlite` —
**no npm is added to denext's runtime** (a CI guard enforces it).

**Honest limits.** denext is function-components only (`Component`/`PureComponent`
resolve so imports don't break, but throw if constructed). The compat modules match
React/Next **behavior and shapes**, but denext is not React internally — anything
reaching for `react-reconciler`, `react-dom/server` streaming internals, or fiber
internals is out of scope. To run an **npm** package's own `import "react"` against
denext, your app's npm dependencies must resolve that specifier to the denext alias
too; in Deno's managed mode a top-level import-map alias doesn't always reach inside
npm packages, so a mixed npm-Radix app may need a build-time specifier rewrite. And
the ICU subset covers interpolation, plural/selectordinal, select, and number/date
formatting — not the entire spec.

## Requirements

- **Deno 2.x** (developed against 2.9). `build`/`dev` bundle client code by shelling out to
  Deno's own `deno bundle` — an experimental, still-evolving subcommand — so a Deno 2.x `deno`
  binary must be reachable. denext checks the version up front and fails with a clear message on
  an older or missing binary; point it at a specific Deno with `DENO_BIN=/path/to/deno`. A
  build-output smoke test in the suite guards against `deno bundle` output-shape drift between
  Deno releases.

## Quick start

The fastest way is the scaffolder — it writes `deno.json`, an `app/`, and an
example page for you:

```
deno run -A jsr:@denext/denext/cli create my-app   # new project (prompts for options)
cd my-app
deno task dev
```

On a terminal, `create`/`init` present the options as a single multi-select
(↑/↓ move · space toggle · enter confirm):

```text
  Select features  (↑/↓ move · space toggle · enter confirm)
› ◉ Tailwind CSS
  ◯ src/ directory layout
  ◯ Auto-memo compiler (experimental)
  ◉ Native desktop app (deno desktop)
  ◯ iOS / Android (Capacitor)
```

`denext create <dir>` scaffolds a new/empty directory; `denext init` scaffolds into
the current directory without overwriting existing files. Both accept `--tailwind`,
`--src-dir`, `--compiler`, `--desktop`, `--capacitor`, and `--yes` (flags pre-check
the corresponding options and, with `--yes`, skip the prompt entirely).

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

Then run the CLI (see [The `denext` command](#the-denext-command) for nicer ways to invoke it):

```
deno run -A jsr:@denext/denext/cli dev .      # dev server + live reload
deno run -A jsr:@denext/denext/cli build .    # produce .denext/ bundles
deno run -A jsr:@denext/denext/cli export .   # static export (SSG) to out/
deno run -A jsr:@denext/denext/cli start .    # serve the production build
```

See [`examples/hello`](./examples/hello) for a complete working app.

## The `denext` command

Instead of typing `deno run -A .../cli.ts` every time, get a real `denext` command one of these ways:

**1. Install it globally** (a thin launcher that still uses your installed Deno):

```
deno install -A -g -n denext jsr:@denext/denext/cli
denext dev        # in a project folder with app/ + deno.json
```

**2. Compile a standalone binary** (bundles the Deno runtime — no Deno needed to _run_ it):

```
deno task compile        # produces ./denext  (deno compile -A --output denext cli.ts)
./denext build .
./denext start .         # fully standalone: serves prebuilt bundles
```

> Note: `dev` and `build` produce browser bundles by shelling out to `deno bundle`, so those two
> subcommands still require a `deno` binary on the machine (found via `DENO_BIN`, `~/.deno/bin/deno`,
> or `PATH`). `start` only serves already-built output, so a compiled `denext start` needs nothing
> else. Set `DENO_BIN=/path/to/deno` to point at a specific Deno.

**3. A project task** — add to your app's `deno.json` (what `examples/hello` does):

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

denext publishes to [JSR](https://jsr.io) as `@denext/denext` with these entry points:

| Import                            | Contents                                                 |
| --------------------------------- | -------------------------------------------------------- |
| `@denext/denext`                  | components, hooks, `renderToString`, `Link`, …           |
| `@denext/denext/server`           | `serve`, `createApp`, middleware helpers, server types   |
| `@denext/denext/client`           | `hydrateRoot`, `startClient`, navigation                 |
| `@denext/denext/jsx-runtime`      | the JSX runtime (`jsxImportSource` target)               |
| `@denext/denext/cli`              | the `create`/`dev`/`build`/`start` CLI                   |
| `@denext/denext/lint-plugin`      | the `deno lint` plugin                                   |
| `@denext/denext/compiler-runtime` | the auto-memo compiler's runtime target (generated code) |

A consuming project's `deno.json` maps the bare `denext` specifiers used in app code and generated
bundles to the package:

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

That's the whole install: no `node_modules`, no lockfile churn — Deno fetches the package on first
run.

> Published from this repo with `deno publish`. Newly-published versions are subject to Deno's
> minimum-dependency-age policy — pass `--min-dep-age=0` (or wait ~24h) to import one immediately.

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
    remotePatterns: [{ protocol: "https", hostname: "*.example.com", pathname: "/img/" }],
  },

  // Experimental auto-memo compiler (default off).
  experimental: { compiler: true },
} satisfies DenextConfig;
```

**Tailwind.** Point `tailwind.input` at a stylesheet containing `@import
"tailwindcss";` and import the compiled `output` from your layout. denext runs the
standalone binary for you; override it with `TAILWIND_BIN` or pin a version with
`DENEXT_TAILWIND_VERSION`. `denext create --tailwind` sets all of this up.

**`src/` directory.** If a `src/app` directory exists, denext puts `app/`,
`middleware`, and `instrumentation` under `src/` (Next.js parity); `public/`, config,
and `.denext` stay at the project root. `denext create --src-dir` scaffolds it.

**Operational hooks.** `serve()` / `createApp()` accept `onRequest(info)` for
per-request logging/metrics (or set `DENEXT_LOG=1` for a built-in structured logger)
and `requestTimeout` (ms; responds `503` when exceeded).

## Memoization & the auto-memo compiler

denext's reconciler bails out of re-rendering a component whose props are
shallow-equal and whose visible context is unchanged — context changes still reach
deep consumers correctly. Use `memo(Component, areEqual?)` for an explicit custom
comparator, and `useMemoCache` as a low-level stable-cache primitive.

The **experimental auto-memo compiler** (`experimental: { compiler: true }`, or
`denext create --compiler`) goes further: a build-time pass lifts JSX component
elements into `useMemoCache`-guarded memo calls so unchanged subtrees keep a stable
reference and skip re-rendering — the same idea as the React Compiler. It transforms
only the client bundle (server output is unchanged, so SSR/hydration stay aligned),
bails to identity on anything it cannot analyze, and is off by default.

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

> Page components receive `{ params, searchParams }` — **not** the raw `Request`.
> Read per-request data (cookies, headers) with `cookies()` / `headers()` from
> `denext/server`; both mark the render dynamic, so a personalized page is never
> shared from the ISR cache. (Route handlers still get the `Request` directly.)

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

denext ships a **Deno-native lint plugin** (`src/lint/denext-plugin.ts`) — no ESLint, no npm. Enable
it in your `deno.json`:

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
cli.ts         dev | build | start | version
mod.ts         public "denext" entry point
```

- **No React.** `src/jsx` + `src/runtime` + `src/client` are a compact React-equivalent (function
  components, the common hooks, context, Suspense, hydration, keyed diffing).
- **No bundler dependency.** `deno bundle` transpiles JSX and bundles each route into a single
  browser module.

## Development

```
deno task test           # run the test suite
deno task lint           # deno lint (incl. the denext hook rules)
deno task fmt            # format the codebase
deno task check          # fmt --check + lint + test
deno task release-check  # check + doc-lint + publish --dry-run
```

Releasing a new version is documented in [`RELEASING.md`](./RELEASING.md).

The suite covers the JSX runtime, SSR (string + streaming), the router and manifest scanner, the
request handler, static serving, the client reconciler (hydration, keyed reordering, effects,
context), Suspense, error boundaries, middleware, client navigation, and the lint plugin.

### Formatting

Formatting is Deno's built-in `deno fmt` (no Prettier/npm), configured in `deno.json`:

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

Adjust these to taste — e.g. `"singleQuote": true`, `"lineWidth": 80`, or `"useTabs": true` — then
run `deno fmt`. Your own denext projects get the same knobs in their own `deno.json`.

## Security

Built-in defenses (see `CHANGELOG.md` for the hardening history):

- **Server Actions are same-origin + POST-only**, deny by default, with a
  scheme-aware Origin/Referer check and a request-body size limit
  (`actionMaxBodyBytes`, default 10 MiB). Set `canonicalOrigin` for scheme-strict
  checks behind a proxy.
- **Image optimization is SSRF-safe:** remote sources are refused unless
  allowlisted (`images.domains` / `remotePatterns`), redirects are re-validated per
  hop, and the host is **resolved and pinned** — the fetch is rejected if any
  resolved IP is loopback/private/link-local (closing DNS rebinding, incl. an
  allowlisted name pointed at cloud metadata). Fetches are time- and size-bounded,
  and decompression bombs are rejected before resizing.
- **SSR escapes attribute names/values** and drops any `on*` handler attribute, so
  spreading untrusted props (`<div {...untrusted}>`) cannot inject a handler.
- **Static serving** blocks `../` traversal and symlinks that escape `public/`.

Your responsibilities:

- **Fetching a user-supplied URL? Use `safeFetch`, not `fetch`.** For link
  previews, "import from URL", avatar-by-URL, webhooks, etc., `safeFetch` (from
  `denext/server`) resolves + validates the host, refuses internal addresses, pins
  the connection (closing DNS rebinding), and bounds time/size:

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
  `redirects()` are normalized to same-origin (a `//host` or `/\host` prefix can't
  escape your origin), but the middleware `redirect()` helper emits the location
  **verbatim** — `redirect(req.nextUrl.searchParams.get("next"))` is an open
  redirect. Allowlist the destination, or route it through `safeRedirectLocation`
  (from `denext/server`) to force it same-origin.
- **`absoluteUrl`/`requestOrigin` derive the origin from the `Host` header** by
  default (forwarded headers are ignored unless you opt in with
  `trustForwardedHeaders`). A client can spoof `Host`, so for a fixed public origin
  set `canonicalOrigin` — it overrides the header and is the robust choice for
  canonical/`og:image` URLs.
- **Gating paths with a middleware `matcher` under i18n? Include the locale.** A
  matcher like `/admin` does not match a locale-prefixed request (`/fr/admin`), so
  a path-restricted middleware can be bypassed by adding a locale prefix. Either
  omit the path matcher (middleware then runs on every request — denext's default)
  and peel the locale inside your handler, or write a locale-aware matcher. denext
  does run middleware on locale-prefixed paths; the gap is only in the matcher you
  author.
- **Don't build a redirect/rewrite destination _host_ from request input.** A
  config rule like `{ destination: "https://:host/..." }` substitutes a URL param
  into the host — an open redirect. (A `rewrite` to an external host is _not_ an
  SSRF in denext — rewrites re-route by pathname against your local manifest and
  never proxy — but it is still a misconfiguration.) Keep params in the path.
- **Run production with least privilege.** The example tasks use `-A` for
  convenience; in production grant only the permissions you need (e.g. `--allow-net
  --allow-read=. --allow-env`). `denext start` only serves prebuilt output.
- **Bound request sizes and rate-limit at your edge/proxy** — denext caps action
  bodies and image sources, but a proxy-level limit and rate limiting are still the
  right place for broad DoS protection.

## Status & limitations

denext is a from-scratch implementation of the Next.js core. It is function-components-first and
omits the legacy `pages/` router. Its client reconciler is **fiber-based**: transition-lane renders
are time-sliced, interruptible, and committed atomically, while the sync lane stays synchronous (see
the migration guide's §10). The one concurrency piece not implemented is the async passive-effect
phase — effects drain synchronously after commit. Class components are supported for running real npm
React libraries through the next-compat build (opt-in via `classComponents`), not in the default
function-component runtime. Client-side navigation re-executes a route bundle on each navigation
(simple and correct; not yet incrementally cached). Contributions and issues welcome.

## License

MIT
