// denext.config.{ts,js} — project configuration parity with next.config.js:
// declarative redirects / rewrites / headers plus basePath / trailingSlash /
// assetPrefix. Loaded once at startup (static config, like Next).

import type { I18nConfig } from "./i18n.ts";
import type { DenextPlugin } from "../plugin/mod.ts";
import type { CspSetting } from "./segment-config.ts";
import type { CacheStore } from "./cache.ts";
import { envGet } from "../runtime/env-safe.ts";
// Type-only (erased at runtime) — `src/cli/command.ts` is a dependency-free leaf whose
// only import is a pure util, so naming it here adds no runtime edge and no cycle.
import type { CommandContext, FlagSpec, PositionalSpec } from "../cli/command.ts";

/** A URL-path redirect rule (`source` → `destination`). */
export interface RedirectRule {
  /** Path pattern to match, with `:name` and `:name*` params (e.g. `/old/:slug`). */
  source: string;
  /** Where to send the client; may reference `:name` params from `source`. */
  destination: string;
  /** `true` → 308 (permanent); otherwise 307 (temporary). */
  permanent?: boolean;
}

/** An internal rewrite rule (`source` served as `destination`, no client redirect). */
export interface RewriteRule {
  /** Path pattern to match, with `:name` params. */
  source: string;
  /** The path to route as instead; may reference `:name` params. */
  destination: string;
}

/** A response-header rule applied to paths matching `source`. */
export interface HeaderRule {
  /** Path pattern to match, with `:name` params. */
  source: string;
  /** Header name/value pairs to add to matching responses. */
  headers: Array<{
    /** The header name, e.g. `Cache-Control`. */
    key: string;
    /** The value to send, e.g. `public, max-age=3600`. */
    value: string;
  }>;
}

/**
 * An allowed remote image source for the optimizer (Next.js-style). A source URL
 * matches when its protocol equals `protocol` (if given), its host matches
 * `hostname` (a literal, or a leading-`*.` wildcard suffix), and its path starts
 * with `pathname` (if given).
 */
export interface RemotePattern {
  /** Required protocol, e.g. `"https"`. Any protocol when omitted. */
  protocol?: string;
  /** Host to match: exact (`cdn.example.com`) or wildcard (`*.example.com`). */
  hostname: string;
  /**
   * Pathname the source must match: a Next.js glob (`/images/**`, `*` = one segment,
   * `**` = any depth). A bare prefix (`/images/`) matches that path and anything below it.
   * Any when omitted.
   */
  pathname?: string;
  /** Required port (e.g. `"3000"`); the protocol default when omitted. */
  port?: string;
  /** Required query string (e.g. `"?v=1"`); any when omitted. */
  search?: string;
}

/**
 * Tailwind CSS integration. When set, denext compiles `input` (which contains the
 * raw `@import "tailwindcss";` directives) into `output` using the Tailwind v4
 * standalone binary — which denext downloads and manages itself — before its own
 * CSS pipeline runs. The `output` file is what your layout imports.
 */
export interface TailwindConfig {
  /** Input stylesheet with the Tailwind directives, relative to the project root. */
  input: string;
  /** Compiled stylesheet to emit (imported by your layout), relative to the root. */
  output: string;
}

/**
 * MDX compilation options (see {@link DenextConfig.mdx}). Each plugin list is a
 * unified `PluggableList`: an array whose entries are either a plugin function or a
 * `[plugin, options]` tuple. Typed loosely (`unknown[]`) so the public config surface
 * doesn't depend on `unified`/`@mdx-js` types; the values are forwarded verbatim to
 * MDX's `compile`.
 */
export interface MdxConfig {
  /** remark (Markdown AST) plugins — e.g. `remark-gfm`, `remarkCodeHike`. */
  remarkPlugins?: unknown[];
  /** rehype (HTML AST) plugins — e.g. `rehype-slug`, `rehype-pretty-code`. */
  rehypePlugins?: unknown[];
  /** recma (JS AST) plugins — e.g. `recmaCodeHike`. */
  recmaPlugins?: unknown[];
  /** Options forwarded to MDX's `remark-rehype` bridge (`remarkRehypeOptions`). */
  remarkRehypeOptions?: Record<string, unknown>;
  /** MDX `providerImportSource` (module exporting `useMDXComponents`), if used. */
  providerImportSource?: string;
}

/**
 * An allowed **local** image source pattern (Next.js `images.localPatterns`). A
 * local source (`/…` under `public/`) matches when its pathname matches `pathname`
 * (a glob: `*` = one path segment, `**` = any) and, if `search` is given, its query
 * string equals it exactly (`search: ""` ⇒ only a query-less URL). When
 * `localPatterns` is set, a local source matching none is refused — an enumeration
 * guard for query-string variants.
 */
export interface LocalPattern {
  /** Pathname glob the local source must match (e.g. `/assets/**`). Any when omitted. */
  pathname?: string;
  /** Exact query string required (e.g. `"v=1"`), or `""` for none. Any when omitted. */
  search?: string;
}

/** Image-optimization config (the `/_denext/image` endpoint). */
export interface ImagesConfig {
  /**
   * Render every `<Image>` as a plain `<img>` with its raw `src` — no optimization,
   * no generated `srcSet` (matches Next's `images.unoptimized`). `<Image>` optimizes
   * by default; set this to opt the whole app out. Static export forces this on (there
   * is no server to optimize against). Per-image, use the `unoptimized` prop.
   */
  unoptimized?: boolean;
  /**
   * Exact remote hosts allowed as sources (host only, e.g. `cdn.example.com`).
   * @deprecated Removed in Next.js 16; use `remotePatterns`. Still honored through denext 2.x,
   * removed in 3.0.
   */
  domains?: string[];
  /** Pattern-based remote allowlist (protocol/host-wildcard/pathname). */
  remotePatterns?: RemotePattern[];
  /**
   * Allowed **local** source patterns (pathname glob + optional exact query). When
   * set, a `public/` source matching none is refused (400); when omitted, all local
   * sources are allowed (the default). Mirrors Next.js `images.localPatterns`.
   */
  localPatterns?: LocalPattern[];
  /**
   * Allowed responsive breakpoint widths for full-width images (matches Next's
   * `images.deviceSizes`). The `/_denext/image` endpoint only honors `w=` values
   * drawn from `deviceSizes ∪ imageSizes`; any other width is refused (400). This
   * bounds the endpoint's distinct-work surface — without it, an attacker can
   * request thousands of arbitrary widths, each forcing a fresh WASM decode/resize.
   * Defaults to Next's standard set.
   */
  deviceSizes?: number[];
  /**
   * Allowed fixed widths for smaller images (icons, thumbnails) — matches Next's
   * `images.imageSizes`. Unioned with {@linkcode ImagesConfig.deviceSizes} to form
   * the `/_denext/image` width allowlist. Defaults to Next's standard set.
   */
  imageSizes?: number[];
  /**
   * Allowed `q=` quality values (matches Next.js 16 `images.qualities`). The
   * endpoint refuses any other quality (400), bounding the distinct-encode surface
   * the same way {@linkcode deviceSizes} bounds widths. Defaults to `[75]`.
   */
  qualities?: number[];
  /**
   * Minimum seconds to cache an optimized image (`Cache-Control: max-age`). Mirrors
   * Next.js `images.minimumCacheTTL`. Defaults to `14400` (4 hours).
   *
   * @minimum 0
   */
  minimumCacheTTL?: number;
  /**
   * Output formats the endpoint may negotiate from the request `Accept` header, in
   * preference order (matches Next.js `images.formats`). Include `"image/avif"` to
   * enable AVIF (falls back to WebP when the client doesn't accept AVIF). Defaults
   * to `["image/webp"]`.
   */
  formats?: Array<"image/webp" | "image/avif">;
  /**
   * Max redirect hops to follow for a remote source, each re-validated (matches
   * Next.js `images.maximumRedirects`). Defaults to `3`; `0` disables redirects.
   *
   * @minimum 0
   */
  maximumRedirects?: number;
  /**
   * **Dangerous.** Allow remote sources that resolve to loopback/private/link-local
   * addresses, disabling the SSRF address guard for the image optimizer (Next.js 16
   * `images.dangerouslyAllowLocalIP`). Only enable in a trusted, isolated network
   * where the optimizer cannot reach internal services. Defaults to `false`.
   */
  dangerouslyAllowLocalIP?: boolean;
}

