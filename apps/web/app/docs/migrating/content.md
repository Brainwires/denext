---
title: Migrating from Next.js
slug: migrating
lead: Moving an existing Next.js (App Router) + React 19 application to denext — a from-scratch Next.js-style framework for Deno with zero runtime npm dependencies, including the honest limits.
---

This guide covers moving an existing **Next.js (App Router) + React 19**
application to [denext](https://github.com/Brainwires/denext) — a from-scratch
Next.js-style framework for Deno with zero runtime npm dependencies. It reflects
what denext actually supports today, including honest limits.

denext runs on **Deno's own React** (a small reconciler-level reimplementation).
Real npm React libraries (Radix, recharts, react-hook-form, dnd-kit, …) run on
that single React via the **next-compat build**, which rewrites their
`import "react"` to denext at bundle time. Your app code changes very little;
the work is in configuration and validating the edges.

---

## 1. Before you start: is your app a good fit?

denext targets the **App Router** on **React 19**. It is
function-components-first; class components work through an on-demand runtime
chunk (§5).

**Validate your dependencies first** — don't guess. denext ships two probes:

```sh
# server-only Node deps: do they load under Deno's node: compat?
deno run -A --node-modules-dir=auto examples/next-compat-feasibility/probe-server.ts

# client React libs: do they bundle on denext's single React?
deno run -A --config deno.json examples/next-compat-feasibility/probe-client.ts /path/to/your-app
```

Edit the package lists in each probe to match your app. A clean run means the
dependency surface is compatible; failures point you at the specific packages to
address (see §7).

> Reference result: a large production app (90 pages / 188 API routes / 201
> server actions, Next 15.5) probed **12/12 server deps loading** and **25/25
> client libraries bundling** with zero code changes — the only native dep,
> `better-sqlite3`, maps to the built-in `node:sqlite` shim.

---

## 2. Compatibility at a glance

The `react` / `react-dom` / `next` / `next-intl` **public surface is diffed
against the latest upstream packages by a CI gate**
(`tests/react-parity.test.ts`) — export names, kinds, arities, and object
members — so a missing or wrong-shaped API fails the build. It currently reports
**zero deviations**. Intentional non-mirrors (`unstable_*` / `experimental_*`
APIs, the generative `next/font` per-font exports, removed-legacy APIs) are the
documented exceptions. See [Architecture](/docs/architecture) → "The surface
promise is machine-verified".

| Area                                                                                                                                                                            | Status                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| App Router (`app/`, layouts, nested routes, `page.tsx`)                                                                                                                         | ✅                                                                                               |
| Server-side rendering + client hydration                                                                                                                                        | ✅                                                                                               |
| Suspense + streaming SSR                                                                                                                                                        | ✅                                                                                               |
| Middleware (`middleware.ts`, `NextRequest`/`NextResponse`, `x-middleware-*`)                                                                                                    | ✅                                                                                               |
| `redirect` / `notFound` / `forbidden` / `unauthorized`                                                                                                                          | ✅                                                                                               |
| Portals, refs, `react-is`, `Slot`/`asChild`, React event semantics                                                                                                              | ✅                                                                                               |
| `next/font/local` + `next/font/google` (self-hosted at build)                                                                                                                   | ✅                                                                                               |
| `next-intl` (compact ICU on `Intl.*`)                                                                                                                                           | ✅                                                                                               |
| `better-sqlite3` → `node:sqlite` shim                                                                                                                                           | ✅                                                                                               |
| Real npm React UI libs (Radix, recharts, RHF, dnd-kit, sonner, …)                                                                                                               | ✅ via next-compat                                                                               |
| React **class components** (for those libs)                                                                                                                                     | ✅ on-demand runtime chunk; `classComponents` forces it on/off                                   |
| Concurrent hooks — `useTransition` with sustained `isPending`, render-phase `useDeferredValue`, `useOptimistic`                                                                 | ✅                                                                                               |
| **Interruptible, time-sliced rendering** (fiber): a transition renders in slices, yields to paint/input, and a sync update interrupts + restarts it — committed atomically      | ✅ (see [Concurrency](/docs/architecture#concurrency-fiber-based-time-sliced-and-interruptible)) |
| Layout / passive effect phases: `useLayoutEffect` + class lifecycle sync at commit, `useEffect` scheduled after paint                                                           | ✅ (see [Concurrency](/docs/architecture#concurrency-fiber-based-time-sliced-and-interruptible)) |
| `use(Context)`, form-scoped `useFormStatus`, `SuspenseList` reveal order, reconciler `Profiler` durations, dev `StrictMode` double-invoke                                       | ✅                                                                                               |
| Metadata: page + **layout** `generateMetadata`/`generateViewport`, file conventions (sitemap/robots/opengraph-image/…)                                                          | ✅                                                                                               |
| ISR **stale-while-revalidate** (serve stale + background regen), `revalidatePath`/`revalidateTag`                                                                               | ✅                                                                                               |
| Automatic `fetch()` caching — **uncached by default**, opt in via `next:{revalidate,tags}` / `cache:"force-cache"`                                                              | ✅ (matches Next 15/16 default)                                                                  |
| **Cache Components** — `use cache`, `cacheLife`/`cacheTag`, `updateTag`/`refresh`, and **PPR** (static shell + per-request dynamic holes)                                       | ✅ opt-in (`cacheComponents: true`)                                                              |
| `next/image` Next 16 knobs — `qualities`, `minimumCacheTTL`, `localPatterns`, `formats` (**AVIF**), `maximumRedirects`, `dangerouslyAllowLocalIP`                               | ✅                                                                                               |
| Soft navigation — reconcile-in-place via a retained root (preserves state, no re-hydrate)                                                                                       | ✅                                                                                               |
| `next/form` (`<Form>`), `connection()`, `after()` (from `next/server`), `useLinkStatus`                                                                                         | ✅                                                                                               |
| `react`/`react-dom` surface — `react-dom/server` (streaming), `useFormStatus`/`useFormState`, `React.cache`, `react-dom/test-utils`                                             | ✅ via next-compat                                                                               |
| Legacy `pages/` router                                                                                                                                                          | ✅ via `@denext/pages-router` (first-party plugin)                                               |
| `getServerSideProps` / `getStaticProps` / `getStaticPaths` (Pages Router data)                                                                                                  | ✅ via `@denext/pages-router`                                                                    |
| `next/navigation` — `ReadonlyURLSearchParams`, `RedirectType`, `ServerInsertedHTMLContext`, `redirect(url, "push"\|"replace")`                                                  | ✅                                                                                               |
| `next/server` — `ImageResponse`, `URLPattern`, `userAgentFromString`, `NextFetchEvent`; `next/image` `getImageProps`; `next/script` `handleClientScriptLoad`/`initScriptLoader` | ✅                                                                                               |
| `next-intl` — `createTranslator`, `createFormatter`, `hasLocale`, `initializeConfig`, `IntlError`/`IntlErrorCode`, `IntlProvider`                                               | ✅                                                                                               |
| `next/router` `Router` singleton + `withRouter` (Pages Router)                                                                                                                  | ✅ via `@denext/pages-router`                                                                    |
| React 19.2 surface — `Activity`, `cacheSignal`, `captureOwnerStack`, `addTransitionType`; `react-dom` `preloadModule`/`preinitModule`/`requestFormReset`                        | ✅                                                                                               |

---

## 3. Project setup

denext resolves React (and `next/*`) through your `deno.json` import map. Point
the React family and the Next compat surface at denext:

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

`denext migrate` (run in the Next project) writes ALL of this for you — the map
above is what it generates, shown so you can audit or hand-tune it; a fresh
compat project gets the same map from `denext create --compatibility`.

```sh
deno run -A jsr:@denext/denext/cli migrate
deno task dev
```

By default `migrate` **only creates config files** — it never rewrites your
source. Your imports keep pointing at `next/*` and `react`, and the alias map
resolves them to denext. To also rewrite the source to import from `denext`
directly (dropping the alias), pass `--codemod` (add `--yes` to skip its
confirmation prompt), or run the standalone `denext codemod` later.

> [!NOTE]
> Migrating a project that already has `node_modules` installed (most real
> apps)? Add `--node-modules-dir=none` to the migrate command:
> `deno run --node-modules-dir=none -A jsr:@denext/denext/cli migrate`. Without
> it, Deno runs in manual-`node_modules` mode and can't resolve the CLI's own
> build dependencies. (Your app's `node_modules` is untouched either way — the
> compat layer still loads your npm React libraries from it.)

`migrate` also writes a `.gitignore` for the artifacts it generates —
`.denext/` (build cache), `out/` (the static export), and (with `--desktop`)
`desktop-icon.png` — creating the file if absent and appending only the missing
lines (it never reorders or removes your entries).

> **npm specifier caveat.** Deno's managed npm resolution binds an npm package's
> _internal_ `import "react"` to real npm React, not to an import-map alias.
> That's exactly why real npm React libraries must go through the **next-compat
> build** (§5), which rewrites those internal imports at bundle time. Your own
> app code respects the import map directly.

> **You don't hand-patch dependencies.** denext's compat build ships a tolerant
> node_modules resolver (`nodeResolve`, default-on — a strict
> superset of Deno's `npm:` loader that honors `exports` wildcard globs and
> falls back to a plain subpath), so an unmodified pnpm/npm/yarn/bun app builds
> straight from its installed `node_modules` with no catalog-concretizing and no
> patching of a dependency's `exports`. `denext migrate` writes config and
> leaves your source alone; the one `package.json` edit it makes is stripping
> Prisma's npm client when it wires the Deno-native adapter (see
> [Databases](/docs/database)). Set `nodeResolve: false` to force app deps back
> through Deno's strict `npm:` loader (escape hatch).

---

## 3b. Migrating a Vite, CRA or generic React SPA

`migrate` also handles a client-only **Vite React SPA** (a `vite.config.*` with
React and no `next.config.*`). It detects the shape and writes a
[SPA-mode](/docs/spa) config instead of the App Router one: `mode: "spa"` +
`compatibilityMode: true`, your `~/` / `@/` path alias from `tsconfig.json`, a
`tailwind` block when it finds a stylesheet with the Tailwind directive
(`@import "tailwindcss"`), the mount element id your entry renders into
(`spa.rootId`), and `spa.env` seeded from your Vite `define` block and
`import.meta.env.VITE_*` usage. Add `--desktop` to also emit a `deno desktop`
entry, and `--backend http://127.0.0.1:3773 --proxy /api,/ws` to wire a
[backend proxy](/docs/spa):

```sh
deno run -A jsr:@denext/denext/cli migrate apps/web \
  --desktop --backend http://127.0.0.1:3773 --proxy /api,/ws
```

The same SPA path also detects a **Create React App** (a `react-scripts` dep, or
a `public/index.html` with React) and a **generic React SPA** (React plus a root
`index.html`, no Vite/CRA/Next) — seeding `spa.env` from
`process.env.REACT_APP_*` / `import.meta.env.VITE_*` as appropriate. Pass
`--from vite|cra|generic` to force the source when detection is ambiguous.

> Migrating from Remix? That is a route-tree transform, not a SPA import — see
> [Migrating from Remix](/docs/migrating-remix).

---

## 4. Migrating app code

Most App Router code is already compatible. Typical adjustments:

- **`"use client"` / `"use server"`** — keep them; denext honors both.
- **Server Components** — default; `async` components and `await` in the tree
  work.
- **Route handlers** (`app/**/route.ts`) — `NextRequest`/`NextResponse` are
  supported (`nextUrl`, `cookies`, `geo`/`ip`, the `x-middleware-*` protocol).
  The request body is not consumed by the adapter, so handlers can read it.
- **`middleware.ts`** — supported. `NextResponse.next({ request: { headers } })`
  header overrides work; inbound client `x-middleware-*` headers are ignored
  (not trusted).
- **`cookies()` / `headers()`** — available from `next/headers`.
- **Metadata** — `<title>`/`<meta>`/`<link>` are hoisted to `<head>` (React 19
  semantics).
- **`next/image`, `next/link`, `next/script`, `next/dynamic`** — compat shims
  provided.

---

## 5. Running real npm React libraries (next-compat build)

Radix, recharts, react-hook-form, dnd-kit, sonner, embla, cmdk, vaul,
react-day-picker, lucide, react-markdown, katex, fabric — these are real npm
packages built on React. They run on denext's single React through
`buildNextCompatPages`, which bundles each page's server (SSR) and client
(hydration) bundles with `react`/`react-dom`/`react-is` aliased to denext:

```ts
import { buildNextCompatPages, renderNextCompatPage } from "jsr:@denext/denext/build/next-compat";

const [page] = await buildNextCompatPages({
  projectDir: appDir,
  configPath: `${appDir}/deno.json`,
  outDir: `${appDir}/.denext`,
  pages: [{
    routePath: "/",
    filePath: `${appDir}/app/page.tsx`,
    layouts: ["app/layout.tsx"],
  }],
  classComponents: true, // optional: import the class runtime statically (it loads on demand otherwise)
});
```

See `examples/next-compat` (real Radix) and `examples/next-compat-recharts`
(real recharts, class components) for runnable end-to-end demos (SSR +
hydration).

Radix's `asChild` resolves through denext's own `Slot`/`Slottable`
(`@denext/denext/slot`) and `composeRefs` (`@denext/denext/compose-refs`): props
merge onto a single child element — className joins, event handlers compose,
refs merge — with no wrapper element. `react-is` classifies denext elements
(`isForwardRef`, `isMemo`, `typeOf`, …), and with the React DevTools integration
the ecosystem and your tools see denext as React.

### `classComponents`

Some libraries (recharts v2, older component libs) use React **class
components**. They work without configuration: the class runtime (lifecycle,
`setState` batching, `getDerivedStateFromProps`/`shouldComponentUpdate`,
`getSnapshotBeforeUpdate`, error boundaries via
`getDerivedStateFromError`/`componentDidCatch`, legacy `contextType`) is a
separate chunk loaded on demand — before hydration when the server rendered a
class, or statically when the build scan finds `Component` in the app's own
sources (the one visible case is in
[Known differences](/docs/differences)). `classComponents` in
`denext.config.ts` (or on `buildNextCompatPages`) forces the choice: `true`
always imports the runtime statically (no round trip); `false` keeps it out
entirely — zero bytes, and a class throws a guided error naming the fix. On the
next-compat/SPA esbuild path the flag is also a `define`, so `false`
dead-code-eliminates the reconciler's class guards from that bundle too.

### Node built-ins in browser libraries

A few browser-capable libraries `require("fs")`/`import "node:path"` inside
Node-only code paths (e.g. `@techstark/opencv-js`, `scribe.js-ocr`). The
next-compat browser build stubs those truly-Node-only built-ins to empty modules
(like webpack's `resolve.fallback: { fs: false }`). Browser-usable built-ins
(`buffer`, `crypto`, `stream`, `util`, `events`, `process`, `zlib`) are **not**
stubbed — if a library genuinely needs one in the browser, the build fails
loudly so you can add a real polyfill rather than ship a silent `undefined`.

---

## 6. Server-side dependencies on Deno

Server SDKs run under Deno's `node:` compatibility layer. Validated to load:
`stripe`, `twilio`, `openai`, `@aws-sdk/client-s3`, `nodemailer`, `imapflow`,
`mailparser`, `jose`, `bcryptjs`, `web-push`, `tar`, `@simplewebauthn/server`.
Loading proves module init; still smoke-test any SDK that opens raw sockets
(IMAP/SMTP) against your provider during migration.

- **Databases** — replace `better-sqlite3` with denext's `better-sqlite3` shim
  over `node:sqlite` (same `prepare`/`pluck`/`raw`/`pragma`/`transaction`
  surface). Other drivers: verify under Deno.
- **Crypto/auth** — `jose`, `bcryptjs`, WebAuthn load cleanly.
- **Env/secrets** — use `Deno.env`; environment variables and CLI flags are
  trusted inputs.

---

## 7. Handling the edges

| Symptom                                          | Cause                                              | Fix                                                                          |
| ------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| A client lib fails to bundle on `node:*`/`fs`    | Node-only code path in a browser lib               | Usually auto-stubbed; if it's a browser-usable builtin, add a polyfill (§5)  |
| A class component throws "classComponents: true" | class runtime gated off (`classComponents: false`) | remove `classComponents: false` (or set it `true`)                           |
| Native addon won't load (`better-sqlite3`)       | native `.node` binary                              | use the `node:sqlite` shim; other native deps need a Deno-native replacement |
| `pages/` routes 404                              | Pages Router plugin not enabled                    | add `@denext/pages-router` (or run `denext migrate`), or port to `app/`      |
| Duplicate-React / "no dispatcher installed"      | a React lib not routed through next-compat         | ensure the page is built via `buildNextCompatPages`                          |

---

## 8. Known limitations

> This is the migration-focused summary. For the full catalogue of behavioral
> divergences, the experimental/unstable API list, and the honest React DevTools
> scope, see [Known limitations](/docs/limitations).

- **App Router is the core** — the legacy Pages Router is the first-party
  `@denext/pages-router` plugin, which `denext migrate` wires up automatically
  when it finds a `pages/` tree. See [Known limitations](/docs/limitations).
- **A strict default CSP blocks external scripts/styles/images** until you opt
  the host in per route with
  `export const csp = { scriptSrc: ["https://…"], styleSrc: ["https://…"], imgSrc: ["https://…"] }`
  (`csp: "off"` in `denext.config.ts`, or a route's `export const csp = "off"`,
  disables it). See [Known differences](/docs/differences).
- **`fetch()` is uncached by default** — opt in per call with
  `next: { revalidate, tags }` or `cache: "force-cache"` (Next 15+ parity). See
  [Known differences](/docs/differences).
- **Opinionated default response headers** (`nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HSTS over HTTPS) are added
  unless you set your own. See [Known differences](/docs/differences).
- **Legacy provider context** (`childContextTypes`/`getChildContext`) is not
  supported; `contextType` is. See [Known limitations](/docs/limitations).
- **Type-checking a compat app isn't clean.** `deno check` still reports
  cross-library `@types/react` conflicts, because npm libraries ship their own
  React types — runtime rendering is unaffected (`skipLibCheck` is set by
  `denext migrate`).

---

## 9. Suggested migration order

1. **Probe dependencies** (§1) — know your blockers before touching code.
2. **Run `denext migrate`** in the project — it writes the `deno.json` import map
   (§3) and `denext.config.ts`, and translates `next.config.*`; it only creates
   config files and never rewrites your source unless you add `--codemod`.
3. **Port a bounded slice first** — a few public/marketing pages through the
   next-compat build; confirm dev + a production build serve and hydrate.
4. **Migrate route handlers + middleware** (§4), smoke-testing server SDKs (§6).
5. **Expand route by route**, enabling `classComponents` if a dependency needs
   it (§5).
6. **Swap native deps** (`better-sqlite3` → `node:sqlite`, §6).
7. **Test dev and a production build** at each stage.

Deploying the result: `deno task build` then `deno task start`, or a fully
static export — any host that runs Deno works. See [Deployment](/docs/deploy).

Starting fresh instead? You don't need the alias — import from `denext` and
`denext/server` directly. See [Getting started](/docs/getting-started).

> [!WARNING]
> Where denext differs from Next is documented honestly. Before a large
> migration, skim [Known differences](/docs/differences) (the deliberate
> behavioral differences) and [Known limitations](/docs/limitations) (the
> surface gaps).

Contributions and issues welcome — see the
[main README](https://github.com/Brainwires/denext).
