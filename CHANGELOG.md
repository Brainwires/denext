# Changelog

All notable changes to **denext** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-08-23

macOS desktop packaging becomes first-class, and a production-readiness / security /
documentation audit of everything since 1.0.2 lands its fixes: a Live-socket
authorization tightening, single-flight for `useLive` data, and a batch of
build-pipeline and resource-cleanup hardening.

### Added

- **macOS desktop packaging.** Scaffolding the desktop target now emits
  `scripts/package-macos.ts` and points `deno task desktop:package` at it. It builds
  `--arch host|arm64|x86_64|both|universal` (cross-compiling and `lipo`-merging for a
  universal bundle), ad-hoc signs by default, and — when `DENEXT_CODESIGN_IDENTITY`
  is a Developer ID identity — signs inside-out with the Hardened Runtime + a secure
  timestamp; with `DENEXT_NOTARY_PROFILE` also set it notarizes and staples. Optional
  `--dmg`. New "Desktop apps (macOS)" docs page. (The old bare `desktop:package` task
  also omitted `--include out`, so packaged binaries shipped without their static
  assets — fixed here.)
- **`react-dom/client` namespace default export.** `import ReactDOM from
  "react-dom/client"; ReactDOM.createRoot(…)` (esModuleInterop / CJS-interop code)
  now bundles, matching the default exports already on the `react`/`react-dom` shims.

### Fixed

- **Scaffolded `deno desktop` entry quits on window close.** The generated
  `desktop.ts` was `Deno.serve(...)`-only; since that task is permanently live,
  closing the window (red button / ⌘W) did nothing. The entry now adopts the window
  via `Deno.BrowserWindow` and `Deno.exit(0)`s on its `close` event.
- **Tailwind input aliased to the compiled output.** An app that imports the Tailwind
  input file it authored (`import "./index.css"`) previously produced an unstyled
  build; the input is now aliased to the compiled output so importing either yields
  the same linked stylesheet.