/**
 * Reverse-proxy configuration for SPA serving — the SPA analogue of a Vite dev
 * server's `server.proxy`. The client talks to its own origin and denext relays
 * matched requests (HTTP + WebSocket) to a separate backend.
 */
export interface SpaProxyConfig {
  /**
   * Path prefixes forwarded to {@link target}, matched against the start of the
   * request pathname — a prefix matches the exact path and any sub-path (e.g. `/api`
   * matches `/api` and `/api/users`). Everything else is served from the SPA export.
   */
  prefixes: string[];
  /**
   * Backend origin matched requests are forwarded to (e.g. `"http://127.0.0.1:3773"`).
   * HTTP is relayed via `fetch` (cookies passed through, `Set-Cookie` `Domain`/`Secure`
   * stripped so they bind to the proxy origin over http); a WebSocket upgrade is
   * bridged to the backend with the request `Cookie` forwarded on the handshake.
   *
   * This is a **desktop/dev convenience** for reaching a *local* backend, not a
   * production reverse proxy — the target must be loopback unless
   * {@link allowNonLoopback} is set (at which point the security implications of
   * running an open reverse proxy are yours).
   */
  target: string;
  /** Permit a non-loopback {@link target}. Default `false` (loopback-only). */
  allowNonLoopback?: boolean;
}

/**
 * SPA-mode settings (`mode: "spa"`). denext bundles {@link SpaConfig.entry} as a
 * single client-side-rendered app, wraps it in a generated HTML shell, and serves
 * that shell for every navigation (history-API fallback) — no `app/` directory, no
 * SSR/Flight. The entry module mounts the app itself (a side-effect import, like a
 * Vite `main.tsx` calling `createRoot(...).render(...)`), so denext stays out of the
 * mount: bring your own router (TanStack, etc.) and data layer.
 */
export interface SpaConfig {
  /**
   * Client entry module that mounts the app, relative to the project root
   * (e.g. `"./src/main.tsx"`). It is imported for its side effects — it is
   * expected to create a root and render into `#${rootId}` on load.
   */
  entry: string;
  /** Element id the generated shell exposes for the app to mount into. Default `"root"`. */
  rootId?: string;
  /** `<title>` for the generated shell. Default `"denext app"`. */
  title?: string;
  /**
   * Extra raw HTML injected into the shell `<head>` (meta tags, preconnect links, …).
   * A `<meta name="viewport">` here replaces the shell's default
   * (`width=device-width, initial-scale=1`) — e.g. `viewport-fit=cover` for iOS safe areas.
   *
   * @widget textarea
   */
  head?: string;
  /**
   * Raw HTML rendered INSIDE the mount element (`#${rootId}`) in the generated shell — the
   * boot placeholder shown before the client bundle loads and renders. The framework does
   * not touch it; the app's first render (createRoot/hydrateRoot) replaces `#root`'s
   * children, clearing it. Use it to paint instantly instead of a blank page: a themed
   * background (pair with a pre-paint script in {@link head}), a logo splash, or a spinner —
   * the same role a Vite/CRA `index.html` fills with markup inside `<div id="root">…</div>`.
   * `denext migrate --from vite` carries the source `index.html`'s `#root` content here.
   *
   * @widget textarea
   */
  loading?: string;
  /** `<html lang>` value for the generated shell. Default `"en"`. */
  lang?: string;
  /**
   * Compile-time `import.meta.env` values (the SPA analogue of a Vite `define`
   * block). Each `{ KEY: "value" }` replaces `import.meta.env.KEY` with the literal
   * `"value"` at build time — the way a Vite app reads `import.meta.env.VITE_*`.
   * Only applied when the app builds through the next-compat (esbuild) pipeline
   * (i.e. it uses npm React); a denext-native SPA has no `import.meta.env`.
   */
  env?: Record<string, string>;
  /**
   * Content-Security-Policy for the generated shell. A client-only React SPA
   * (Vite/CRA and denext alike) ships no CSP by default — it's the app's/host's
   * call — so this is **opt-in**:
   * - unset / `"off"` — no CSP (default).
   * - `"strict"` — denext's strict policy (`default-src 'self'`, `script-src 'self'`,
   *   `object-src 'none'`, `base-uri 'self'`, `img/font 'self' data:`, and
   *   `style-src-attr 'unsafe-inline'` so React `style={{}}` keeps working).
   * - a {@link CspSetting} object — that strict policy plus your global opt-ins
   *   (e.g. `{ connectSrc: ["https://api.example.com"] }` for your API host).
   *
   * Emitted as a `<meta http-equiv="Content-Security-Policy">` in the shell so it
   * applies for `export` (any static host), `start`, and `dev` alike. `frame-ancestors`
   * is header-only (ignored in `<meta>`); clickjacking is covered by the always-on
   * `X-Frame-Options: SAMEORIGIN`. Set a header at your edge for `frame-ancestors`.
   */
  csp?: CspSetting;
  /**
   * Reverse-proxy selected path prefixes to a separate backend while serving the SPA
   * (`denext start` in `mode:"spa"`, and the `deno desktop` runtime). Mirrors a Vite
   * dev server's `server.proxy`: the client talks to its own origin and denext relays
   * matched requests — HTTP and WebSocket — to the backend. Omit for a backend-less SPA.
   */
  proxy?: SpaProxyConfig;
  /**
   * Write a gzip `.gz` sibling next to each compressible client asset at `build` and
   * `export`, so `denext start` serves `Content-Encoding: gzip` with no per-request CPU.
   * Default `true`. Set `false` when the export is bundled into a native shell such as
   * Capacitor, whose iOS/Android webview loads files from the app bundle and never requests
   * the `.gz` variants, to keep them out of the bundle.
   */
  precompress?: boolean;
  /**
   * Stamp the static export for over-the-air UI updates: `denext export` writes
   * `_denext/ota.json` (every file's path, SHA-256 and size, plus a `version` hashed over
   * them) into the export directory as its last step. A Capacitor shell with the
   * `DenextOta` plugin (`denext mobile add-ota`) reads the bundled copy to know which UI it
   * ships, and `checkForUiUpdate` from `denext/mobile` compares a server's copy against it.
   * Default `false`. `*.gz` siblings are never listed. When the `DENEXT_OTA_SIGNING_KEY` env var
   * holds a PKCS#8 PEM (`denext ota keygen`), the manifest is also signed.
   */
  ota?: boolean;
  /** `deno desktop` packaging settings (used when building the desktop app). */
  desktop?: SpaDesktopConfig;
}

/** `deno desktop` packaging settings under {@link SpaConfig.desktop}. */
export interface SpaDesktopConfig {
  /**
   * Path to the app icon (relative to the project root, e.g. `"./assets/icon.png"` —
   * point it anywhere, regardless of name or location). **Overrides icon
   * auto-detection.** A **PNG is used verbatim** (supply a finished 1024² master already
   * shaped for macOS — the app's own icon set is the right source); a JPEG/WebP is
   * composed into the macOS template; an undecodable format (`.ico`/`.icns`) is refused
   * with a message and the build falls back to auto-detection. When unset, denext
   * auto-detects a web icon (`apple-touch-icon`, a named `icon`/`logo`, `favicon.png`)
   * and, because those are small/full-bleed, composes it into Apple's macOS template
   * (centered in the ~824px safe area of a 1024² canvas) so it isn't oversized. Either
   * way the result is written to `desktop-icon.png` at build time.
   *
   * The `deno task desktop` command carries `--icon desktop-icon.png` only when an app
   * icon was detected at migrate time. If your app had one then, editing this and
   * rebuilding is enough — no re-migration. If migrate found no icon (so the task has no
   * `--icon`), re-run `denext migrate --desktop` after setting this so the flag is wired.
   */
  icon?: string;
}

