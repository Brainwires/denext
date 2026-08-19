# denext — supported features

The master list of what denext ships today, by category. Experimental (flag-gated)
features are marked **⚑**. For behavioral divergences from Next.js see
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); for the forward plan see
[ROADMAP-FORWARD.md](./ROADMAP-FORWARD.md) and [ROADMAP-ECOSYSTEM.md](./ROADMAP-ECOSYSTEM.md).

## Rendering & routing (App Router)

- File-convention **App Router**: `app/page.tsx`, `layout.tsx`, `template.tsx`,
  `loading.tsx`, `error.tsx`, `global-error.tsx`, `not-found.tsx`, `default.tsx`.
- Dynamic (`[slug]`), catch-all (`[...all]`), optional catch-all (`[[...opt]]`),
  **route groups** (`(group)`), **parallel routes / slots** (`@slot` + `default`),
  and **intercepting routes** (`(.)`/`(..)`/`(...)`, soft-nav-aware).
- **Server Components** (default), async Server Components (`await` data in a page),
  and **`"use client"`** islands.
- **Streaming SSR** with `<Suspense>` (out-of-order boundary resolution) and the
  **RSC/Flight** boundary (server components stay server-side; only islands hydrate).
- **Metadata**: static `metadata`, `generateMetadata`, `generateViewport`,
  `generateStaticParams`; file-based `opengraph-image`/`twitter-image`/`icon`/
  `apple-icon`, `sitemap`, `robots`.
- `redirect()` / `notFound()` / `forbidden()` / `unauthorized()`.

## React runtime (own React 19-compatible implementation)

- Hooks: `useState`, `useReducer`, `useRef`, `useContext`, `useMemo`, `useCallback`,
  `useEffect`, `useLayoutEffect`, `useInsertionEffect`, `useId`, `useTransition`,
  `useDeferredValue`, `useSyncExternalStore`, `useImperativeHandle`, `useDebugValue`,
  `useEffectEvent`, `use()`, `useOptimistic`, `useActionState`, `useFormStatus`.
- `Suspense`, `SuspenseList`, `ErrorBoundary`, `startTransition`, `memo`,
  `createContext`, `forwardRef`, `createPortal`, `lazy`, `Profiler`, `StrictMode`.
- **Auto-memo compiler** (React-Compiler-style automatic memoization) ⚑.
- Class components (`Component`/`PureComponent`) in the next-compat build.

## Data, caching & ISR

- `fetch()` caching (Next 15/16 semantics: uncached by default; opt in via
  `next: { revalidate, tags }` / `force-cache`), request-scoped fetch dedupe.
- `unstable_cache`, `revalidatePath`, `revalidateTag`, `updateTag`.
- **Cache Components** (`"use cache"`, `cacheLife`, `cacheTag`) ⚑ and **Partial
  Prerendering (PPR)** — a cached static shell + per-request dynamic holes ⚑.
- **ISR** (`revalidate` / `force-static`) with stale-while-revalidate.
- Pluggable **cache stores**: in-memory (LRU-bounded), **SQLite** (`@denext/sqlite`),
  **Deno KV** — shared across instances (`setCacheStore`, `cacheStoreHealthy`).

## Server features

- **Route handlers** (`app/api/*/route.ts`, `GET`/`POST`/… returning `Response`).
- **Server Actions** (`"use server"`, progressive-enhancement forms, CSRF-defended).
- **`cookies()` / `headers()`** with **secure cookie defaults** (httpOnly, SameSite=Lax,
  Secure over HTTPS).
- **Signed-cookie sessions**: `getSession()` (HMAC-SHA256, secret rotation) — the
  built-in auth primitive.
- **Middleware** (`middleware.ts`), **`draftMode()`**, `after()`-style deferred work.
- **Instrumentation** (`instrumentation.ts`): `register()` + `onRequestError()` with
  Next-shaped context (`routerKind`, `routePath`, `routeType`, `renderSource`,
  `revalidateReason`).
- **`safeFetch`** (SSRF-guarded fetch for untrusted URLs).
- **Databases**: any DB that runs on Deno works — built-in **`node:sqlite`** and
  **Deno KV** are zero-npm; Postgres/MySQL/Drizzle via standard drivers. See
  [DATABASE.md](./DATABASE.md), [`examples/notes`](./examples/notes) (SQLite, single
  process), and [`examples/postgres-load`](./examples/postgres-load) (a networked
  Postgres pool driven under concurrent load).

## Client runtime

- Hydration, **soft (SPA) client navigation** with reconcile-in-place, `Link`,
  scroll/focus handling.
- **Fast Refresh** (dev) with state preservation for route-structural components.
- **`dynamic()`** with `ssr: false` code-split islands.
- React DevTools: **Components tree** (props/nesting) ⚑ (hooks/state inspection is a
  documented gap).

## Styling

- **CSS**, **CSS Modules** (scoped class hashing), global CSS, and **Tailwind** (v4,
  compiled automatically) — extracted per route and `<link>`ed for a styled first paint.

## Images, fonts & OG

- **`next/image`** with a built-in, **SSRF-hardened** image optimizer
  (resize + WebP/AVIF, decompression-bomb guards, allowlists).
- Codecs as first-party zero-npm JSR packages: **`@denext/photon`** (resize/WebP),
  **`@denext/avif`** (AVIF).
