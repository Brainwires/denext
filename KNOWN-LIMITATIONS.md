# denext — Honest edges

denext's promise is the **React/Next.js surface**: public APIs exist and behave
correctly for correct usage. This file lists only the places that promise doesn't
fully hold — a genuine **surface gap** (an API missing, throwing, or behaving
observably wrong) — plus the **bounded scope** of denext's own capabilities (islands,
resumability, Live, SPA mode) and the one that is still genuinely experimental (Cache
Components). It is deliberately terse; a fixed entry is deleted, not annotated.

Internal differences that **don't** break the surface — denext's own reconciler, its
async SSR renderer, the two-mechanism soft-nav, request-scoped `React.cache`,
Pages-Router-as-a-plugin, the next-compat build defaults — are **design choices, not
limitations**, and live in [ARCHITECTURE.md](./ARCHITECTURE.md). Operational defaults
live in [DEPLOYMENT.md](./DEPLOYMENT.md).

## React / Next.js surface gaps

Where the compat surface genuinely differs from React/Next (mostly on the next-compat
interop path — denext's own apps are unaffected):

- **The Node-stream `react-dom/server` APIs buffer (no `Writable` backpressure).**
  `renderToString` / `renderToStaticMarkup` render the **synchronously-renderable** subset
  (a `<Suspense>` whose children suspend renders its fallback, exactly as React's
  `renderToString` does); a genuinely async Server Component outside a boundary throws a
  guided error pointing at `renderToReadableStream`. The **Node-stream** APIs —
  `renderToPipeableStream` / `renderToStaticNodeStream` — now work via a thin `node:stream`
  adapter over the Web renderer (for npm libraries that hard-code them), but they **buffer
  the document in memory** rather than applying `Writable` backpressure, and
  `onShellReady` fires when the stream is available (≈ first chunk), not on a distinct
  React shell-flush event. denext's own apps should use `renderToReadableStream`.
- **Legacy provider context** (`childContextTypes` / `getChildContext`) is an
  **intentional non-goal** — React deprecated this pre-`createContext` API, so denext
  won't chase it. Modern class context (`static contextType`) reaches parity; migrate
  providers to `createContext`.
- **`next/og` renders satori's layout subset** — flexbox + inline `style` (plus Tailwind
  via the `tw` prop); arbitrary `className`/CSS isn't resolved (satori ignores it). Async
  components are supported. Bundled Noto Sans covers Latin offline; non-Latin glyphs fetch
  fonts from Google at render time unless you pass your own `fonts` or set `offline: true`
  (which errors instead of fetching — see the Security note below).
- **Async `startTransition` scopes by a time _window_ by default; opt into identity
  scoping with `experimental.asyncContext`.** React scopes async-transition entanglement
  with an async-context primitive browsers haven't shipped (`AsyncLocalStorage` is
  server-only; TC39 `AsyncContext` is still a proposal). By default denext uses a time
  window: while any async transition's promise is pending, updates are treated as
  transition-priority — **except** an update enqueued in a DOM event handler (a click/
  keydown/input), which stays urgent (React's discrete-event priority), so a user
  interaction is never demoted by the window. What remains coarse is an unrelated
  urgent update raised _outside_ any event handler (e.g. from an unrelated timer) while
  the window is open. Rather than wait on the platform, denext ships its own first-party
  `AsyncContext` plus a build transform that makes it survive `await`; enable
  `experimental: { asyncContext: true }` and priority is scoped by transition **identity**
  — a post-`await` update stays a transition, an unrelated urgent update in the window
  keeps its priority. The transform instruments every `await` in client code (a small
  per-`await` cost), so it is opt-in; it now also instruments async generators (`await`
  and `yield`, with the frame captured at the first `.next()`), except those using
  `yield*` delegation, which are left un-instrumented — as is top-level `await`. Dev
  warns on a transition pending >10s either way.

## denext-original features — bounded scope

These are **capabilities React/Next don't have** ([FEATURES.md](./FEATURES.md)). They're
shipped and on by default in their contexts; the notes below are their **documented
boundaries**, not a regression from React and not an "experimental" caveat — being a
denext original is not the same as being incomplete. (The one still-experimental
feature, Cache Components, is called out as such at the end.)

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

## DevTools (dev-only)

denext ships its **own** in-page glass-box panel (`denext/devtools`, Ctrl+Shift+D) as the
full-fidelity surface: a searchable, collapsible component tree; an element picker with a
hover-highlight overlay; live-editable hooks/state (plus ref-set and reducer-dispatch);
prop overrides; deep, lazy nested-value inspection with copy / `console.log` / store-as-`$d`
actions; capability badges; "why did this render" diffs; a per-commit **Profiler** with a
flamegraph + commit step-through; source links / owner stacks; and a render-mode tab
(static/dynamic/streamed + page-cache HIT/STALE/MISS + a **real-time** Suspense-boundary
waterfall + island hydration).

The stock **React DevTools** extension also works — Components tree, props, live prop/state
editing, and element selection all route back through denext's reconciler (with an honest
dev/prod build type). Two residuals are inherent to driving a non-React reconciler through
the extension: its **hooks view** and its **Profiler** rely on React-internal introspection
a synthetic fiber tree can't provide — use denext's own panel for those. The panel's "owner
stack" is the render-parent chain, an approximation of React's JSX-owner stack (they
coincide for the common case).

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
- **`@denext/og` fetches a missing non-Latin font from `fonts.googleapis.com`** at render
  time — supply a local `fonts` option, or set `offline: true` on the `ImageResponse` to
  refuse the fetch (it raises a clear error instead of egressing).
- **The public-env island ships only _referenced_ prefixed vars.** A key read via a
  computed expression can't be detected — force-include it via `publicEnv: [...]`. Never
  give a secret a public prefix.

## Not yet available

A few capabilities aren't built yet (none affects the zero-npm runtime):

- **Remix migration** — `denext migrate` handles Next.js, Vite, CRA, and generic React
  SPAs today; a Remix source path is not yet supported.
- **Per-module granular HMR** — a dev refresh re-imports the whole route entry (fast, and
  hook state is preserved) rather than swapping a single module through an accept boundary.
  (Client-bundle stack frames already resolve to source: dev bundles ship inline source
  maps.)
- **Desktop packaging on Windows** — `denext desktop package` builds **macOS** (`.app`,
  signed/notarized) and **Linux** (bundle → `.tar.gz`, plus AppImage when `appimagetool`
  is present) bundles; Linux cross-builds from any OS (`--target-os linux`). Windows
  packaging isn't wired yet (`deno desktop` supports the target; the installer/signing
  seam is still to come). `denext desktop run` works on any OS. The target Linux desktop
  needs a WebKitGTK (`webkit2gtk`) runtime for the window.
