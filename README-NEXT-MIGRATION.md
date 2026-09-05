<p align="center">
  <img src="./assets/app-image.png" alt="denext" width="180">
</p>

# Migrating a Next.js app to denext

This guide covers moving an existing **Next.js (App Router) + React 19**
application to [denext](./README.md) — a from-scratch Next.js-style framework
for Deno with zero runtime npm dependencies. It reflects what denext actually
supports today, including honest limits.

denext runs on **Deno's own React** (a small reconciler-level reimplementation).
Real npm React libraries (Radix, recharts, react-hook-form, dnd-kit, …) run on
that single React via the **next-compat build**, which rewrites their
`import "react"` to denext at bundle time. Your app code changes very little;
the work is in configuration and validating the edges.

---

## 1. Before you start: is your app a good fit?

denext targets the **App Router** on **React 19**. It is
function-components-first; class components are supported for npm libraries via
the next-compat build (§5).

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
documented exceptions. See [ARCHITECTURE.md](./ARCHITECTURE.md) → "The surface
promise is machine-verified".

| Area                                                                                                                                                                            | Status                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| App Router (`app/`, layouts, nested routes, `page.tsx`)                                                                                                                         | ✅                                                 |
| Server-side rendering + client hydration                                                                                                                                        | ✅                                                 |
| Suspense + streaming SSR                                                                                                                                                        | ✅                                                 |
| Middleware (`middleware.ts`, `NextRequest`/`NextResponse`, `x-middleware-*`)                                                                                                    | ✅                                                 |
| `redirect` / `notFound` / `forbidden` / `unauthorized`                                                                                                                          | ✅                                                 |
| Portals, refs, `react-is`, `Slot`/`asChild`, React event semantics                                                                                                              | ✅                                                 |
| `next/font/local` + `next/font/google` (self-hosted at build)                                                                                                                   | ✅                                                 |
| `next-intl` (compact ICU on `Intl.*`)                                                                                                                                           | ✅                                                 |
| `better-sqlite3` → `node:sqlite` shim                                                                                                                                           | ✅                                                 |
| Real npm React UI libs (Radix, recharts, RHF, dnd-kit, sonner, …)                                                                                                               | ✅ via next-compat                                 |
| React **class components** (for those libs)                                                                                                                                     | ✅ opt-in via `classComponents`                    |
| Concurrent hooks — `useTransition` with sustained `isPending`, render-phase `useDeferredValue`, `useOptimistic`                                                                 | ✅                                                 |
| **Interruptible, time-sliced rendering** (fiber): a transition renders in slices, yields to paint/input, and a sync update interrupts + restarts it — committed atomically      | ✅ (see §10)                                       |
| Layout / passive effect phases: `useLayoutEffect` + class lifecycle sync at commit, `useEffect` scheduled after paint                                                           | ✅ (see §10)                                       |
| `use(Context)`, form-scoped `useFormStatus`, `SuspenseList` reveal order, reconciler `Profiler` durations, dev `StrictMode` double-invoke                                       | ✅                                                 |
| Metadata: page + **layout** `generateMetadata`/`generateViewport`, file conventions (sitemap/robots/opengraph-image/…)                                                          | ✅                                                 |
| ISR **stale-while-revalidate** (serve stale + background regen), `revalidatePath`/`revalidateTag`                                                                               | ✅                                                 |
| Automatic `fetch()` caching — **uncached by default**, opt in via `next:{revalidate,tags}` / `cache:"force-cache"`                                                              | ✅ (matches Next 15/16 default)                    |
| **Cache Components** — `use cache`, `cacheLife`/`cacheTag`, `updateTag`/`refresh`, and **PPR** (static shell + per-request dynamic holes)                                       | ✅ opt-in (`cacheComponents: true`)                |
| `next/image` Next 16 knobs — `qualities`, `minimumCacheTTL`, `localPatterns`, `formats` (**AVIF**), `maximumRedirects`, `dangerouslyAllowLocalIP`                               | ✅                                                 |
| Soft navigation — reconcile-in-place via a retained root (preserves state, no re-hydrate)                                                                                       | ✅                                                 |
| `next/form` (`<Form>`), `connection()`, `after()` (from `next/server`), `useLinkStatus`                                                                                         | ✅                                                 |
| `react`/`react-dom` surface — `react-dom/server` (streaming), `useFormStatus`/`useFormState`, `React.cache`, `react-dom/test-utils`                                             | ✅ via next-compat                                 |
| Legacy `pages/` router                                                                                                                                                          | ✅ via `@denext/pages-router` (first-party plugin) |
| `getServerSideProps` / `getStaticProps` / `getStaticPaths` (Pages Router data)                                                                                                  | ✅ via `@denext/pages-router`                      |
| `next/navigation` — `ReadonlyURLSearchParams`, `RedirectType`, `ServerInsertedHTMLContext`, `redirect(url, "push"\|"replace")`                                                  | ✅                                                 |
| `next/server` — `ImageResponse`, `URLPattern`, `userAgentFromString`, `NextFetchEvent`; `next/image` `getImageProps`; `next/script` `handleClientScriptLoad`/`initScriptLoader` | ✅                                                 |
| `next-intl` — `createTranslator`, `createFormatter`, `hasLocale`, `initializeConfig`, `IntlError`/`IntlErrorCode`, `IntlProvider`                                               | ✅                                                 |
| `next/router` `Router` singleton + `withRouter` (Pages Router)                                                                                                                  | ✅ via `@denext/pages-router`                      |
| React 19.2 surface — `Activity`, `cacheSignal`, `captureOwnerStack`, `addTransitionType`; `react-dom` `preloadModule`/`preinitModule`/`requestFormReset`                        | ✅                                                 |

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

