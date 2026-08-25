// denext.config.{ts,js} — project configuration parity with next.config.js:
// declarative redirects / rewrites / headers plus basePath / trailingSlash /
// assetPrefix. Loaded once at startup (static config, like Next).

import type { I18nConfig } from "./i18n.ts";
import type { DenextPlugin } from "../plugin/mod.ts";
import type { CspSetting } from "./segment-config.ts";
import type { CacheStore } from "./cache.ts";

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
  headers: Array<{ key: string; value: string }>;
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
  /** Pathname prefix the source must start with (e.g. `/images/`). Any when omitted. */
  pathname?: string;
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
  /** Exact remote hosts allowed as sources (host only, e.g. `cdn.example.com`). */
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
   */
  minimumCacheTTL?: number;
  /**
   * Output formats the endpoint may negotiate from the request `Accept` header, in
   * preference order (matches Next.js `images.formats`). Include `"image/avif"` to
   * enable AVIF (falls back to WebP when the client doesn't accept AVIF). Defaults
   * to `["image/webp"]`.
   */
  formats?: string[];
  /**
   * Max redirect hops to follow for a remote source, each re-validated (matches
   * Next.js `images.maximumRedirects`). Defaults to `3`; `0` disables redirects.
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
  /** Extra raw HTML injected into the shell `<head>` (meta tags, preconnect links, …). */
  head?: string;
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
  /** Max rows in the durable data cache before FIFO eviction (default 1000). */
  maxDataEntries?: number;
  /** Max rows in the durable page (ISR) cache before FIFO eviction (default 1000). */
  maxPageEntries?: number;
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
  /** Enforce a trailing slash on page URLs (308-redirect to normalize). */
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
   * incremental streaming) never carry the hash-based CSP regardless — see
   * [KNOWN-LIMITATIONS.md]. Absent ⇒ `"strict"`.
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
  /** Experimental, opt-in features (default off). */
  experimental?: ExperimentalConfig;
  /**
   * Enable React class components (`class X extends React.Component`) in the
   * **next-compat build** (`buildNextCompatPages`, used to run real npm React
   * libraries). There the flag is compiled in as an esbuild `define`, so with it off
   * the entire class runtime (lifecycle, setState batching, error boundaries) is
   * dead-code-eliminated — a next-compat app that doesn't use classes pays zero bytes
   * for them, and a class used with the flag off throws a guided error.
   *
   * Note: the standard `denext build`/`dev` pipeline uses `deno bundle`, which has no
   * build-time `define`, so it cannot DCE the gate — there the (small) class runtime
   * is always included and enabled. This flag is therefore only meaningful for the
   * next-compat build; it defaults off.
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
}

/** `Strict-Transport-Security` (HSTS) header options. */
export interface HstsConfig {
  /** `max-age` in seconds (how long browsers pin HTTPS). Default `31536000` (1 year). */
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
  /** Max `<Live>` boundaries watched per connection (default 256). */
  maxBoundaries?: number;
  /** Max inbound message size in bytes (default 65536). */
  maxMessageBytes?: number;
  /** Socket idle timeout in seconds passed to `Deno.upgradeWebSocket` (default 120). */
  idleTimeoutSeconds?: number;
}

/**
 * Live Server Components security policy (`experimental.live`). Presence rooms and
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
  /** Resource caps for the hub. */
  limits?: LiveLimits;
}

/**
 * Opt-in experimental features, set under `experimental` in `denext.config.ts`. Each is
 * off by default; the surfaces are still stabilizing and may change between minor versions.
 */
export interface ExperimentalConfig {
  /**
   * Enable the build-time auto-memoization compiler (a React-Compiler-style pass).
   * Experimental: transforms are conservative and bail to identity when unsure.
   */
  compiler?: boolean;
  /**
   * Enable Cache Components (Next.js 16): the `"use cache"` directive is compiled
   * into cross-request caching on the server (`src/build/use-cache-transform.ts`),
   * and — once the PPR render path lands — dynamic-by-default rendering with
   * cacheable `use cache` islands. Experimental. When off, `"use cache"` directives
   * are inert (a plain no-op string statement) and rendering is unchanged.
   */
  cacheComponents?: boolean;
  /**
   * Incremental (Suspense) streaming, **on by default**; set `false` to opt out.
   * A page with a pending Suspense boundary flushes its shell first and streams each
   * boundary's content as it resolves; a fully synchronous page (no holes) is still
   * delivered buffered, so it stays shared-cacheable. Streamed responses carry the
   * same strict hash-based CSP as buffered ones (the swap runtime is a hashed
   * constant), survive a failing boundary (its fallback stays), and cover Flight
   * routes. ISR/PPR-cacheable routes (revalidate/force-static) and soft navigations
   * take their own path first, so streaming never bypasses the page cache.
   */
  streaming?: boolean;
  /**
   * Live Server Components security policy: authorization hooks and resource caps
   * for the `<Live>` / `useLive` / `usePresence` WebSocket hub. See {@link LiveConfig}.
   * Presence/data are default-deny in production without a policy here.
   */
  live?: LiveConfig;
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
  if (/^https?:\/\//i.test(location)) return location;
  // Collapse a leading run of `/` or `\` to a single `/` (neutralizes `//`, `/\`).
  return "/" + location.replace(/^[/\\]+/, "");
}

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
