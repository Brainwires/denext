# denext — Honest edges

denext's promise is the **React/Next.js surface**: public APIs exist and behave
correctly for correct usage. This file lists only the places that promise doesn't
fully hold — a genuine **surface gap** (an API missing, throwing, or behaving
observably wrong) — plus the **bounded scope** of denext's own still-growing
features (islands, resumability, Cache Components). It is deliberately terse; a fixed
entry is deleted, not annotated.

Internal differences that **don't** break the surface — denext's own reconciler, its
async SSR renderer, the two-mechanism soft-nav, request-scoped `React.cache`,
Pages-Router-as-a-plugin, the next-compat build defaults — are **design choices, not
limitations**, and live in [ARCHITECTURE.md](./ARCHITECTURE.md). Operational defaults
live in [DEPLOYMENT.md](./DEPLOYMENT.md).

## React / Next.js surface gaps

Where the compat surface genuinely differs from React/Next (mostly on the next-compat
interop path — denext's own apps are unaffected):

- **Sync `react-dom/server` APIs throw.** denext's renderer is async by design (see
  [ARCHITECTURE.md](./ARCHITECTURE.md)), so `renderToString` / `renderToStaticMarkup` /
  `renderToPipeableStream` throw loudly (never a wrong render). Use
  `renderToReadableStream`. Libraries that SSR through the sync APIs at runtime (some
  `@emotion/server`, `react-pdf`, `@react-email`) are unsupported.
- **Legacy provider context** (`getChildContext` / `childContextTypes`) is unsupported
  on SSR; only `contextType` reaches parity. (Legacy React context, pre-`createContext`.)
- **ICU message formatting is a compact subset.** Interpolation, `number`/`date`/`time`,
  `plural`/`selectordinal`/`select` (with `offset:`/`#`), nested submessages, and
  apostrophe escaping are supported; `spellout`/`duration` and full skeletons are not.
- **`next/og` renders satori's layout subset** — flexbox + inline `style` only (no
  `className`/CSS), synchronous components. Bundled Noto Sans covers Latin offline;
  non-Latin glyphs fetch fonts from Google at render time (pass your own `fonts` to stay
  offline — see the Security note below).
- **Async `startTransition` scopes by a time _window_, not transition identity** — a
  **browser-platform** constraint, not a denext choice: React scopes entanglement with a
  server-only async-context primitive that browsers don't have yet (`AsyncLocalStorage`
  is server-only; TC39 `AsyncContext` hasn't shipped). While any async transition's
  promise is pending, updates are treated as transition-priority, so an unrelated urgent
  update in that brief window is also deferred. Removable once browsers ship
  `AsyncContext`. Dev warns on a transition pending >10s.

## Experimental denext features — bounded scope

These are **capabilities React/Next don't have** ([FEATURES.md](./FEATURES.md)); the
scope below is where they're still growing, not a regression from React.

### Islands & resumability (`client:*`, `resumable`, `qrl`)

- **Flight route only.** Per-island carve-out lives on the Flight path; add a
  `"use client"` boundary (or `export const resumable = true`) to opt in. The isomorphic
  single-root path and SPA mode hydrate as one root.
- **`client:only` skips SSR** (no first paint / SEO for that subtree); **`client:media`**
  hydrates eagerly when `matchMedia` is unavailable.

### Cache Components (`use cache` + PPR) — experimental

Enabled with `experimental: { cacheComponents: true }`; off, `use cache` is inert and
the render path is byte-for-byte unchanged.

- **Reading request data inside `use cache` throws** — `cookies()`/`headers()`/
  `connection()` are request-specific; read them outside and pass the value in.
- **A streamed hole can't emit an inline `<style>`/`<script>`** — the head (with its CSP
  hashes) is already flushed; the drainer dev-warns if a hole's HTML contains one. A
  streamed route isn't ISR page-cached, and in-boundary `<title>`/`<meta>` that resolves
  after the head flush stays inline rather than hoisting.
