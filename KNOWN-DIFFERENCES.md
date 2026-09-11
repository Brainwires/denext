# denext — Known differences

Where denext **deliberately** behaves differently from React or Next.js. Each entry
is an observable behavior, documented so a port knows what to expect — not a gap
waiting to be closed. A surface that is missing, throwing, or wrong is a
_limitation_ and lives in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); an
internal design choice with no observable difference lives in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## React rendering semantics

- **Every function component is implicitly `memo()`-wrapped.** denext's reconciler
  skips re-rendering a component whose props (shallow), context and own state are
  unchanged — the default React only applies under `memo`. Pure components are
  unaffected; a component that reads module-level mutable data, `Date.now()`, or a
  mutated object without a prop/state change will render stale until something it
  depends on changes. Put such inputs in state, a ref read inside an effect, or a
  context. Test suites ported from React that count renders will see fewer renders.
  Deliberate (it is a large part of why denext's runtime is small and fast), not a
  bug — so it is listed here rather than fixed.
- **Errors thrown in DOM event handlers are routed to the nearest error boundary.**
  React lets them reach `window.onerror` and keeps the UI up; denext catches them
  (`onCaughtError` sees them) and shows the boundary's fallback, so one bad click
  swaps out that boundary's subtree. Deliberate — a boundary that never sees the
  most common runtime error in an app is a weak boundary — but it is a behavioral
  difference; wrap the handler body in `try/catch` when you want React's behavior.
- **`useDeferredValue` under `act()` / `flushSync`** — the test renderer's
  synchronous flush collapses the deferred pass, so a test sees the final value at
  once rather than the stale one first. Real event-path rendering defers as React
  does.
- **The class-component runtime loads on demand.** React ships its class support in the
  core; denext ships it as a separate chunk (`denext/class-runtime`) that a page fetches only
  when it needs it. A server-rendered class is preloaded before hydration (the document
  carries a marker), and an app whose own sources name `Component` gets a static import — so
  in both common cases nothing is observable. The one visible case: a class that first
  appears **client-side only**, on a page that server-rendered none (a soft navigation onto a
  class page from a class-free one, a `client:only` island) and with no `<Suspense>` above
  it, renders an empty subtree for one round trip while the chunk loads, then renders
  normally; inside a Suspense boundary it shows the fallback instead. Deliberate — it is
  what keeps a function-only app from paying for class support — and `classComponents:
  true` in `denext.config.ts` opts out by always importing the runtime statically.
- **`useId` values encode the component's tree position, not a counter.** denext emits
  `_d{path}_{n}_` (e.g. `_d0-2-1_0_`) where React 19.2 emits `_r_{n}_`. Both use the same
  character class — a valid CSS identifier, XML 1.0 name and `view-transition-name`, so
  `querySelector("#" + id)` needs no `CSS.escape` — but the values differ, so a snapshot
  test that pins React's literal ids will not match. Deliberate: a position-derived id is
  what lets a streamed PPR hole or an independently-hydrated island reproduce the server's
  ids without a shared global counter. A user-supplied `identifierPrefix` is concatenated
  verbatim, as in React, so keep it selector-safe too.

- **The root `denext` barrel exports React's function-component surface, not its
  class one.** `Component`, `PureComponent`, `version`, `act` and `useMemoCache`
  live on `denext/react` (and `denext/testing` for `act`); on the root barrel
  `Component` is the function-component _type_. Everything else React exposes
  (`cache`, `Children`, `cloneElement`, `forwardRef`, `Activity`, the hook and
  event types, …) is on both.
- **A `redirect()` thrown during a CLIENT render is a full document load**
  (`location.assign`), not a soft navigation — the render is abandoned, the browser
  loads the target. On the server it is the usual 307.
- **`notFound()` / `forbidden()` / `unauthorized()` are Server-side signals.** Next
  documents them for Server Components, Server Functions, and Route Handlers, and denext
  supports exactly those (plus Server Actions) — the matching `not-found.tsx` /
  `forbidden.tsx` / `unauthorized.tsx` boundary renders with its 404/403/401. Per Next's
  own contract each "throws … and terminates rendering of the route segment," so one
  thrown during a CLIENT render terminates that render (the control signal bubbles past
  `<ErrorBoundary>`) rather than swapping in the boundary — matching the documented
  behavior, a deliberate difference from real Next's undocumented client-boundary catch.
- **`defineAction` handler errors are redacted in production** (`error: "Internal
  Server Error"` + a `digest` that correlates with the server log), exactly like a
  render error handed to `error.tsx`; `ActionValidationError` messages and field
  errors pass through verbatim because they are authored for the user.
- **`defineApi` routes follow the same redaction split.** A thrown `ApiError` (and
  a schema `validation` failure) is authored for the client and passes through
  verbatim as the JSON error envelope; any other throw is a redacted JSON 500
  (`{ error: { code: "internal", message: "Internal Server Error", digest } }`). A
  plain `route.ts` handler's unknown throw keeps the text 500 it always had. Likewise
  a `defineSubscription` resolver failure reaches the client as a redacted `failed`
  frame (with `digest`), while its `invalid-input` field errors are verbatim; a
  channel payload is app-authored and never redacted.
- **`redirect()` / `notFound()` / `forbidden()` / `unauthorized()` thrown in a
  `route.ts` handler are HTTP responses** — the redirect with its status, or
  404/403/401 as a JSON error envelope (plain text when the request prefers
  `text/html`). Next has no equivalent for route handlers.
- **Route handler request bodies are capped** at 1 MiB by default (Next: unbounded),
  matching Server Actions. Raise or lift per route with `export const maxBodyBytes =
  N | false`, app-wide with `apiMaxBodyBytes`; streaming consumers keep streaming.
- **A typed client call made during SSR never goes over the network.** Inside a
  request, `createApiClient` / `useApi` run the call in-process through the full
  pipeline under the caller's identity (and through the tag-aware cache when `cache` /
  `next` options are passed); outside a request, or to a foreign `base`, it is a fetch.
