# denext

**A Next.js-style web framework for [Deno](https://deno.com), built on the
standard library with zero runtime npm dependencies.**

denext reimplements the core of Next.js — file-based App Router, server-side
rendering, client hydration, Suspense, middleware — as native Deno/TypeScript.
It ships its **own tiny React-equivalent** (JSX runtime, hooks, context,
reconciler), so there is no React dependency and nothing to `npm install`. The
only third-party code is a handful of `@std` modules; transpilation and bundling
use Deno's own `deno bundle`.

> _Deno-next, without the "o"._

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

- **App Router** — folder-based `app/` routing with `page`, `layout`, `route`
  (API), and the special files `loading`, `error`, `not-found`. Static, dynamic
  `[slug]`, catch-all `[...rest]`, optional catch-all `[[...rest]]`, and route
  groups `(group)`.
- **Server-side rendering** — a self-contained JSX runtime renders function
  components (sync **and** async) to HTML, with correct escaping, context, and
  metadata.
- **Client hydration** — a small virtual-DOM reconciler hydrates server markup in
  place with real hooks (`useState`, `useEffect`, `useReducer`, `useMemo`,
  `useRef`, `useContext`) and keyed reconciliation.
- **Suspense + streaming** — `<Suspense>`, `use()`, and `createResource()` with
  streaming SSR (`renderToReadableStream`) that flushes fallbacks first and
  streams resolved content progressively.
- **Error boundaries & 404s** — `error.tsx` boundaries with `reset()`, and
  `notFound()` → real `404`.
- **Middleware** — root `middleware.ts` (or `proxy.ts`) with `redirect`,
  `rewrite`, `next` + header injection, and a path `matcher`.
- **Client navigation** — `<Link>`, `useRouter`, `usePathname`,
  `useSearchParams`, and SPA soft navigation with history support.
- **Toolchain** — `dev` (live reload), `build`, and `start`, all powered by
  `deno bundle`. No webpack, no esbuild config, no `node_modules`.

## Requirements

- Deno 2.x (developed against 2.9).

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
    "denext": "<path-to-denext>/mod.ts",
    "denext/jsx-runtime": "<path-to-denext>/src/jsx/jsx-runtime.ts",
    "denext/server": "<path-to-denext>/src/server/mod.ts",
    "denext/client": "<path-to-denext>/src/client/mod.ts"
  }
}
```

Then:

```
deno run -A <path-to-denext>/cli.ts dev .      # dev server + live reload
deno run -A <path-to-denext>/cli.ts build .    # produce .denext/ bundles
deno run -A <path-to-denext>/cli.ts start .    # serve the production build
```

See [`examples/hello`](./examples/hello) for a complete working app.

## Routing conventions

| File                         | Meaning                                             |
| ---------------------------- | --------------------------------------------------- |
| `app/page.tsx`               | Page at `/`                                          |
| `app/about/page.tsx`         | Page at `/about`                                     |
| `app/blog/[slug]/page.tsx`   | Dynamic page; `params.slug`                          |
| `app/docs/[...path]/page.tsx`| Catch-all; `params.path` is `"a/b/c"`               |
| `app/layout.tsx`             | Wraps this segment and everything beneath it         |
| `app/loading.tsx`            | Suspense fallback for the segment                    |
| `app/error.tsx`              | Error boundary (`{ error, reset }`)                  |
| `app/not-found.tsx`          | Not-found UI (`notFound()` or unmatched routes)      |
| `app/api/x/route.ts`         | API endpoint exporting `GET`/`POST`/…                |
| `app/(group)/…`              | Route group — folder name omitted from the URL       |
| `middleware.ts` / `proxy.ts` | Runs before routing                                  |

## API surface

```ts
// Components & rendering
import {
  useState, useEffect, useReducer, useMemo, useRef, useContext,
  createContext, Suspense, use, createResource,
  ErrorBoundary, notFound,
  Link, useRouter, usePathname, useSearchParams,
  renderToString, renderToReadableStream,
} from "denext";

// Server helpers & types
import {
  serve, createApp, renderPage,
  next, redirect, rewrite,          // middleware helpers
} from "denext/server";
import type { PageProps, LayoutProps, ApiContext, Metadata } from "denext/server";

// Client runtime
import { hydrateRoot, createRoot, startClient } from "denext/client";
```

### Pages, layouts, API

```tsx
// app/blog/[slug]/page.tsx — async server component
export default async function Post({ params }: PageProps) {
  const post = await db.get(params.slug);      // runs on the server
  return <article><h1>{post.title}</h1></article>;
}

// app/api/hello/route.ts
export function GET(req: Request, ctx: ApiContext) {
  return Response.json({ hello: ctx.params });
}
```

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

| Rule                        | Catches                                                        |
| --------------------------- | ------------------------------------------------------------- |
| `denext/rules-of-hooks`     | Hooks called conditionally (in `if`/loops) — order must be stable |
| `denext/hooks-in-component` | Hooks called outside a component/`useX` hook (e.g. in callbacks) |
| `denext/no-hooks-in-async`  | Hooks in an async server component (never hydrates)           |

```tsx
function Comp() {
  if (cond) {
    const [n] = useState(0);   // ✗ denext/rules-of-hooks
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

- **No React.** `src/jsx` + `src/runtime` + `src/client` are a compact
  React-equivalent (function components, the common hooks, context, Suspense,
  hydration, keyed diffing).
- **No bundler dependency.** `deno bundle` transpiles JSX and bundles each route
  into a single browser module.

## Development

```
deno task test     # run the test suite
deno test -A       # (equivalent)
```

The suite covers the JSX runtime, SSR (string + streaming), the router and
manifest scanner, the request handler, static serving, the client reconciler
(hydration, keyed reordering, effects, context), Suspense, error boundaries,
middleware, and client navigation.

## Status & limitations

denext is a from-scratch implementation of the Next.js core, not a drop-in
replacement. It intentionally omits some React/Next features: concurrent
rendering, class components, server actions, image optimization, and the legacy
`pages/` router. Client-side navigation re-executes a route bundle on each
navigation (simple and correct; not yet incrementally cached). Contributions and
issues welcome.

## License

MIT
