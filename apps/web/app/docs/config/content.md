---
title: Configuration
slug: config
lead: Every field of denext.config.ts — routing, rendering mode, images, caching, security, compatibility, plugins, and the build-time switches. All optional; a denext app runs with no config at all.
---

denext reads an optional `denext.config.ts` (or `.js`) from your project root.
Export a default object typed as `DenextConfig` — `satisfies DenextConfig` gives
you autocomplete and type-checking without widening the type:

```ts
// denext.config.ts
import type { DenextConfig } from "denext/server";

export default {
  basePath: "/app",
  images: {
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }],
  },
} satisfies DenextConfig;
```

Every field is optional. With no config file at all, denext serves the App
Router from `app/` (or `src/app/`) with sensible defaults.

## Routing & URLs

- **`basePath`** — `string`. Serve the whole app under a sub-path (e.g.
  `/docs`). It's stripped before routing and re-added to generated links and
  asset URLs.
- **`trailingSlash`** — `boolean` (default `false`). Enforce a trailing slash on
  page URLs, 308-redirecting to normalize.
- **`assetPrefix`** — `string`. Prefix for client bundle/asset URLs — point it
  at a CDN origin.
- **`redirects`** — `() => RedirectRule[]`. Declarative redirects, evaluated
  once at startup. Each rule is `{ source, destination, permanent? }`;
  `source`/`destination` support `:name` and `:name*` params. `permanent: true`
  → 308, else 307.
- **`rewrites`** — `() => RewriteRule[]`. Internal rewrites — `source` is served
  as `destination` with no client-visible redirect.
- **`headers`** — `() => HeaderRule[]`. Response headers per path —
  `{ source, headers: [{ key, value }] }`.
- **`i18n`** — `I18nConfig`. Internationalized routing:
  `{ locales: string[], defaultLocale: string, localePrefix?, messages? }`.
  `localePrefix` is `"as-needed"` (default — the default locale is served
  unprefixed) or `"always"` (every locale is prefixed, including the default).
  Locale prefixes are parsed off the path and exposed to your routes.
- **`src/` directory** — not a config key, a layout denext detects. If a
  `src/app` directory exists, denext looks for `app/`, `middleware` and
  `instrumentation` under `src/` (Next.js parity); `public/`, the config files
  and `.denext` stay at the project root. `denext create --src-dir` scaffolds
  it.

```ts
export default {
  redirects: () => [{
    source: "/old/:slug",
    destination: "/new/:slug",
    permanent: true,
  }],
  i18n: { locales: ["en", "fr"], defaultLocale: "en" },
} satisfies DenextConfig;
```

## Rendering mode

- **`mode`** — `"spa"`. Omit for the default App Router (SSR/SSG) pipeline.
  `"spa"` builds a pure client-side-rendered app (React, but not Next: no
  `app/`, no SSR, no Flight) — denext bundles the entry, emits an HTML shell
  with a history-API fallback, and can `export` / package it as a static desktop
  app. Use it to host an existing Vite-style SPA on denext's toolchain.
- **`spa`** — `SpaConfig` (required when `mode: "spa"`). Fields: `entry` (the
  client entry file, required), `rootId`, `title`, `head`, `lang`, `env`,
  `proxy` (dev proxy to a backend), `csp` (a `CspSetting` for the shell), and
  `desktop` (desktop-packaging options). See [SPA mode](/docs/spa).

## Images

- **`images`** — `ImagesConfig`. Config for the `/_denext/image` optimizer.
  Remote sources are **refused by default** (local-only, SSRF-safe) — allowlist
  hosts to optimize remote images. Fields: `remotePatterns`
  (`{ protocol?, hostname, pathname? }`, `hostname` allows a leading `*.`
  wildcard), `localPatterns`, `deviceSizes`, `imageSizes`, `qualities` (allowed
  `q=` values), `formats` (negotiated `Accept` order — include `"image/avif"` to
  offer AVIF), `dangerouslyAllowLocalIP` (opt out of the private-address SSRF
  guard — trusted networks only), and the legacy `domains`.

```ts
export default {
  images: {
    remotePatterns: [{
      protocol: "https",
      hostname: "*.githubusercontent.com",
    }],
    deviceSizes: [640, 828, 1200, 1920],
  },
} satisfies DenextConfig;
```

See [Images](/docs/images) for the full model.

## Styling

- **`tailwind`** — `TailwindConfig`. When set, denext manages the Tailwind v4
  standalone binary and compiles `input` → `output` automatically on
  `dev`/`build`. Both fields are required: `{ input, output }`. See
  [Styling](/docs/styling).