- **`json()` from `denext/server` may add an `x-denext-wire: 1` header** when the body
  carried a Date / Map / Set / BigInt / `undefined` (the wire codec); a plain-JSON body
  stays byte-identical to `Response.json()`. Third-party consumers of a route that
  returned a previously-lossy value now see `{ "$": … }` tags plus that header.

## Non-goals

- **Legacy provider context** (`childContextTypes` / `getChildContext`) is an
  **intentional non-goal** — React deprecated this pre-`createContext` API, so
  denext won't chase it. Modern class context (`static contextType`) reaches
  parity; migrate providers to `createContext`.

## Next.js routing and config

- **Config `rewrites` have one phase.** Next distinguishes `beforeFiles` /
  `afterFiles` / `fallback` rewrites; denext runs its single `rewrites` list after
  middleware and before the filesystem (Next's `beforeFiles` position). Middleware
  matchers therefore always see the URL the client asked for.
- **`nodeResolve` is on by default** for the compat (npm React) build — every bare
  npm specifier resolves from the installed `node_modules` through denext's tolerant
  resolver, which is what lets an unmodified pnpm/npm/yarn app build with no
  `package.json` rewrite. Next has no such layer. Set `nodeResolve: false` for
  Deno's strict `npm:` loader.
- **Server-action ids are opaque hashes** of `module#export` (Next's are hashes too,
  but of a build-specific manifest); ids are stable across processes and replicas
  without a build salt.
- **`userAgent().device.type`** is `undefined` for a desktop browser (matching
  ua-parser-js); the older denext value was `"desktop"`.
- **`client-only` is inert at build time.** Next fails a build that imports `client-only`
  from the `react-server` layer. denext's compat SSR bundle server-renders the `"use client"`
  tree as well, so it has no such layer and treats `client-only` as an empty marker on both
  sides; `server-only` in the client bundle is still a build error, and the runtime
  `clientOnly()` guard still throws on the server.

## Security posture — safe defaults

Deliberate **safe defaults** that differ from Next's, each with a one-line
opt-in — documented, not surprises. Full checklist in [DEPLOYMENT.md](./DEPLOYMENT.md).

- **Strict CSP by default** blocks external `<script>`/stylesheet/`<img>` until
  opted in per route (`csp: "strict" | "off" | {…}`; a route's `csp` export
  overrides). Applies to buffered **and** streamed/PPR responses.
- **HSTS is host-only by default** (no `includeSubDomains`/`preload`) so it
  can't brick non-HTTPS sibling subdomains. Strengthen via `hsts`, or
  `hsts: false`.
- **Session cookie isn't `__Host-`-locked by default** (would log everyone out
  on upgrade). Opt in with `hostPrefix: true` on `getSession`.
- **`denextAuth` sessions are stateless by default, so they can't be revoked before
  they expire.** Opt in to server-side sessions with `sessionStore`
  (`inMemorySessionStore()` / `sqliteSessionStore()` or your own) to get
  `revokeSession`/`revokeAllSessions`.
- **The credentials rate limiter keys on the socket peer, not `x-forwarded-for`, unless
  `trustForwardedHeaders: true`.** Behind a proxy without that flag every client shares
  one IP key, so the limit is effectively per account (an attacker can lock an account
  they know the email of for one window); set the flag when a proxy fronts the app.
- **Graceful shutdown drains up to a deadline** (default 10s;
  `DENEXT_SHUTDOWN_DRAIN_MS`), then force-exits so a stuck client can't pin the
  process (plugin teardown is skipped on a forced exit).
- **Scaffolded `dev`/`build` tasks use `-A`** (they compile/spawn tooling); the
  generated `start` task runs least-privilege.
- **`@denext/og` fetches a missing non-Latin font from `fonts.googleapis.com`**
  at render time — supply a local `fonts` option, or set `offline: true` on the
  `ImageResponse` to refuse the fetch (it raises a clear error instead of
  egressing).
- **The public-env island ships only _referenced_ prefixed vars.** A key read
  via a computed expression can't be detected — force-include it via
  `publicEnv: [...]`. Never give a secret a public prefix.
- **Pages Router Preview Mode signs its cookie with `DENEXT_PREVIEW_SECRET`.**
  Set it to a long random value in production (comma-separated to rotate).
  Without it a random per-process key is used, so preview sessions don't survive
  a restart or span instances (a one-time warning fires). A forged/unsigned
  preview cookie is ignored — it never discloses drafts.
