<p align="center">
  <img src="./app-image.png" alt="denext" width="180">
</p>

# Migrating a Next.js app to denext

This guide covers moving an existing **Next.js (App Router) + React 19** application to
[denext](./README.md) — a from-scratch Next.js-style framework for Deno with zero runtime
npm dependencies. It reflects what denext actually supports today, including honest limits.

denext runs on **Deno's own React** (a small reconciler-level reimplementation). Real npm
React libraries (Radix, recharts, react-hook-form, dnd-kit, …) run on that single React via the
**next-compat build**, which rewrites their `import "react"` to denext at bundle time. Your app
code changes very little; the work is in configuration and validating the edges.

---

## 1. Before you start: is your app a good fit?

denext targets the **App Router** on **React 19**. It is function-components-first; class
components are supported for npm libraries via the next-compat build (§5).

**Validate your dependencies first** — don't guess. denext ships two probes:

```sh
# server-only Node deps: do they load under Deno's node: compat?
deno run -A --node-modules-dir=auto examples/next-compat-feasibility/probe-server.ts

# client React libs: do they bundle on denext's single React?
deno run -A --config deno.json examples/next-compat-feasibility/probe-client.ts /path/to/your-app
```

Edit the package lists in each probe to match your app. A clean run means the dependency
surface is compatible; failures point you at the specific packages to address (see §7).

> Reference result: a large production app (90 pages / 188 API routes / 201 server actions,
> Next 15.5) probed **12/12 server deps loading** and **25/25 client libraries bundling** with
> zero code changes — the only native dep, `better-sqlite3`, maps to the built-in `node:sqlite`
> shim.

---

## 2. Compatibility at a glance

| Area                                                                                                   | Status                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| App Router (`app/`, layouts, nested routes, `page.tsx`)                                                | ✅                                          |
| Server-side rendering + client hydration                                                               | ✅                                          |
| Suspense + streaming SSR                                                                               | ✅                                          |
| Middleware (`middleware.ts`, `NextRequest`/`NextResponse`, `x-middleware-*`)                           | ✅                                          |
| `redirect` / `notFound` / `forbidden` / `unauthorized`                                                 | ✅                                          |
| Portals, refs, `react-is`, `Slot`/`asChild`, React event semantics                                     | ✅                                          |
| `next/font/local` + `next/font/google` (self-hosted at build)                                          | ✅                                          |
| `next-intl` (compact ICU on `Intl.*`)                                                                  | ✅                                          |
| `better-sqlite3` → `node:sqlite` shim                                                                  | ✅                                          |
| Real npm React UI libs (Radix, recharts, RHF, dnd-kit, sonner, …)                                      | ✅ via next-compat                          |
| React **class components** (for those libs)                                                            | ✅ opt-in via `classComponents`             |
| Concurrent hooks (`useTransition`, `useDeferredValue`, `useOptimistic`) — API present, results correct | ✅                                          |
| True concurrent _rendering_ (interruptible/time-sliced, priority lanes)                                | ❌ (hooks run synchronously)                |
| Legacy `pages/` router                                                                                 | ❌                                          |
| `getServerSideProps` / `getStaticProps` (Pages Router data)                                            | ❌ (use Server Components / route handlers) |

---

## 3. Project setup

denext resolves React (and `next/*`) through your `deno.json` import map. Point the React family
and the Next compat surface at denext:

```jsonc
// deno.json
{
  "nodeModulesDir": "auto",
  "imports": {
    "react": "jsr:@denext/denext/react",
    "react/jsx-runtime": "jsr:@denext/denext/react/jsx-runtime",
    "react-dom": "jsr:@denext/denext/react-dom",
    "react-dom/client": "jsr:@denext/denext/react-dom/client",
    "react-is": "jsr:@denext/denext/react-is",

    "next/link": "jsr:@denext/denext/next/link",
    "next/navigation": "jsr:@denext/denext/next/navigation",
    "next/headers": "jsr:@denext/denext/next/headers",
    "next/server": "jsr:@denext/denext/next/server",
    "next/font/google": "jsr:@denext/denext/next/font/google",
    "next/font/local": "jsr:@denext/denext/next/font/local",

    "next-intl": "jsr:@denext/denext/next-intl",
    "better-sqlite3": "jsr:@denext/denext/better-sqlite3"
  }
}
```

The `denext create --next-compat` scaffolder writes most of this for you.

> **npm specifier caveat.** Deno's managed npm resolution binds an npm package's _internal_
> `import "react"` to real npm React, not to an import-map alias. That's exactly why real npm
> React libraries must go through the **next-compat build** (§5), which rewrites those internal
> imports at bundle time. Your own app code respects the import map directly.

---

## 4. Migrating app code

Most App Router code is already compatible. Typical adjustments:

- **`"use client"` / `"use server"`** — keep them; denext honors both.
- **Server Components** — default; `async` components and `await` in the tree work.
- **Route handlers** (`app/**/route.ts`) — `NextRequest`/`NextResponse` are supported
  (`nextUrl`, `cookies`, `geo`/`ip`, the `x-middleware-*` protocol). The request body is not
  consumed by the adapter, so handlers can read it.
- **`middleware.ts`** — supported. `NextResponse.next({ request: { headers } })` header
  overrides work; inbound client `x-middleware-*` headers are ignored (not trusted).
- **`cookies()` / `headers()`** — available from `next/headers`.
- **Metadata** — `<title>`/`<meta>`/`<link>` are hoisted to `<head>` (React 19 semantics).
- **`next/image`, `next/link`, `next/script`, `next/dynamic`** — compat shims provided.

---

## 5. Running real npm React libraries (next-compat build)