/** Cache Components / ISR cache-store configuration ({@link DenextConfig.cache}). */
export interface CacheConfig {
  /**
   * Which store backs `use cache` / ISR. `"sqlite"` = the durable `node:sqlite` file
   * store (real SQLite, built into Deno, zero-npm); `"memory"` = the in-process LRU store
   * (ephemeral, per-process); or a custom {@link CacheStore}. Omit for the smart default:
   * `node:sqlite` when a writable FS is available, otherwise in-memory.
   */
  store?: "sqlite" | "memory" | CacheStore;
  /** SQLite store file path (default `.denext/cache.db`). */
  path?: string;
  /**
   * Max rows in the durable data cache before FIFO eviction (default 1000).
   *
   * @minimum 1
   */
  maxDataEntries?: number;
  /**
   * Max rows in the durable page (ISR) cache before FIFO eviction (default 1000).
   *
   * @minimum 1
   */
  maxPageEntries?: number;
}

/** Scheduled/background task behaviour ({@link DenextConfig.tasks}). */
export interface TasksConfig {
  /**
   * Record every task run — scheduled and on demand — to `.denext/tasks.db`, so `denext ui`'s
   * Cron panel can show last status, success/failure counts and a recent-run feed.
   *
   * Off unless set: denext writes no run history unasked. Once on, recording can never fail or
   * delay a run — a read-only filesystem or a locked file degrades to no history instead.
   *
   * Each row keeps the run's output in plain text: the tail of a string the handler returned
   * (up to 2 KB) and, for a failure, the error's message and stack. A task that returns a token,
   * a DSN or another secret should return nothing instead. The file is `tasks.db` (with its
   * `-wal`/`-shm` siblings) inside the build output directory, `.denext/` by default, created
   * owner-only (mode 0600) where the platform has file modes.
   */
  history?: boolean;
  /**
   * Runs kept per task before the oldest are dropped (default 500).
   *
   * Per task rather than overall, so a task running every minute cannot evict a daily task's
   * history. A task running more often than roughly every 20 minutes fills this inside a week,
   * so raise it for such a task if its counts should cover the whole window.
   *
   * @minimum 1
   */
  historyMaxRuns?: number;
}

/** React Native / Expo web build options ({@link DenextConfig.reactNative}). */
export interface ReactNativeConfig {
  /**
   * Inject Expo web's root style into the SPA shell's `<head>`:
   * `html,body,#root{height:100%;margin:0}` and `#root{display:flex}` (`#root` follows
   * `spa.rootId`). React Native's root view is `flex: 1` and needs a sized flex parent;
   * without it the app collapses to its content height and absolutely positioned overlays
   * cover the page. It comes before `spa.head`, so a rule there overrides it.
   *
   * @default true
   */
  rootStyle?: boolean;
  /**
   * Alias each `expo-*` package that has a `denext/expo/*` shim (`expo-haptics` →
   * `denext/expo/haptics`, …: the list is `denext/expo/manifest`'s `EXPO_SHIMS`) to that
   * shim, which implements the package's API over `denext/mobile` and web APIs. A package
   * without a shim resolves normally. `false` resolves every `expo-*` package normally.
   *
   * @default true
   */
  expoShims?: boolean;
}

/** Limits for the typed-API batch endpoint (`POST /_denext/api-batch`). */
export interface ApiBatchConfig {
  /**
   * Serve the endpoint at all (default true; `false` → 404).
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Max items per batch (default 20, at most 100).
   *
   * @minimum 1
   * @maximum 100
   */
  maxItems?: number;
  /**
   * Max batch request body in bytes (default 1 MiB).
   *
   * @minimum 1
   */
  maxBodyBytes?: number;
  /**
   * Items run concurrently per batch (default 4).
   *
   * @minimum 1
   * @maximum 64
   */
  concurrency?: number;
  /**
   * Max bytes of one item's response body carried back (default 4 MiB; over → a 500 item).
   *
   * @minimum 1
   */
  maxItemResponseBytes?: number;
  /**
   * Max bytes of ALL items' response bodies together (default 16 MiB; over → the rest are
   * 500 items).
   *
   * @minimum 1
   */
  maxTotalResponseBytes?: number;
}

/**
 * A project-local CLI verb declared in `denext.config.ts` under
 * {@link DenextConfig.commands} — the zero-ceremony half of denext's CLI extension
 * story: no plugin, no `setup`, just an object. It is structurally a CLI
 * `CommandSpec`, so the same parser, `--help` renderer, and dispatcher run it, and a
 * verb that outgrows the config can move into a plugin's `addCommand` unchanged.
 *
 * ```ts
 * // denext.config.ts
 * export default {
 *   commands: [{
 *     name: "seed",
 *     summary: "Load fixture data into the dev database",
 *     flags: [{ name: "rows", type: "number", default: 100, help: "How many rows" }],
 *     run: async (ctx) => { await seed(Number(ctx.flags.rows)); },
 *   }],
 * };
 * ```
 */
export interface DenextCommand {
  /** The verb, e.g. `"seed"` for `denext seed`. Lowercase; `[a-z][a-z0-9-]*`. */
  name: string;
  /** One-line summary shown by `denext commands` under "Project commands". */
  summary: string;
  /** Optional multi-line detail shown by `denext <name> --help`. */
  usage?: string;
  /** Declarative flags (parsed, defaulted, and documented like a built-in verb's). */
  flags?: FlagSpec[];
  /** Declarative positionals (for help/usage; parsing collects all positionals). */
  positionals?: PositionalSpec[];
  /** The implementation, handed the parsed invocation. */
  run(ctx: CommandContext): void | Promise<void>;
}

