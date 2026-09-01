// denext.config validation — pure (types only, no build/IO deps) so both the
// server-side `defineConfig` authoring helper and the build-time config loader can
// share one source of truth. `validateDenextConfig` throws a field-scoped error on a
// bad *value*; `warnUnknownConfigKeys` warns (never throws) on an unrecognized *key*,
// with a "did you mean" suggestion — a typo like `basepath` would otherwise be
// silently dropped by the loader's field whitelist.

import type { DenextConfig } from "./config.ts";

/**
 * The recognized top-level {@link DenextConfig} keys. Kept in sync with the interface;
 * `warnUnknownConfigKeys` flags anything outside this set (the loader drops unknown
 * keys silently otherwise). A `tests` guard asserts this matches the loader whitelist.
 */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  "mode",
  "spa",
  "i18n",
  "basePath",
  "trailingSlash",
  "assetPrefix",
  "redirects",
  "rewrites",
  "headers",
  "images",
  "tailwind",
  "mdx",
  "cache",
  "streaming",
  "live",
  "experimental",
  "plugins",
  "csp",
  "hsts",
  "publicEnv",
  "compatibilityMode",
  "classComponents",
];

/** Levenshtein edit distance (small strings; iterative two-row). */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * The closest known key to `key` within a small edit distance (case-insensitive), or
 * `undefined` when nothing is near enough to suggest. Used for "did you mean" hints.
 */
export function didYouMean(
  key: string,
  known: readonly string[] = KNOWN_CONFIG_KEYS,
): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const d = editDistance(lower, k.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  // Only suggest when the typo is close: within a third of the key's length (min 2).
  return best !== undefined && bestDist <= Math.max(2, Math.floor(key.length / 3))
    ? best
    : undefined;
}

/**
 * Warn (to stderr, never throw) on any top-level config key not in {@link KNOWN_CONFIG_KEYS}.
 * The loader reconstructs config from a fixed field list, so an unrecognized key (a typo,
 * a stale Next.js option) is otherwise dropped with no signal. Emits a "did you mean"
 * suggestion when a close known key exists.
 *
 * @param config The raw config object as authored (before the loader's whitelist).
 * @param name The config file name, for the message (default `"denext.config"`).
 */
export function warnUnknownConfigKeys(config: object, name = "denext.config"): void {
  for (const key of Object.keys(config)) {
    if (KNOWN_CONFIG_KEYS.includes(key)) continue;
    const suggestion = didYouMean(key);
    console.warn(
      `denext: ${name} has an unknown option \`${key}\`, which will be ignored` +
        (suggestion ? ` — did you mean \`${suggestion}\`?` : "."),
    );
  }
}

// --- Value validation ------------------------------------------------------------
// Split into small field-group validators (mode/spa, routing, images, security, cache)
// so each stays readable and independently testable — validation of a 20-field config
// object is inherently branchy, but no single function has to carry all of it.

/** Throws a field-scoped `invalid <name>: \`<field>\` <msg>` error. */
type Fail = (field: string, msg: string) => never;

interface NumOpts {
  int?: boolean;
  min?: number;
  max?: number;
}

/** Whether `v` is a finite number within the requested range / integer-ness. */
function isValidNumber(v: unknown, opts: NumOpts): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (v < (opts.min ?? 0)) return false;
  if (opts.max !== undefined && v > opts.max) return false;
  if (opts.int && !Number.isInteger(v)) return false;
  return true;
}

/**
 * A `NaN`/`Infinity`/negative slips silently into HTTP headers (`max-age`),
 * redirect-loop bounds, and cache-eviction counts otherwise, so validate
 * finiteness/range at boot (present fields only; `undefined` keeps the default).
 */
function num(fail: Fail, field: string, v: unknown, opts: NumOpts = {}): void {
  if (isValidNumber(v, opts)) return;
  const min = opts.min ?? 0;
  const range = opts.max !== undefined ? `${min}..${opts.max}` : `>= ${min}`;
  fail(field, `must be a finite ${opts.int ? "integer" : "number"} ${range}`);
}

/** Validate an array of numbers element-wise. */
function numArray(fail: Fail, field: string, v: unknown, opts: NumOpts): void {
  if (!Array.isArray(v)) fail(field, "must be an array of numbers");
  else (v as unknown[]).forEach((el, i) => num(fail, `${field}[${i}]`, el, opts));
}