The `denext create --compatibility` scaffolder writes most of this for you.

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
> [DATABASE.md](./DATABASE.md)). Set `nodeResolve: false` to force app deps back
> through Deno's strict `npm:` loader (escape hatch).

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
  classComponents: true, // enable if any dependency uses React class components (e.g. recharts)
});
```

See `examples/next-compat` (real Radix) and `examples/next-compat-recharts`
(real recharts, class components) for runnable end-to-end demos (SSR +
hydration).

### `classComponents`

Some libraries (recharts v2, older component libs) use React **class
components**. Enable them with `classComponents: true` on the next-compat build.
When enabled, denext compiles in the full class runtime (lifecycle, `setState`
batching, `getDerivedStateFromProps`/`shouldComponentUpdate`,
`getSnapshotBeforeUpdate`, error boundaries via
`getDerivedStateFromError`/`componentDidCatch`, legacy `contextType`). When off,
the class runtime is **dead-code-eliminated** from the next-compat bundle, and
using a class throws a guided error naming the fix.

> The standard `denext build`/`dev` pipeline uses `deno bundle`, which has no
> build-time `define`, so it cannot DCE the gate — there the (small) class
> runtime is always included and enabled. The `classComponents` flag is
> therefore only meaningful for the next-compat build.

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

| Symptom                                          | Cause                                      | Fix                                                                          |
| ------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| A client lib fails to bundle on `node:*`/`fs`    | Node-only code path in a browser lib       | Usually auto-stubbed; if it's a browser-usable builtin, add a polyfill (§5)  |
| A class component throws "classComponents: true" | class runtime gated off                    | set `classComponents: true` on the next-compat build                         |
| Native addon won't load (`better-sqlite3`)       | native `.node` binary                      | use the `node:sqlite` shim; other native deps need a Deno-native replacement |
| `pages/` routes 404                              | Pages Router plugin not enabled            | add `@denext/pages-router` (or run `denext migrate`), or port to `app/`      |
| Duplicate-React / "no dispatcher installed"      | a React lib not routed through next-compat | ensure the page is built via `buildNextCompatPages`                          |

---

## 8. Known limitations

> This is the migration-focused summary. For the full catalogue of behavioral
> divergences, the experimental/unstable API list, and the honest React DevTools
> scope, see [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

- **App Router is the core.** The legacy Pages Router (with
  `getServerSideProps`/`getStaticProps`/`getStaticPaths`) is available as an
  optional first-party plugin, `@denext/pages-router` — `denext migrate` wires
  it up automatically when it finds a `pages/` tree.
- **Concurrent rendering** is fiber-based and complete: transition renders are
  time-sliced, interruptible, and committed atomically, and effects are split
  into a synchronous layout phase and a scheduled passive phase. See
  [§10](#10-concurrency-fiber-based-time-sliced-and-interruptible) for exactly
  what's implemented. (Practical note: assert a `useEffect` side effect in a
  test only after `flushSync()`/`act()`.) A `startTransition`/`useDeferredValue`
  update that re-suspends an already-revealed boundary keeps the current content
  on screen (no fallback flash) and preserves its state, like React. On an
  **urgent** (non-transition) re-suspend, denext matches React's Offscreen: it
  keeps the primary subtree mounted-but-hidden (inline `display:none`) and
  reveals the **same instances** on resolve, so local state is preserved (no
  remount).
- **`contextType` in the streaming/flight renderers** resolves from provider
  scopes (parity with `render-to-string`); `getChildContext`/`childContextTypes`
  (legacy provider context) are not supported.
- **Client-side navigation** reconciles the new route in place through a
  retained reconciler root (preserving state in unaffected subtrees, no
  re-hydrate). A **Flight** route (with a `"use client"`/`"use server"`
  boundary) transfers just its RSC/Flight payload and re-runs no route bundle;
  an isomorphic (non-Flight) route still re-fetches the full HTML document.
- **Automatic `fetch()` caching is uncached by default** — a bare `fetch()` is
  never cached (opt in per call with `next: { revalidate, tags }` or
  `cache: "force-cache"`). This **matches Next.js 15+**, which flipped `fetch`
  (and GET Route Handlers) to uncached-by-default for predictability; it was
  stricter only versus Next ≤ 14. It avoids accidental caching of authed data
  and does not force a route dynamic.
- **A default Content-Security-Policy blocks external scripts/styles.** Unlike
  Next.js (which ships no CSP), denext emits a strict hash-based CSP on every
  document response. **Migration impact:** a third-party
  `<script src="https://…">` or external stylesheet, and raw
  `<img src="https://…">` (use `<Image>` — it proxies to same-origin), are
  blocked until you opt the host in per route:
  `export const csp = { scriptSrc: ["https://…"], styleSrc: ["https://…"], imgSrc: ["https://…"] }`
  (opt-ins union down the layout→page chain). React `style={{}}` and inline
  `<Script>` bodies keep working. Set your own policy via `headers()`/middleware
  to override it entirely.
- **Opinionated default response headers** (`nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HSTS over HTTPS) are added
  unless you set your own — again, stricter than Next.