- **`useLive` data recomputes are single-flighted** (per subscription), so a burst of
  tag invalidations can no longer race the async fetcher and push out-of-order `data`
  frames — the last frame always reflects the latest state (mirrors the `<Live>`
  boundary's existing `busy`/`dirty` guard).
- **SPA build/dev pipeline hardening:** `denext build` no longer leaves a half-written
  staging dir behind on a failed build; `export` surfaces a real `public/` copy error
  instead of silently shipping missing assets; the dev watcher ignores events under
  the output dir / `node_modules` / `.git` (stops a self-triggered rebuild loop when
  the entry sits at the project root); the esbuild service is kept warm across dev
  rebuilds and torn down once on shutdown; and a dev-server races that could deref a
  pruned build dir is closed.
- **Auth robustness:** `denextAuth` fails fast at config time when an OAuth provider's
  `clientId`/`clientSecret` is empty (a missing env var previously POSTed the literal
  `"undefined"` and failed every login opaquely), and a misconfigured provider now
  degrades the sign-in _initiation_ to the sign-in page with `?error=config` instead
  of a raw 500 (matching the callback path).
- **Resource cleanup:** the Live hub clears its coalesce timer + pending tags on
  teardown (no dangling timer on the test path); a wake-lock claim is rolled back if
  its sentinel fails to acquire (no phantom "screen held"); and macOS packaging always
  removes its per-arch temp bundles and the notarization zip, even on error paths
  (plus a `plutil` exit-code check so the main executable can't be signed twice).

### Security

- **`experimental.live.allowAnonymous` no longer opens arbitrary data over the Live
  socket.** It gates presence-room joins; `useLive` data subscriptions still require
  the per-action `liveReadable(...)` opt-in (or a `canSubscribe` hook). Previously,
  enabling anonymous presence also admitted a `data-subscribe` to _any_ registered
  action — including mutations, which a data subscription re-runs on every tag
  invalidation — defeating the `liveReadable` guard. Unmarked actions are now a
  `no-policy` refusal even under `allowAnonymous`.
- **`spa.head` gets the dev-only raw-HTML injection warning** that `metadata.head`
  already emits, flagging it as an untrusted-input sink.

## [1.2.0] - 2026-08-23

Run your existing React SPA on denext: a first-class `mode: "spa"`, the next-compat
pipeline that resolves an npm library's `import "react"` to denext's single React,
and a set of React-fidelity reconciler fixes that make heavy component libraries
(Base UI, Radix, floating-ui, `@effect/atom`) render correctly.

### Added

- **SPA mode (`mode: "spa"`) — host a client-only React app ("React but not
  Next").** Set `mode: "spa"` with a `spa.entry` in `denext.config.ts` and denext
  bundles that single client entry, wraps it in an HTML shell, and serves the shell
  for every navigation (history-API fallback) — no `app/` directory, no SSR/Flight.
  `dev` (live reload), `build`, `export`, and `start` all support it; `export`
  emits a static `out/` that `deno desktop` packages unchanged. Bring your own
  router (TanStack, etc.) and data layer — denext only bundles and mounts. The CSS
  pipeline/Tailwind and the next-compat react→denext aliases apply, so an existing
  Vite-style React SPA runs on denext's small, zero-npm runtime. New
  `examples/spa` (with a `bench.ts` bundle-size comparison vs React+ReactDOM) and a
  docs page. `SpaConfig` is exported from `denext/server`.
- **SPA mode runs npm-React apps on denext's single React (next-compat path).**
  When the app uses npm React (`node_modules/react`, or `nextCompat: true`), SPA
  mode bundles through the next-compat esbuild rewrite so an npm library's own
  `import "react"` also resolves to denext's React — the "two Reacts" fix a plain
  `deno bundle` cannot do. This is what lets an existing Vite-style React SPA (Radix,
  TanStack Router, etc.) run on denext's runtime. A denext-native SPA keeps the fast
  plain-`deno bundle` path.
- **`import.meta.env` for SPA mode** (the Vite `define` analogue): the built-ins
  `MODE`/`DEV`/`PROD`/`SSR`/`BASE_URL` are injected with correct types (`DEV`/`PROD`
  are real booleans — `dev` on `denext dev`, production on `build`), and `spa.env`
  `{ KEY: "value" }` adds/overrides string values. Substituted at build time on the
  next-compat path.
- **Vite-style asset imports on the SPA compat path**: `?url` (emit a file, import
  its URL), `?worker` (bundle the module + `new Worker(url)`), `?raw` (text),
  `?inline` (data URL), bare `.wasm`/`.woff2`/image imports, and `new URL(…,
  import.meta.url)` — all emitted under `/_denext/client/assets/` and served by the
  SPA server / copied by `export`. New esbuild `assets` option on
  `bundleNextCompatModules` (`publicPath`/`assetNames`/`loaders`).
- **pnpm `catalog:` / `workspace:*` support on the SPA compat path.** The esbuild
  deno-loader's resolver can't parse those version protocols (the real version lives
  in `pnpm-workspace.yaml`), so denext now front-runs it: packages whose
  `package.json` version is `catalog:`/`workspace:*` (and their whole transitive
  subtree) are resolved straight from `node_modules` via a Node-style importer-relative
  walk that realpaths through pnpm's symlinks — honoring each package's `exports`
  map. Auto-detected from `package.json`; only active for such apps. This is what lets
  a real pnpm-workspace Vite app (e.g. an Effect + TanStack monorepo) build on denext.
- **Opt-in Content-Security-Policy for SPA mode (`spa.csp`).** A client-only React
  SPA (Vite/CRA and denext alike) ships no CSP by default, so this is opt-in:
  `spa.csp: "strict"` emits denext's strict policy (`default-src 'self'`,
  `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `style-src-attr
  'unsafe-inline'` so React `style={{}}` keeps working) as a `<meta http-equiv>` in
  the generated shell — so it applies for `export` (any static host), `start`, and
  `dev`. Pass a `{ connectSrc: [...] }`-style object to add global opt-ins (your API
  host, etc.). `frame-ancestors` is header-only (ignored in `<meta>`); the always-on
  `X-Frame-Options: SAMEORIGIN` covers clickjacking.

### Changed

- **Bundled Tailwind standalone bumped `v4.1.11` → `v4.3.0`.** 4.1.11 predates the
  logical inset shorthands `inset-s-*` / `inset-e-*` (`inset-inline-start/end`), so a
  class like `inset-e-2.5` compiled to nothing and an element relying on it fell back
  to its static position — e.g. an `absolute inset-e-2.5` "Add" button landing on top
  of a left-aligned control instead of pinned to the right. Real Tailwind 4.3.0 (what
  Vite-built apps use) emits these utilities; matching it keeps denext a faithful
  drop-in. Override still available via `DENEXT_TAILWIND_VERSION`.

### Fixed

- **Inline styles are patched per-property instead of by rewriting the whole `style`
  attribute — foreign inline properties now survive re-renders.** denext replaced the
  entire `style` attribute on every commit, which erased CSS custom properties set
  imperatively on the element from outside the render. floating-ui (used by Base UI /
  Radix popovers, menus, tooltips) writes `--available-width` / `--available-height` /
  `--anchor-width` / `--transform-origin` directly onto the positioned element and
  relies — as with react-dom — on the renderer never clobbering them. Wiping them each
  commit changed the popup's size (`max-height: var(--available-height)`), which fired
  floating-ui's `ResizeObserver`, which repositioned and re-rendered — an infinite
  reposition loop that made a dropdown/menu flicker and dismiss itself. denext now
  diffs the style object against the previous one and touches only the keys it manages
  (`element.style.setProperty` / `removeProperty`), leaving foreign inline properties
  intact — matching react-dom, so positioning settles.
- **An unkeyed top-level Fragment returned by a component is now transparent
  (React's `isUnkeyedTopLevelFragment`), so a keyed child inside it survives a change
  in the surrounding structure.** denext kept the returned fragment as its own fiber,
  so when a component conditionally wrapped a keyed element in extra siblings the new
  unkeyed fragment could not match the previous keyed one and the whole subtree — the
  keyed element's DOM node — was remounted. This broke every Base UI floating
  component (menu, select, popover, tooltip): `MenuTrigger` wraps its `<button>` in
  `<Fragment key={triggerId}>` and, when open, returns that keyed wrapper alongside
  focus guards inside an outer unkeyed fragment (its comment: "a fragment with key is
  required to ensure the element is mounted to the same DOM node regardless of whether
  the focus guards are rendered") — so opening a menu remounted the trigger, detaching
  the node floating-ui uses as its positioning anchor; the popup then measured a zero
  rect and stayed at `opacity: 0`, unpositioned (open in state, but invisible). denext
  now reconciles a plain unkeyed fragment's children directly, matching react-dom.
  Marker-carrying fragments (context Providers, StrictMode, SuspenseList, Profiler)
  keep their own fiber, so their behavior is unaffected.
- **SVG (and MathML) elements are now created in their own namespace, so icons
  render.** The client reconciler created every element with `createElement` (HTML
  namespace), so an `<svg>` and its `<path>`/`<circle>`/… children occupied layout
  space but drew nothing — the classic "an icon shifts the text but is invisible"
  (all lucide-react / Radix / Base UI icons in a client-rendered app). Elements in an
  `<svg>`/`<math>` subtree are now created with `createElementNS` (a `<foreignObject>`
  switches its children back to HTML), and React's camelCase SVG presentation
  attributes (`strokeWidth` → `stroke-width`, `strokeLinecap` → `stroke-linecap`, …)
  are converted to the hyphenated names SVG expects (structural attributes like
  `viewBox` are kept as-is), so icons render at the correct weight.
- **A deferred passive effect (`useEffect`) scheduled during a multi-render commit
  cycle could be stranded and never run.** `renderRoot` flushes to completion in a
  render+commit loop; it flushed pending passive effects only once before the loop, so
  an effect scheduled and committed in one iteration could have its fiber's
  `passiveEffects` cleared by a later iteration's `createWorkInProgress` (buffer reuse)
  before the deferred flush ran it. Passive effects are now flushed before **each**
  iteration, matching React (which flushes them before any new unit of work). This
  manifested as a Base UI dialog that opened correctly but **never unmounted on close**
  (its root's unmount-watcher `useEffect` was the stranded effect), so it stayed
  invisibly mounted and could not be reopened.
- **React-fidelity reconciler fixes — real, unmodified npm-React libraries now
  render on denext's own React.** These land together and are what let heavy
  component libraries (Base UI, Radix, floating-ui, `@effect/atom`, React-Compiler
  output) work:
  - **`useState`/`useReducer` return a referentially stable setter/dispatch** across
    renders (React's guarantee). A fresh closure each render re-fired effects that
    depend on the setter and, when such an effect writes back through it (Base UI's
    label/id registration), looped until the update-depth guard tripped.
  - **Render-phase state updates converge locally** (the "adjust state while
    rendering" idiom — Base UI's transition status, `usePrevious`-style prop
    adjustments): denext now re-invokes just that component to convergence, as React
    does, instead of scheduling a whole-tree commit that never settles.
  - **Unkeyed children are matched by type bucket, not a consuming cursor**, so
    inserting a node at the front of an unkeyed list no longer remounts the siblings
    after it (lost DOM state, re-run effects).
  - **Legacy class `contextType` consumers no longer go stale** under the new
    context-aware bailout: a class reads context via `this.context` (not the
    `useContext` dispatcher), so it was invisible to the consumer-only re-render pass
    and missed a provider value change when a memoized non-consumer ancestor bailed
    the subtree. Class reads are now recorded like `useContext` reads.
- **Reflected XSS in the `next-compat` page emitter** (`renderNextCompatPage`, a
  `./build/next-compat` public export): URL-derived props were embedded in an inline
  `<script>` with an unescaped `JSON.stringify`, so a `</script>` in a param value
  could break out. Now escaped (`<`), matching the document shell.

- **`useSyncExternalStore`: a subscription scheduled by a render that was superseded
  before its (deferred) passive-effect commit could be lost, so the store never
  notified that consumer.** The subscribe effect is keyed on `cell.deps`; denext marked
  that key satisfied during render, but the hook cell is shared across a fiber's two
  buffers, so if the mount render was superseded by a re-render before its passive
  effect ran (a component that re-renders as its subtree mounts, under StrictMode /
  an interrupted transition), the committed re-render saw `depsChanged === false` and
  never re-queued the subscribe. The consumer then silently stopped re-rendering on
  store changes. Concretely: a Base UI dialog opened at its enter start-frame
  (`data-starting-style`, `opacity: 0`) and never advanced, because its popup/viewport
  (which re-render as their contents mount) never subscribed to the transition-status
  store while a leaf sibling backdrop did. Fixed by marking `cell.deps` only when the
  subscription actually commits, and by scheduling store updates against the live
  fiber buffer (`cell.owner`) rather than the render-time fiber.
- **Client events now expose `event.nativeEvent`** (a self-reference to the DOM
  event, as React's `SyntheticEvent.nativeEvent` is). Libraries that read it or gate
  on `"nativeEvent" in event` (Base UI / floating-ui-react: `getTarget(event.nativeEvent)`,
  `"composedPath" in event.nativeEvent`) previously got `undefined` and threw on hover.
- **`useSyncExternalStore`: a throwing `getSnapshot` in the subscribe callback tore
  down the tree.** When a store's `getSnapshot` throws (e.g. `@effect/atom-react`'s
  `useAtomValue`, which asserts on a value transiently absent mid-notify), denext let
  the throw escape the store's notify callback — where no error boundary can catch it —
  and the root was removed (blank screen). Now, exactly as React's `checkIfSnapshotChanged`
  does, a throwing snapshot check is treated as "changed" and forces a re-render, so the
  throw (if it recurs) surfaces during render where an error boundary catches it — and
  usually the store has settled by the scheduled microtask, so it doesn't recur.
- **Portal commit evicted foreign siblings from a shared container.** Committing a portal
  into a container the reconciler doesn't exclusively own (`document.body`, which also
  holds `#root`, the entry `<script>`, and other portals) count-pruned the container to
  the portal's children — removing those foreign nodes (a body-level Base UI toast/tooltip
  would blank the app by evicting `#root`). Portals now place only their own nodes (new
  `placePortalChildren`); sibling nodes the reconciler didn't insert are never pruned, as
  in React.
- **CSS was not extracted for apps whose `deno.json` anchors resolution**
  (`nodeModulesDir` / `npm:` imports — e.g. a converted Next/Vite app). `buildAppCss`
  mirrors the css→shim redirect into the app config so the module loader resolves
  `.css`, but the CSS graph crawl (`discoverCssFiles` via `deno info`) then
  auto-discovered that same config and resolved every `.css` to its empty shim →
  found zero stylesheets → emitted none. The crawl now temporarily strips the
  css→shim redirects from the app's own `deno.json` (restoring it afterward; every
  build re-mirrors them), so `deno info` reports the real `.css`.
- **Import-map prefix mappings lost their trailing slash** when absolutized to
  file URLs (`"~/": "./src/"` → `…/src` instead of `…/src/`), breaking subpath
  resolution and, in a merged module config, tripping Deno's "package address must
  end with /" error. Fixed in the bundle, CSS, and module-config absolutizers.
- **`loadDenextConfig` silently dropped `nextCompat` and `classComponents`**, so
  the explicit `nextCompat: true` override never reached `detectNextCompat` (both
  the App Router and SPA mode relied on `node_modules/react` detection instead).
  All `denext.config` fields now carry through.

### Changed

- **Isomorphic soft navigation now transfers a compact JSON payload instead of
  the full HTML document.** A soft nav (`x-denext-nav`) to an interactive route
  that has no Flight boundary previously answered with the entire server-rendered
  HTML document — whose `<body>` the client immediately discarded, since the
  re-run route bundle rebuilds the DOM from its own tree. The server now answers
  such a nav with `{title, data, entry, styles}` (header `x-denext-iso: 1`, the
  isomorphic analogue of the Flight-nav JSON path), and the client applies the
  title, the `#__denext_data` island, and — newly — swaps the **per-route
  stylesheets** before re-injecting the entry. This trims each isomorphic soft
  nav to the bytes it actually uses and fixes a latent bug where per-route CSS was
  never swapped on navigation. Hard requests still return the full HTML document.

### Performance

- **Context-aware memo bailout — a provider value change re-renders only the
  components that actually read that context**, letting a memoized non-consumer
  ancestor between the provider and a consumer bail its subtree (mirrors React's
  `propagateContextChange`). Previously any context value change forced the whole
  subtree below the provider to re-render. A stable-value provider still costs
  nothing.

## [1.1.0] - 2026-08-21

### Added

- **Resumability — `export const resumable = true`** (resumability, the
  automatic mode). Opt a route into resumable rendering and it is interactive
  with **no up-front hydration** — and **plain components work unchanged**
  (`useState` + `onClick`, no `qrl`, no `client:*` directive needed). Each
  island's wake-up moment is chosen automatically from what it does: a
  handler-only island waits for the first interaction (then the triggering event
  is replayed to the just-resumed handler), and an island that runs an effect (a
  clock, a subscription) hydrates on idle so it runs without a click — no
  annotation required. The first interaction resumes only the touched island;
  `useSignal` state is adopted rather than recomputed. Under the hood the server
  carves each island into a foreign `<dnx-island>` the page root never executes,
  stamps handler hosts with `data-dnx-h`, and a single delegated listener
  resumes-and-replays (or, for a `qrl`, dispatches without mounting at all). Off
  by default — a route keeps React-style hydration until it opts in — and the
  whole runtime tree-shakes out of apps that don't use it.
- **`useSignal` / `useStore` — reactive, serializable state** (resumability,
  stage 3; from `@denext/denext`). Opt-in reactive state that transports from
  server to client: `const n = useSignal(0)` returns a stable box (`n.value` /
  `n.peek()`), `useStore(obj)` a shallow reactive object; a write re-renders the
  owning component. Their values are serialized into a `#__denext_state` island
  keyed by position and **adopted** on the client instead of recomputing the
  initializer — the groundwork for resuming state without re-running components.
  Orthogonal to the React-parity hooks: code that doesn't opt in keeps
  `useState` unchanged, and the signal runtime tree-shakes out of apps that
  never use it.
- **`qrl()` — lazily-loaded, code-split, resumable event handlers**
  (resumability, stages 2 & 4; from `@denext/denext/client`). Wrap a handler's
  dynamic import —
  `qrl(() => import("./handlers.ts").then((m) => m.onClick), "id")` — and use it
  as any event-handler prop; the handler's code is fetched only on first
  activation, not shipped in the island bundle. Each `qrl` carries a stable id,
  so a handler **survives serialization** (a new Flight `{$:"e"}` reference) and
  the server stamps it as a `data-dnx-h` descriptor. A single delegated listener
  then **dispatches the handler without ever running its component** — so,
  paired with `client:interaction` and adopted signals, a component is
  interactive with **zero up-front tree execution**. (The _automatic_ transform
  that turns every plain `onClick` into a `qrl` is future work; the authoring
  API ships now.)
- **Island-level lazy hydration — `client:*` directives** (resumability, stage
  1). Opt any client island into deferred hydration with a namespaced JSX
  attribute — `<Counter client:load|idle|visible|interaction />` — and the page
  ships that island's server HTML immediately but defers its hydration
  (component execution + listener attach) until the strategy fires: on idle, on
  scroll into view, or on first interaction. The server carves each lazy island
  into a layout-neutral `<dnx-island>` wrapper the page root adopts but does not
  own (a _foreign_ subtree), and the client hydrates it in place via a
  per-island `hydrateRoot` when its strategy fires — `interaction` uses a single
  delegated capture-phase listener so the triggering event is not lost. Default
  behavior is unchanged (no directive → hydrate at load), and the
  deferred-hydration runtime is a separate `@denext/denext/lazy` chunk,
  dynamically imported only when a page has lazy islands, so non-lazy apps
  bundle none of it. (A per-component `export const hydrate` default is planned;
  the usage-site prop ships now.)
- **Live Server Components — `<Live>`** (new `@denext/denext/live` entrypoint).
  Wrap a server-rendered subtree that reads tagged cache data in
  `<Live tags={["orders"]}>…`; when any of those tags is invalidated
  (`revalidateTag`/`updateTag`, from anywhere — a Server Action, a webhook, a
  cron), the server re-renders **just that boundary, under the viewer's own
  session**, and pushes it over a WebSocket. The client reconciles the subtree
  in place: every other component's state is preserved and no navigation occurs.
  Next.js has no equivalent. It degrades safely — a boundary that can't be
  located (route changed, auth expired) falls back to a route refresh, and with
  no client runtime `<Live>` just renders its children (SSR-safe). The transport
  is opt-in: the socket only opens once a `<Live>` boundary mounts, and an app
  that never imports `<Live>` bundles none of it. Requires a Flight (RSC) route.
- **Live data — `useLive` / `usePresence` / `useLiveOptimistic`** (from
  `@denext/denext/live`), the real-time data family on the same WebSocket hub.
  `useLive(action, args, { tags })` subscribes to a server function's result and
  re-renders whenever one of its cache tags is invalidated — the server re-runs
  the function **under the viewer's own session** and pushes the value
  (real-time data, zero client library). `usePresence(room)` gives who's-online
  / cursors (`{ self, others, peers, setState }`) over the same socket,
  orthogonal to tags. `useLiveOptimistic` pairs an optimistic overlay with a
  live value so a local update reconciles when the authoritative value arrives.
  A Convex / Liveblocks / PartyKit-class real-time layer with **zero npm and
  zero extra infra**; the socket is shared with `<Live>` and opens only when a
  live feature mounts.
- **First-party auth — `denextAuth`** (from `@denext/denext/server`). A
  zero-npm, secure-by-default authentication layer on denext's signed-cookie
  sessions: **OAuth 2.0 / OIDC** (Authorization Code + **PKCE**) with
  **Google**, **GitHub**, and generic **OIDC** presets, plus a **Credentials**
  (email/password) provider. Added as a plugin (`plugins: [denextAuth({ … })]`)
  it **auto-mounts** `/auth/*` (signin/callback/session/providers/signout) — no
  route files to write. OIDC `id_token`s are verified (RS256 via JWKS +
  `iss`/`aud`/`exp`/`nonce`); the session stores only a non-sensitive
  `{ user, provider, expiresAt }` in a signed `__Host-` cookie (never tokens).
  Provider calls go through the SSRF-safe `safeFetch`, the `redirect_uri` is
  pinned to a required `canonicalOrigin` (host-header-injection proof), and
  state-changing POSTs are same-origin gated. Read the session anywhere with
  `auth()`, gate routes with `requireAuth()` middleware, and on the client use
  `<SessionProvider>` / `useSession()` / `signIn()` / `signOut()` (from
  `@denext/denext`).

- **`withWebLock(name, fn, options?)`** (exported from `denext`) — cross-tab /
  cross-worker single-flight built on the standard Web Locks API. Only one
  holder of an exclusive lock runs at a time across every tab of an origin, and
  the lock auto-releases when `fn` settles (or the tab dies), so it can't
  deadlock. It degrades gracefully: on the server (SSR) or in a browser without
  Web Locks, `fn` just runs uncoordinated. Supports `mode: "shared"`,
  `ifAvailable`, and an abort `signal`. The canonical use is coordinating an
  auth-token refresh so concurrent tabs don't stampede a one-time-use refresh
  cookie.
- **`useWakeLock(options?)`** (hook, exported from `denext`) — a React-style
  hook over the Screen Wake Lock API (`navigator.wakeLock`) that keeps the
  display awake. The screen is a device-global resource, so it's a **refcounted
  singleton**: each instance owns its own claim (`request` / `release` / its own
  `released`) and composes safely, but a single real lock is acquired once and
  released when the last claim drops. Instances also share the global reads
  `count` / `active` (via `useSyncExternalStore`) and a `releaseAll()`
  kill-switch. Base surface mirrors the community `react-screen-wake-lock` hook
  (Next.js ships no equivalent); it re-acquires when the tab returns to visible
  and releases on unmount. Client-only; a no-op during SSR / where unsupported.
- **`usePictureInPicture(options?)`** (hook, exported from `denext`) — a
  React-style hook over the Picture-in-Picture API for `<video>`. Attach the
  returned `ref` and drive it with `enter`/`exit`/`toggle`; returns
  `{ isSupported, isActive, isPiPOpen, pipWindow, ... }` with
  `onEnter`/`onExit`/ `onResize`/`onError` callbacks. PiP is a browser
  singleton, so `isActive` is per-video while `isPiPOpen` is a shared global
  read. Next.js ships no equivalent. Client-only; a no-op during SSR / where
  unsupported.

### Security

- **Live Server Components — authorization model + resource caps.** Following a
  pre-release audit of the (unreleased) Live feature, the WebSocket hub gains a
  first-class security model via `experimental.live` in `denext.config`:
  - **Presence rooms and `useLive` data subscriptions are now default-deny**,
    identically in dev and production. Previously any same-origin client could
    join any presence `room` (reading every peer's state and publishing forged
    state) and could `data-subscribe` to any registered server action with
    arbitrary args. Supply a policy — `authorize(ctx)`,
    `canJoinRoom(ctx, room)`, `canSubscribe(ctx, sub)` — to admit them; hooks
    run inside the viewer's own request context so they can call `getSession()`.
    Actions can instead be opted in individually with `liveReadable(action)`.
    Using a gated hook with no policy raises a loud, actionable error the first
    time it runs (there is no dev-only allowance that would work locally and
    silently break in production); `experimental.live.allowAnonymous: true` is
    the one explicit line that opts into open access for genuinely public
    collaboration.
  - **Resource caps** (all with safe defaults, overridable via
    `experimental.live.limits`): max connections, subscriptions-per-connection,
    rooms-per-connection, watched boundaries, and an inbound message-size limit
    — closing an unbounded-registry / amplification DoS where one client could
    exhaust server memory/CPU. The upgrade now also sets an explicit socket idle
    timeout. A refused subscription or a hit cap sends an advisory `error`
    frame.

- **Auth — post-login open redirect closed.** `denextAuth` passed the
  request-supplied `callbackUrl` straight to `safeRedirectLocation`, which by
  design returns a fully-qualified `http(s)://…` URL unchanged — so
  `?callbackUrl=https://evil/…` sent a user to an attacker site after a genuine
  login. Request-derived redirect targets are now coerced to a same-origin path
  (an absolute URL is admitted only when its origin equals `canonicalOrigin`,
  and then only its path is kept). Applied at sign-in, callback, and sign-out.
- **Auth — hardened the OAuth transaction cookie.** `denext_auth_tx` (CSRF
  `state`, PKCE verifier, OIDC nonce, return path) was an unsigned, plain cookie
  with no `__Host-` prefix — overwritable via cookie injection (a login-CSRF
  vector). It is now a signed, `__Host-`-prefixed, short-lived session cookie
  (same infrastructure as the auth session).
- **Auth — OIDC `id_token` validation.** A token that omitted `exp` was accepted
  as non-expiring; `nbf` was not checked. `exp` is now required (a missing `exp`
  is rejected) and a not-yet-valid (`nbf`) token is refused, within clock skew.
- **Auth — `canonicalOrigin` required in production.** Without it the OAuth
  `redirect_uri` and same-origin checks fall back to the attacker-controllable
  `Host` header; `denextAuth` now throws when it is unset and
  `NODE_ENV`/`DENEXT_ENV` is `production` (still a warning in dev).

### Fixed

- **`useWakeLock` could leak an OS wake lock under a concurrent acquire.** Two
  claims added in the same tick both saw no sentinel and each called
  `navigator.wakeLock.request`, so the second overwrote the first and the first
  real lock was never released (the screen stayed awake). Acquisition now
  coalesces through a single in-flight promise, and release awaits it — exactly
  one sentinel.
- **`withWebLock` fallback surfaced errors on the wrong channel.** On the SSR /
  no-Web-Locks path a synchronous throw in the callback escaped synchronously
  (instead of rejecting the returned promise like the real path), and an
  already-aborted `signal` was ignored. The fallback now rejects on both.
- **`usePictureInPicture` leaked a resize listener on unmount-in-PiP.** If the
  component unmounted while still in Picture-in-Picture, `leavepictureinpicture`
  never fired, so the `resize` listener added on the PiP window was never
  removed. The effect cleanup now removes it.

- **Resumability was not re-wired after a Flight soft navigation.**
  `bootResumability` ran only from the full-load entry, so a client-side
  navigation into a route with `client:*`/resumable islands left them inert
  (rendered empty, non-interactive) and event types unique to the new route got
  no delegated listener. The Flight soft-nav payload now carries the route's
  islands + signal state, and `navigation.ts` calls a registered re-boot hook
  that mounts each island from its own Flight and adopts its state. The
  delegated dispatcher now tracks already-registered event types on a global so
  a re-boot adds listeners for newly-appearing ones without double-binding. Also
  hardened along the way: signal-state adoption now drops prototype-polluting
  keys (`__proto__`/`constructor`/`prototype`) — the same filter `parseFlight`
  uses; `qrl()` rejects an id containing whitespace or `:` (the `data-dnx-h`
  delimiters); and island wrapper attributes are HTML-escaped on emission.

- **Interactivity classifier could ship a broken (zero-JS) interactive page.**
  The static-route scan blanks string/comment content before looking for
  interactivity signals, but did not recognize **regex literals** — so a regex
  containing a quote (e.g. a validation `/['"]/g`) opened a spurious "string"
  that blanked real code after it. A client component whose only signal was a
  JSX `onInput=`/`onClick=` sitting after such a regex could be misclassified
  static and shipped with **no JavaScript**, leaving the handler dead. The
  scanner now lexes regex literals (disambiguating regex from division by the
  preceding token, and deliberately never treating JSX `</div>`, `/>`, or
  `{a}/{b}` as a regex) and blanks only the regex interior. A regression
  introduced when the scan moved off raw source; caught before release.

- **Soft navigation re-hydrated against the previous page in dev.** The retained
  reconciler root was held in a module-level variable, which assumed the route
  bundle shared a single runtime chunk. A dev build serves each route bundle
  self-contained, so a soft nav's re-run entry got a fresh module with
  `retainedRoot === null` and fell into the `hydrateRoot` branch — adopting the
  outgoing page's DOM as the incoming tree. The visible result was a flood of
  hydration-mismatch warnings and stale UI (e.g. the docs sidebar keeping the
  previous page's active indicator). The root is now stored on a global so it
  survives across route-bundle module instances; soft nav reconciles in place
  via `root.render` in dev and production alike. Dev-only; production
  code-splitting already shared the runtime chunk.

- **Read-your-writes after a Server Action.** A Server Action that calls
  `revalidateTag`/`updateTag` or `refresh()` already returned those directives
  in its XHR response, but the client discarded them — so the mutated content
  only updated on the next navigation. The client runtime now honours them and
  re-renders the current route in place (preserving component state), matching
  Next.js refresh semantics.

## [1.0.2] - 2026-08-19

Documentation-only patch. Adds an `@module` tag to the bare-`next` barrel
(`src/compat/next/index.ts`) so `deno doc`/JSR attribute its leading comment to
the module — the last entrypoint that wasn't credited a module doc. Flips JSR's
"has module docs in all entrypoints" criterion to passing. No behavior change.

## [1.0.1] - 2026-08-19

Documentation-only patch to complete the public-API doc graph (raises the JSR
score). No runtime or behavior change.

- Export the types the public API exposed only transitively, so JSR/`deno doc`
  see a complete graph: `FontResult` (from `next/font/local` +
  `next/font/google`),
  `RequestCookies`/`ResponseCookies`/`RequestCookie`/`CookieOptions` (from
  `next/server`), the class-component base types (from `react`), and the
  `MetadataRoute.*` members (from `next`).
- `deno doc --lint` is now clean across the full `exports` set (previously only
  a curated subset was linted).

## [1.0.0] - 2026-08-19

The 1.0.0 release, declaring the public API stable. Post-0.12.0 hardening,
verification, and demonstration work, with one small breaking change to the
`instrumentation.ts` `onRequestError` signature (below) for Next.js parity.

### Breaking

- **`onRequestError(error, request, context)` now receives Next's plain
  `{ path, method, headers }` object as `request`, not a `Request`.** This
  matches Next.js so instrumentation (Sentry/OpenTelemetry) written for Next
  works unchanged. If your handler used `request.url` / `request.clone()`, read
  `request.path` / `request.method` instead. `context` also gains `renderType`
  and a `renderSource` for RSC/Flight render errors, and middleware errors are
  now reported with `routeType: "proxy"`.

### Security

- **CVE-2026-64641 (CWE-834) — Server-Action unbounded iteration:** the
  multipart argument decoder trusted an attacker-controlled `fdIndex`, so
  `args[fdIndex] = fd` could inflate the argument array to an arbitrary length
  that the handler then spreads (`handler(...args)`) — a CPU/memory DoS.
  `fdIndex` is now validated as an in-range integer of `others`; anything else
  falls back to a single-FormData arg.
- **CVE-2026-64644 — image-optimizer DoS/XSS via SVG source:** an SVG source is
  now refused outright (`400`, sniffed from the leading bytes before decode)
  instead of failing into an incidental `500`. The optimizer emits only raster
  webp/avif and never rasterizes or echoes a script-bearing SVG. Matches Next's
  default; only the `/_denext/image` optimizer path is affected — static/inline
  SVG is untouched.
- New parity tests for CVE-2024-47831/CVE-2026-44577 (image width-allowlist +
  decompression bomb) and CVE-2026-53668 (`javascript:`/`vbscript:` redirect
  target neutralized to an inert path). Five `CVE-DEFENSE-GUIDE.md` rows moved
  to "Protected (tested)".

### Fixed

- **In-repo RSC/Server-Action boundary detection:** the import-graph boundary
  crawl excluded the entire framework root, so an app living under the repo (an
  example, a monorepo app) could never form a `"use client"`/`"use server"`
  boundary. The exclusion is now scoped to the framework's `src/` subtree. Real
  (jsr:) users were unaffected; this unblocks source-checkout/monorepo apps.

Pre-1.0.0 production-readiness remediation (a whole-app review; all fixes carry
regression tests, no public API break):

- **Flight boundary crawl (H1):** the client/server boundary manifest was built
  from **page files only**, so an interactive island imported solely by a
  `layout`/`template`/slot shipped non-interactive in prod. The crawl now covers
  every route entry (page + layout + template + slot chains) via a shared
  `routeEntryFiles` helper.
- **ISR background regeneration (H2):** a hung upstream during a stale-while-
  revalidate regen leaked the in-flight key and froze staleness for that route
  forever. Regen now runs under its own bounded deadline + `AbortController` and
  frees its key on a hard timer regardless of settle; it also no longer takes
  the render leader-lock.
- **`useSyncExternalStore` hydration (H3):** the hook ignored
  `getServerSnapshot` during hydration (guaranteed mismatch for SSR state libs)
  and could miss a store mutation landing in the subscribe window. It now reads
  the server snapshot while hydrating and re-checks after subscribing.
- **Dynamic-page CDN safety (M1):** an HTML response whose render read
  `cookies()`/`headers()` now carries `Cache-Control: private, no-store` and
  `Vary: Cookie`, so a shared cache can't serve one visitor's per-user render to
  another.
- **Server Action error reporting (M2):** a thrown Server Action now reaches
  `onRequestError` instrumentation (it returns a normal 500, so it never hit the
  top-level reporter before).
- **Fetch cache key includes headers (M3):** `cachedFetch` / the automatic fetch
  cache keyed on URL/body only; two requests differing only by a header (e.g.
  `Authorization`) collided onto one entry. A normalized header fingerprint is
  now part of the key.
- **Data-cache byte budget (M4):** the in-memory data cache was count-bounded
  but not byte-bounded; it now evicts the LRU to hold a byte budget too (~32
  MB).
- **`x-request-id` on error responses (M5):** timeout/abort/shed/global-error
  responses now echo the correlation id.
- **`useTransition` sync throw (M7):** a synchronous throw in the transition
  callback left `isPending` stuck true; `onComplete` is now scheduled before the
  rethrow.
- **Effect cleanup/setup ordering (M8):** within a commit phase, ALL effect
  cleanups now run before ANY setup (React's order), so a resource handed
  between siblings is released before it is re-acquired.
- **Tier-3:** framework-src exclusion now matches on a path-segment boundary (a
  sibling `…/src-app/` is no longer wrongly excluded) and realpath-normalizes
  the framework root for symlinked checkouts; an auto-implemented `HEAD` cancels
  the synthesized `GET` stream instead of leaking it; a real page URL hit by a
  non-GET/HEAD method returns `405` + `Allow` (was `404`).

### Added

- **Examples:** `examples/image` (`<Image>` + `/_denext/image` optimizer + OG
  image), `examples/caching` (`unstable_cache` + `revalidateTag` + ISR),
  `examples/actions` (Server Actions, progressive enhancement + a client
  island), and `examples/streaming` (Suspense, `loading.tsx`, streaming SSR).
  Each has an integration smoke test.
- **Tests:** ~100 new tests — API-route dispatch (previously untested), prod/dev
  server contracts, request-path helpers, router/metadata edge cases, new CVE
  parity cases, plus opt-in real-browser e2e for the new examples.
- **Benchmark:** a load & memory tier (`deno task bench:load`) — high-volume
  concurrent requests with throughput, latency percentiles, error rate, and
  server RSS (idle vs. peak), head-to-head with Next.js when its fixture is
  built.

### Changed — first-party AVIF codec (zero-npm)

- **AVIF output is now first-party.** The image optimizer's AVIF encoder is the
  new `@denext/avif` JSR package (a Deno-native fork of `@jsquash/avif@2.1.1`'s
  prebuilt libavif wasm, driven via emscripten's `instantiateWasm` hook) instead
  of the opt-in `@jsquash/avif` npm peer dep. AVIF output now works with **no
  import-map setup and zero npm** — joining `@denext/photon` (resize/WebP) and
  `@denext/sqlite` (durable cache). The optimizer now passes `quality` (0–100)
  straight through, dropping the lossy `quality → cqLevel` round-trip.
  `tests/image-next16.test.ts`'s AVIF case, which previously self-skipped when
  the peer dep was absent, now runs on CI.

### Changed — first-party OG renderer (`next/og`), zero peer codecs remain

- **`next/og` `ImageResponse` is now first-party.** It renders through the new
  `@denext/og` JSR package — a self-contained esbuild bundle of the full
  **satori + yoga + resvg** stack (vendored from `@cf-wasm/og@0.5.0`'s `node`
  entry, with all wasm and the default Noto Sans font inlined as base64) —
  instead of the opt-in `@cf-wasm/og` npm peer dep. `next/og` now works with
  **no import-map setup and zero npm**, and plain-Latin rendering needs **no
  runtime permissions**. This retires the **last** opt-in peer codec:
  `@denext/photon`, `@denext/avif`, `@denext/og`, and `@denext/sqlite` are all
  first-party JSR packages now — **no npm peer dependencies remain**. The
  internal `src/server/peer-codec.ts` loader was removed.
  `tests/image-response.test.ts`, previously self-skipping when the peer dep was
  absent, now runs on CI.

### Added — Cache Components (`use cache` + PPR), experimental

Behind `experimental: { cacheComponents: true }` (off by default; the render
path is byte-for-byte unchanged when off). Version held at `0.12.0`.

- **`use cache` directive** — module-top or function-body, compiled by a
  build-time swc AST transform (`src/build/use-cache-transform.ts`) into a
  `__useCache` runtime wrapper with single-flight, `cacheLife`, and `cacheTag`.
  A transitive server loader reaches cached helpers imported by directive-free
  modules.
- **New caching APIs** — `cacheLife` profiles, `cacheTag`,
  `revalidateTag(tag, profile)` soft-expire, `updateTag` (read-your-writes in a
  Server Action), and `refresh()`.
- **Partial Prerendering** — a cacheable page renders a request-independent
  **static shell** (cached once, including `use cache` islands) with dynamic
  subtrees (`cookies()`/`headers()` behind a Suspense boundary) postponed to
  **per-request holes** spliced into the shell. New `src/runtime/prerender.ts`
  (Postpone signal), `src/jsx/render-to-ppr.ts` (two-pass shell/hole renderer),
  and gated wiring in `renderPage`/`app.ts`. See
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) for the first-landing scope
  (buffered resume, `useId`/Flight/metadata caveats).
- **Example:** `examples/cache-components` (a `use cache` data helper + a PPR
  page with a static shell and a per-request dynamic hole) with an integration
  smoke test.

### Added — `next/image` alignment (Next.js 16)

- New `images` config: `qualities` (default `[75]`), `minimumCacheTTL` (default
  `14400`), `localPatterns`, `formats` (default `["image/webp"]`; add
  `"image/avif"`), `maximumRedirects` (default `3`), and the
  `dangerouslyAllowLocalIP` SSRF escape hatch.
- The `q=` param is now applied (coerced to the nearest configured quality);
  **AVIF** output is negotiated from `Accept` and encoded via `@jsquash/avif`;
  `Cache-Control` `max-age` derives from `minimumCacheTTL`; `Vary: Accept` is
  emitted; `16` was dropped from the default image sizes; `localPatterns` guards
  local-source enumeration.

### Verified in a real browser

- The `"use client"` island's **Server-Action RPC round-trip on submit** and the
  `/stream` **`__dnxSwap` out-of-order reveal** both work end-to-end under
  headless Chromium (`tests/e2e/actions.e2e.test.ts`,
  `tests/e2e/streaming.e2e.test.ts`). Two earlier e2e assertions were flaky —
  the streaming test checked the fallback text that the swap deliberately
  replaces, and a headless keystroke silently dropped on one input — both now
  deterministic. No framework change was needed.

## [0.12.0] - 2026-08-14

Closes the remaining React-19 and Next.js App-Router gaps — each built
faithfully, no placeholders — **plus** a round of proactive security hardening
driven by `CVE-DEFENSE-GUIDE.md`: all six tracked residual-risk gaps closed or
mitigated, and ten more CVE classes locked in with parity tests. denext is
stricter than Next.js out of the box (Next ships **no** default security headers
or CSP). No breaking public API; the default CSP blocks external scripts/styles
by design (per-route opt-in).

### Security — new defaults

- **Default Content-Security-Policy** on every document response:
  `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self';
  form-action 'self'; img-src 'self' data:`.
  `script-src` is exactly `'self'` — inline scripts are **never** hashed, so an
  injected inline `<script>` can't self-authorize; each inline `<style>` denext
  emits is allowed by a content `'sha256-…'` (nonces would be useless under the
  byte-identical ISR cache), and `style-src-attr 'unsafe-inline'` keeps React
  `style={{}}` working. **⚠️ Intentional behavior change:** external scripts and
  stylesheets are **blocked by default** — opt in per route via a segment-config
  export,
  `export const csp = { scriptSrc: ["https://…"], styleSrc: ["https://…"] }`
  (opt-ins union down the layout→page chain); an author-supplied inline
  `<Script>` needs an external `src` or such an opt-in. An app CSP set via
  `headers()`/middleware overrides the default. The computed policy is stored
  with the cached page.
- **Default hardening headers** on every response (only where the app hasn't set
  its own): `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and HSTS when served over
  HTTPS.
- **Dangerous URL scheme filtering** — `javascript:`/`vbscript:` in any
  URL-bearing attribute (and executable `data:` in navigable/scripty contexts)
  are dropped at a shared chokepoint (all SSR renderers + client
  `setAttribute`), defeating whitespace/control-char obfuscation. React only
  warns; denext neutralizes.
- **Framework redirects normalized** — middleware, server-component and
  server-action redirects route their `Location` through `safeRedirectLocation`
  (protocol-relative escapes collapse to same-origin; explicit `http(s)://`
  targets preserved).
- **Slow-body idle timeout** on the Server-Action body reader (→ 408), so a
  trickled or never-closed body can't pin a handler under the size cap.
- **Soft-nav / prefetch responses** carry `Cache-Control: private, no-store` so
  a shared CDN can't cache the nav variant.
- **Dev reload-stream Origin check** — the dev `/_denext/reload` SSE endpoint
  refuses cross-origin subscribers; `allowedDevOrigins` mirrors Next.js.

### Security — developer aids

- **`dangerouslySetInnerHTML` dev warning** (SSR + client, dev-only), pointing
  at a sanitizer; also fixed a latent client bug where the HTML was never
  applied (a bogus `[object Object]` attribute was set instead).

### Tests

- New parity/regression suites: `tests/url-scheme.test.ts`,
  `tests/dangerous-html.test.ts`, `tests/dev-origin.test.ts`,
  `tests/security-headers.test.ts`, `tests/csp.test.ts`,
  `tests/csp-integration.test.ts`, plus ten new
  `tests/nextjs-cve-parity.test.ts` cases (param injection, segment-prefetch,
  prefetch caching, malformed-URL, error-page escaping, action-id enumeration,
  server-function source non-disclosure, internal-header leakage, invalid-UTF-8
  cache keying, WS-upgrade).

### Added — React 19 fidelity

- **`use(Context)`** — `use()` now handles React 19's context overload (reads
  the nearest provided value, may be called conditionally), on the client and
  under every SSR renderer.
- **Render-phase `useDeferredValue`** — replaced the effect-based approximation
  with a true render-phase deferral driven by the fiber priority lanes: an
  urgent render returns the previous value and self-schedules a time-sliced,
  interruptible catch-up. Adds the React 19 `initialValue` argument.
- **Form-scoped `useFormStatus`** — was a single global "any action pending"
  flag; now tracks the nearest enclosing `<form action={fn}>`, so concurrent
  forms report independent status.
- **StrictMode dev double-invoke** — was a no-op Fragment alias; now really
  double-invokes renders and mount effects (setup → cleanup → setup) in
  development to surface impure renders and missing cleanup. A transparent
  Fragment in production and SSR (zero cost).
- **`SuspenseList` reveal ordering** — `revealOrder`
  (forwards/backwards/together) and `tail` (collapsed/hidden) are now enforced:
  sibling `<Suspense>` boundaries reveal in order regardless of the order their
  data resolves.
- **Profiler actual-vs-base durations** — the reconciler now times each
  component's render, so `actualDuration` counts only the components that
  re-rendered this commit (memoized/bailed excluded) while `baseDuration` covers
  the whole subtree.
- **Transition-aware Suspense** — a `startTransition`/`useDeferredValue` update
  that re-suspends an already-revealed boundary now keeps the current content on
  screen (no fallback flash) and commits the new content once the promise
  settles, matching React's recommended pattern. Because the subtree is never
  unmounted, its local state is preserved across the re-suspend. (An urgent,
  non-transition re-suspend still shows the fallback — full Offscreen
  mount-hidden for that path is tracked in ROADMAP-1.0.)

### Added — Next.js App Router

- **Layout-level `generateMetadata` / `generateViewport`** — layouts previously
  contributed only static `metadata`; their generator functions now run at every
  segment (page metadata still wins on conflict).
- **Stale-while-revalidate ISR** — a numeric `revalidate: N` serves fresh for N
  seconds, then serves the stale render immediately (`x-denext-cache: STALE`)
  while regenerating once in the background, instead of a blocking TTL miss.
  Wired through the in-memory, Deno KV, and SQLite stores.
- **Automatic `fetch()` caching, uncached by default** — a bare `fetch()` is
  passed through uncached (no accidental caching of authed/per-user data); a GET
  given `next: { revalidate, tags }` or `cache: "force-cache"` is cached in the
  data cache and its tags feed `revalidateTag` to purge dependent pages.
- **Reconcile-in-place soft navigation** — a client navigation now reconciles
  the new route through a retained reconciler root (patching the DOM, preserving
  state in unaffected subtrees) instead of replacing the root's innerHTML and
  re-hydrating from scratch.

### Fixed — production-readiness audit

A six-dimension source-level audit found 1 Critical, 5 High, 16 Medium, and 11
Low issues; all are fixed (each its own commit + test where runtime-verifiable).

- **SSRF via IPv4-mapped IPv6 in `safeFetch` (Critical).** The IPv6 guard was
  string-prefix matching; a real parser now expands `::`, reads embedded IPv4,
  and routes IPv4-mapped (`::ffff:7f00:1`), IPv4-compatible, and NAT64
  (`64:ff9b::`) forms through the IPv4 block-list — closing a cloud-metadata
  reachability bypass.
- **Real request cancellation + default timeout (High).** The abort signal
  threads into the render (checkpointed `throwIfAborted`), and `requestTimeout`
  defaults to 30s (background ISR regen exempt; `0` disables) so a wedged render
  can't pin resources. `onError` is guarded against its own throw.
- **Client-runtime resilience (High).** An unboundaried transition throw no
  longer wedges the scheduler (state is reset and re-thrown); effect and
  unmount-cleanup errors route to the nearest error boundary instead of
  stranding the tree.
- **Least-privilege CLI (High).** The CSS re-exec propagates the parent's actual
  permission grants instead of `-A`.
- **Graceful-shutdown drain (High).** `serveWithPortFallback` now calls
  `server.shutdown()` to drain in-flight requests (the `Deno.serve` `signal`
  option hard-closes); covered by a new integration test.
- **Server/redirect hardening (Medium).** Global-error output is redacted in
  production (generic message + correlatable digest); `serve()` forwards every
  `AppConfig` field to `createApp`.
- **Cache correctness & bounds (Medium/Low).** Page cache key normalizes
  query-param order (no forking/thrashing); the in-memory store gains a byte
  budget + expired sweep; the SQLite store retries a failed open and wraps
  writes in transactions; the KV store skips already-expired/oversize writes and
  checks `commit().ok`; `safeKey` throws on non-serializable args instead of a
  colliding fallback.
- **Image optimizer (Medium).** A decode-free header probe (PNG/GIF/JPEG/WebP)
  rejects decompression-bomb dimensions before decode; local `public/` sources
  are byte-capped.
- **Build & config (Medium).** Builds stage into a temp dir and swap atomically
  (no half-written `client/` on failure); `denext.config` is validated on load
  with field-scoped errors; build/export failures print a clean CLI message; the
  dev/prod bundling divergence is documented.
- **Observability (Medium/Low).** A per-request correlation id rides
  `RequestLogInfo`, the error log, and the `x-request-id` header;
  `DENEXT_LOG=json` emits structured JSON; cache-error logging is rate-limited
  per operation; prefetch cache is LRU+TTL-bounded.
- **Tests/CI.** SQLite failure-mode tests (fake module, no optional dep) and a
  nightly, non-blocking e2e workflow.

### Fixed — release-readiness pass (path to 1.0.0)

A final batch of audits (React-19/Next-16 surface, npm-interop, production
readiness, security, test coverage, developer experience) ahead of the 1.0.0
stability commitment. No blocking correctness defects were found; the following
close cheap compat gaps, small feature gaps, and secure-default/test-gate
polish.

- **CLI / package entry never exited.** `denext init`/`create` — and any script
  doing `import "mod.ts"` — finished their work but hung forever: the fiber
  reconciler built a `MessageChannel` with a live listener at module scope (a
  ref'd handle keeping Deno's event loop alive), dragged into the SSR/CLI graph
  by the class runtime's static import of the client reconciler. The channel is
  now lazily created on first real (browser) use, and the class runtime injects
  `scheduleUpdate` instead of statically importing the client reconciler; a
  subprocess regression test asserts a clean, timely exit.
- **npm-interop crash-class fixes.** `react-dom/server` (+`.browser`/`.edge`) is
  now aliased to a denext shim (React-shaped `renderToReadableStream`; the
  synchronous APIs throw a guided error) so importing it no longer pulls a
  second React; `useFormStatus`/`useFormState` are exported from `react-dom`;
  `React.cache` is added (client-safe arg memo); `react-dom/test-utils` (`act`)
  is aliased. `react-is` gains real `isStrictMode`/`isProfiler`/
  `isContextConsumer`; `forwardRef`/`memo` brand fields are now enumerable.
- **Small Next-16 features.** `next/form` (`<Form>` — progressive-enhancement
  GET form that soft-navigates), `connection()` and `after()` exported from
  `next/server`, and `useLinkStatus` (global navigation-pending) from
  `next/link`.
- **Security/ops hardening.** The reused inbound `x-request-id` is sanitized
  (safe token chars, length-bounded) so it can't forge logs or inject the echoed
  header; HSTS's `x-forwarded-proto` trust is gated on `trustForwardedHeaders`;
  new `DEPLOYMENT.md` documents the operational responsibilities left to the
  edge (concurrency ceiling, SSRF-pinning, CSP-on-streaming, proxy origin).
- **Test hardening.** A fast, blocking next-compat build guard runs on every PR
  (the real-npm proof stays nightly); a `test:coverage` task; and new coverage
  for `precompress.ts`, `next/request.ts`, `next/cookies.ts`, and
  `next-intl/routing.ts`.
- **DevTools honesty.** The React DevTools bridge now reports `bundleType`
  honestly (production `0`, development `1`) instead of always advertising a dev
  build.
- **Docs.** New `KNOWN-LIMITATIONS.md` (behavioral divergences, experimental-API
  list, honest DevTools scope) and `ROADMAP-1.0.md` (deferred 1.0.0 work).

### Changed

- **Server Actions body-size default lowered to 1 MiB** (`actionMaxBodyBytes`),
  matching Next.js' `serverActions.bodySizeLimit` default of `1mb` (previously
  10 MiB). A stricter, safer default; large payloads (e.g. multipart uploads)
  opt into a higher limit via `actionMaxBodyBytes`.

