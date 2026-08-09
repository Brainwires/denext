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
  pages stay dynamic). For multi-replica deployments, swap the in-memory default for a shared backend:

  ```ts
  import { denoKvCacheStore, setCacheStore } from "denext/server";

  // Requires --unstable-kv. Now ISR renders + cached data are shared across
  // replicas, and revalidateTag/revalidatePath reach every instance.
  setCacheStore(denoKvCacheStore());
  ```

  Implement the `CacheStore` interface for any other backend (e.g. Redis).
- **SEO** — `app/sitemap.ts`, `robots.ts`, `manifest.ts`, `favicon.ico`, `generateMetadata`, and React
  19 in-tree `<title>`/`<meta>`/`<link>` hoisting.
- **Assets** — `<Image>`, `<Script>` strategies, and a `localFont` (`@font-face`) helper.
- **Toolchain** — `dev` (live reload), `build`, and `start`, all powered by `deno bundle`. No
  webpack, no esbuild config, no `node_modules`.

## Requirements

- **Deno 2.x** (developed against 2.9). `build`/`dev` bundle client code by shelling out to
  Deno's own `deno bundle` — an experimental, still-evolving subcommand — so a Deno 2.x `deno`
  binary must be reachable. denext checks the version up front and fails with a clear message on
  an older or missing binary; point it at a specific Deno with `DENO_BIN=/path/to/deno`. A
  build-output smoke test in the suite guards against `deno bundle` output-shape drift between
  Deno releases.

## Quick start

Create an `app/` directory next to a `deno.json`:

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

| Import                       | Contents                                               |
| ---------------------------- | ------------------------------------------------------ |
| `@denext/denext`             | components, hooks, `renderToString`, `Link`, …         |
| `@denext/denext/server`      | `serve`, `createApp`, middleware helpers, server types |
| `@denext/denext/client`      | `hydrateRoot`, `startClient`, navigation               |
| `@denext/denext/jsx-runtime` | the JSX runtime (`jsxImportSource` target)             |
| `@denext/denext/cli`         | the `dev`/`build`/`start` CLI                          |
| `@denext/denext/lint-plugin` | the `deno lint` plugin                                 |

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

## Status & limitations

denext is a from-scratch implementation of the Next.js core, not a drop-in replacement. It
intentionally omits some React/Next features: concurrent rendering, class components, server
actions, image optimization, and the legacy `pages/` router. Client-side navigation re-executes a
route bundle on each navigation (simple and correct; not yet incrementally cached). Contributions
and issues welcome.

## License

MIT
