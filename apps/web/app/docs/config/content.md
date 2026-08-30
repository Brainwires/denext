---
title: Configuration
slug: config
lead: Every field of denext.config.ts — routing, rendering mode, images, caching, security, compatibility, plugins, and experimental features. All optional; a denext app runs with no config at all.
---

denext reads an optional `denext.config.ts` (or `.js`) from your project root.
Export a default object typed as `DenextConfig` — `satisfies DenextConfig` gives
you autocomplete and type-checking without widening the type:

```ts
// denext.config.ts
import type { DenextConfig } from "@denext/denext/server";

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
  client entry file, required), `rootId`, `title`, `head`, `lang`, `env`, and
  `proxy` (dev proxy to a backend). See [SPA mode](/docs/spa).

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

See [Data & caching](/docs/data).

> Numeric config fields are validated at startup: `hsts.maxAge`, the
> `images.*` sizes/qualities/`minimumCacheTTL`/`maximumRedirects`, and the
> `cache.max*Entries` counts must be finite and in range (a `NaN`/`Infinity`/
> negative would otherwise poison a `max-age` header, a redirect-loop bound, or
> an eviction count) — an invalid value fails the build/boot with a field-named
> error rather than shipping.

## Security

- **`hsts`** — `HstsConfig | false`. `Strict-Transport-Security` tuning for
  HTTPS responses. Defaults to `max-age=31536000` (1 year, host-only — no
  `includeSubDomains`/`preload`, so it can't brick sibling subdomains). Fields:
  `maxAge`, `includeSubDomains`, `preload`. Set `false` to omit the header (e.g.
  when your edge sets it).
- **`csp`** — `CspSetting` (default `"strict"`). App-wide
  Content-Security-Policy: `"strict"` (denext's hash-based strict policy on
  buffered pages), `"off"` (emit no CSP — set it at the edge), or a `RouteCsp`
  object (the strict policy plus global opt-ins). A route's own `csp` export
  overrides this. Streamed responses never carry the hash-based CSP.
- **`publicEnv`** — `string[]`. Public-env keys to always embed in the page, in
  addition to the ones the build detects. Use it for a key read via a computed
  expression the build can't see (e.g. `publicEnv()["NEXT_PUBLIC_" + x]`).

> [!IMPORTANT]
> Remote image hosts, redirects to absolute URLs, and `csp: "off"` all widen
> your app's trust boundary. Only allowlist hosts you control or trust, and
> prefer path-relative redirect destinations for anything derived from the
> request.

## Compatibility

- **`compatibilityMode`** — `boolean | "auto"` (default `"auto"`). Run the app
  through the **next-compat** pipeline, which rewrites every
  `react`/`react-dom`/`next/*` import (including those inside npm React
  libraries) to denext at bundle time — the drop-in path for real Next.js App
  Router projects. `"auto"` enables it when `node_modules/react` exists or
  `package.json` lists `react`/`next`; a pure denext-native app keeps the
  zero-overhead source-load path. (Renamed from `nextCompat`; the old key is no
  longer accepted.)
- **`classComponents`** — `boolean` (default `false`). Enable React class
  components in the **next-compat build** only, where the flag compiles in as a
  `define` so the class runtime is dead-code-eliminated when off. The standard
  `deno bundle` pipeline always includes the (small) class runtime and ignores
  this flag.
- **`mdx`** — `MdxConfig`. MDX/CommonMark compilation options for `.mdx`/`.md`
  sources in a compat (npm-React) app. The baseline loader compiles plain MDX;
  set this to thread your own `remarkPlugins`, `rehypePlugins`, `recmaPlugins`,
  `remarkRehypeOptions`, or `providerImportSource` (forwarded verbatim to MDX's
  `compile`). Because `denext.config.ts` is a real module, `import` the plugins
  directly.

## Plugins

- **`plugins`** — `DenextPlugin[]`. denext plugins (e.g. a Pages Router, or
  htmx). Each is set up once before routes are scanned and may contribute
  routes, claim requests, emit build assets, and add CLI verbs. Apps with no
  plugins pay nothing.

Install and wire one in a single step with the CLI:

```sh
denext plugin add @denext/htmx      # adds the dep and edits denext.config.ts
denext plugin list                  # show what's wired
```

See [Writing a plugin](https://github.com/denext/denext/blob/main/PLUGINS.md).

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

## Experimental

A feature stays here only while it is genuinely **incomplete** — being new is
not enough. All off by default.

- **`experimental`** — `ExperimentalConfig`.
- **`experimental.compiler`** — `boolean`. An opt-in build-time auto-memoization
  optimization (a React-Compiler-style pass). Conservative by construction —
  bails to identity whenever a transform isn't provably safe, so it only ever
  adds memoization. Off while its coverage widens.
- **`experimental.cacheComponents`** — `boolean`. Cache Components (Next.js 16):
  the `"use cache"` directive compiles into cross-request server caching, plus
  the PPR render path — dynamic-by-default rendering with cacheable `use cache`
  islands (a cached shell with per-request dynamic holes). Implemented and
  tested, but still experimental because of documented bounds (see
  KNOWN-LIMITATIONS) — reading request data (`cookies()`/`headers()`) inside
  `use cache` throws, and a streamed hole can't add to the already-flushed head.
  Inert when off.
- **`experimental.asyncContext`** — `boolean`. Scope async `startTransition` by
  transition **identity** instead of the default time window: a build transform
  makes denext's first-party `AsyncContext` survive `await`, so a post-`await`
  update stays a transition while an unrelated urgent update in the pending
  window keeps its priority. Opt-in — it instruments every client `await` (a
  small per-`await` cost), and in v1 leaves async generators and top-level
  `await` un-instrumented. Off by default, with the time-window behavior
  unchanged. See [Async transitions](/docs/rendering#async-transitions).
- **`experimental.nodeResolve`** — `boolean` (**default on** for the compat
  build). denext's tolerant `node_modules` resolver: a strict superset of Deno's
  `npm:` loader that resolves bare npm specifiers straight from the app's
  installed `node_modules`, honoring `exports` wildcard globs. This is what lets
  an unmodified pnpm/npm/yarn/bun app build without hand-patching dependency
  `exports` — the reason `denext migrate` never rewrites `package.json`. Set
  `false` to force app deps back through Deno's strict `npm:` loader (escape
  hatch).

## See also

Every public type and signature — including `DenextConfig` and each sub-config —
is in the [API reference](/docs/api).