## [0.11.1] - 2026-08-10

Docs and a new example for the 0.11.0 fiber concurrency — no runtime code
change.

### Added

- **`examples/concurrency`** ("smoothness under load") — a demo of what the
  fiber reconciler does that cooperative scheduling could not: a
  `requestAnimationFrame` spinner + FPS counter keep advancing and the text
  field stays typable while a transition re-renders a grid of up to 25,000
  cells; a **Blocking-mode toggle** runs the same update as a plain `setState`
  for a direct before/after; and a started/committed counter shows the in-flight
  renders discarded by interruption. `deno task example:concurrency`.

### Docs

- README: corrected the stale "function-components only / classes throw if
  constructed" limit (class components have been supported since 0.9.0); added a
  "Concurrent rendering (fiber)" feature bullet; refreshed the bundle-size table
  to the measured 0.11.0 numbers (~12 KB first load / ~11 KB runtime baseline —
  the fiber reconciler added ~1.8 KB gz, still ~11× smaller than Next.js 16).
- Refreshed the now-stale "cooperative scheduler / no mid-tree interruption"
  wording in `examples/transitions` and the transition test headers.

## [0.11.0] - 2026-08-10

Rewrites the client reconciler around a **fiber architecture**, delivering
genuinely **time-sliced and interruptible concurrent rendering** for the
transition lane — the long-standing gap documented in the migration guide's §10.
Still **no new npm runtime dependency**, and the public API is unchanged.

