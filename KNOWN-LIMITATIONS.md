# denext — Honest edges

denext reimplements React + Next.js on Deno with its own fiber reconciler, an
async-only SSR renderer, and **zero runtime npm dependencies**. It aims to do _more_
than the originals (islands, resumability, live components, a strict-CSP default) —
this file is the short, honest catalogue of where observable behavior differs and
which surfaces are still experimental. It is deliberately terse: when a limitation is
genuinely fixed, its entry is **deleted**, not annotated.

Most divergences are confined to the **next-compat interop path** (running real npm
React libraries); denext's own apps are unaffected. Operational responsibilities live
in [DEPLOYMENT.md](./DEPLOYMENT.md).

## React & Next.js divergences

- **Async `startTransition` scopes by a time _window_, not transition identity.** React
  uses a server-only async-context primitive to scope entanglement; the reconciler runs
  in the **browser**, where none exists yet (`AsyncLocalStorage` is server-only, TC39
  `AsyncContext` hasn't shipped). So while any async transition's promise is pending,
  updates are treated as transition-priority — an unrelated urgent update in that brief
  window is also deferred. Dev warns if a transition stays pending >10s (a never-settling
  `await`); it never force-settles.
- **`unstable_batchedUpdates(fn)` just calls `fn`.** denext already auto-batches (as React
  18+ does), so this legacy API is a no-op wrapper for import compatibility.
- **Legacy provider context** (`getChildContext`/`childContextTypes`) is unsupported on
  SSR; only `contextType` reaches parity.
- **Sync `react-dom/server` APIs throw.** The renderer is async, so `renderToString` /
  `renderToStaticMarkup` / `renderToPipeableStream` throw loudly (never a wrong render).
  Use `renderToReadableStream`. Libraries that SSR through the sync APIs at runtime (some
  `@emotion/server`, `react-pdf`, `@react-email`) are unsupported.
- **Pages Router is a plugin, not core.** App Router is built in; the full Next.js Pages
  Router ships as opt-in [`@denext/pages-router`](./packages/pages-router) — `getServerSideProps`
  / `getStaticProps` / `getStaticPaths` / `getInitialProps`, `_app`/`_document`, `pages/api/*`,
  and `useRouter` with events, shallow routing, `<Link>` prefetch, and i18n locale routing.
  The only divergence is that it's a plugin you add, not built into core.
- **`fetch()` is uncached by default** — matches Next 15/16 (both flipped to
  uncached-by-default). Opt in per call with `next: { revalidate, tags }` /
  `cache: "force-cache"`.
- **ICU message formatting is a compact subset.** Interpolation, `number`/`date`/`time`,
  `plural`/`selectordinal`/`select` (with `offset:`/`#`), nested submessages, and
  apostrophe escaping are supported; `spellout`/`duration` and full skeletons are not.
- **`next/og` renders satori's layout subset** — flexbox + inline `style` only (no
  `className`/CSS), synchronous components. Bundled Noto Sans covers Latin offline;
  non-Latin glyphs fetch fonts from Google at render time (pass your own `fonts` to stay
  offline — see the Security note).
- **Isomorphic soft-nav re-runs the route bundle** (no in-place Flight reconcile). A
  non-Flight route answers a soft nav with a compact JSON payload (`{title, data, entry,
  styles}`) and re-injects the entry, so its module is re-evaluated per nav. Give a route
  a `"use client"`/`"use server"` boundary to make it a Flight route (tree rebuilt from a
  registry, no re-eval).

## Next.js drop-in (next-compat pipeline)

An unmodified Next.js **App Router** project builds and runs on denext: `denext migrate`
writes a `deno.json`, then `denext build && denext start`. npm React libraries are
detected (or set `compatibilityMode`) and every `react`/`react-dom`/`next/*` import —
**including those inside npm packages** — is rewritten to denext's one React at bundle
time. The RSC/Flight boundary is preserved (async Server Components stay server-side;
only `"use client"` islands ship). Bounded edges:

- **Run `denext build`/`dev` from the project directory** — the boundary crawl resolves
  `@/…` aliases from the app's `deno.json` on the cwd; running elsewhere can misclassify a
  `@/`-imported `"use client"` route as static.
- **`deno check` uses `skipLibCheck: true`** (as Next/CRA do), so it validates your `.tsx`,
  not npm libraries' bundled `.d.ts`. Residual library type edges are type-only, never
  runtime.
- **`React.cache` is request-scoped during SSR** (one request's value never leaks to
  another); off-request it's a persistent per-function memo.
- **Class components are opt-in in the next-compat build** (`classComponents: true`), so a
  function-only project pays nothing for the class runtime; off, a class library throws a
  guided error at first render. The standard `deno bundle` path always includes it.

## SPA mode (`mode: "spa"`)

A client-only app (no `app/`). Deliberately not the App Router:

- **No SSR/SSG/Flight** — the server sends a shell with an empty root; the app renders on
  the client. Choose the App Router when you want server rendering.
- **Dev is live-reload, not Fast Refresh** — a source edit does a full reload; component
  state isn't preserved (a per-module SWC refresh for SPA mode isn't wired).
- **The entry mounts itself** (`createRoot(...).render(...)`, as in Vite); denext provides
  an empty `#root` and doesn't call back in.
- **One mode per project** — `mode: "spa"` turns off route scanning; you can't mix `app/`
  routes with it. For a mostly-server app with a few client screens, use the App Router
  with `"use client"` islands.
- **History-API fallback only** — every non-asset path gets the same shell; no per-path
  server response, redirect, or middleware.
- npm-React SPAs bundle through esbuild and need materialized `node_modules` + a
  workspace-consistent `deno.json`; framework codegen (e.g. TanStack's `routeTree.gen.ts`)
  runs out-of-band (esbuild doesn't run Vite plugins). See [SPA mode](./FEATURES.md).

## Islands & resumability (`client:*`, `resumable`, `qrl`)

Directive-based islands + resumability go beyond React/Next; the bounded gaps:

- **Flight route only.** Per-island carve-out lives on the Flight path; add a `"use client"`
  boundary (or `export const resumable = true`) to opt in. The isomorphic single-root path
  and SPA mode hydrate as one root.
- **`client:only` skips SSR** (no first paint / SEO for that subtree); **`client:media`**
  hydrates eagerly when `matchMedia` is unavailable.
- **Nested `client:*` islands hydrate with their parent** — a directive on an island nested
  inside another island is gated to eager (its own directive is ignored). Keep an island
  that must defer at a route's top level.
- **`qrl()` has no build transform yet** — `qrl(() => import("./h.ts"))` works at runtime,
  but you write the call yourself (no auto-wrapping pass). A plain `onClick` in `resumable`
  mode is resumed/replayed via the delegated dispatcher.

## Cache Components (`use cache` + PPR) — experimental

Enabled with `experimental: { cacheComponents: true }`. `use cache` compiles into
cross-request server caching; a cacheable page renders a cached static shell with dynamic
subtrees as per-request streamed holes (works on `"use client"`/Flight routes too). Off,
`use cache` is inert and the render path is byte-for-byte unchanged. Bounded scope:

- **Reading request data inside `use cache` throws** — `cookies()`/`headers()`/
  `connection()` are request-specific; read them outside and pass the value in.
- **A streamed hole can't emit an inline `<style>`/`<script>`** — the head (with its CSP
  hashes) is already flushed; the drainer dev-warns if a hole's HTML contains one. A
  streamed route isn't ISR page-cached, and in-boundary `<title>`/`<meta>` that resolves
  after the head flush stays inline rather than hoisting.
- **`searchParams` read outside a Suspense boundary** with `cacheKeyParams` set can reflect
  one request's value — keep such reads inside a hole, or don't narrow the key.

## DevTools (dev-only)

The stock **React DevTools** extension shows denext's **Components tree + read-only props**
(honest dev/prod build type); it can't do hooks/state, context, or the Profiler through
denext's reconciler internals. denext ships its **own** in-page panel (`denext/devtools`,
Ctrl+Shift+D) that covers the rest — hooks/state with **live `useState` editing**, context,
**Profiler**, **prop overrides**, **source links / owner stacks**, and a render-mode tab
(static/dynamic/streamed + page-cache HIT/STALE/MISS + island hydration waterfall). One
remaining depth item: the per-Suspense-boundary timeline is emitted as an **end-of-stream**
island, not real-time per-boundary marks. `denext dev` also has a standalone error overlay.