/** Project configuration exported from `denext.config.{ts,js}` (as `default` or named). */
export interface DenextConfig {
  /**
   * Rendering mode. Omit (the default) for the App Router (SSR/SSG) pipeline.
   * `"spa"` builds {@link SpaConfig.entry} as a pure client-side-rendered app —
   * React but not Next: no `app/` directory, no SSR, no Flight. denext bundles the
   * entry, emits an HTML shell around it, serves it with a history-API fallback, and
   * (via `denext export` / `deno desktop`) packages it as a static app. Use it to
   * host an existing Vite-style React SPA on denext's toolchain and runtime.
   */
  mode?: "spa";
  /** SPA-mode settings (required when {@link DenextConfig.mode} is `"spa"`). */
  spa?: SpaConfig;
  /** Internationalized routing config. */
  i18n?: I18nConfig;
  /** Serve the app under a sub-path (e.g. `/docs`). Stripped before routing. */
  basePath?: string;
  /**
   * Enforce a trailing slash on page URLs (308-redirect to normalize). Unset or `false`
   * (Next's default) redirects `/about/` → `/about`.
   */
  trailingSlash?: boolean;
  /** Prefix for client bundle/asset URLs (e.g. a CDN origin). */
  assetPrefix?: string;
  /** Declarative redirects, evaluated once at startup. */
  redirects?: () => RedirectRule[] | Promise<RedirectRule[]>;
  /** Declarative rewrites, evaluated once at startup. */
  rewrites?: () => RewriteRule[] | Promise<RewriteRule[]>;
  /** Declarative response headers, evaluated once at startup. */
  headers?: () => HeaderRule[] | Promise<HeaderRule[]>;
  /**
   * Cron schedules for background tasks: a map of a 5-field cron expression to the task name(s)
   * to run on it (a task is `tasks/<name>.ts` exporting `defineTask(...)`). Registered at server
   * startup via `Deno.cron` when the runtime exposes it (Deno Deploy, or `--unstable-cron`) and a
   * dependency-free minute-tick scheduler otherwise. A task may also declare its own `schedule`.
   *
   * ```ts
   * scheduledTasks: { "0 3 * * *": "cleanup", "0 0 * * 1": ["digest", "warm-cache"] }
   * ```
   */
  scheduledTasks?: Record<string, string | string[]>;
  /**
   * Scheduled/background task behaviour. Currently run history, which is off unless asked for.
   *
   * ```ts
   * tasks: { history: true }
   * ```
   */
  tasks?: TasksConfig;
  /**
   * Image-optimization config. Remote sources are refused by default (local-only,
   * SSRF-safe); allowlist hosts here to enable optimizing remote images.
   */
  images?: ImagesConfig;
  /**
   * Tailwind CSS integration. When set, denext manages the Tailwind v4 standalone
   * binary and compiles `input` → `output` automatically on `dev`/`build`.
   */
  tailwind?: TailwindConfig;
  /**
   * MDX compilation options for `.mdx`/`.md` sources in a compat (npm-React) app.
   * The baseline loader compiles plain MDX/CommonMark; set this to thread
   * app-configured unified plugins (e.g. Codehike, GFM, syntax highlighting) into
   * MDX's `compile`. Because `denext.config.ts` is a real module, the plugins are imported
   * and passed as function references, not named as strings.
   *
   * ```ts
   * import { remarkCodeHike, recmaCodeHike } from "codehike/mdx";
   * export default { compatibilityMode: true, mdx: {
   *   remarkPlugins: [[remarkCodeHike, chConfig]],
   *   recmaPlugins: [[recmaCodeHike, chConfig]],
   * } };
   * ```
   */
  mdx?: MdxConfig;
  /**
   * Cache Components / ISR data + page cache store. Omit to let denext resolve the
   * default at startup — the durable `node:sqlite` store when a writable filesystem is
   * available, else the in-memory store. Set {@link CacheConfig.store} to force a choice,
   * or pass your own {@link CacheStore}.
   */
  cache?: CacheConfig;
  /**
   * `Strict-Transport-Security` (HSTS) header tuning, applied to responses served
   * over HTTPS. Defaults to `max-age=31536000` (1 year, host-only — no
   * `includeSubDomains`/`preload`, a safe default that can't brick sibling
   * subdomains). Set fields to opt into a stronger policy, or `false` to omit the
   * header entirely (e.g. when your edge sets it).
   */
  hsts?: HstsConfig | false;
  /**
   * App-wide Content-Security-Policy default (three-state), overridable per file:
   * - `"strict"` (default) — denext's hash-based strict policy on buffered pages.
   * - `"off"` — emit no CSP header at all (set your policy at the edge, or for
   *   Next.js-style "CSP is the app's job" behavior). A route can still opt back in
   *   with its own `csp` export.
   * - a {@link CspSetting} object — the strict policy plus these global opt-ins.
   *
   * A route's `csp` export overrides this for that route. Streamed responses (PPR /
   * incremental streaming) carry the **same** strict hash-based CSP, computed from the
   * buffered shell prefix plus the hashed swap-runtime constant (see
   * {@link resolveStreamingCsp}); the one inherent limit is that an inline
   * `<style>`/`<script>` appearing inside a streamed hole (flushed after the head) is
   * not covered by the header — see [KNOWN-LIMITATIONS.md]. Absent ⇒ `"strict"`.
   */
  csp?: CspSetting;
  /**
   * Public-env vars to always embed in the page island, in addition to the ones
   * the build detects the client references. Use this to force-include a key the
   * client reads via a computed expression (`publicEnv()["NEXT_PUBLIC_" + x]`),
   * which the build can't see. Referenced keys are shipped automatically; this only
   * adds to that set.
   */
  publicEnv?: string[];
  /**
   * Incremental (Suspense) streaming, **on by default**; set `false` to opt out.
   * A page with a pending Suspense boundary flushes its shell first and streams each
   * boundary's content as it resolves; a fully synchronous page (no holes) is still
   * delivered buffered, so it stays shared-cacheable. Streamed responses carry the
   * same strict hash-based CSP as buffered ones (the swap runtime is a hashed
   * constant), survive a failing boundary (its fallback stays), and cover Flight
   * routes. ISR/PPR-cacheable routes (revalidate/force-static) and soft navigations
   * take their own path first, so streaming never bypasses the page cache. A shipped,
   * default-on capability — not an experiment.
   *
   * @default true
   */
  streaming?: boolean;
  /**
   * Live Server Components security policy: authorization hooks and resource caps
   * for the `<Live>` / `useLive` / `usePresence` WebSocket hub. See {@link LiveConfig}.
   * Presence/data are default-deny in production without a policy here — so this is a
   * **security-policy** field, not an on/off experiment.
   */
  live?: LiveConfig;
  /**
   * The typed-API batch endpoint (`POST /_denext/api-batch`: N GET/HEAD calls from
   * `createApiClient` in one round trip). Same-origin only; caps on items, body, fan-out
   * concurrency, and per-item response size. See {@link ApiBatchConfig}.
   */
  apiBatch?: ApiBatchConfig;
  /**
   * The request-body cap for route handlers (`route.ts`), in bytes — default 1 MiB. A route
   * raises or lifts its own with `export const maxBodyBytes = N | false`; a `defineApi`
   * endpoint with `maxBodyBytes` in its definition overrides both. Over the cap → 413.
   *
   * @minimum 1
   */
  apiMaxBodyBytes?: number;
  /**
   * The request-body cap for Server Actions, in bytes — default 1 MiB (Next's default). Raise
   * it only for actions that accept large payloads (multipart uploads); over the cap → 413
   * before the action runs. `denext start`/`dev` forward it to the server; a custom server
   * passes `actionMaxBodyBytes` to `createApp()` itself.
   *
   * @minimum 1
   */
  actionMaxBodyBytes?: number;
  /**
   * The app's public origin (e.g. `"https://example.com"`), pinned outright: absolute URLs
   * (canonical, `og:image`), the Server Action origin check and HSTS all use it instead of
   * the `Host` / forwarded headers — the robust choice behind a proxy that rewrites `Host`.
   * A full origin (scheme + host, no path). Unset, the `DENEXT_CANONICAL_ORIGIN` env var is
   * read at boot (config > env > derived from the request).
   */
  canonicalOrigin?: string;
  /**
   * Trust `X-Forwarded-Proto` / `X-Forwarded-Host` from a reverse proxy when deriving the
   * request origin (absolute URLs, the Server Action origin check, HSTS), and
   * `X-Forwarded-For` / an inbound `X-Request-Id` for `clientIp()`, `requestId()` and the
   * rate limiters (`denextAuth` inherits it unless it sets its own). Enable ONLY when clients
   * cannot reach denext directly — a client that can spoofs them. The origin part is ignored
   * when {@link DenextConfig.canonicalOrigin} is set. Unset, `DENEXT_TRUST_PROXY=1` turns it on
   * (config > env > `false`).
   */
  trustForwardedHeaders?: boolean;
  /**
   * `denext dev` only: extra hosts allowed to reach the dev server's `/_denext/*` assets (the
   * bundles, the module graph, the reload stream, the Live hub), beyond loopback. Each entry is
   * an origin (`"http://192.168.1.5:3000"`) or a bare host (`"192.168.1.5"`, `"mac.local"`,
   * `"mac.local:3000"`); matching is on the hostname. Wildcards are not supported: list each
   * host. Mirrors Next.js's `allowedDevOrigins`.
   *
   * Without it the dev server refuses those assets to any non-loopback `Host` (the DNS-rebinding
   * defense, cf. CVE-2025-48068), so a phone or another machine gets a dead page. You rarely
   * need to set it by hand: `denext dev --lan` and an explicit `--host` allow the address they
   * bind, and `--allowed-dev-origin <origin>` adds entries for one run. A listed host is
   * trusted as a dev client: anything on the network that can reach it (and send that `Host`)
   * can read the app's transformed source, as a loopback client can. Ignored by `denext start`.
   */
  allowedDevOrigins?: string[];
  /**
   * Per-request deadline in milliseconds — default 30 000. A request still running past it
   * is aborted and answered `503`; the per-request `AbortSignal` fires so cooperative work
   * (`fetch(url, { signal })`) cancels. `0` disables the deadline. Unset, the
   * `DENEXT_REQUEST_TIMEOUT_MS` env var is read at boot (config > env > default).
   *
   * @minimum 0
   */
  requestTimeout?: number;
  /**
   * In-process concurrency ceiling: the max number of client requests one instance handles
   * at once. A request arriving at capacity is shed immediately with `503` + `Retry-After`
   * (never queued). Bounds work up to the point the `Response` is produced (a streaming
   * body's client-read time is not counted); background ISR regeneration is exempt. A
   * complement to — not a replacement for — the edge/load-balancer ceiling. Default: no
   * limit. Unset, the `DENEXT_MAX_CONCURRENCY` env var is read at boot (config > env >
   * unlimited).
   *
   * @minimum 1
   */
  maxConcurrency?: number;
  /**
   * With {@link DenextConfig.maxConcurrency} set and {@link DenextConfig.requestTimeout} `0`,
   * the milliseconds after which a never-settling request's concurrency slot is force-freed
   * (default 120 000). It frees only the slot — the render is not aborted, since the request
   * timeout was opted out of. Inert while a request timeout is in place.
   *
   * @minimum 1
   */
  slotBackstop?: number;
  /**
   * Allowlist of query-parameter names that fork the ISR page-cache key. When set, only these
   * params make a distinct cached entry; every other param (`?utm_*`, `?fbclid`, a random
   * cache-buster) is ignored for keying — but still reaches the render via `searchParams`, so
   * list every param whose value changes cacheable output. Unset, every param participates.
   */
  cacheKeyParams?: string[];
  /**
   * denext's tolerant node_modules resolver for the compat (npm-React) build — default ON.
   *
   * Every bare npm specifier is resolved straight from the app's installed `node_modules`
   * using denext's own resolver, a strict superset of Deno's `npm:` loader: it honors
   * `exports` wildcard globs, falls back to a plain subpath, and returns nothing on a miss
   * (so the deno-loader still gets its shot). This is what makes an unmodified
   * pnpm/npm/yarn/bun app build with no catalog-concretizing and no hand-patching of
   * dependency `exports` — the "seamless migration" contract. Set `false` only to force
   * app deps back through Deno's strict `npm:` loader (escape hatch). The pre-2.0 home,
   * `experimental.nodeResolve`, is still honored.
   *
   * @default true
   */
  nodeResolve?: boolean;
  /**
   * Cache Components (Next.js 16): the `"use cache"` directive is compiled into
   * cross-request caching on the server (`src/build/use-cache-transform.ts`), plus the
   * PPR render path — dynamic-by-default rendering with cacheable `use cache` islands (a
   * cached shell with per-request dynamic holes spliced in). A stable, **opt-in**
   * feature, deliberately **off by default**: caching stays a choice, because a cache
   * bug's failure class (a poisoned or cross-user shell) is severe and must not be
   * imposed on apps that never asked. When off, every `"use cache"` directive is inert
   * (a plain no-op string statement) and rendering is unchanged.
   *
   * Documented bounds (see KNOWN-LIMITATIONS): reading request data
   * (`cookies()`/`headers()`) inside `use cache` throws; a streamed hole can't add an
   * inline `<style>`/`<script>` or hoist an in-boundary `<title>`/`<meta>` into the
   * already-flushed head; and `searchParams` read outside a Suspense boundary with
   * `cacheKeyParams` can reflect one request's value.
   *
   * Configs written against 2.0 pre-releases may still set
   * `experimental.cacheComponents`; that legacy alias is honored (see
   * {@linkcode resolveCacheComponents}) but this top-level field is the canonical home.
   */
  cacheComponents?: boolean;
  /**
   * The build-time auto-memoization compiler (a React-Compiler-style pass), an opt-in
   * optimization that is off by default. Conservative by construction: it bails to
   * identity whenever a transform isn't provably safe, so it only ever adds memoization,
   * never changes behavior.
   *
   * Graduated from `experimental.reactCompiler` in 2.5; that spelling (and the older
   * `experimental.compiler`) is still honored, with a dev warning, when this field is absent.
   */
  reactCompiler?: boolean;
  /**
   * Scope async `startTransition` by transition IDENTITY instead of a time window, so a
   * post-`await` update is attributed to its transition while an unrelated urgent update in
   * the pending window keeps its priority. Off by default.
   *
   * Enables a build-time transform that makes denext's first-party {@link AsyncContext}
   * survive `await` (src/build/async-context-transform.ts). It instruments every `await`
   * in client code (a small per-await cost); the default time-window behavior is unchanged
   * when off. Removes the async-`startTransition` gap in KNOWN-LIMITATIONS when on.
   *
   * Graduated from `experimental.asyncContext` in 2.5; that spelling is still honored, with
   * a dev warning, when this field is absent.
   */
  asyncContext?: boolean;
  /**
   * Compile-time feature flags: `feature("KEY")` (from `denext/feature`) always returns the
   * configured value, and a call with a string-literal KEY is folded to a literal where the
   * build can, so the bundler dead-code-eliminates the untaken branch. A key not listed
   * reads `false`.
   *
   * The server and every client bundle are seeded with this map. The fold (DCE) covers the
   * native App Router's component (`.tsx`/`.jsx`) modules, the SPA bundle, and dev; the
   * compat drop-in App Router path and non-component modules on the native path read the
   * seeded value without DCE. Flag names and states are embedded in the client bundle.
   *
   * Graduated from `experimental.features` in 2.5; that spelling is still honored, with a
   * dev warning, when this field is absent.
   */
  features?: Record<string, boolean>;
  /**
   * npm packages whose barrel (`index`) imports are rewritten to the files that define each
   * name, as Next.js's `optimizePackageImports` does: `import { Check } from "lucide-react"`
   * becomes an import of `lucide-react`'s `icons/check.js`, so the bundler never loads the
   * barrel. Your list is ADDED to a built-in default (lucide-react, date-fns, lodash-es, …);
   * a `"!pkg"` entry removes a package from it, and `false` turns the optimization off.
   *
   * That keeps an icon library's thousand re-exports out of the module graph — and, when the
   * package also code-splits every icon (`lucide-react/dynamic`), out of the startup chunk
   * list. Applied to the esbuild bundles (the compat client and server bundles and SPA mode,
   * in production builds and compat dev rebuilds), for app source and for npm modules that
   * import a listed package. The unbundled per-module dev server and the native `deno bundle`
   * path do not apply it.
   *
   * The built-in default is `lucide-react`, `date-fns`, `lodash-es`, `ramda`, `rxjs`,
   * `@tabler/icons-react`, `@heroicons/react/{20,24}/solid`, `@heroicons/react/24/outline`,
   * `react-icons/*`, `@mui/icons-material`, `recharts`, `react-use`, `@headlessui/react`,
   * `effect`; an entry ending in `/*` matches every subpath of the package, and `"!pkg"`
   * removes exactly the entry `pkg` (`"!react-icons/*"` drops the wildcard). Only named value
   * imports are rewritten, and only names the barrel re-exports from another module (a name
   * the barrel defines itself stays on the barrel); a barrel that runs code of its own
   * (including a decorator), carries a directive, or cannot be analysed is left untouched.
   *
   * **Listing a package asserts its modules are side-effect free** (Next.js's contract too):
   * the modules beside the one a name comes from are never loaded, so a top-level side effect
   * in one of them no longer runs. Next's `experimental.optimizePackageImports` spelling is
   * honored, with a dev warning, when this field is absent.
   */
  optimizePackageImports?: string[] | false;
  /**
   * Keep iOS momentum scrolling alive while scroll-anchoring code corrects the scroll offset —
   * default ON. In iOS WebKit (Safari, WKWebView, Capacitor) any programmatic scroll write
   * during a touch fling (`scrollBy`, `scrollTo`, assigning `scrollTop`) stops the fling dead,
   * and virtualized lists (LegendList, react-virtuoso, TanStack Virtual) issue exactly such
   * writes to compensate for rows measured taller or shorter than estimated. The client
   * runtime therefore defers those writes during a gesture (see `installMomentumSafeScroll`
   * in `denext/mobile`) and applies them in one step once the scroller comes to rest.
   *
   * It installs only on iOS/iPadOS WebKit, loaded as its own chunk, so other platforms pay a
   * user-agent check and nothing more. Set `false` to opt out.
   *
   * @default true
   */
  momentumSafeScroll?: boolean;
  /**
   * Build a React Native / Expo app's source for the web through `react-native-web` — SPA
   * mode only (`mode: "spa"`). `true` turns on the defaults; an object sets options.
   *
   * - `react-native` (and every `react-native/…` subpath) resolves to the installed
   *   `react-native-web`, for every importer, even when a real `react-native` is installed.
   *   A deep `react-native/Libraries/…` import maps to react-native-web's equivalent where one
   *   exists, else to a stub that throws, naming the import, when it is called.
   * - Web platform files win: `.web.tsx`, `.web.ts`, `.web.jsx` and `.web.js` are probed
   *   before the plain extensions, for relative and alias imports and for package subpaths.
   * - `.js` files are parsed as JSX (React Native libraries ship JSX in `.js`).
   * - `__DEV__` (true in dev, false in a production build), `global` → `globalThis` and
   *   `process.env.EXPO_OS` → `"web"` are defined at build time.
   * - The SPA shell gets Expo web's root style (see {@link ReactNativeConfig.rootStyle}).
   *
   * The build always takes the esbuild (compat) path, and `denext dev` defaults to the
   * bundled loop, which applies the same resolution. Install `react-native-web` in the
   * project; native-only modules still need web shims of your own.
   */
  reactNative?: boolean | ReactNativeConfig;
  /**
   * @deprecated Every `experimental.*` key graduated to a top-level field by 2.5
   * (`reactCompiler`, `asyncContext`, `features`, `nodeResolve`, `cacheComponents`). The
   * old spellings are still honored, with a dev warning, when the top-level field is absent;
   * the top-level field wins when both are set. Removed in 3.0.
   */
  experimental?: ExperimentalConfig;
  /**
   * How the client bundle gets the React class-component runtime (`class X extends
   * React.Component`: lifecycle, setState batching, class error boundaries). It is a
   * code-split chunk (`denext/class-runtime`), so the default needs no configuration.
   * Unset, `denext build` scans your sources and installs it eagerly when a class is found,
   * otherwise a page loads it on demand; `true` always installs it eagerly; `false` never
   * ships it — the runtime is dead-code-eliminated and a class used anyway throws a guided
   * error.
   *
   * - **unset** (default): loaded **on demand**. `denext build` scans your app's own sources
   *   (and sibling workspace packages) for `Component`/`PureComponent` and, when it finds
   *   one, installs the runtime eagerly; otherwise the generated entry fetches the chunk
   *   only for a page whose server render produced a class component — so a class that
   *   lives in an npm dependency you never name still works in production, and a
   *   function-only page never downloads it.
   * - **`true`**: always install it eagerly (skips the scan and the on-demand round trip).
   * - **`false`**: never ship it. In the next-compat (esbuild) build the flag is a `define`,
   *   so the entire runtime is dead-code-eliminated — zero bytes — and a class used anyway
   *   throws a guided error.
   */
  classComponents?: boolean;
  /**
   * Run the app through the **next-compat** SSR/client pipeline, which rewrites
   * every `react`/`react-dom`/`next/*` import (including those inside npm React
   * libraries) to denext at bundle time so the whole app runs on one denext React
   * — the drop-in path for real Next.js App Router projects. `true`/`false` force
   * it; the default `"auto"` enables it when `node_modules/react` exists or
   * `package.json` lists `react`/`next`. A pure denext-native app keeps the
   * zero-overhead source-load path.
   *
   * (Renamed from `nextCompat`; the old key is no longer accepted.)
   */
  compatibilityMode?: boolean | "auto";
  /**
   * denext plugins (e.g. a Pages Router). Each is set up once before routes are
   * scanned and may contribute routes, claim requests, and emit build assets — see
   * {@linkcode DenextPlugin}. Apps with no plugins pay nothing.
   */
  plugins?: DenextPlugin[];
  /**
   * Project-local CLI verbs: `denext <name>` runs the entry's `run`, with the same
   * flag parsing, `--help` rendering, and "did you mean" suggestions a built-in verb
   * gets. The shorthand for a one-off project script — a plugin (`addCommand`) is
   * only needed when the verb ships as a reusable package.
   *
   * They are listed under "Project commands" by `denext commands` and included in
   * `denext completions <shell>` (`denext --help` deliberately imports nothing and
   * points at `denext commands`). A **built-in verb always wins a name collision**:
   * an entry named `dev` or `build` is ignored, never shadowing the core verb.
   * Loading them costs one config read, paid only when the CLI must enumerate every
   * verb (`commands`, `completions`) or hits a verb it doesn't recognize.
   */
  commands?: DenextCommand[];
}