### Added

- **Fiber reconciler** (`src/client/fiber/`). Rendering proceeds as resumable
  units of work over a double-buffered fiber tree (`child`/`sibling`/`return`
  links + an `alternate` buffer). The next tree is built **off-DOM** and
  committed **atomically**, so an interrupted or discarded render never shows
  partial DOM (no tearing).
- **Time-slicing (transition lane).** A transition render checks a ~5 ms frame
  budget between units of work and yields via `MessageChannel`, resuming on the
  next slice — so a heavy transition no longer blocks paint or input. It commits
  only when the render drains.
- **Priority lanes with interrupt-and-restart.** An urgent (sync) update that
  arrives while a transition is in flight abandons the transition's off-DOM
  work, commits the urgent update immediately, and restarts the transition from
  the freshly-committed state (`useId` counters are snapshot/restored so a
  restart is deterministic).
- **`flushSync`** now reclaims any in-flight transition slice and renders
  everything to completion synchronously.
- **Layout / passive effect phase split.** `useLayoutEffect`,
  `useInsertionEffect`, and class `componentDidMount`/`componentDidUpdate` run
  **synchronously at commit** (before paint); `useEffect` (and
  `useSyncExternalStore` subscriptions) are now **passive** — scheduled on a
  task after commit, flushed before the next render and inside
  `flushSync`/`act`, matching React's effect ordering. This closes the last item
  from the migration guide's §10, so denext now covers React's full
  concurrent-rendering model (fiber work loop, time-slicing, priority lanes,
  double-buffering, phase split).

### Changed

- The **sync (default) lane still renders and commits synchronously** —
  `render()`, `flushSync()`, and `act()` are synchronous. Passive effects
  (`useEffect`) now run on a post-commit task (as in React), so a test asserting
  a `useEffect` side effect after a bare `render()` must flush first
  (`flushSync()` or `act()`); layout effects and class lifecycle remain
  synchronous.
- Extracted the renderer-agnostic pieces (DOM props/events/refs, vnode helpers,
  context maps) into shared modules
  (`src/client/{dom-props,vnode-utils,context-map}.ts`) reused by the
  reconciler.

## [0.10.0] - 2026-08-10

Rounds out the React API surface (the pieces that don't require true concurrent
rendering) and fixes two library-compat gaps uncovered by running real animation
libraries. Still **no new npm runtime dependency**.

### Added

- **`useInsertionEffect`** — runs at commit for CSS-in-JS / animation style
  injection. Unblocks `motion` (motion.dev / framer-motion), and is what emotion
  and styled-components use. (denext has no separate pre-mutation phase, so it
  commits alongside layout effects; a no-op during SSR.)
- **`Context.Consumer`** — `createContext(...)` now returns a working
  render-prop consumer (`<Ctx.Consumer>{value => …}</Ctx.Consumer>`). Also fixes
  libraries that merely reference/assign to `.Consumer` (e.g. react-spring's
  `makeContext`).
- **`Profiler`** — measures a subtree's render timing and calls `onRender` after
  each commit (best-effort durations; denext renders synchronously).
- **`act(callback)`** — the React test helper: runs the callback, flushes
  pending updates/effects (including transitions), and returns a thenable for
  sync/async use.
- **Resource preloading** (`react-dom`): `preload`, `preinit`, `preconnect`,
  `prefetchDNS` — inject deduped `<link>`/`<script>` into `document.head` on the
  client; safe no-ops during SSR.
- **`SuspenseList`** — present as a documented pass-through (renders its
  children); `revealOrder`/`tail` coordination is not yet enforced (planned with
  concurrent rendering).
- **`useDebugValue`** (DevTools-only no-op) and **`useFormState`** (deprecated
  alias of `useActionState`), for API completeness.
- **Examples:** `examples/animation` — real `motion` **and** `@react-spring/web`
  co-existing in one project, both on denext's single React (SSR + hydrate).

### Fixed

- `mod.ts` `VERSION` was stale (`0.8.12`); now tracks the package version.
- CI's doc-lint step now runs the `deno task doc-lint` (single source of truth)
  instead of a hardcoded file list that had drifted and reported false errors.

## [0.9.0] - 2026-08-09

Reconciler-level React fidelity + Next.js runtime fidelity — the compat story
moves from "matching API names" to "being React at the reconciler level" and
running real Next.js apps. Every runtime piece here rides Deno built-ins / JSR
`@std/*` / `Intl.*` / `node:sqlite` — **no new npm runtime dependency**
(enforced by a CI guard).