- **`searchParams` read outside a Suspense boundary** with `cacheKeyParams` set can
  reflect one request's value — keep such reads inside a hole, or don't narrow the key.

### SPA mode (`mode: "spa"`)

- **Dev is live-reload, not Fast Refresh** — a source edit in SPA mode does a full reload
  (component state isn't preserved); a per-module refresh transform for SPA mode isn't
  wired yet. (The App Router entry _does_ get state-preserving Fast Refresh.)

## DevTools (dev-only)

The stock **React DevTools** extension shows denext's Components tree + read-only props
(and an honest dev/prod build type); it can't drive hooks/state, context, or the
Profiler through denext's reconciler internals. denext ships its **own** in-page panel
(`denext/devtools`, Ctrl+Shift+D) that covers the rest — hooks/state with live `useState`
editing, context, Profiler, prop overrides, source links / owner stacks, and a
render-mode tab (static/dynamic/streamed + page-cache HIT/STALE/MISS + island hydration
waterfall). One residual: the per-Suspense-boundary timeline is emitted **end-of-stream**,
not as real-time per-boundary marks.

## Experimental / unstable APIs

Implemented for compatibility but tracking still-unstable upstream surfaces, so they may
change: `unstable_cache` (still `unstable_` in Next 16), `unstable_batchedUpdates` (a
no-op — see [ARCHITECTURE.md](./ARCHITECTURE.md)), `useMemoCache`/`c` (React Compiler
runtime — the compiler hit 1.0 stable; this is an internal helper). **Not implemented by
design:** React `taint*`, `Activity`, `ViewTransition`; Next `dynamicIO`/`taint`.

## Security posture — accepted trade-offs

These are deliberate **safe defaults**, each with a one-line opt-in — documented, not
surprises. Full checklist in [DEPLOYMENT.md](./DEPLOYMENT.md).

- **Strict CSP by default** blocks external `<script>`/stylesheet/`<img>` until opted in
  per route (`csp: "strict" | "off" | {…}`; a route's `csp` export overrides). Applies to
  buffered **and** streamed/PPR responses.
- **HSTS is host-only by default** (no `includeSubDomains`/`preload`) so it can't brick
  non-HTTPS sibling subdomains. Strengthen via `hsts`, or `hsts: false`.
- **Session cookie isn't `__Host-`-locked by default** (would log everyone out on
  upgrade). Opt in with `hostPrefix: true` on `getSession`.
- **Graceful shutdown drains up to a deadline** (default 10s; `DENEXT_SHUTDOWN_DRAIN_MS`),
  then force-exits so a stuck client can't pin the process (plugin teardown is skipped on
  a forced exit).
- **Scaffolded `dev`/`build` tasks use `-A`** (they compile/spawn tooling); the generated
  `start` task runs least-privilege.
- **`@denext/og` egresses non-Latin text to `fonts.googleapis.com`** to fetch the matching
  font — supply a local `fonts` option to render fully offline.
- **The public-env island ships only _referenced_ prefixed vars.** A key read via a
  computed expression can't be detected — force-include it via `publicEnv: [...]`. Never
  give a secret a public prefix.

## Not yet available

A few capabilities aren't built yet (none affects the zero-npm runtime):

- **Remix migration** — `denext migrate` handles Next.js, Vite, CRA, and generic React
  SPAs today; a Remix source path is not yet supported.
- **Per-module granular HMR** and source-mapped client-bundle stack frames in dev (a dev
  refresh re-imports the whole route entry, and SSR stack frames already resolve to
  source; client frames don't yet).
- **Real-time per-boundary DevTools timing** — today the streamed-boundary timeline is
  emitted end-of-stream, not as live per-boundary marks.
- **Desktop packaging beyond macOS** — `denext desktop package` builds a macOS bundle
  today; `denext desktop run` works on any OS.