/** `Strict-Transport-Security` (HSTS) header options. */
export interface HstsConfig {
  /**
   * `max-age` in seconds (how long browsers pin HTTPS). Default `31536000` (1 year).
   *
   * @minimum 0
   */
  maxAge?: number;
  /** Add `includeSubDomains` (applies HSTS to every subdomain — enable only when all are HTTPS). */
  includeSubDomains?: boolean;
  /** Add `preload` (eligibility for browser HSTS preload lists; requires `includeSubDomains`). */
  preload?: boolean;
}

/** Experimental, opt-in features. All default to off. */
/**
 * Identity/context passed to Live authorization hooks. The hooks run inside the
 * viewer's own request context (the connection's replayed cookies), so
 * `getSession()` / `cookies()` work inside them to derive the acting user.
 */
export interface LiveConnectionContext {
  /** The connection's origin. */
  origin: string;
  /** The current route href the connection is on. */
  url: string;
  /** The viewer's raw Cookie header (their replayed identity). */
  cookie: string;
  /** The connection's stable per-connection presence id. */
  peerId: string;
}

/** A `useLive` data subscription presented to {@link LiveConfig.canSubscribe}. */
export interface LiveSubscriptionRequest {
  /** The registered server-action id the client asked to run. */
  actionId: string;
  /** Arguments the client passed. */
  args: unknown[];
  /** Cache tags whose invalidation would recompute this subscription. */
  tags: string[];
}