Radix, recharts, react-hook-form, dnd-kit, sonner, embla, cmdk, vaul, react-day-picker,
lucide, react-markdown, katex, fabric — these are real npm packages built on React. They run on
denext's single React through `buildNextCompatPages`, which bundles each page's server (SSR) and
client (hydration) bundles with `react`/`react-dom`/`react-is` aliased to denext:

```ts
import { buildNextCompatPages, renderNextCompatPage } from "jsr:@denext/denext/build/next-compat";

const [page] = await buildNextCompatPages({
  projectDir: appDir,
  configPath: `${appDir}/deno.json`,
  outDir: `${appDir}/.denext`,
  pages: [{ routePath: "/", filePath: `${appDir}/app/page.tsx`, layouts: ["app/layout.tsx"] }],
  classComponents: true, // enable if any dependency uses React class components (e.g. recharts)
});
```

See `examples/next-compat` (real Radix) and `examples/next-compat-recharts` (real recharts,
class components) for runnable end-to-end demos (SSR + hydration).

### `classComponents`

Some libraries (recharts v2, older component libs) use React **class components**. Enable them
with `classComponents: true` on the next-compat build. When enabled, denext compiles in the full
class runtime (lifecycle, `setState` batching, `getDerivedStateFromProps`/`shouldComponentUpdate`,
`getSnapshotBeforeUpdate`, error boundaries via `getDerivedStateFromError`/`componentDidCatch`,
legacy `contextType`). When off, the class runtime is **dead-code-eliminated** from the
next-compat bundle, and using a class throws a guided error naming the fix.

> The standard `denext build`/`dev` pipeline uses `deno bundle`, which has no build-time
> `define`, so it cannot DCE the gate — there the (small) class runtime is always included and
> enabled. The `classComponents` flag is therefore only meaningful for the next-compat build.

### Node built-ins in browser libraries

A few browser-capable libraries `require("fs")`/`import "node:path"` inside Node-only code
paths (e.g. `@techstark/opencv-js`, `scribe.js-ocr`). The next-compat browser build stubs those
truly-Node-only built-ins to empty modules (like webpack's `resolve.fallback: { fs: false }`).
Browser-usable built-ins (`buffer`, `crypto`, `stream`, `util`, `events`, `process`, `zlib`) are
**not** stubbed — if a library genuinely needs one in the browser, the build fails loudly so you
can add a real polyfill rather than ship a silent `undefined`.

---

## 6. Server-side dependencies on Deno

Server SDKs run under Deno's `node:` compatibility layer. Validated to load: `stripe`, `twilio`,
`openai`, `@aws-sdk/client-s3`, `nodemailer`, `imapflow`, `mailparser`, `jose`, `bcryptjs`,
`web-push`, `tar`, `@simplewebauthn/server`. Loading proves module init; still smoke-test any SDK
that opens raw sockets (IMAP/SMTP) against your provider during migration.

- **Databases** — replace `better-sqlite3` with denext's `better-sqlite3` shim over `node:sqlite`
  (same `prepare`/`pluck`/`raw`/`pragma`/`transaction` surface). Other drivers: verify under Deno.
- **Crypto/auth** — `jose`, `bcryptjs`, WebAuthn load cleanly.
- **Env/secrets** — use `Deno.env`; environment variables and CLI flags are trusted inputs.

---

## 7. Handling the edges

| Symptom                                          | Cause                                      | Fix                                                                          |
| ------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| A client lib fails to bundle on `node:*`/`fs`    | Node-only code path in a browser lib       | Usually auto-stubbed; if it's a browser-usable builtin, add a polyfill (§5)  |
| A class component throws "classComponents: true" | class runtime gated off                    | set `classComponents: true` on the next-compat build                         |
| Native addon won't load (`better-sqlite3`)       | native `.node` binary                      | use the `node:sqlite` shim; other native deps need a Deno-native replacement |
| `pages/` routes 404                              | Pages Router unsupported                   | port to App Router (`app/`)                                                  |
| Duplicate-React / "no dispatcher installed"      | a React lib not routed through next-compat | ensure the page is built via `buildNextCompatPages`                          |

---

## 8. Known limitations

- **No Pages Router** and no `getServerSideProps`/`getStaticProps` — App Router only.
- **Concurrent rendering.** The concurrent _hooks_ exist and return correct results —
  `useTransition` (`isPending` toggles), `useDeferredValue` (lags one commit), `useOptimistic`
  (fully works) — so code using them is safe to keep. What's missing is the underlying
  concurrency: rendering is **synchronous and non-interruptible** (no time-slicing, no priority
  lanes), so `startTransition` runs eagerly and a heavy transition still blocks the main thread
  rather than yielding. You get correct UI, not improved responsiveness under load.
- **`contextType` in the streaming/flight renderers** resolves from provider scopes (parity with
  `render-to-string`); `getChildContext`/`childContextTypes` (legacy provider context) are not
  supported.
- **Client-side navigation** re-executes a route bundle per navigation (not incrementally cached).
- **ICU** is a compact subset built on `Intl.*`, not full `intl-messageformat`.

---

## 9. Suggested migration order

1. **Probe dependencies** (§1) — know your blockers before touching code.
2. **Set up `deno.json`** import map (§3) — `denext create --next-compat` bootstraps it.
3. **Port a bounded slice first** — a few public/marketing pages through the next-compat build;
   confirm dev + a production build serve and hydrate.
4. **Migrate route handlers + middleware** (§4), smoke-testing server SDKs (§6).
5. **Expand route by route**, enabling `classComponents` if a dependency needs it (§5).
6. **Swap native deps** (`better-sqlite3` → `node:sqlite`, §6).
7. **Test dev and a production build** at each stage.

Contributions and issues welcome — see the main [README](./README.md).