### Added

- **First-class, context-preserving portals.** `createPortal` is now backed by a
  reconciler `PORTAL` instance kind: the portaled subtree keeps its place in the
  component and **context** tree (context providers and error boundaries above
  the call are visible across the portal), while its DOM mounts into the target
  container. This fixes the previous sub-root portal, which lost context — the
  gating requirement for Radix/shadcn overlays (Dialog/Popover/Tooltip). Also
  exported natively as `denext`'s `createPortal`.
- **`react-is` compat** (`@denext/denext/react-is`) with type branding.
  `forwardRef`, `memo`, `lazy`/`dynamic`, and `Suspense` now carry stable
  `$$typeof` brands, so
  `isForwardRef`/`isMemo`/`isLazy`/`isFragment`/`isPortal`/
  `isSuspense`/`isValidElement`/`typeOf` classify denext's shapes.
- **`Slot` / `Slottable` + `composeRefs`** (`@denext/denext/slot`,
  `@denext/denext/compose-refs`) — the Radix `asChild` primitive: merges props
  onto a single child element (className joins, handlers compose child-first,
  refs merge), no wrapper element.
- **Ref fidelity.** Refs are now detached on unmount and when they change;
  React-19 cleanup-returning callback refs are honored.
- **Event-system fidelity.** `onChange` maps to the DOM **`input`** event
  (per-keystroke, controlled-input semantics), `onDoubleClick` → `dblclick`, and
  `on*Capture` registers a real capture-phase listener (previously produced a
  broken `clickcapture` type).
- **Full `NextRequest` / `NextResponse`** (`next/server`). `NextRequest` adds
  `nextUrl` (cloneable), `cookies` (`@std/http`-backed), and best-effort
  `ip`/`geo`. `NextResponse` is a real `Response` subclass with a `.cookies`
  writer; its statics use Next's `x-middleware-*` header protocol so
  `NextResponse.next()`/`.rewrite()` (with `res.cookies.set(...)`) interoperate
  with denext's middleware runner. Middleware handlers now receive a
  `NextRequest`.
- **`next-intl` compat** (`next-intl`, `/server`, `/navigation`, `/middleware`,
  `/routing`): `useTranslations`/`useLocale`/`useFormatter`/`useMessages`/
  `NextIntlClientProvider`, server `getTranslations`/`getLocale`/`getMessages`/
  `getFormatter`/`getRequestConfig`/`setRequestLocale`, locale-aware navigation,
  and locale-routing middleware — over a compact **ICU MessageFormat** built on
  `Intl.PluralRules`/`NumberFormat`/`DateTimeFormat` (no `intl-messageformat`).
- **`next/font/local` + `next/font/google`.** Local fonts self-host via
  `@font-face`; Google fonts register a stylesheet link (with an optional
  build-time downloader for true self-hosting). Both return the
  `{ className, style, variable }` handle. ~40 popular Google families are
  exposed as named exports.
- **`better-sqlite3` over `node:sqlite`** (`@denext/denext/better-sqlite3`) —
  `prepare().run/get/all/iterate`, `.pluck()/.raw()`, `exec`, `pragma`,
  `transaction` (nesting via savepoints), `function`, `close`. Swaps the native
  npm addon for Deno's built-in SQLite.
- **`denext create/init --next-compat`** now also aliases `react-is`,
  `next-intl` (+ `next-intl/`), and `better-sqlite3`.
- ~60 new tests across portals, events, refs, react-is, Slot, NextRequest/
  Response, next-intl (ICU/hooks/server/navigation/middleware), fonts, and
  sqlite, plus a guard test that fails if any `npm:` specifier enters the compat
  runtime.

### Changed

- The middleware runner recognizes the `x-middleware-next` /
  `x-middleware-rewrite` response headers and preserves `Set-Cookie` across the
  chain.

### Fixed (production-readiness review)

- **POST bodies survive next-compat middleware.** The `NextRequest` adapter now
  wraps a `clone()` of the request, so constructing it no longer consumes the
  original body — Server Actions and API route handlers behind middleware can
  read it. (Previously any POST behind next-compat middleware got an
  already-consumed body.)
- **next-intl locale is request-isolated.** `setRequestLocale`/`getLocale`/
  `getTranslations` store the active locale in the request's `AsyncLocalStorage`
  context instead of a process global, so concurrent SSR for different locales
  can no longer cross-contaminate.
- **`withHeaders` preserves multiple `Set-Cookie`.** It appends cookies (via
  `getSetCookie()`) instead of `set()`-collapsing them, so a
  `NextResponse.next()` that sets several cookies keeps them all.
- **`next/font` CSS is emitted.** `renderFontStyles()` is now wired into the SSR
  `<head>` pipeline, so `@font-face`/font stylesheet links from
  `next/font/local` and `next/font/google` actually reach the page.
- **Event-listener keys no longer collide.** Listeners are keyed by the React
  prop name, so `onChange`+`onInput` (both DOM `input`) and
  `onClick`+`onClickCapture` each keep their own handler.
- **`better-sqlite3` transaction depth** decrements exactly once even if
  `COMMIT`/`RELEASE` throws (no counter corruption); `fileMustExist` now throws
  for a missing file; `Slot` throws (like Radix) instead of silently dropping
  props when given no single element child; the ICU parse cache is bounded.
- **Compat-fidelity polish:** `react-is.isContextProvider` now recognizes a
  denext context; the ICU formatter threads `#` into nested `select` branches
  and renders missing values gracefully (empty / `other`) instead of `"NaN"`;
  `NextResponse.redirect` requires an absolute URL (like Next) and
  `NextResponse.next({ request: { headers } })` now overrides the downstream
  request headers; `ResponseCookies.get`/`getAll` return the full cookie with
  its attributes.

## [0.8.12] - 2026-08-09

### Added

- **Next.js compat entrypoints.** Alias `next/*` to denext in the import map so
  code that imports from `"next/..."` resolves to denext: `next/link`,
  `next/image`, `next/script`, `next/dynamic`, `next/navigation` (App Router
  hooks + `redirect`/`notFound`/…), `next/headers` (`cookies`/
  `headers`/`draftMode`), `next/cache` (`revalidatePath`/`revalidateTag`/
  `unstable_cache`), `next/og` (`ImageResponse`), and `next/server` (a
  `NextResponse` shim mapping to denext middleware returns, plus `userAgent`). A
  single `"next/": "jsr:@denext/denext/next/"` import-map prefix covers them
  all.
- **`denext create/init --next-compat`** — writes the React + Next import-map
  aliases into the scaffolded `deno.json`; also offered in the interactive
  multi-select.
- **React compat improvements:** a real client-side `createPortal` (renders into
  a separate DOM container via a sub-root, preserving the target's existing
  children) and **`useEffectEvent`** (React 19.2), added to the core hooks and
  the `react` shim. +17 compat tests.

  Scope note: these aliases provide **framework-API** compatibility (routing,
  Link/Image, navigation, headers/cache, basic route handlers). They do not make
  denext a drop-in for arbitrary React-ecosystem libraries that depend on
  React's reconciler internals (refs/`Slot`/`react-is`), nor for
  `NextRequest.nextUrl`/ `cookies` or `next-intl`.

## [0.8.11] - 2026-08-09

### Added

- **React compatibility via import aliases.** New entrypoints let code and
  libraries that `import ... from "react"` / `"react-dom"` run on denext by
  aliasing those specifiers in the import map (no React install):
  - `@denext/denext/react` — re-exports denext's hooks/helpers under their React
    names (`createElement`, `Fragment`, every `use*` hook, `memo`,
    `createContext`, `Suspense`, `lazy` = `dynamic`) plus compat shims for
    `forwardRef`, `Children`, `cloneElement`, `isValidElement`, and a default
    `React` object.
  - `@denext/denext/react-dom` and `@denext/denext/react-dom/client` —
    `createRoot` / `hydrateRoot` / `flushSync` plus legacy `render` / `hydrate`.
  - `@denext/denext/react/jsx-runtime` (+ `jsx-dev-runtime`) — the automatic JSX
    runtime under React's specifier.

    Caveats: function-components only (`Component`/`PureComponent` resolve but
    throw if constructed); `createPortal` is a best-effort no-op. +10 tests.
    Combined with 0.8.10's React DevTools support, the ecosystem and tooling see
    denext as React.

## [0.8.10] - 2026-08-09

### Added

- **React DevTools support.** The client reconciler now registers denext as a
  renderer with the React DevTools extension (`__REACT_DEVTOOLS_GLOBAL_HOOK__`)
  and reports its tree as React fibers on each commit — so the extension
  recognizes a denext app and shows its component tree, as if it were React.
  It's a cheap no-op when the extension isn't installed, and every call into the
  extension is guarded so a DevTools error can never affect rendering. New
  `src/client/devtools.ts`; +7 tests (registration, fiber mapping, the guard,
  and an end-to-end commit through the real reconciler).
- **`--desktop` scaffolding includes an app-icon convention** — an
  `icons/README.md` documenting where to drop `app.icns` / `app.ico` / `app.png`
  and the `desktop.app.icons` config to enable them (`deno desktop` uses a
  default icon otherwise, so packaging still works out of the box).
  `examples/native` ships a real cross-platform icon set wired into its
  `desktop` config.

### Fixed

- **`denext build` now cleans its client output dir first**, so content-hashed
  `chunk-*.js` from prior builds no longer accumulate on rebuilds.

### Documentation

- New project logo; README gains the logo, a multi-select prompt preview under
  Quick start, and a React DevTools feature bullet. Refreshed the bundle-size
  numbers (first load ~8 KB after the DevTools bridge, still ~10× under
  Next.js).

## [0.8.9] - 2026-08-09

### Changed

- **`denext create`/`init`: one multi-select instead of five yes/no prompts.**
  On a TTY, the scaffolder now shows a single checkbox list — ↑/↓ (or j/k) to
  move, space to toggle, enter to confirm — for Tailwind, the `src/` layout, the
  compiler, desktop, and mobile, with any features passed as flags pre-checked.
  Flags and `--yes` stay fully non-interactive (unchanged for scripts/CI). New
  dependency-free `src/build/multi-select.ts` with injectable terminal I/O; +7
  tests for the key handling.

## [0.8.8] - 2026-08-09

### Added

- **Native scaffolding — `denext create/init --desktop` and `--capacitor`.** The
  scaffolder can now wire up a native **desktop** app (via Deno 2.9's
  `deno
  desktop`) and/or **iOS/Android** (via Capacitor) — generating config
  files **and** the `deno task`s to drive them (not just config). Both build on
  `denext export` (static SSG to `out/`):
  - `--desktop`: a `desktop.ts` entry (`Deno.serve()` over the static export,
    which `deno desktop` wraps in a native WebView window), a `desktop` block in
    `deno.json` (app name / bundle id), and `export` / `desktop` /
    `desktop:package` tasks.
  - `--capacitor`: a `capacitor.config.ts` (`webDir: "out"`), a `package.json`
    for Capacitor's CLI + platform packages, and `export` / `mobile:sync` /
    `mobile:ios` / `mobile:android` tasks.

    Both are offered as interactive prompts and as flags; `denext --help` lists
    them.
- **`examples/native/`** — one denext app packaged three ways (web,
  `deno desktop`, Capacitor) in a single project, with a README for each path.

### Changed

- **CI pins Deno to 2.9.5** (from a floating `v2.x`) so `deno fmt`/`deno lint`
  are reproducible between contributors and CI. Bump deliberately (e.g. to 3.x
  for stable KV) and re-run `deno fmt` when moving.

## [0.8.7] - 2026-08-09

### Performance

- **Static routes now ship zero JavaScript.** A page route with no interactivity
  anywhere in its tree — no state/effect/ref/context hooks, no DOM event
  handlers, no `dynamic()` island — is served as pure server-rendered HTML with
  **no client bundle and no hydration script**. The build detects these by
  scanning each route's whole transitive import graph and is deliberately
  conservative: any interactivity signal, or any uncertainty (unreadable module,
  failed crawl), errs toward hydrating, so an interactive page is never
  mis-classified as static. A `<Link>` on a static page still works (a plain
  anchor; a soft navigation _into_ the page from an interactive page also still
  works). New `src/build/hydration.ts` (`routeNeedsHydration`); the build
  records `staticRoutes` in `manifest.json`, and the prod server skips both the
  hydration script and the missing-bundle check for them. Content/marketing
  pages are now pure HTML.

### Documentation

- New **"Tiny by default"** section in the README (and a matching module-doc
  bullet) with the measured bundle-size comparison vs Next.js / React.

## [0.8.6] - 2026-08-09

### Performance

- **Client bundling now shares one runtime chunk across all routes.** Each page
  route was previously bundled in isolation, which inlined a full copy of the
  denext client runtime (~19 KB raw / ~6.9 KB gzip) into **every** route entry.
  The production build now bundles all page routes in a single code-split pass,
  hoisting the runtime into **one shared chunk** that every route references —
  downloaded once and cached across client-side navigations. On the example app,
  per-route entries dropped from ~19 KB to ~1 KB each; a navigation after the
  first page now transfers only the route's own delta (~0.6 KB gzip) instead of
  re-downloading the runtime. New `bundleRoutes()` in `src/build/bundle.ts`; the
  dev server's on-demand per-route bundling is unchanged. Added a bundle-budget
  regression test.

## [0.8.5] - 2026-08-09

### Documentation

- **A real landing page on JSR.** The `@denext/denext` package Overview on JSR
  renders the main entrypoint's module doc, which was a single sentence plus one
  `renderToString` example. Rewrote `mod.ts`'s `@module` doc into a proper
  overview: what denext is and why (no npm / no React, App Router parity,
  security-first, Deno-native), a quick-start App Router example, and the list
  of entrypoints. No code or API changes.

## [0.8.4] - 2026-08-09

Continues the Next.js security-parity work against the most recent disclosures
(the July 2026 Next.js release), fixing one real gap it surfaced and restoring
the JSR documentation score. No breaking changes.

### Security

- **`cachedFetch`: the cache key now reflects a non-string request body.** The
  key is derived from the call arguments via `JSON.stringify`, under which a
  `Blob`/`FormData`/`ArrayBuffer`/`URLSearchParams`/stream body all serialize to
  `"{}"` — so two calls to the same URL with **different** such bodies could
  collide onto one cached entry (response-body cache confusion, the class behind
  Next.js CVE-2026-64648 / CVE-2026-64647). denext now buffers a non-string body
  to bytes before keying, so distinct bodies get distinct entries. String bodies
  were already keyed correctly.

### Added

- **More Next.js-parity probes** (`tests/nextjs-cve-parity.test.ts`, now 23):
  the July 2026 disclosures — rewrite/redirect SSRF via a request-built
  destination host (CVE-2026-64645; denext never proxies a rewrite, so it
  re-routes by pathname and cannot reach out), Server Action redirect SSRF
  (CVE-2026-64649; denext returns a client 3xx, never a server-side fetch), i18n
  middleware/proxy bypass (CVE-2026-64642; middleware runs on locale-prefixed
  paths), and the `cachedFetch` body-keying regression test above.

### Fixed

- **JSR module-doc score:** `src/runtime/compiler-runtime.ts` (the
  `denext/compiler-runtime` entrypoint) carried its module doc as a `//`
  comment, which JSR does not recognize as a module doc — dropping the package
  score to 94%. Converted it to a `/** … @module */` block so all entrypoints
  are documented again.