/** Resource limits for the Live WebSocket hub. Each has a safe built-in default. */
export interface LiveLimits {
  /** Max simultaneous connections (default 10000). */
  maxConnections?: number;
  /** Max `useLive` subscriptions per connection (default 64). */
  maxSubscriptionsPerConnection?: number;
  /** Max presence rooms per connection (default 32). */
  maxRoomsPerConnection?: number;
  /**
   * Max peers in one presence room (default 1000). A room's membership is otherwise bounded
   * only by `maxConnections`, and `broadcastRoom` re-encodes O(N) bytes to N peers on every
   * join/update/leave, so an unbounded room is O(N²) fan-out fleet-wide — a join past the cap
   * is refused with `limit`.
   */
  maxPeersPerRoom?: number;
  /** Max `<Live>` boundaries watched per connection (default 256). */
  maxBoundaries?: number;
  /** Max inbound message size in bytes (default 65536). */
  maxMessageBytes?: number;
  /**
   * Max size in bytes of one subscription's input / args (default 16384): the input is
   * stored for the connection's lifetime and re-used on every recompute, so it is capped
   * tighter than a frame.
   */
  maxSubscriptionInputBytes?: number;
  /** Max `useChannel` subscriptions per connection (default 32). */
  maxChannelsPerConnection?: number;
  /** Max bytes of one channel payload (default 16384); `publish` throws past it. */
  maxChannelPayloadBytes?: number;
  /**
   * Seconds after which a channel subscriber is lazily re-authorized on the next push
   * (default 300). Per-push re-authorization would cost subscribers × `authorize` per emit;
   * `channel.revoke(key)` ends access immediately when that matters.
   */
  channelAuthTtlSeconds?: number;
  /** Socket idle timeout in seconds passed to `Deno.upgradeWebSocket` (default 120). */
  idleTimeoutSeconds?: number;
  /**
   * Fleet-wide cap on concurrent live re-renders/recomputes (default 40). A single
   * `revalidateTag` can match every connected socket; this bounds how many full-route
   * re-renders (`<Live>`) and `useLive` fetcher runs execute at once so one
   * invalidation can't spawn one render per connection simultaneously (a self-inflicted
   * DoS amplification). Excess work queues and drains as slots free.
   */
  maxConcurrentRenders?: number;
  /**
   * Per-render deadline in seconds (default 30). A `<Live>` re-render or `useLive`
   * fetcher run holds one of the `maxConcurrentRenders` slots for its whole duration;
   * without a deadline a hung user fetcher pins its slot forever, and enough hung
   * fetchers peg the concurrency gate and stall the whole live fleet. On timeout the
   * run is aborted (a cooperative `AbortSignal` reaches the fetcher's `fetch`/cache
   * reads) and its slot released; the client gets an error/refresh frame. On by default
   * — there is no "disable" value (an invalid one falls back to 30s).
   */
  renderTimeoutSeconds?: number;
}