- **ICU** is built on `Intl.*` + first-party code, not `intl-messageformat`:
  interpolation, number/date/time with full `::` skeletons, `duration`,
  plural/select, `spellout`/`ordinal` (first-party speller, English built in),
  nested submessages, and apostrophe escaping — zero npm deps, zero bundled
  data.

---

## 9. Suggested migration order

1. **Probe dependencies** (§1) — know your blockers before touching code.
2. **Set up `deno.json`** import map (§3) — `denext create --compatibility`
   bootstraps it.
3. **Port a bounded slice first** — a few public/marketing pages through the
   next-compat build; confirm dev + a production build serve and hydrate.
4. **Migrate route handlers + middleware** (§4), smoke-testing server SDKs (§6).
5. **Expand route by route**, enabling `classComponents` if a dependency needs
   it (§5).
6. **Swap native deps** (`better-sqlite3` → `node:sqlite`, §6).
7. **Test dev and a production build** at each stage.

Contributions and issues welcome — see the main [README](./README.md).

---

## 10. Concurrency: fiber-based, time-sliced, and interruptible

denext renders on a **fiber architecture**. The client reconciler builds the
next tree as resumable units of work over a double-buffered fiber tree and
commits it atomically. This section is precise about what that gives you and the
one gap that remains.

### Two lanes

- **Sync (default) lane** — urgent updates (`setState` outside a transition, the
  initial `render()`/`hydrateRoot()`, `flushSync`, `act`) render **and commit to
  completion synchronously**. Nothing about the timing your code observes has
  changed.
- **Transition lane** — updates inside `startTransition`/`useTransition`, and
  `useDeferredValue`, render on the **concurrent path** below.

### What the transition lane does

1. **Resumable work loop.** Rendering proceeds as discrete units of work over
   the fiber tree (`child`/`sibling`/`return`), so it can pause and resume at
   any node.
2. **Time-slicing.** The loop checks a ~5 ms frame budget between units and
   **yields via `MessageChannel`**, continuing on the next slice — so a heavy
   transition never blocks paint or input. `isPending` paints immediately and
   clears when the transition commits.
3. **Interrupt-and-restart.** A sync update that arrives while a transition is
   in flight **abandons** the transition's in-progress work, commits the urgent
   update immediately, and **restarts** the transition from the
   freshly-committed state (`useId` counters are snapshot/restored so the
   restart is deterministic).
4. **Double-buffering / atomic commit.** The next tree is built **off-DOM**
   (`current` + `workInProgress` buffers); an interrupted or discarded
   transition never shows partial DOM. The work-in-progress tree becomes
   `current` in a single swap at commit.
5. **Render / commit phase split.** `beginWork`/`completeWork` build the tree
   with no live-DOM mutation; a separate commit phase does deletions, prop
   updates, placement, the atomic swap, then effects — so a render can be
   dropped or restarted safely.

`useDeferredValue` trails the urgent render and coalesces rapid changes;
`useOptimistic` applies an optimistic value until the real update lands.

### Effect phases

Effects are split exactly as React splits them:

- **Layout phase (synchronous, before paint):** `useLayoutEffect`,
  `useInsertionEffect`, and class `componentDidMount`/`componentDidUpdate` run
  synchronously during commit, so DOM measurements and style injection see the
  committed tree with no flicker.
- **Passive phase (scheduled, after paint):** `useEffect` and
  `useSyncExternalStore` subscriptions run on a task scheduled after the commit.
  They are flushed before the next render and inside `flushSync`/`act`, so
  ordering is deterministic. (In tests, assert a `useEffect` side effect only
  after a `flushSync()` or `await act(...)` — the same requirement as React.)

### Concurrent rendering

denext implements React's concurrent-rendering model: a resumable fiber
work loop, time-slicing, priority lanes with interrupt-and-restart,
double-buffering with atomic commit, and the render/commit + layout/passive
phase split. The sync (default) lane still renders and commits synchronously, so
`render()`/`hydrateRoot()`/`flushSync()`/`act()` remain synchronous.