- **`next/font`** (local + Google; Google self-hosting opt-in).
- **`next/og`** dynamic OG images via **`@denext/og`** (satori + resvg + yoga).

## Internationalization

- Optional-prefix **locale routing**, **`next-intl`** compatibility (provider,
  navigation, middleware, routing), ICU message subset, `useTranslations`.

## Security

- Secure cookie defaults, **hash-based CSP** on buffered responses, opinionated
  hardening headers (nosniff, frame-options, HSTS over HTTPS), error redaction,
  correlation ids (`x-request-id`), config validation, SSRF-pinned image fetch,
  and a continuously-run **CVE-defense** probe suite (see
  [CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md)).

## Pages Router (opt-in plugin: `@denext/pages-router`)

Full Next.js Pages Router parity as a plugin (`plugins: [pagesRouter()]`):

- `pages/` file routing (`index`, `[slug]`, `[...all]`, `[[...opt]]`), `_app`,
  `_document`, and custom `_error`/`404`/`500`.
- `getServerSideProps`, `getStaticProps` with **build-time SSG** + `revalidate` **ISR**,
  and `getStaticPaths`.
- `next/head`, CSS / CSS Modules / Tailwind, `pages/api/*` (`(req, res)`).
- `useRouter`, `Link`, **client hydration + code-split soft navigation**, dev Fast Refresh.

## Next.js drop-in (next-compat)

- **`denext migrate`** migrates a Next App Router app in one pass: converts
  `package.json` → `deno.json` (react/react-dom/`next/*` aliased), **then** rewrites
  the app's own `next/*` + `react` imports to **native denext** (default
  `<Link>`/`<Image>` → named, `next/navigation` → `denext`, `next/headers`/
  `next/cache` → `denext/server`, …) after a confirmation prompt (`--yes` to skip;
  `--drop-in` to stop at the config and rely on the alias). Pages-Router-only
  imports are flagged, not broken. `denext codemod` runs just the import rewrite.
- Build-time **react → denext rewrite** (incl. inside npm packages) so the whole app
  runs on **one** React; the RSC/Flight island boundary is preserved.
- **`deno check` is clean** for typical apps (`skipLibCheck` + a `JSX.ElementType`
  admitting `ReactNode`-returning components) — Radix/lucide/recharts/cva type-check.
- The full `next/*` surface is aliased (link, image, navigation, headers, cache,
  server, font, script, dynamic, form, og, …).

## Ecosystem packages (first-party JSR)

`@denext/photon`, `@denext/sqlite`, `@denext/avif`, `@denext/og`, `@denext/pages-router`
— published independently, zero-npm.

## Testing

- **App-testing helper** (`denext/testing`): `createTestApp(dir)` builds an
  in-process request handler (no build, no socket) that renders Server Components,
  runs Server Actions and `middleware.ts`, and reads cookies; `createTestClient`
  wraps any handler with a **cookie jar**, redirect control, and form
  parse-and-submit — so you can drive the whole app the way a **JavaScript-disabled**
  browser would and assert progressive enhancement in CI.
- **Component-testing helper** (`denext/testing`): `render(vnode)` mounts a single
  component into an in-memory DOM with **real hooks, effects, and events** (no
  browser), returning Testing-Library-style queries (`getByRole`/`getByText`/
  `getByLabelText`/`getByTestId`, `query*`/`getAll*`) and `fireEvent`.
- **Rendered-app conformance probe** (`denext/testing` → `probeApp`, or
  **`denext probe`**): renders **every route** of an app in process (expanding
  dynamic routes via `generateStaticParams`) and asserts each is a well-formed HTML
  document — `<!DOCTYPE>`, one `<html>`/`<head>`/`<body>`, a non-empty `<title>`,
  no server crash — classifying each route static (0 KB JS) or interactive. A CI
  gate that turns "every route renders" from a claim into a checked assertion.

## Build, tooling & CLI

- Build via **`deno bundle`** (no npm toolchain) with **code splitting** (shared
  runtime chunk), the CSS pipeline, and per-route client entries.
- **Plugin contract** (`DenextPlugin`: route-synthesizer / request-handler /
  build-step / teardown seams) with public `@denext/denext/bundle` and
  `@denext/denext/build/css` primitives. See [PLUGINS.md](./PLUGINS.md) for the
  authoring guide; consumed by `@denext/pages-router` and
  [`examples/plugin-aliases`](./examples/plugin-aliases).
- **Lint plugin** (denext-specific rules), `deno fmt`/`deno lint` integration.
- CLI: `create`, `init`, `dev`, `build`, `start`, `export` (static), `probe`
  (route conformance), `migrate`, `version` — plus **desktop/mobile** targets
  (Tauri / Capacitor scaffolding).

## Deployment

- Production server with **graceful drain**, per-request **timeout**, an optional
  in-process **`maxConcurrency`** ceiling, body/cache/prefetch caps.
- **Static export** (`denext export`) for fully-static hosting.
- Deploy recipes (Docker / Deno Deploy / self-host) in
  [DEPLOYMENT.md](./DEPLOYMENT.md).

## Zero-npm runtime

The framework's **runtime carries no npm dependencies** — CI-enforced across
`src/{jsx,runtime,client,server,compat,plugin}` (`tests/no-npm-compat-guard.test.ts`).
Build-time tooling (esbuild/swc/lightningcss) never reaches the shipped runtime.