/**
 * Live Server Components security policy (the top-level `live` config). Presence rooms and
 * `useLive` data subscriptions are **default-deny**, identically in dev and
 * production: without a policy hook (or {@link LiveConfig.allowAnonymous}) the hub
 * refuses joins/subscriptions — so a persistent socket can't read other users'
 * presence or run registered actions — and surfaces a loud, actionable error the
 * first time it runs (there is no dev/prod divergence that could let it work locally
 * and silently break in production). Resource caps in {@link LiveLimits} always apply.
 */
export interface LiveConfig {
  /**
   * Permit presence-room joins with no policy hook — opens rooms to any same-origin
   * client. It does **not** open arbitrary data: `useLive` data subscriptions still
   * require the per-action `liveReadable(...)` opt-in (or a `canSubscribe` hook), so
   * enabling anonymous presence never exposes unmarked/mutating actions on the socket.
   * Only set it for genuinely public collaboration. Defaults to `false` (deny in dev
   * and production alike).
   */
  allowAnonymous?: boolean;
  /** Gate the WebSocket connection itself (after the same-origin handshake check). */
  authorize?(ctx: LiveConnectionContext): boolean | Promise<boolean>;
  /** Gate a presence-room join/update. Return `false` to refuse the room. */
  canJoinRoom?(ctx: LiveConnectionContext, room: string): boolean | Promise<boolean>;
  /** Gate a `useLive` data subscription (which action + args it may run). */
  canSubscribe?(
    ctx: LiveConnectionContext,
    sub: LiveSubscriptionRequest,
  ): boolean | Promise<boolean>;
  /**
   * Gate a `useApi({ tags })` tag watch: may this viewer be TOLD that `tags` were invalidated?
   * The socket carries only tag names (the client then refetches over HTTP with its own
   * cookies, so the route handler still authorizes the data). Under `allowAnonymous` every
   * same-origin client may watch; without either it is a `no-policy` refusal.
   */
  canWatchTags?(ctx: LiveConnectionContext, tags: string[]): boolean | Promise<boolean>;
  /** Resource caps for the hub. */
  limits?: LiveLimits;
}

/**
 * The legacy `experimental` block of `denext.config.ts`. Every key in it graduated to a
 * top-level {@link DenextConfig} field — what denext ships is its own finished work, and an
 * "experimental" label only kept developers from using it — so each member is a deprecated
 * alias of its top-level twin: still honored (with a dev warning) when the top-level field
 * is absent, and ignored when both are set. The interface stays exported so a config written
 * against 2.x keeps type-checking; it is removed in 3.0.
 */
export interface ExperimentalConfig {
  /**
   * @deprecated Graduated to the top-level `reactCompiler` in 2.5. Honored as an alias
   * through 2.x; removed in 3.0.
   */
  reactCompiler?: boolean;
  /**
   * @deprecated Renamed `reactCompiler` (Next.js's key) in 2.0, now the top-level
   * `reactCompiler`. Honored as an alias through 2.x; removed in 3.0.
   */
  compiler?: boolean;
  /**
   * @deprecated Graduated to the top-level `asyncContext` in 2.5. Honored as an alias
   * through 2.x; removed in 3.0.
   */
  asyncContext?: boolean;
  /**
   * @deprecated Graduated to the top-level `features` in 2.5. Honored as an alias through
   * 2.x; removed in 3.0.
   */
  features?: Record<string, boolean>;
  /**
   * @deprecated Moved to the top-level `nodeResolve` in 2.0 — it is load-bearing for every
   * compat migration, not an incomplete feature. Honored as an alias through 2.x.
   */
  nodeResolve?: boolean;
  /**
   * @deprecated Next.js's spelling of the top-level `optimizePackageImports`. Honored as an
   * alias (with a dev warning) when the top-level field is absent.
   */
  optimizePackageImports?: string[];
}

/**
 * Whether the client runtime auto-installs the iOS momentum-safe scroll shim. Default-on:
 * only an explicit `momentumSafeScroll: false` disables it. Threaded into every client entry
 * generator, which seeds the opt-out for the runtime.
 */
export function momentumSafeScrollEnabled(config: DenextConfig | null | undefined): boolean {
  return config?.momentumSafeScroll !== false;
}

/**
 * The effective React Native options when `reactNative` is on (`true` → `{}`), else null.
 */
export function reactNativeOptions(
  config: DenextConfig | null | undefined,
): ReactNativeConfig | null {
  const value = config?.reactNative;
  if (value === true) return {};
  return value && typeof value === "object" ? value : null;
}

/** Whether the SPA shell carries Expo web's root style (`reactNative` on, `rootStyle` not off). */
export function reactNativeRootStyle(config: DenextConfig | null | undefined): boolean {
  const options = reactNativeOptions(config);
  return options !== null && options.rootStyle !== false;
}

/**
 * Whether the tolerant node_modules resolver is active for the compat build. Default-on:
 * only an explicit `nodeResolve: false` (or the legacy `experimental.nodeResolve: false`)
 * disables it. Threaded into every compat bundler (SSR/client/flight + SPA) so App Router
 * and SPA behave identically.
 */
export function nodeResolveEnabled(config: DenextConfig | null | undefined): boolean {
  return (config?.nodeResolve ?? config?.experimental?.nodeResolve) !== false;
}

/**
 * The effective auto-memo compiler flag: the top-level `reactCompiler`, else the legacy
 * `experimental.reactCompiler` / `experimental.compiler` aliases (top-level wins).
 */
export function reactCompilerEnabled(config: DenextConfig | null | undefined): boolean {
  return (config?.reactCompiler ?? config?.experimental?.reactCompiler ??
    config?.experimental?.compiler) === true;
}

/**
 * The effective AsyncContext transition-scoping flag: the top-level `asyncContext`, else the
 * legacy `experimental.asyncContext` alias (top-level wins). Gates the build transform in
 * src/build/async-context-transform.ts.
 */
export function asyncContextEnabled(config: DenextConfig | null | undefined): boolean {
  return (config?.asyncContext ?? config?.experimental?.asyncContext) === true;
}

/**
 * The configured compile-time feature flags — the top-level `features`, else the legacy
 * `experimental.features` alias (top-level wins) — or an empty map. The build folds
 * `feature("KEY")` calls to these values (see src/build/feature-transform.ts) and seeds the
 * same map for server rendering (`resolveProject`) and the esbuild compat `define`.
 */
export function featureFlags(config: DenextConfig | null | undefined): Record<string, boolean> {
  return config?.features ?? config?.experimental?.features ?? {};
}

/**
 * The effective incremental-streaming setting: the top-level `streaming` field. The
 * pre-1.4 `experimental.streaming` alias was removed in 2.0 and is ignored (the config
 * validator warns about it in dev); `undefined` means "not set" (the caller's default-on
 * applies).
 */
export function resolveStreaming(config: DenextConfig | null | undefined): boolean | undefined {
  return config?.streaming;
}

/**
 * The effective Live Server Components policy: the top-level `live` field (it is a
 * security policy, not an experiment). The pre-1.4 `experimental.live` alias was removed
 * in 2.0 and is ignored (the config validator warns about it in dev).
 */
export function resolveLive(config: DenextConfig | null | undefined): LiveConfig | undefined {
  return config?.live;
}