## Experimental / unstable APIs

Implemented for compatibility but tracking still-unstable upstream surfaces, so they may
change: `unstable_cache` (still `unstable_` in Next 16), `unstable_batchedUpdates` (legacy
no-op), `useMemoCache`/`c` (React Compiler runtime — the compiler hit 1.0 stable, this is
an internal helper). **Not implemented by design:** React `taint*`, `Activity`,
`ViewTransition`; Next `dynamicIO`/`taint`.

## Security posture — accepted trade-offs

Every High/Medium from the 1.0 audit is fixed; these are deliberate **safe defaults** with
a one-line opt-in, not surprises. Full operational checklist in
[DEPLOYMENT.md](./DEPLOYMENT.md).

- **Strict CSP by default** blocks external `<script>`/stylesheet/`<img>` until opted in
  per route. Configure globally with `csp: "strict" | "off" | {…}`; a route's `csp` export
  overrides. Applies to buffered **and** streamed/PPR responses.
- **HSTS is host-only by default** (`max-age=31536000`, no `includeSubDomains`/`preload`) so
  it can't brick non-HTTPS sibling subdomains. Strengthen via `hsts`, or `hsts: false`.
- **Session cookie isn't `__Host-`-locked by default** (would rename the cookie and log
  everyone out on upgrade). Opt in with `hostPrefix: true` on `getSession`.
- **Graceful shutdown drains up to a deadline** (default 10s; `DENEXT_SHUTDOWN_DRAIN_MS`,
  `0` = wait forever), then force-exits so a stuck client can't pin the process — plugin
  teardown is skipped on a forced exit.
- **Scaffolded `dev`/`build` tasks use `-A`** (they compile/spawn tooling); the generated
  `start` task runs least-privilege. Tighten `dev`/`build` for locked-down CI if needed.
- **`@denext/og` egresses non-Latin text to `fonts.googleapis.com`** to fetch the matching
  font — supply a local `fonts` option to render fully offline.
- **The public-env island ships only _referenced_ prefixed vars.** A key read via a computed
  expression can't be detected — force-include it via `publicEnv: [...]`. Never give a
  secret a public prefix.

## Post-2.0 (deferred, not gaps)

Deliberately deferred past the 2.0 DX release — large, low-marginal-value, or gated on
out-of-band infra (a WASM toolchain / a JSR publish). None affects the zero-npm **runtime**
guarantee. Tracked in [ROADMAP.md](./ROADMAP.md):

- **Build-time deps → first-party JSR/WASM.** `lightningcss`/`swc`/`esbuild` are build-time
  only (never shipped; enforced by `no-npm-compat-guard`); repackaging as `@denext/*`
  JSR/WASM is publish-gated.
- **Migration: Remix** (`denext migrate` handles Next/Vite/CRA/generic today).
- **Dev loop:** per-module granular HMR and source-mapped client-bundle stack frames (SSR
  frames already resolve).
- **DevTools:** real-time per-boundary marks (today end-of-stream) and the Flight-shell
  timeline variant.
- **Scaffolding:** a filesystem `templates/` tree + remote/community templates.
- **Desktop packaging beyond macOS** (Linux/Windows; `denext desktop run` is cross-OS).
