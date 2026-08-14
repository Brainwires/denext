// denext.config.{ts,js} — project configuration parity with next.config.js:
// declarative redirects / rewrites / headers plus basePath / trailingSlash /
// assetPrefix. Loaded once at startup (static config, like Next).

import type { I18nConfig } from "./i18n.ts";

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

/** Image-optimization config (the `/_denext/image` endpoint). */
export interface ImagesConfig {
  /** Exact remote hosts allowed as sources (host only, e.g. `cdn.example.com`). */
  domains?: string[];
  /** Pattern-based remote allowlist (protocol/host-wildcard/pathname). */
  remotePatterns?: RemotePattern[];
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
}

/** Project configuration exported from `denext.config.{ts,js}` (as `default` or named). */
export interface DenextConfig {
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
}

/** Experimental, opt-in features. All default to off. */
export interface ExperimentalConfig {
  /**
   * Enable the build-time auto-memoization compiler (a React-Compiler-style pass).
   * Experimental: transforms are conservative and bail to identity when unsure.
   */
  compiler?: boolean;
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