### Documentation

- **Two more security-responsibility callouts** (README): include the locale in
  a middleware `matcher` under i18n (a `/admin` matcher does not catch
  `/fr/admin`), and do not build a redirect/rewrite destination **host** from
  request input (open redirect; rewrites still can't SSRF in denext).

## [0.8.3] - 2026-08-09

Security-parity release. denext was tested against the adversary's exact moves
from Next.js's most serious and hardest-to-fix vulnerabilities; every class
bounced off, and the exercise surfaced one small parser bug (now fixed). No
breaking changes.

### Security

- **`safeFetch` response parser: strict `Content-Length` framing.** The
  hand-rolled HTTP/1.1 client (added in 0.8.2) parsed the `Content-Length`
  header with `Number()`, which coerces an empty/blank value to `0` (truncating
  the body to empty) and `"0x10"` to hex `16`. It now requires a plain
  non-negative integer, so a malformed or hostile origin can't cause a
  blank/mis-framed body. Found by the new parser-fuzzing tests.

### Added

- **Next.js-issue parity test suite** (`tests/nextjs-cve-parity.test.ts`): 13
  live exploit attempts mirrored from real Next.js CVEs — middleware auth bypass
  via `x-middleware-subrequest` (CVE-2025-29927), cache poisoning via a data/RSC
  variant and via non-200/empty responses (CVE-2024-46982 / CVE-2025-32421 /
  CVE-2025-49826), open-redirect + CRLF response splitting, static-file path
  traversal (CVE-2024-51479 class), image-optimizer SSRF + DNS rebinding,
  SVG-XSS via the image endpoint, and Server Action CSRF (CVE-2024-34351 class).
  Each fires the exact payload at denext's equivalent surface and asserts it is
  refused.
- **Response-parser hardening tests** (`tests/safe-fetch.test.ts`): fuzz
  coverage for `parseHttpResponse`/the chunked decoder — lying/blank
  Content-Length, request-smuggling framing (Transfer-Encoding precedence over
  Content-Length), oversized declared chunk sizes (no
  over-read/over-allocation), chunk extensions, non-hex chunk sizes, bare-LF and
  missing terminators, malformed status lines, and invalid header names.

### Changed

- **CI: split the heavy build/bundle tests into a parallel `integration` job and
  cache Deno dependencies.** The subprocess-spawning integration tests
  (example-app builds, scaffold type-checking, Flight/static-export bundling)
  moved to `tests/integration/` and now run as their own CI job alongside the
  fast unit suite, shortening the critical path; both jobs cache
  `~/.cache/deno`. New tasks: `deno task test:unit` / `test:integration`
  (`deno task test` still runs both). The test tasks also run with `--parallel`
  (~40% faster wall-clock locally and in CI; e2e stays sequential).

### Documentation

- **Security responsibilities** (README + `redirect()` JSDoc): the middleware
  `redirect()` helper emits its location verbatim (validate or normalize a
  user-controlled target with `safeRedirectLocation`; config-driven
  `redirects()` are already same-origin-normalized), and
  `absoluteUrl`/`requestOrigin` derive the origin from the spoofable `Host`
  header by default (set `canonicalOrigin` for a fixed origin).

## [0.8.2] - 2026-08-09

### Added

- **`safeFetch` — an SSRF-safe `fetch` for untrusted URLs** (exported from
  `denext/server`). Use it instead of `fetch()` whenever the destination is
  influenced by an end user (link previews, "import from URL", avatar-by-URL,
  webhooks). It resolves the host, **refuses any request whose resolved address
  is loopback/private/link-local**, and connects to the pinned IP with the
  original Host/SNI (closing DNS rebinding). Supports method/headers/body, an
  optional host allowlist (`*.domain` wildcards), per-hop-revalidated redirects,
  byte/time limits, and an `AbortController` `signal`; failures throw a typed
  `SafeFetchError`. (Do not use it to reach your own internal services — that's
  what `fetch`/`cachedFetch` are for.)

### Security

- **Image optimizer: DNS-rebinding protection (closes the residual SSRF gap from
  0.8.1).** Remote sources are no longer fetched by hostname and left to
  `fetch()`'s own DNS resolution. denext now resolves the host itself, **rejects
  the fetch if any resolved A/AAAA record is
  loopback/private/link-local/CGNAT/multicast**, and connects to that pinned IP
  while preserving the original `Host` header and TLS SNI (so certificate
  validation still holds and there is no second, rebindable resolution). An
  allowlisted hostname whose DNS points at an internal address (e.g. cloud
  metadata) is now refused. Implemented as a small SSRF-safe HTTP/1.1 GET client
  (`src/server/safe-fetch.ts`) with time and size bounds; the resolver and
  socket are injectable, so the path is fully unit-tested without network
  access.

## [0.8.1] - 2026-08-09

Security hardening from two independent reviews of 0.8.0. No breaking changes.

### Security

- **XSS via lowercase `on*` handler attributes.** The SSR attribute serializer
  only stripped React-style camelCase handlers (`onClick`), so lowercase
  HTML-native names (`onmouseover`, `onerror`, …) spread from untrusted props
  (`<div
  {...untrusted}>`) were emitted as live event-handler attributes. The
  handler filter is now case-insensitive, and `isValidAttrName` rejects any
  `on*` name — a single chokepoint covering all three SSR renderers **and** the
  client reconciler's `setAttribute`.
- **Image-optimizer SSRF via redirects.** The optimizer validated only the
  initial URL, then followed redirects automatically — an allowlisted host could
  redirect to cloud metadata (`169.254.169.254`), loopback, or a private
  service. Redirects are now followed manually with the full policy re-checked
  on **every** hop: allowlist, http(s) only, a redirect cap, and rejection of
  loopback/private/link-local/CGNAT/ multicast IP literals (v4 and v6, incl.
  IPv4-mapped). (DNS rebinding — an allowlisted host resolving to a private
  address — remains out of scope; keep the allowlist to trusted hosts.)

### Fixed

- **Image endpoint resource limits.** Remote fetches now have a timeout and a
  max download size (declared and streamed); decoded sources are rejected past a
  dimension/pixel cap before resizing (decompression-bomb guard).
- **Server Action request body limit.** Oversized bodies are rejected (413)
  before the handler runs — a declared-`Content-Length` fast path plus a hard
  cap on the buffered body (covers chunked requests). Configurable via
  `actionMaxBodyBytes` (default 10 MiB).
- **CSRF origin check is now scheme-aware.** An `http` Origin is rejected for a
  known- HTTPS app (determined via `canonicalOrigin`, a trusted
  `X-Forwarded-Proto`, or the request URL); full-origin `allowedOrigins` entries
  match scheme-strictly. Bare-host entries stay scheme-agnostic for
  compatibility, and proxied deployments where the scheme is unknown keep the
  prior host-only behavior (no regression).
- **Static serving blocks symlink escapes.** A symlink inside `public/` that
  resolves outside it (via `Deno.realPath`) is no longer served; symlinks that
  stay within `public/` still work.

## [0.8.0] - 2026-08-09

Developer-experience and scaling release: a project scaffolder, first-class
Tailwind, an optional `src/` layout, configurable remote-image optimization, the
deferred operational features from 0.7.1, a memoization foundation, and an
experimental React-Compiler-style auto-memo pass. No breaking changes.

### Added

- **`denext create` / `denext init` scaffolder.** `create <dir>` generates a
  clean starter into a new/empty directory; `init` scaffolds into the current
  (possibly non-empty) directory without ever overwriting existing files. Both
  prompt interactively (or take `--tailwind`, `--src-dir`, `--compiler`,
  `--yes`) and wire up `deno.json`, an `app/` with a hydrating example page, and
  `.gitignore`.
- **Tailwind CSS, driven by denext.** Set `tailwind: { input, output }` in
  `denext.config.ts` and denext downloads and manages the Tailwind v4
  _standalone_ binary (zero npm — a build-time tool like the lightningcss wasm)
  and compiles your stylesheet automatically on `dev`/`build`. Override the
  binary with `TAILWIND_BIN` or the version with `DENEXT_TAILWIND_VERSION`.
- **Optional `src/` directory layout** (Next.js parity). When `src/app` exists,
  the app, middleware, and instrumentation live under `src/`; `public/`, config,
  and `.denext` stay at the project root.
- **Configurable remote image optimization.**
  `images: { domains, remotePatterns }` in `denext.config.ts` allowlists remote
  sources for the `/_denext/image` endpoint (exact hosts, or
  protocol/host-wildcard/pathname patterns). Remote sources remain refused by
  default (local-only, SSRF-safe).
- **Operational hooks (deferred from 0.7.1).** `onRequest(info)` for per-request
  logging/metrics (plus a `DENEXT_LOG=1` default logger), a per-request
  `requestTimeout` (→ 503), and cache single-flight (stampede protection) for
  both the data cache and the ISR page cache — coordinating waiters only, never
  sharing a live per-user render.
- **Memoization foundation.** The client reconciler now bails out of
  re-rendering a component whose props are shallow-equal and whose visible
  context is unchanged (context changes still reach deep consumers correctly).
  New `memo(Component,
  areEqual?)` HOC and `useMemoCache` primitive, plus a
  `denext/compiler-runtime` entrypoint.
- **Experimental auto-memo compiler** (`experimental: { compiler: true }`,
  default off). A build-time pass that lifts JSX component elements into
  `useMemoCache`-guarded memo calls so unchanged subtrees keep a stable
  reference and skip re-render. It runs only on the client bundle (server output
  is unchanged), is conservative (bails to identity on anything it cannot
  analyze), and is proven equivalent + effective by tests. Enable with
  `denext create --compiler`.

### Changed

- The `denext/rules-of-hooks` lint rule now also flags a hook called after a
  conditional early return (it may be skipped on some renders).

## [0.7.1] - 2026-08-09

Production-readiness fixes from a three-lens (correctness / operations /
security) review of 0.7.0. Two of the defects were in 0.7.0's own new features.

### BREAKING

- **`request` removed from `PageProps`.** The raw `Request` is no longer passed
  to page components, `metadata`/`generateMetadata`, or `generateViewport`.
  Reading per-request data off it bypassed the cache-safety tripwire, so a
  personalized render could be cached under a shared key and served to other
  users. **Migration:** read per-request data through `cookies()` / `headers()`
  from `denext/server` (both mark the render dynamic, so it is correctly
  excluded from the cache). `params` and `searchParams` are unchanged (they are
  part of the cache key and safe to read).

### Security

- **Cross-user cache disclosure** via the `request` prop — closed by the
  breaking change above (affected the in-memory page cache too; the shared KV
  cache made it cross-replica).
- **Host-header `og:image` cache poisoning.** When `og:image` is auto-populated
  from a dynamic `opengraph-image` route and no `canonicalOrigin` is configured,
  the URL is derived from the request `Host`; the render is now marked dynamic
  so a poisoned value can't be cached and served to everyone. Set
  `canonicalOrigin` to re-enable caching for such pages.

### Fixed

- **Cache is now fail-safe.** A `CacheStore` error (KV outage, a page body over
  Deno KV's 64 KiB value cap, a non-cloneable value) no longer 500s the request:
  reads degrade to a live render and writes are skipped, both logged
  (throttled). Applies to `unstable_cache`/`cachedFetch` and the ISR page cache.
- **Dev hydration-mismatch false positives.** The 0.7.0 diagnostic warned on
  nearly every page (`Count: {n}`): SSR coalesces adjacent text into one node
  while the client splits it. The reconciler now splits and adopts the coalesced
  node cleanly — no warning — while still reporting genuine divergences. A
  boundary that re-suspends during hydration no longer warns either (its
  fallback mounts fresh).
- **`after()` no longer blocks the response.** Deferred callbacks (and deferred
  cache invalidations) drain after the response is produced, not before it.
- **Un-awaited `revalidateTag`/`revalidatePath` under an async store.** Inside a
  request, the invalidation is registered on the request's deferred queue so it
  drains before the isolate can be reclaimed; awaiting is documented as required
  for a fully-consistent result with an async store.
- **`deno bundle` probe no longer caches a transient failure**, which had
  permanently bricked a long-lived dev server after one spawn hiccup.
- **Bundler resolves root-relative (`/`) import-map paths** to absolute in the
  merged config (previously only `./`/`../`).
- **KV index markers stay bounded**: overwriting an entry drops the markers it
  no longer carries, so re-tagging a non-TTL entry can't leak index keys.
- **Prod server validates the build at startup** — a missing client entry now
  fails fast instead of a page that SSRs but silently never hydrates.
- **Dev file-watcher and live-reload streams close on shutdown**; concurrent
  first-hits for the same route are coalesced so duplicate `deno bundle`
  subprocesses aren't spawned.

### Added

- **`/_denext/health` reports cache reachability** (`{ status, cache }`) — still
  200 for liveness (the site serves even during a cache outage), with
  `cache: "degraded"` surfacing a backend problem to operators. New
  `cacheStoreHealthy()` export.

### Deferred to 0.8

Three net-new operational features from the review are intentionally not in this
patch: opt-in structured request logging/metrics, a per-request
timeout/deadline, and cache-miss single-flight (stampede protection).

## [0.7.0] - 2026-08-08

A production-maturity release that closes the architectural gaps left open after
0.6.1: shared multi-replica caching, a real-browser test suite, hydration
diagnostics, and hardening of the experimental `deno bundle` dependency.

### Added

- **Pluggable shared cache (`CacheStore`) + Deno KV adapter.** The data cache
  and ISR page cache now sit behind a `CacheStore` interface (mirroring
  `setDraftTokenStore`). `setCacheStore(store)` swaps the backend for all
  subsequent operations; the default stays in-memory. A built-in
  `denoKvCacheStore()` backs both caches with Deno KV, so a render or cached
  data entry produced on one replica is served by another and `revalidateTag` /
  `revalidatePath` reach every instance. New exports from `denext/server`:
  `setCacheStore`, `inMemoryCacheStore`, `denoKvCacheStore`, and the
  `CacheStore` / `DataEntry` types.
- **Real-browser E2E suite.** `deno task test:e2e` builds and serves
  `examples/hello` and drives it with a headless Chromium (via `@astral/astral`,
  a test-only dependency — never in the runtime graph, excluded from publish).
  It verifies the SSR→hydration round-trip the in-memory DOM tests cannot: the
  pre-hydration flag flips, the counter is interactive, a
  `dynamic({ ssr: false })` island is code-split and mounted client-side,
  `<Link>` navigation is a true SPA swap, and no console errors occur. Excluded
  from `deno task test`/`check`.
- **Dev-only hydration-mismatch warnings.** The client reconciler now warns (dev
  server only) when server and client markup disagree — a mismatched tag, a
  swapped node, or divergent text — instead of silently patching it. Gated on
  the live hydration cursor, so intentional divergences
  (`dynamic({ ssr: false })`, resolved Suspense, error fallbacks) never trigger
  false positives. Zero cost and fully silent in production.
- **`deno bundle` version guard + build smoke test.** `build`/`dev` now verify
  the resolved `deno` is new enough for the (experimental) `bundle` subcommand
  and fail with an actionable message (`DENO_BIN` hint) on a missing/old binary,
  instead of a cryptic bundle error. A full-build smoke test asserts the on-disk
  artifact shape (client entry + code-split chunks) as a tripwire against
  `deno bundle` output drift.

### Fixed

- **Page-cache tag invalidation.** ISR page-cache entries now inherit the tags
  of the cached data (`unstable_cache`/`cachedFetch`) read during their render,
  so `revalidateTag(tag)` purges the page and not just the underlying data.
  Page-cache writes previously stored no tags, making tag-based page
  invalidation a no-op.
- **Bundling from a project with relative import-map paths.** The bundler now
  resolves a base config's relative `imports` (e.g. `denext` → `../../mod.ts`)
  to absolute when writing its merged config to a temp dir, fixing
  `Module not found` failures when a route imported CSS (the merged-config
  path).

### Changed

- The ISR page cache is now async end to end (`PageCache.get`/`set` return
  promises) so it can be backed by a remote store;
  `revalidateTag`/`revalidatePath` now return a `Promise` you may await (the
  in-memory default still applies synchronously, so existing non-awaited calls
  keep working).

## [0.6.1] - 2026-08-08

A hardening release: a security fix plus the concrete production-readiness
blockers found in a post-0.6.0 review. No API changes.

### Security

- **Open redirect (protocol-relative `Location`).** `trailingSlash`
  normalization and path-preserving config `redirects()` (a `:path*` capture
  reflected into the destination) built a `Location` from request-path data
  without neutralizing protocol-relative (`//host`) or backslash (`/\host`)
  prefixes, which browsers resolve cross-origin. New `safeRedirectLocation()`
  preserves explicit `http(s)://` external redirects but forces everything else
  to a single-slash same-origin path; applied to all redirect sites. Regression
  tests added.

### Fixed

- **Graceful shutdown.** The CLI now traps `SIGINT`/`SIGTERM` (`SIGBREAK` on
  Windows) and aborts an `AbortController` wired into `Deno.serve`, so in-flight
  requests drain on deploy / pod termination instead of being dropped. The CSS
  re-exec forwards the signal to its child process.
- **Unbounded caches (memory-exhaustion).** The ISR `PageCache` and the
  `unstable_cache` / `cachedFetch` data store are now bounded LRUs, so
  high-cardinality keys (e.g. many distinct query strings) can no longer grow
  them without limit.
- **Image endpoint re-encoding.** `/_denext/image` now serves from a
  byte-bounded (64 MB) LRU of encoded webp output keyed on `src`+width, instead
  of decoding/resizing/re-encoding on every request.
- **Silent config failure.** A malformed `denext.config.ts` now fails fast with
  a clear error instead of silently dropping `basePath`/redirects/**security
  headers**.
- **Compiled-binary CSS.** A `deno compile`d binary now warns loudly that it
  cannot apply the CSS import map (`import "./x.css"` would fail), instead of
  failing silently at runtime.

### Added

- **`/_denext/health`** — a liveness/readiness probe endpoint for load balancers
  and Kubernetes.

### Notes

- Known limitations unchanged from 0.6.0 (see below), plus: ISR/data caches and
  `revalidatePath`/`revalidateTag` remain process-local — multi-replica
  deployments should front denext with a CDN and treat per-instance cache
  windows accordingly (a shared-store seam is planned).

## [0.6.0] - 2026-08-08

The "real CSS pipeline + Next.js parity" release: a genuine CSS Modules / global
CSS build (full `lightningcss` semantics) on a bundler-less Deno server, true
code-split `next/dynamic`, `next.config`-style redirects/rewrites/headers, a
complete Metadata + `generateViewport` API, and a batch of utility helpers.

### Added

- **Real CSS pipeline (CSS Modules + global CSS + Tailwind).**
  `import s from
  "./x.module.css"` yields scoped, hashed class names with
  `composes` and `:global` resolved; `import "./globals.css"` is extracted and
  linked. Powered by **`lightningcss` (wasm)** — the engine Parcel/Turbopack
  use. Because Deno cannot `import()` a `.css` module (and offers no runtime
  loader hook), the CLI generates a merged deno config that redirects each
  `.css` to a JS shim (the class map for modules, an empty module for globals)
  and **re-execs the module loader with `--config`**; the same import map feeds
  `deno bundle` for the browser. Extracted, transformed CSS is emitted per route
  and linked in `<head>`. Tailwind works through the global-import path (run the
  Tailwind CLI → import the output). Zero overhead for CSS-free projects.
- **`next/dynamic` — true code-splitting.**
  `dynamic(() => import("./Heavy"), {
  ssr, loading })` loads a component on
  demand as its **own bundle chunk** (via `deno bundle --code-splitting`, which
  hoists shared modules — context symbols, registries — into a common chunk so
  module identity is preserved). `ssr: false` renders the fallback on the server
  and mounts on the client; loading rides the existing Suspense machinery.
- **`denext.config` redirects / rewrites / headers + basePath / trailingSlash /
  assetPrefix.** Declarative `redirects()` (307/308 with `:param` substitution),
  `rewrites()` (internal re-route), and `headers()` (per-path response headers),
  evaluated once at startup; `trailingSlash` normalization (308); `basePath`
  (routing, asset serving, **and** client
  `<Link>`/`navigate()`/`usePathname()`); `assetPrefix` for CDN asset URLs.
- **Complete Metadata API + `generateViewport`.** `Metadata` now covers
  `twitter` cards, structured `alternates` (canonical + `hreflang`),
  `metadataBase` (resolves relative og/twitter images), structured `icons`
  (icon/shortcut/apple), `robots` as an object, `authors`, `verification`, and
  multi-image `openGraph.image` with width/height/alt. New `viewport` /
  `generateViewport` exports drive the viewport, `theme-color`, and
  `color-scheme` tags.
- **File-based metadata icons.** `app/icon.*`, `app/apple-icon.*`, and
  `app/twitter-image.*` (static images or dynamic `.tsx` modules) are
  auto-served at `/icon`, `/apple-icon`, `/twitter-image` and auto-injected as
  `<link rel="icon">` / `apple-touch-icon` / `twitter:image` — zero-config.
- **`next/og` `ImageResponse`** — render JSX to a PNG (satori flexbox layout →
  SVG → resvg raster, via `@cf-wasm/og`, which bundles a font and inlines its
  wasm). Returns a `Response` that flows through the `opengraph-image`
  convention.
- **Self-hosted image optimization** — a built-in `/_denext/image` endpoint
  (decode → resize → webp, via `@cf-wasm/photon`) for local `public/` assets;
  remote sources require an explicit host allowlist (SSRF-safe). `<Image>` gains
  a `loader` prop (`denextImageLoader` targets the endpoint), a generated
  responsive `srcSet` from a widths list, and `placeholder="blur"` +
  `blurDataURL`.
- **`next/font/google`** — `googleFont({ family, weights, styles })` fetches the
  Google Fonts CSS2 stylesheet and returns the same `FontResult`/`FontFace`
  shape as `localFont`.
- **`after()`** — schedule work to run after the response (drained on every exit
  path; throws are logged, not propagated).
- **`userAgent(request)`** — a stdlib UA parser (browser / OS / device / engine
  / bot detection).

### Deferred

- Image optimization covers local `public/` assets by default; remote sources
  need an explicit host allowlist.

### Notes

- New build/server-time dependencies (never enter the client bundle):
  `lightningcss-wasm` (CSS), `@cf-wasm/og` (ImageResponse), `@cf-wasm/photon`
  (image optimization).
- Dev limitation: adding a **new** `.css` file needs a dev restart (editing
  existing ones hot-reloads), because the server CSS import map is fixed at
  boot.

## [0.5.0] - 2026-08-08

The React Server Components release: a real `"use client"`/`"use server"`
boundary built bundler-lessly on Deno, plus the App Router features that were
previously shipped scoped-down. Server Actions folded into `"use server"` are
built with the same defensive posture as 0.4.0 (Next.js's worst CVEs were here).

### Added

- **Flight / RSC boundary (`"use client"` / `"use server"`)** — a true Server
  Components boundary with no third-party bundler. The server still SSRs client
  modules for first paint but emits them as **references** in a **Flight**
  payload (`#__denext_flight` island); only client modules ship to the browser.
  Directives are parsed by a real tokenizer (not a regex), the app-wide
  client/server split is discovered by crawling Deno's own module graph
  (`deno info`), and client islands are tagged as references via ESM singletons.
  `"use server"` exports auto-register and are stripped from the browser bundle
  by redirecting each server module to a generated client stub through a
  `deno bundle` import map — proven by byte-grep tests that server-component and
  server-action code are **provably absent** from the client bundle. `useId` is
  re-based per island so hydration ids stay aligned; streaming Flight
  interleaves boundary rows. Undirected modules stay **isomorphic** (opt-in,
  fully backward compatible). `serverAction("id", fn)` still works. The default
  remains the whole-tree isomorphic hydration for routes with no boundary.
- **Parallel routes done right** — `@slot` folders become full routable subtrees
  (their own segments, dynamic params, `layout`/`loading`/`error`), matched
  against the current URL with a new **`default.tsx`** convention, and
  **layout-scoped** so a slot spans every route under its layout (the canonical
  `@modal/(.)photo/[id]` intercept-in-slot modal works on soft nav).
- **Layout-relative `useSelectedLayoutSegment(s)`** — each layout now sees only
  the path segments **below its own level** (route groups add no depth), via a
  segment-depth provider wrapped around each layout on both server and client.
- **Dynamic OG images** — an `opengraph-image.{tsx,ts,jsx,js}` convention served
  at `/opengraph-image`. The default export may return an **SVG VNode**
  (serialized to `image/svg+xml`, no rasterizer dependency), a **`Uint8Array`**
  (served `image/png` — bring-your-own rasterizer), or a **`Response`**
  (verbatim). `og:image` auto-populates to its absolute URL when a page sets
  none.
- **`useTranslations()`** — a real message-catalog hook. `I18nConfig.messages`
  maps locale → catalog; the active catalog is provided to SSR and embedded in
  the hydration payload, so `t("greeting", { name })` interpolates `{var}`
  placeholders server-side and on the client (re-read on soft navigation).
  Correct under the Flight boundary too.
- **`instrumentation.ts`** — a project-root module exporting `register()` (run
  once at server boot, for tracing/metrics/error-reporting setup) and/or
  `onRequestError(error, request, context)` (called for each server-side request
  error, e.g. to forward to Sentry). Wired into the dev and production servers;
  both hooks are optional, may be async, and are invoked defensively so a
  failing hook never takes the server down. Errors are reported exactly once.
- **`.env` file support with client/server isolation** — `loadEnv` reads `.env`
  then `.env.local` (later wins; real shell vars win unless `override`) into
  `Deno.env`, wired into `dev`/`build`/`export`/`start`. Only variables prefixed
  **`NEXT_PUBLIC_`** (Next.js-compatible) or **`DENEXT_PUBLIC_`** are exposed to
  the browser — embedded in a `#__denext_public_env` island and read by the
  isomorphic `publicEnv()`; server-only variables never reach the client through
  this channel. Also `parseEnv`, `isPublicEnvKey`, `filterPublicEnv`.
- **Hardening & loose ends** — a **pluggable draft-token store**
  (`setDraftTokenStore` / `DraftTokenStore`) for multi-instance deployments
  (default in-memory; server-minted-token security preserved); **`<html lang>`**
  now reflects the active locale; and an **absolute-URL helper**
  (`requestOrigin` / `absoluteUrl`).

### Security

- **Directive scan can't be hidden by a banner** — `readDirective` now grows its
  read window until the module's directive prologue is conclusively resolved,
  instead of reading a fixed 1 KB head. A license banner longer than the window
  could previously hide a `"use server"` directive, failing open and leaking the
  server module into the client bundle.
- **`X-Forwarded-*` untrusted by default** — `requestOrigin`/`absoluteUrl` (used
  to auto-populate `og:image`) now ignore `X-Forwarded-Proto`/`-Host` unless a
  deployment opts in via `trustForwardedHeaders` (trusted reverse proxy) or pins
  the origin with `canonicalOrigin`, closing a header-spoofing vector.

## [0.4.0] - 2026-08-07

Server-first features: mutations, caching, and SEO — with Server Actions built
defensively (Next.js's worst CVEs were here).

### Added

- **Route segment config** — page/layout modules may `export const dynamic`,
  `revalidate`, `dynamicParams`, `runtime`, etc. The effective config is merged
  down the layout chain (shortest `revalidate` wins) and drives static/dynamic
  rendering; the static export skips `dynamic: "force-dynamic"` routes.
- **Data cache & Incremental Static Regeneration** — `cache()` (per-request
  memoization), `unstable_cache` + `cachedFetch` (cross-request TTL + tags), and
  `revalidatePath`/`revalidateTag`. The production server serves a rendered
  **page cache** for routes that opt in via `revalidate`/`force-static`; the
  default (`dynamic: "auto"`, `revalidate: false`) is **never cached**, so pages
  reading `cookies()`/`headers()` stay per-request.
- **Server Actions** — `serverAction(id, handler)` registers a server function
  dispatched over `POST /_denext/action/<id>`, usable as a `<form action>` (with
  no-JS **progressive enhancement**) or via `useActionState`. **Security:**
  every action request is enforced **same-origin** (Origin, then Referer, deny
  when absent) as a CSRF defense; POST-only; only registered ids resolve;
  handler errors are logged server-side but returned to the client as a generic
  message; redirects are forced to 303 and the no-JS redirect target is
  restricted to a same-origin path. Plus `serverOnly()`/`clientOnly()` boundary
  guards.
- **Metadata files** — `app/sitemap.ts` → `/sitemap.xml`, `app/robots.ts` →
  `/robots.txt`, `app/manifest.ts` → `/manifest.webmanifest`, and
  `app/favicon.ico`.
- **Document metadata hoisting** — render `<title>`/`<meta>`/`<link>` anywhere
  in the tree (React 19); they are hoisted into `<head>` during SSR (in-tree
  `<title>` wins over the `metadata` export).
- **Asset & navigation ergonomics** — `<Image>`
  (lazy/async/`priority`/`srcSet`), `<Script>` strategies, `localFont` +
  `<FontFace>` (`@font-face`), `useParams()`, `<Link prefetch>` (hover +
  viewport prefetch with a client HTML cache), and `draftMode()` (httpOnly
  preview cookie).

## [0.3.0] - 2026-08-07

Four "owns-both-halves" wins — things possible because denext owns the
reconciler, the router, the middleware runner, **and** the linter together.

### Added

- **Composable, ordered middleware** — `middleware.ts` / `proxy.ts` may now
  export an **ordered array** of handlers (or `{ handler, config }` entries)
  instead of a single function. They run in order: a `Response` short-circuits
  the chain, a `rewrite()` threads its URL into every later entry, and
  `next({ headers })` accumulates headers across the chain. Per-entry
  `config.matcher` gates individual entries. New `composeMiddleware()`;
  single-function exports keep working unchanged. 7 tests.
- **i18n routing (optional default-locale prefix)** — `/about` serves the
  default locale, `/fr/about` serves `fr`; the locale is peeled at request time
  (the router core is untouched) and merged into route `params`, so pages,
  layouts, templates, and client hydration all see `params.locale`. New
  `useLocale()` client hook, `peelLocale`, `detectLocale`/`parseAcceptLanguage`,
  and a ready-made `localeMiddleware` (cookie + `Accept-Language` negotiation)
  that composes into the chain above. Config comes from a `serve({ i18n })`
  option or a `denext.config.{ts,js}` export; static export emits one variant
  per locale. 10 tests.
- **Convention registry + parallel & intercepting routes** —
  - The scanner's hardcoded file-convention regexes are now a **table-driven
    registry** with a `registerConvention()` seam and a post-scan
    `registerRouteSynthesizer()` hook (extension points for derived routes). A
    golden-manifest test locks scanner output so the refactor is provably
    behavior-preserving.
  - **Parallel routes** — `@slot` folders are collected and rendered into the
    nearest layout as **named props** (server and client), without creating
    standalone routes.
  - **Intercepting routes** — `(.)`, `(..)`, `(..)(..)`, and `(...)` folders are
    parsed (fixing a bug where `(..)` was mis-stripped as a route group) and
    match **only on soft navigation** (via the existing `x-denext-nav` header);
    a hard load falls through to the real route. 8 tests.
- **Error-boundary superpowers** — beyond what React can do:
  - `useErrorBoundary()` returns `{ reset, captureError }` — `captureError(e)`
    routes an error (including async/`setTimeout` failures) to the nearest
    boundary's fallback; `reset()` retries its children.
  - Errors thrown in **event handlers and form actions** are caught and routed
    to the nearest boundary (React silently drops these). A rejected async
    handler/action is routed too.

  6 tests.

### Fixed

- **Client error boundaries no longer swallow control signals.** `redirect()`,
  `notFound()`, `forbidden()`, and `unauthorized()` thrown during client render
  now bubble past `<ErrorBoundary>` (matching the server renderer) instead of
  rendering the error fallback. A `redirect()` from an event handler performs a
  client navigation rather than showing a fallback.

## [0.2.0] - 2026-08-07

### Added

- **React 19 hook parity** — `useId` (deterministic across server render and
  client hydration), `useSyncExternalStore`, `useLayoutEffect`,
  `useDeferredValue`, `useTransition`/`startTransition`, and
  `useImperativeHandle` (with React 19 **ref-as-prop** — components receive
  `ref` in props, no `forwardRef`). Context objects are now usable **directly as
  a provider element** (`<MyContext value={v}>`, React 19 style) in addition to
  `<MyContext.Provider>`. (`useTransition`/`useDeferredValue` are simplified,
  non-interruptible approximations in this synchronous renderer.) 11 tests.
- **Router completeness** — new App Router special files and helpers:
  - `template.tsx` (wraps like a layout, conceptually re-mounted),
    `global-error.tsx` (replaces the whole tree on an uncaught render error →
    500).
  - `forbidden()` / `unauthorized()` control signals (like `notFound()`) that
    render `forbidden.tsx` / `unauthorized.tsx` (nearest up the tree) with a
    real `403` / `401`; they bubble past error boundaries.
  - `useSelectedLayoutSegment()` / `useSelectedLayoutSegments()` (reactive;
    simplified, not layout-relative). The manifest scanner and client entry were
    extended to cover the new files. 7 tests.
- **Server ergonomics** — `redirect()`/`permanentRedirect()` control signals
  (throw from a server component → `307`/`308`), and a per-request async context
  (Deno `AsyncLocalStorage`) powering `cookies()` and `headers()` from
  `denext/server` (read request cookies/headers; `cookies().set()`/`delete()`
  queue `Set-Cookie` on the response). Added the client `useOptimistic` hook. 6
  tests.
- **Form actions** — the React 19 `useActionState` and `useFormStatus` hooks,
  plus `<form action={fn}>` interception (submit calls the action with the
  form's `FormData`). Actions run on the client (typically calling a route
  handler); denext does **not** implement Next.js's bundler-transformed
  `"use server"` RPC. 4 tests.
- **Static generation & SEO** — `denext export` pre-renders the whole app to a
  static, host-anywhere directory (`out/`): every page plus dynamic routes
  enumerated by `generateStaticParams`, with client bundles and `public/` assets
  copied in (still hydratable). Added `generateMetadata` (async) support and an
  expanded `Metadata` type (`keywords`, `robots`, `canonical`, `openGraph`,
  `icon`) rendered into `<head>`. 4 tests.

## [0.1.2] - 2026-08-07

### Fixed

- **JSR module-doc detection** — `jsx-runtime.ts`'s top JSDoc lacked an
  `@module` tag, so deno doc attached it to the first export instead of treating
  it as a module doc, failing JSR's "module docs in all entrypoints" check
  (`./jsx-runtime` and `./jsx-dev-runtime` both map to this file). Added the
  tag; all entrypoints now expose a recognized module doc.

## [0.1.1] - 2026-08-07

### Security

- **Fixed an XSS via unsafe attribute names in SSR and hydration.** An attribute
  name containing tag/attribute-delimiter characters — reachable when a
  component spreads untrusted keys, e.g. `<div {...untrusted}>` — could break
  out of the tag and inject markup. `serializeAttributes` (server) and the
  client reconciler now drop names failing `isValidAttrName` (rejects
  whitespace, quotes, `< > / =`, and control characters;
  `data-*`/`aria-*`/`xml:lang` stay valid). Attribute _values_ were already
  escaped; this closes the name vector. Added 5 security regression tests.

### Added

- **Full API documentation** — JSDoc on every exported symbol across all public
  entrypoints and module docs on each entrypoint (`deno doc --lint` is clean),
  taking JSR documentation coverage to 100%.
- **CI & release automation** — a GitHub Actions `CI` workflow (fmt / lint /
  type-check / tests / `deno doc --lint`) and a `Publish to JSR` workflow that
  runs on `v*` tags with `id-token: write`, so releases carry **build
  provenance**.

## [0.1.0] - 2026-08-07

### Added

- **`denext` executable + packaging**:
  - `deno task compile` produces a standalone `denext` binary via
    `deno compile`. Fixed the compiled case where bundling shelled out to the
    wrong executable — `denoExecutable()` now resolves the real `deno` (via
    `DENO_BIN`, `~/.deno/bin/deno`, or `PATH`) instead of `Deno.execPath()`
    (which is `denext` in a compiled binary). `start` runs fully standalone;
    `dev`/`build` still need a `deno` for client bundling.
  - Exposed `./cli` and `./lint-plugin` exports, so
    `deno install`/`deno run jsr:@denext/denext/cli` and the lint plugin work
    from the published package.
  - Added a `publish.exclude` (tests, examples, build output, binary) —
    `deno publish --dry-run` passes with no slow-type errors, so the package is
    JSR-ready.
  - README: "The `denext` command" (install/compile/task) and "Using denext as a
    package" sections.
- **Port handling** (`src/server/serve-utils.ts`): when no `--port` is given,
  `dev`/`start` now auto-select an open port (trying 3000, 3001, … up to 10),
  logging each fallback, instead of crashing with `AddrInUse`. When `--port`
  **is** given, that exact port is required — an in-use port fails immediately
  with a clean, single-line error (exit 1). 4 tests.
- **Tooling config & clean baseline**: explicit, customizable `deno fmt`
  settings
  (`useTabs`/`lineWidth`/`indentWidth`/`semiColons`/`singleQuote`/`proseWrap`/`exclude`)
  and lint config in `deno.json`, plus `fmt`/`lint`/`check` tasks. The whole
  repo is now `deno fmt` clean and `deno lint` clean (including the denext hook
  rules).
- **Deno-native lint plugin** (`src/lint/denext-plugin.ts`): React/denext hook
  rules enforced by `deno lint` (no ESLint/npm) — `denext/rules-of-hooks` (no
  conditional hooks), `denext/hooks-in-component` (hooks only in
  components/`useX` hooks, not callbacks), and `denext/no-hooks-in-async` (hooks
  in async server components have no client effect). Wired into both `deno.json`
  files; 8 tests via `Deno.lint.runPlugin`.
- **Root not-found rendering**: unmatched page requests render the app's root
  `not-found.tsx` (within the root layout) with a `404` status, instead of a
  generic message. The manifest now tracks `rootNotFound`.
- **README + LICENSE**: full documentation (quick start, routing conventions,
  API surface, middleware, linting, architecture, limitations) and an MIT
  license. The example app (`examples/hello`) gained its own `deno.json` so it
  runs as a realistic standalone project.
- **Client-side navigation** (`src/client/navigation.ts`): SPA soft navigation
  without full reloads.
  - `<Link href>` renders a normal SSR anchor and navigates on the client;
    global click delegation also intercepts plain internal `<a>` links.
  - `navigate()` fetches the target page's server HTML, swaps the hydration
    root, updates `<title>` + history (push/replace/`popstate`), and re-runs the
    route bundle to hydrate; falls back to a full load on cross-origin or
    failure.
  - Router hooks: `useRouter()` (`push`/`replace`/`back`/`forward`/`refresh`),
    reactive `usePathname()` and `useSearchParams()`.
  - Route bundles now boot via `startClient()` (hydrate + install navigation).
- **App Router special files** (`loading.tsx`, `error.tsx`, `not-found.tsx`) and
  the primitives behind them (`src/runtime/error-boundary.ts`):
  - `<ErrorBoundary fallback>` renders a fallback (given `error` + `reset`) when
    a descendant throws during render — server (string + streaming) and client,
    with a working `reset()`.
  - `notFound()` throws a sentinel that bubbles past error boundaries to render
    the not-found UI with a real `404` status.
  - The manifest scanner captures the nearest `loading`/`error`/`not-found` per
    page (inherited down the tree); the render pipeline wraps each page in its
    error boundary and a `<Suspense>` whose fallback is `loading.tsx`; the
    client entry mirrors the same wrapping for hydration.
- **Root middleware** (`src/server/middleware.ts`): a `middleware.ts` (or
  `proxy.ts` alias) at the project root runs before routing. Handlers return a
  `Response` (short-circuit), `redirect()`, `rewrite()` (internal re-route), or
  `next()` (continue, optionally injecting response headers). Supports a
  `config.matcher` (`:name`, `:name*`, `*` patterns). Loaded by dev
  (hot-reloaded) and prod servers; exported from `denext/server`.
- **Suspense + streaming SSR** (`src/runtime/suspense.ts`,
  `src/jsx/render-to-stream.ts`): a `<Suspense fallback>` boundary, a `use()`
  primitive that unwraps promises by suspending, and `createResource()`.
  - `renderToReadableStream()` flushes the shell with each boundary's fallback,
    then streams each boundary's real content as it resolves plus an inline swap
    script — supporting multiple concurrent and nested boundaries.
  - `renderToString()` transparently resolves Suspense (no streaming).
  - Client reconciler supports Suspense: shows the fallback while a descendant
    suspends and swaps in real content when the promise settles.
- **Project scaffolding**: `deno.json` with a self-contained JSX toolchain
  (`jsxImportSource: "denext"`), standard-library-only import map, and
  dev/start/ build/test tasks. No runtime npm dependencies.
- **JSX runtime** (`src/jsx/`): a self-contained mini virtual DOM. `jsx`/`jsxs`/
  `jsxDEV`/`Fragment` for the automatic runtime, plus a classic `h()` helper. No
  React dependency.
- **Server-side rendering** (`src/jsx/render-to-string.ts`): `renderToString`
  supporting function components (sync and async), fragments, context providers,
  correct HTML escaping, void elements, boolean attributes, style-object
  serialization, and `dangerouslySetInnerHTML`.
- **Hooks** (`src/runtime/hooks.ts`): swappable-dispatcher `useState`,
  `useReducer`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useContext`,
  shared between server and (upcoming) client runtimes.
- **Context** (`src/runtime/context.ts`): `createContext` with provider/consumer
  resolution during rendering.
- **File-based router** (`src/router/`): Next.js App Router-style conventions —
  `page`, `layout`, `route` files; static, dynamic (`[slug]`), catch-all
  (`[...rest]`), and optional catch-all (`[[...rest]]`) segments; route groups
  (`(group)`); specificity-ordered matching; filesystem manifest scanner.
- **HTTP server** (`src/server/`): request handler dispatching to API routes,
  server-rendered pages, static assets, or a 404. Includes:
  - Page render pipeline composing the layout chain around a page and merging
    layout + page `metadata` (title/description/meta/head).
  - Full HTML document assembly with `<head>` metadata and a hydration bootstrap
    (serialized route data + client module script).
  - API dispatch by HTTP method (`GET`/`POST`/… exports) with automatic `HEAD`
    from `GET` and `405` + `Allow` for unsupported methods.
  - Static file serving from `public/` with path-traversal protection and
    content-type detection.
  - `serve()` helper over `Deno.serve`, and an injectable module loader.
- **Client runtime** (`src/client/`): a small virtual-DOM reconciler with real
  hooks and in-place DOM patching. Includes:
  - `createRoot` (fresh mount) and `hydrateRoot` (adopts server markup in place,
    binding events without recreating nodes; self-heals on mismatch).
  - Full hooks on the client (`useState`/`useReducer`/`useEffect` with
    dependency tracking + cleanup, `useMemo`/`useRef`/`useContext`).
  - Keyed children reconciliation that preserves element identity across
    reorders; microtask-batched updates with a `flushSync` escape hatch.
  - Context provider/consumer resolution through the live instance tree.
  - `bootstrap.ts` browser entry that rebuilds the server's tree from the
    embedded hydration payload and hydrates `#__denext`.
  - Injectable `document` (`setDocument`) so the reconciler stays DOM-agnostic
    and testable without a third-party DOM.
- **Toolchain & CLI** (`src/build/`, `cli.ts`): dev/build/start commands driven
  by Deno's own toolchain — **no third-party bundler**.
  - Browser bundling via `deno bundle`: one entry per route (page + layouts +
    client runtime as a single module graph, preserving context identity).
  - `denext dev`: SSR + on-demand per-route bundling + live reload over SSE,
    with a filesystem watcher and generation-based module/bundle cache busting.
  - `denext build`: pre-bundles + minifies each route to `.denext/client/` and
    writes a build manifest.
  - `denext start`: serves SSR pages plus the pre-built, immutably-cached client
    bundles.
- **Example app** (`examples/hello/`): App Router demo — root layout, an
  interactive home page (`useState`/`useEffect` hydration), a static about page,
  a dynamic async blog route (`/blog/[slug]`), an API route, and CSS. Verified
  end-to-end: SSR, hydration payload, API GET/POST, static serving, dynamic
  params, and the production build/start path.
- **Tests**: coverage for the JSX runtime, SSR renderer, route-segment matching,
  the manifest scanner, the request handler, static serving, the client
  reconciler (hydration, keyed reordering, effects, context), and the build
  layer (route ids, generated entries), Suspense/streaming, error boundaries and
  `notFound()`, middleware, client navigation, and the lint plugin — 75 passing.
  Ships a tiny in-memory DOM shim so reconciler tests need no third-party DOM.

[1.0.2]: https://jsr.io/@denext/denext@1.0.2
[1.0.1]: https://jsr.io/@denext/denext@1.0.1
[1.0.0]: https://jsr.io/@denext/denext@1.0.0
[0.12.0]: https://jsr.io/@denext/denext@0.12.0
[0.6.1]: https://jsr.io/@denext/denext@0.6.1
[0.6.0]: https://jsr.io/@denext/denext@0.6.0
[0.5.0]: https://jsr.io/@denext/denext@0.5.0
[0.4.0]: https://jsr.io/@denext/denext@0.4.0
[0.3.0]: https://jsr.io/@denext/denext@0.3.0
[0.2.0]: https://jsr.io/@denext/denext@0.2.0
[0.1.2]: https://jsr.io/@denext/denext@0.1.2
[0.1.1]: https://jsr.io/@denext/denext@0.1.1
[0.1.0]: https://jsr.io/@denext/denext@0.1.0