/**
 * The effective Cache Components setting. `cacheComponents` graduated to a top-level
 * config field in 2.0; a config written against a 2.0 pre-release may still set the
 * legacy `experimental.cacheComponents`, which is honored when the top-level field is
 * absent (soft migration — the validator emits a "moved to top-level" dev warning). The
 * top-level field always wins when both are set. `undefined` means "not set" (off).
 */
export function resolveCacheComponents(
  config: DenextConfig | null | undefined,
): boolean | undefined {
  return config?.cacheComponents ??
    (config?.experimental as { cacheComponents?: boolean } | undefined)?.cacheComponents;
}

/**
 * The production-server knobs `denext start` / `denext dev` hand to `createApp()`: the
 * config's `canonicalOrigin`, `trustForwardedHeaders`, `requestTimeout`, `maxConcurrency`,
 * `slotBackstop`, `actionMaxBodyBytes` and `cacheKeyParams`, each falling back to its env
 * var when the config leaves it unset (`DENEXT_CANONICAL_ORIGIN`, `DENEXT_TRUST_PROXY=1`,
 * `DENEXT_REQUEST_TIMEOUT_MS`, `DENEXT_MAX_CONCURRENCY`), else `undefined` so `createApp`'s
 * own default applies — config > env > default. A malformed env value (a non-numeric
 * timeout, a non-origin) is ignored with one warning rather than failing the boot, since
 * env is set by an operator, not type-checked like the config.
 */
export interface ServerOptions {
  /** The pinned public origin, if any. */
  canonicalOrigin?: string;
  /** Whether `X-Forwarded-*` headers are trusted. */
  trustForwardedHeaders?: boolean;
  /** The per-request deadline (ms; `0` = none). */
  requestTimeout?: number;
  /** The in-process concurrency ceiling. */
  maxConcurrency?: number;
  /** The slot backstop (ms) for `requestTimeout: 0`. */
  slotBackstop?: number;
  /** The Server Action body cap (bytes). */
  actionMaxBodyBytes?: number;
  /** The ISR cache-key query-param allowlist. */
  cacheKeyParams?: string[];
}

/** One env var, or `undefined` when unset, empty, or not permitted (a narrowed `--allow-env`). */
function envValue(name: string): string | undefined {
  return envGet(name) || undefined;
}

/** A non-negative integer env value (`DENEXT_REQUEST_TIMEOUT_MS`, …), or `undefined` + a warning. */
function envInteger(name: string, min: number): number | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min) return n;
  console.warn(`denext: ignoring ${name}="${raw}" — expected an integer >= ${min}`);
  return undefined;
}

/** `DENEXT_CANONICAL_ORIGIN` as a bare origin, or `undefined` + a warning when it is not one. */
function envOrigin(name: string): string | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  if (isOrigin(raw)) return raw;
  console.warn(`denext: ignoring ${name}="${raw}" — expected an origin like https://example.com`);
  return undefined;
}

/**
 * Whether `value` is exactly an http(s) origin — scheme + host (+ port), no path, query,
 * hash or credentials — the shape `canonicalOrigin` accepts.
 */
export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

/**
 * Resolve the {@link ServerOptions} for `createApp()` from the config, with the env-var
 * fallbacks applied (see {@link ServerOptions}).
 */
export function resolveServerOptions(config: DenextConfig | null | undefined): ServerOptions {
  return {
    canonicalOrigin: config?.canonicalOrigin ?? envOrigin("DENEXT_CANONICAL_ORIGIN"),
    trustForwardedHeaders: config?.trustForwardedHeaders ?? envFlag("DENEXT_TRUST_PROXY"),
    requestTimeout: config?.requestTimeout ?? envInteger("DENEXT_REQUEST_TIMEOUT_MS", 0),
    maxConcurrency: config?.maxConcurrency ?? envInteger("DENEXT_MAX_CONCURRENCY", 1),
    slotBackstop: config?.slotBackstop,
    actionMaxBodyBytes: config?.actionMaxBodyBytes,
    cacheKeyParams: config?.cacheKeyParams,
  };
}

/**
 * A `=1` flag env var (`DENEXT_TRUST_PROXY`): `true` for `1`/`true`/`yes`/`on` (any case),
 * `false` for any other value, `undefined` when unset.
 */
function envFlag(name: string): boolean | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** A source pattern compiled to a matcher with its capture keys. */
export interface CompiledPattern {
  /** The compiled matcher. */
  regex: RegExp;
  /** Capture-group names, in order, for substituting into a destination. */
  keys: string[];
}

/**
 * Compile a `source` pattern (`/old/:slug`, `/blog/:path*`) into a RegExp with
 * named capture keys, mirroring the middleware matcher but retaining names so
 * `destination` can substitute them.
 *
 * @param source The path pattern.
 */
export function compilePattern(source: string): CompiledPattern {
  const keys: string[] = [];
  let re = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ":") {
      i++;
      let name = "";
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) name += source[i++];
      keys.push(name);
      if (source[i] === "*") {
        i++;
        re += "(.*)";
      } else {
        re += "([^/]+)";
      }
    } else if (ch === "*") {
      i++;
      keys.push("*");
      re += "(.*)";
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return { regex: new RegExp(`^${re}$`), keys };
}

/**
 * Match `pathname` against a compiled pattern, returning captured params (or
 * `null` when it does not match).
 */
export function matchPattern(
  pattern: CompiledPattern,
  pathname: string,
): Record<string, string> | null {
  const m = pattern.regex.exec(pathname);
  if (!m) return null;
  const params: Record<string, string> = {};
  pattern.keys.forEach((key, idx) => {
    params[key] = m[idx + 1] ?? "";
  });
  return params;
}

/** Substitute `:name` params into a `destination` template. */
export function fillDestination(destination: string, params: Record<string, string>): string {
  return destination.replace(
    /:([A-Za-z0-9_]+)\*?/g,
    (whole, name) => name in params ? params[name] : whole,
  );
}

/**
 * Make a redirect `Location` safe against open redirects. An explicit
 * `http(s)://` absolute URL is preserved (a deliberately-configured external
 * redirect); anything else is forced to a single-slash, same-origin path so a
 * protocol-relative (`//host`) or backslash (`/\host`) prefix — which browsers
 * resolve cross-origin — cannot escape the current origin.
 *
 * SEC-L3 — the absolute-URL passthrough is deliberate but unconstrained: a fully
 * qualified `http(s)://…` value is returned as-is (no host allowlist), so it is an
 * open redirect if built from untrusted input. Only pass an absolute URL that is
 * statically configured or otherwise trusted; for anything derived from the request
 * (query/path/header), pass a PATH so it is pinned to the current origin, or
 * validate the host against your own allowlist before calling this.
 *
 * @param location The candidate `Location` value (may embed user path data).
 */
export function safeRedirectLocation(location: string): string {
  // Strip ASCII control characters and whitespace FIRST: the WHATWG URL parser drops
  // tab/newline anywhere in the input, so `/\t/evil.com` would otherwise slip past the
  // leading-slash collapse below and resolve as protocol-relative `//evil.com`. A bare
  // `\r`/`\n` would also make `new Response(…, { headers: { location } })` throw.
  const clean = location.replace(CONTROL_CHARS, "");
  if (/^https?:\/\//i.test(clean)) return clean;
  // Collapse a leading run of `/` or `\` to a single `/` (neutralizes `//`, `/\`).
  return "/" + clean.replace(/^[/\\]+/, "");
}

/** C0 controls, space, and DEL — never legitimate in a `Location` value. */
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u0020\u007f]/g;

/** The config's rule functions resolved to concrete arrays (evaluated once). */
export interface ResolvedRules {
  /** Resolved redirect rules. */
  redirects: RedirectRule[];
  /** Resolved rewrite rules. */
  rewrites: RewriteRule[];
  /** Resolved header rules. */
  headers: HeaderRule[];
}

/** Evaluate a config's `redirects()`/`rewrites()`/`headers()` once at startup. */
export async function resolveConfigRules(config: DenextConfig | null): Promise<ResolvedRules> {
  return {
    redirects: config?.redirects ? await config.redirects() : [],
    rewrites: config?.rewrites ? await config.rewrites() : [],
    headers: config?.headers ? await config.headers() : [],
  };
}