## Caching

- **`cache`** — `CacheConfig`. Backing store for Cache Components / ISR data and
  the page cache. Omit to let denext pick at startup — the durable `node:sqlite`
  store when a writable filesystem is available, else in-memory. Fields: `store`
  (`"sqlite"` | `"memory"` | your own `CacheStore`), `path` (sqlite file),
  `maxDataEntries`, `maxPageEntries` (finite whole numbers ≥ 1).
- **`cacheComponents`** — `boolean` (**off by default**; a stable **opt-in**
  since 2.0). Cache Components (Next.js 16): the `"use cache"` directive
  compiles into cross-request server caching (`cacheLife`/`cacheTag`), plus the
  PPR render path — a cached, request-independent static shell with per-request
  dynamic holes behind `<Suspense>`, Flight-capable. Caching is a choice, not a
  default, so it stays opt-in. Its documented bounds (see KNOWN-LIMITATIONS):
  reading request data (`cookies()`/`headers()`) inside `use cache` throws, and
  a streamed hole can't add to the already-flushed head. Inert when off — the
  render path is byte-for-byte unchanged. The pre-2.0
  `experimental.cacheComponents` is still honored and warns in dev.

See [Data & caching](/docs/data).

> Numeric config fields are validated at startup: `hsts.maxAge`, the `images.*`
> sizes/qualities/`minimumCacheTTL`/`maximumRedirects`, the `cache.max*Entries`
> counts and the production-server numbers (`requestTimeout`, `maxConcurrency`,
> `slotBackstop`, `actionMaxBodyBytes`) must be finite and in range (a
> `NaN`/`Infinity`/ negative would otherwise poison a `max-age` header, a
> redirect-loop bound, or an eviction count) — an invalid value fails the
> build/boot with a field-named error rather than shipping.

## Security