/** `mode` and, in SPA mode, the required `spa.entry`. */
function validateMode(config: DenextConfig, fail: Fail): void {
  if (config.mode !== undefined && config.mode !== "spa") {
    fail("mode", 'must be "spa" (or omitted for the default App Router)');
  }
  if (config.mode !== "spa") return;
  if (!config.spa || typeof config.spa !== "object") {
    fail("spa", 'is required when `mode: "spa"` (e.g. `spa: { entry: "./src/main.tsx" }`)');
  } else if (typeof config.spa.entry !== "string" || config.spa.entry === "") {
    fail("spa.entry", "must be a non-empty path to the client entry module");
  }
}

/** Match the whole 127.0.0.0/8 block, localhost, or ::1 — NOT a `127.` prefix (which
 * would also accept `127.0.0.1.evil.com`, DNS-resolvable to an attacker IP). */
function isLoopback(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

type Proxy = NonNullable<NonNullable<DenextConfig["spa"]>["proxy"]>;

/** `spa.proxy.prefixes`: a non-empty array of "/"-rooted path strings. */
function validateProxyPrefixes(prefixes: Proxy["prefixes"], fail: Fail): void {
  const bad = !Array.isArray(prefixes) || prefixes.length === 0 ||
    prefixes.some((p) => typeof p !== "string" || !p.startsWith("/"));
  if (bad) {
    fail(
      "spa.proxy.prefixes",
      'must be a non-empty array of path prefixes starting with "/" (e.g. ["/api", "/ws"])',
    );
  }
}

/** `spa.proxy.target`: an absolute URL, loopback unless `allowNonLoopback`. */
function validateProxyTarget(proxy: Proxy, fail: Fail): void {
  let target: URL | undefined;
  try {
    target = new URL(proxy.target);
  } catch {
    fail("spa.proxy.target", 'must be an absolute URL (e.g. "http://127.0.0.1:3773")');
  }
  if (target && !proxy.allowNonLoopback && !isLoopback(target.hostname)) {
    fail(
      "spa.proxy.target",
      `must be a loopback host (127.0.0.1 / localhost / [::1]) unless \`allowNonLoopback: true\` — got "${target.hostname}"`,
    );
  }
}

/** The dev-proxy `spa.proxy` block (loopback-gated target). */
function validateProxy(proxy: Proxy | undefined, fail: Fail): void {
  if (proxy === undefined) return;
  if (typeof proxy !== "object" || proxy === null) {
    fail(
      "spa.proxy",
      'must be an object (e.g. `{ prefixes: ["/api"], target: "http://127.0.0.1:3773" }`)',
    );
  }
  validateProxyPrefixes(proxy.prefixes, fail);
  validateProxyTarget(proxy, fail);
}

/** `basePath`: empty, or a "/"-rooted path without a trailing slash. */
function validateBasePath(basePath: DenextConfig["basePath"], fail: Fail): void {
  if (basePath === undefined) return;
  if (typeof basePath !== "string") fail("basePath", "must be a string");
  else if (basePath !== "" && (!basePath.startsWith("/") || basePath.endsWith("/"))) {
    fail("basePath", 'must start with "/" and not end with "/" (e.g. "/docs")');
  }
}

/** `basePath`/`assetPrefix`/`trailingSlash` and the redirect/rewrite/header thunks. */
function validateRouting(config: DenextConfig, fail: Fail): void {
  const { basePath, assetPrefix, trailingSlash, redirects, rewrites, headers } = config;
  validateBasePath(basePath, fail);
  if (assetPrefix !== undefined && typeof assetPrefix !== "string") {
    fail("assetPrefix", "must be a string");
  }
  if (trailingSlash !== undefined && typeof trailingSlash !== "boolean") {
    fail("trailingSlash", "must be a boolean");
  }
  // redirects/rewrites/headers are functions that return the rule array at startup.
  const thunks = [["redirects", redirects], ["rewrites", rewrites], ["headers", headers]] as const;
  for (const [field, v] of thunks) {
    if (v !== undefined && typeof v !== "function") {
      fail(field, "must be a function returning an array (e.g. `redirects: () => [...]`)");
    }
  }
}

/** `images.domains` / `images.remotePatterns` host allowlists. */
function validateImageAllowlists(images: DenextConfig["images"], fail: Fail): void {
  if (images?.domains !== undefined) {
    if (!Array.isArray(images.domains) || images.domains.some((d) => typeof d !== "string")) {
      fail("images.domains", "must be an array of host strings");
    }
  }
  if (images?.remotePatterns === undefined) return;
  if (!Array.isArray(images.remotePatterns)) {
    fail("images.remotePatterns", "must be an array");
  } else if (
    images.remotePatterns.some((p) => !p || typeof p.hostname !== "string" || p.hostname === "")
  ) {
    fail("images.remotePatterns", "each entry needs a non-empty `hostname` string");
  }
}

/** Image-pipeline numerics: pixel widths, quality (1..100), cache TTL, redirect bound. */
function validateImageNumerics(images: DenextConfig["images"], fail: Fail): void {
  if (!images) return;
  const { deviceSizes, imageSizes, qualities, minimumCacheTTL, maximumRedirects } = images;
  // Array widths/qualities: each element a finite positive integer (quality capped 100).
  const arrays: Array<[string, unknown, NumOpts]> = [
    ["images.deviceSizes", deviceSizes, { int: true, min: 1 }],
    ["images.imageSizes", imageSizes, { int: true, min: 1 }],
    ["images.qualities", qualities, { int: true, min: 1, max: 100 }],
  ];
  for (const [field, v, opts] of arrays) {
    if (v !== undefined) numArray(fail, field, v, opts);
  }
  if (minimumCacheTTL !== undefined) num(fail, "images.minimumCacheTTL", minimumCacheTTL);
  if (maximumRedirects !== undefined) {
    num(fail, "images.maximumRedirects", maximumRedirects, { int: true });
  }
}

/** `csp`: `"strict"` | `"off"` | an opt-in object. */
function validateCsp(csp: DenextConfig["csp"], fail: Fail): void {
  if (csp === undefined) return;
  const ok = csp === "strict" || csp === "off" || (typeof csp === "object" && csp !== null);
  if (!ok) {
    fail("csp", 'must be "strict", "off", or an opt-in object (e.g. `{ scriptSrc: [...] }`)');
  }
}

/** `hsts`: an object (with a finite `maxAge`) or `false`. */
function validateHsts(hsts: DenextConfig["hsts"], fail: Fail): void {
  if (hsts === undefined || hsts === false) return;
  if (typeof hsts !== "object" || hsts === null) {
    fail("hsts", "must be an object (e.g. `{ includeSubDomains: true }`) or `false`");
  } else if (hsts.maxAge !== undefined) {
    num(fail, "hsts.maxAge", hsts.maxAge); // seconds; finite >= 0
  }
}

/** `csp` (three-state) and `hsts` (object|false). */
function validateSecurity(config: DenextConfig, fail: Fail): void {
  validateCsp(config.csp, fail);
  validateHsts(config.hsts, fail);
}

/** Cache eviction counts (finite whole numbers >= 1) and the `publicEnv` allowlist. */
function validateCacheAndEnv(config: DenextConfig, fail: Fail): void {
  if (config.cache?.maxDataEntries !== undefined) {
    num(fail, "cache.maxDataEntries", config.cache.maxDataEntries, { int: true, min: 1 });
  }
  if (config.cache?.maxPageEntries !== undefined) {
    num(fail, "cache.maxPageEntries", config.cache.maxPageEntries, { int: true, min: 1 });
  }
  if (config.publicEnv !== undefined) {
    if (!Array.isArray(config.publicEnv) || config.publicEnv.some((k) => typeof k !== "string")) {
      fail("publicEnv", "must be an array of env-variable-name strings");
    }
  }
}

/** Validate a loaded `denext.config`, throwing a field-scoped error on a bad value. */
export function validateDenextConfig(config: DenextConfig, name = "denext.config"): void {
  const fail: Fail = (field, msg) => {
    throw new Error(`invalid ${name}: \`${field}\` ${msg}`);
  };
  validateMode(config, fail);
  validateProxy(config.spa?.proxy, fail);
  validateRouting(config, fail);
  validateImageAllowlists(config.images, fail);
  validateImageNumerics(config.images, fail);
  validateSecurity(config, fail);
  validateCacheAndEnv(config, fail);
}