- **`hsts`** — `HstsConfig | false`. `Strict-Transport-Security` tuning for
  HTTPS responses. Defaults to `max-age=31536000` (1 year, host-only — no
  `includeSubDomains`/`preload`, so it can't brick sibling subdomains). Fields:
  `maxAge`, `includeSubDomains`, `preload`. Set `false` to omit the header (e.g.
  when your edge sets it).
- **`csp`** — `CspSetting` (default `"strict"`). App-wide
  Content-Security-Policy: `"strict"` (denext's hash-based strict policy on
  every HTML page response), `"off"` (emit no CSP — set it at the edge), or a
  `RouteCsp` object (the strict policy plus global opt-ins). A route's own `csp`
  export overrides this. Streamed and PPR responses carry the **same** strict
  hash-based CSP as buffered ones; the only uncovered case is an inline
  `<style>`/`<script>` inside a streamed hole flushed after the head.
- **`publicEnv`** — `string[]`. Public-env keys to always embed in the page, in
  addition to the ones the build detects. Use it for a key read via a computed
  expression the build can't see (e.g. `publicEnv()["NEXT_PUBLIC_" + x]`).

> [!IMPORTANT]
> Remote image hosts, redirects to absolute URLs, and `csp: "off"` all widen
> your app's trust boundary. Only allowlist hosts you control or trust, and
> prefer path-relative redirect destinations for anything derived from the
> request.

## Production server

The knobs `denext start` (and `denext dev`) hand to the request handler. Four of
them also read an env var when the config leaves them unset — **config > env >
default** — so a deployment can set them without a config change. A custom
server that embeds denext passes the same names to `createApp()` / `serve()`
itself (it reads neither the config keys nor the env vars for them).

- **`canonicalOrigin`** — `string` (env `DENEXT_CANONICAL_ORIGIN`). The app's
  public origin, pinned outright: absolute URLs (canonical, `og:image`), the
  Server Action origin check and HSTS use it instead of the `Host` / forwarded
  headers. A bare origin (`"https://example.com"` — scheme + host, no path);
  anything else fails validation at boot. The fix for a proxy that rewrites
  `Host` (every Server Action answers `403` otherwise).
- **`trustForwardedHeaders`** — `boolean` (env `DENEXT_TRUST_PROXY=1`; default
  `false`). Trust `X-Forwarded-Proto` / `X-Forwarded-Host` from a reverse proxy
  when deriving the origin. Only when clients **cannot** reach denext directly.
  Ignored when `canonicalOrigin` is set.
- **`requestTimeout`** — `number` ms (env `DENEXT_REQUEST_TIMEOUT_MS`; default
  `30000`, `0` disables). A request running past it is aborted and answered
  `503`; the per-request `AbortSignal` fires so cooperative work cancels.
- **`maxConcurrency`** — `number` ≥ 1 (env `DENEXT_MAX_CONCURRENCY`; default: no
  limit). In-process concurrency ceiling: a request arriving at capacity is shed
  at once with `503` + `Retry-After`. A complement to the edge ceiling, not a
  replacement — see
  [Deployment](/docs/deploy#1-put-a-concurrency-ceiling-in-front-of-denext-required).
- **`slotBackstop`** — `number` ms ≥ 1 (default `120000`). With `maxConcurrency`
  set and `requestTimeout: 0`, when a never-settling request's slot is
  force-freed (the render itself is not aborted). Inert while a request timeout
  is in place.
- **`actionMaxBodyBytes`** — `number` ≥ 1 (default 1 MiB). The Server Action
  request-body cap; over it → `413` before the action runs. Raise it for actions
  that take multipart uploads. Route handlers have their own cap,
  **`apiMaxBodyBytes`** (same default; a route overrides it with
  `export const maxBodyBytes`).
- **`cacheKeyParams`** — `string[]`. Allowlist of query-parameter names that
  fork the ISR page-cache key; every other param (`?utm_*`, `?fbclid`) is
  ignored for keying but still reaches the render via `searchParams`. Unset,
  every param participates.

```ts
export default {
  canonicalOrigin: "https://example.com",
  maxConcurrency: 100,
  actionMaxBodyBytes: 20 * 1024 * 1024, // 20 MiB uploads
  cacheKeyParams: ["page", "sort"],
} satisfies DenextConfig;
```

Per-request observability is code, not config: export `onRequest(info)` from
`instrumentation.ts` (beside `register` / `onRequestError`) — see
[Deployment › Observability](/docs/deploy#14-observability).

## Compatibility

- **`compatibilityMode`** — `boolean | "auto"` (default `"auto"`). Run the app
  through the **next-compat** pipeline, which rewrites every
  `react`/`react-dom`/`next/*` import (including those inside npm React
  libraries) to denext at bundle time — the drop-in path for real Next.js App
  Router projects. `"auto"` enables it when `node_modules/react` exists or
  `package.json` lists `react`/`next`; a pure denext-native app keeps the
  zero-overhead source-load path. (Renamed from `nextCompat`; the old key is no
  longer accepted.)
- **`classComponents`** — `boolean` (unset by default). Class components work
  without it: the class runtime is a separate chunk loaded on demand — before
  hydration when the server rendered a class, statically when the build scan
  finds `Component` in the app's own sources. `true` always imports the runtime
  statically (no round trip); `false` keeps it out entirely (zero bytes, and a
  class throws a guided error). On the next-compat/SPA esbuild path the flag is
  also a `define`, so `false` dead-code-eliminates the reconciler's class guards
  from that bundle too.
- **`mdx`** — `MdxConfig`. MDX/CommonMark compilation options for `.mdx`/`.md`
  sources in a compat (npm-React) app. The baseline loader compiles plain MDX;
  set this to thread your own `remarkPlugins`, `rehypePlugins`, `recmaPlugins`,
  `remarkRehypeOptions`, or `providerImportSource` (forwarded verbatim to MDX's
  `compile`). Because `denext.config.ts` is a real module, `import` the plugins
  directly. A **fumadocs-mdx** app needs none of this: when the app has a
  `source.config.*` and `fumadocs-mdx` installed, its `x.mdx?collection=…` and
  `meta.json?collection=…` imports compile through fumadocs' own loader (hosted
  in a child process), so `.source/` must be generated first (fumadocs'
  `postinstall`).

## Plugins

- **`plugins`** — `DenextPlugin[]`. denext plugins (e.g. a Pages Router, or
  htmx). Each is set up once before routes are scanned and may contribute
  routes, claim requests, emit build assets, generate inputs the app imports
  (prepare steps, live in dev), register a teardown, and add CLI verbs. Apps
  with no plugins pay nothing.

Install and wire one in a single step with the CLI:

```sh
denext plugin add @denext/htmx      # adds the dep and edits denext.config.ts
denext plugin list                  # show what's wired
```

See [Writing a plugin](/docs/plugins).

## Streaming & Live

Both are top-level fields — shipped, complete capabilities, not experiments.

- **`streaming`** — `boolean` (**on by default**; set `false` to opt out).
  Incremental Suspense streaming: a page with a pending boundary flushes its
  shell first and streams each boundary as it resolves. Fully-synchronous pages
  stay buffered (and shared-cacheable); streamed responses keep the same strict
  CSP and survive a failing boundary.
- **`live`** — `LiveConfig`. Security policy for Live Server Components
  (`<Live>` / `useLive` / `usePresence`). Presence and data are **default-deny**
  in dev and production alike: without a policy hook (`canJoinRoom` /
  `canSubscribe`) or `allowAnonymous: true`, the hub refuses joins and
  subscriptions. Resource caps in `LiveLimits` always apply. See
  [Live components](/docs/live).

## Tasks

- **`scheduledTasks`** — `Record<string, string | string[]>`. Cron expression →
  the task name(s) it runs, merged with each task's own `schedule:`. Five-field
  Vixie cron in **UTC**, weekdays POSIX (`0–6`, `0` = Sunday); denext translates
  the weekday field into names for `Deno.cron`, which numbers days differently.
  A malformed expression or an unknown task is skipped at boot with an error.
  See [Scheduled tasks](/docs/tasks#cron-syntax).
- **`tasks`** — `TasksConfig`. Run history. `history: true` records every run —
  scheduled, `runTask`, and `denext task <name>` — to `.denext/tasks.db`
  (created `0600`; each row keeps a returned string's tail and a failure's
  message/stack in plain text, up to 2 KB). Off unless set, and never able to
  fail or delay a run. `historyMaxRuns` (whole number ≥ 1, default `500`) is the
  runs kept **per task**; rows older than 14 days go regardless. See
  [Run history](/docs/tasks#run-history) and the Project UI's
  [Cron page](/docs/ui#cron), which owns both keys in the editor.

```ts
export default {
  scheduledTasks: {
    "0 3 * * *": "cleanup",
    "0 0 * * 1": ["digest", "warm-cache"],
  },
  tasks: { history: true, historyMaxRuns: 200 },
} satisfies DenextConfig;
```

## Build & optimization

Build-time switches. All off by default except `nodeResolve`,
`momentumSafeScroll` and the `optimizePackageImports` defaults.

- **`reactCompiler`** — `boolean`. The build-time auto-memoization compiler (a
  React-Compiler-style pass; Next.js's key). Conservative by construction —
  bails to identity whenever a transform isn't provably safe, so it only ever
  adds memoization, never changes behavior. `denext create` offers it as
  "Auto-memo compiler", and `denext migrate` turns it on for a Vite app that ran
  React Compiler.
- **`asyncContext`** — `boolean`. Scope async `startTransition` by transition
  **identity** instead of the default time window: a build transform makes
  denext's first-party `AsyncContext` survive `await`, so a post-`await` update
  stays a transition while an unrelated urgent update in the pending window
  keeps its priority. Opt-in because it instruments every client `await` (a
  small per-`await` cost); the time-window behavior is unchanged when off. See
  [Async transitions](/docs/rendering#async-transitions).
- **`features`** — `Record<string, boolean>`. Compile-time feature flags for
  `feature("KEY")` from `denext/feature`: the call always returns the configured
  value (the server and every client bundle are seeded with this map), and a
  string-literal KEY is folded to a literal where the build can, so the untaken
  branch is dead-code eliminated. A key not listed reads `false`; flag names and
  states are embedded in the client bundle. See
  [Feature flags](/docs/bundling#feature-flags-compile-time).
- **`optimizePackageImports`** — `string[]` (a built-in default list is always
  on). Next.js's barrel-import optimization: `import { Check } from
  "lucide-react"` is rewritten to an import of the module that defines `Check`,
  so the bundler never loads the package's barrel. That saves build time, and it keeps
  an icon library's thousand re-exports out of the module graph — and when the
  package also code-splits every icon (`lucide-react/dynamic`), it keeps one
  bare `import "./chunk-<icon>.js"` per icon out of your startup chunk. Your
  list is **added to** the defaults: `lucide-react`, `date-fns`, `lodash-es`,
  `ramda`, `rxjs`, `@tabler/icons-react`, `@heroicons/react/20/solid`,
  `@heroicons/react/24/solid`, `@heroicons/react/24/outline`, `react-icons/*`
  (a trailing `/*` matches every subpath), `@mui/icons-material`, `recharts`,
  `react-use`, `@headlessui/react` and `effect`. It applies to the compat
  (esbuild) client and server bundles, SPA mode included, under `nodeResolve`,
  and rewrites app source and npm modules alike. Only named value imports move
  (`import type`, default, `* as` and dynamic `import()` are left alone), and
  only names the barrel re-exports from another module: a name the barrel
  defines itself stays on the barrel, and a barrel that runs code of its own,
  carries a directive (`"use client"`) or cannot be analysed is left untouched —
  it never fails a build. Next's `experimental.optimizePackageImports` spelling
  is honored with a dev warning.

  ```ts
  export default {
    optimizePackageImports: ["@acme/icons", "@acme/ui/*"],
  } satisfies DenextConfig;
  ```
- **`nodeResolve`** — `boolean` (**default on** for the compat build). denext's
  tolerant `node_modules` resolver: a strict superset of Deno's `npm:` loader
  that resolves bare npm specifiers straight from the app's installed
  `node_modules`, honoring `exports` wildcard globs. This is what lets an
  unmodified pnpm/npm/yarn/bun app build without hand-patching dependency
  `exports` — the reason `denext migrate` never rewrites `package.json`. Set
  `false` to force app deps back through Deno's strict `npm:` loader (escape
  hatch).
- **`momentumSafeScroll`** — `boolean` (**default on**). In iOS WebKit (Safari,
  WKWebView, Capacitor) any programmatic scroll write during a touch fling
  (`scrollBy`, `scrollTo`, assigning `scrollTop`) stops the fling dead, and
  virtualized lists (LegendList, react-virtuoso, TanStack Virtual) make exactly
  such writes to correct for rows measured taller or shorter than estimated.
  On iOS/iPadOS WebKit the client runtime therefore defers those writes while a
  gesture is in flight, shifts the list with a CSS `translate` so the picture is
  unchanged, and applies the offset in one step once the scroller rests. Other
  platforms pay one user-agent check; the shim is its own lazily loaded chunk.
  Set `false` to opt out. See
  [`denext/mobile`](/docs/desktop).

> **`experimental` is superseded.** Everything denext shipped under it is
> denext's own finished work, so every key graduated to a top-level field —
> `experimental.reactCompiler` (and the older `experimental.compiler`) →
> `reactCompiler`, `experimental.asyncContext` → `asyncContext`,
> `experimental.features` → `features`, `experimental.nodeResolve` →
> `nodeResolve`, `experimental.cacheComponents` → `cacheComponents` — and
> Next's own `experimental.optimizePackageImports` → `optimizePackageImports`. The legacy
> spellings are still honored when the top-level field is absent (the top-level
> one wins when both are set), and each emits a dev warning naming the new
> field, so nothing breaks while you migrate; the block is removed in 3.0.
> `experimental.streaming` → `streaming` and `experimental.live` → `live` are no
> longer read at all — move the value up. An unknown `experimental.*` key warns
> with a did-you-mean, like a top-level one.

## Config schema

The repo root carries `denext.config.schema.json`, a JSON Schema generated from
the `DenextConfig` type by a zero-dependency script over `deno doc --json` — the
TypeScript type stays the single source of truth (no Zod, no npm), and the
schema is regenerated by `deno task docs:api` alongside the API reference so it
can't drift.

It describes the shape, not just the names: array `items` (so `redirects`,
`rewrites`, `headers`, `images.remotePatterns` carry their rule schema),
`additionalProperties` for a `Record` / index signature (the value schema of
`scheduledTasks`, `features`), `anyOf` for a union of mappable members and a
single `enum` for a union of literals, and `minimum` / `maximum` from explicit
`@minimum` / `@maximum` tags where `config-validate.ts` enforces that exact
bound. Two `x-denext` markers tell a form renderer what a plain array or object
cannot: `wrapper: "function"` on a key written as a thunk around its data
(`redirects: () => RedirectRule[]`), and `widget: "textarea"` on a string tagged
`@widget textarea` (`spa.head`, `spa.loading`). A map has no marker: a renderer
recognises one by its `additionalProperties`. What it deliberately does **not**
claim is a shape the type does not spell out — an imported, conditional or
intersection type keeps only its JSDoc description, and a function type other
than a data thunk maps to `{}` (which is what makes `commands[].run` and the
Live callbacks read as opaque). `additionalProperties: false` is set exactly
where the runtime warns on unknown keys — the root and `experimental` — and
nowhere else.

Point an editor or a config linter at it for autocomplete on a `.js` config; a
`.ts` config gets the same from `satisfies DenextConfig`. It is also what
[the Project UI](/docs/ui)'s configuration editor derives its widgets from.

## See also

Every public type and signature — including `DenextConfig` and each sub-config —
is in the [API reference](/docs/api).
