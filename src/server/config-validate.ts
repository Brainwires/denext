// denext.config validation — pure (types only, no build/IO deps) so both the
// server-side `defineConfig` authoring helper and the build-time config loader can
// share one source of truth. `validateDenextConfig` throws a field-scoped error on a
// bad *value*; `warnUnknownConfigKeys` warns (never throws) on an unrecognized *key*,
// with a "did you mean" suggestion — a typo like `basepath` would otherwise be
// silently dropped by the loader's field whitelist.

import type { DenextConfig } from "./config.ts";
import { CONFIG_KEYS, EXPERIMENTAL_KEYS } from "./config-keys.generated.ts";
import { editDistance } from "../utils/edit-distance.ts";

/**
 * The recognized top-level {@link DenextConfig} keys — the generated
 * {@link CONFIG_KEYS} list (derived from the interface by `deno task gen:config-schema`,
 * so it cannot drift from the type). `warnUnknownConfigKeys` flags anything outside this
 * set, since the loader copies exactly these fields and would drop an unknown key silently.
 */
export const KNOWN_CONFIG_KEYS: readonly string[] = CONFIG_KEYS;

/** The recognized `experimental.*` sub-keys (generated from `ExperimentalConfig`). */
const KNOWN_EXPERIMENTAL_KEYS: readonly string[] = EXPERIMENTAL_KEYS;

/**
 * The closest key in `known` to `key` within a small edit distance (case-insensitive), or
 * `undefined` when nothing is near enough to suggest. Used for "did you mean" hints; the
 * candidate list defaults to the top-level {@link KNOWN_CONFIG_KEYS}.
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

/** The "unknown option" warning line, with a suggestion when a close known key exists. */
function unknownKeyMessage(name: string, key: string, suggestion: string | undefined): string {
  return `denext: ${name} has an unknown option \`${key}\`, which will be ignored` +
    (suggestion ? ` — did you mean \`${suggestion}\`?` : ".");
}

/**
 * `experimental.*` keys that graduated to top-level config, with whether the old alias is
 * still read. Setting one gets a "moved" message instead of a generic unknown-key warning.
 */
const MOVED_EXPERIMENTAL_KEYS: ReadonlyMap<string, { to: string; honored: boolean }> = new Map([
  ["streaming", { to: "streaming", honored: false }], // alias removed in 2.0
  ["live", { to: "live", honored: false }], // alias removed in 2.0
  ["cacheComponents", { to: "cacheComponents", honored: true }], // graduated in 2.0; alias kept
]);

/** The warning for a graduated `experimental.<key>`, pointing at its top-level home. */
function movedKeyMessage(name: string, key: string, to: string, honored: boolean): string {
  const status = honored ? "is still honored for now but has moved" : "is no longer honored";
  return `denext: ${name} sets \`experimental.${key}\`, which ${status} — set top-level \`${to}\` instead.`;
}

/** One level down: warn on `experimental.*` keys outside the generated `EXPERIMENTAL_KEYS`. */
function warnUnknownExperimentalKeys(experimental: unknown, name: string): void {
  if (typeof experimental !== "object" || experimental === null || Array.isArray(experimental)) {
    return;
  }
  for (const key of Object.keys(experimental)) {
    if (KNOWN_EXPERIMENTAL_KEYS.includes(key)) continue;
    const moved = MOVED_EXPERIMENTAL_KEYS.get(key);
    if (moved) {
      console.warn(movedKeyMessage(name, key, moved.to, moved.honored));
      continue;
    }
    const suggestion = didYouMean(key, KNOWN_EXPERIMENTAL_KEYS);
    console.warn(unknownKeyMessage(name, `experimental.${key}`, suggestion));
  }
}

/**
 * Warn (to stderr, never throw) on any top-level config key not in {@link KNOWN_CONFIG_KEYS},
 * and one level down on any `experimental.*` key not in the generated `EXPERIMENTAL_KEYS`.
 * The loader reconstructs config from a fixed field list, so an unrecognized key (a typo,
 * a stale Next.js option) is otherwise dropped with no signal. Emits a "did you mean"
 * suggestion when a close known key exists, and a "moved to top-level" pointer for the
 * graduated `experimental.streaming` / `experimental.live` / `experimental.cacheComponents`.
 *
 * @param config The raw config object as authored (before the loader's whitelist).
 * @param name The config file name, for the message (default `"denext.config"`).
 */
export function warnUnknownConfigKeys(config: object, name = "denext.config"): void {
  for (const key of Object.keys(config)) {
    if (KNOWN_CONFIG_KEYS.includes(key)) continue;
    console.warn(unknownKeyMessage(name, key, didYouMean(key)));
  }
  warnUnknownExperimentalKeys((config as { experimental?: unknown }).experimental, name);
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

/** `tailwind.input`/`output` are required non-empty path strings. */
function validateTailwind(tailwind: unknown, fail: Fail): void {
  if (tailwind === undefined) return;
  if (typeof tailwind !== "object" || tailwind === null) {
    return fail("tailwind", "must be an object");
  }
  const tw = tailwind as Record<string, unknown>;
  for (const k of ["input", "output"]) {
    if (typeof tw[k] !== "string" || !tw[k]) {
      fail(`tailwind.${k}`, "must be a non-empty path string");
    }
  }
}

/** `i18n.locales` is a non-empty string list and `defaultLocale` is one of them. */
function validateI18n(i18n: unknown, fail: Fail): void {
  if (i18n === undefined) return;
  const { locales, defaultLocale } = (i18n ?? {}) as { locales?: unknown; defaultLocale?: unknown };
  const list = Array.isArray(locales) ? locales : [];
  if (list.length === 0 || list.some((l) => typeof l !== "string")) {
    return fail("i18n.locales", "must be a non-empty array of locale strings");
  }
  if (typeof defaultLocale !== "string" || !list.includes(defaultLocale)) {
    fail("i18n.defaultLocale", "must be one of i18n.locales");
  }
}

/** Nested fields whose absence would crash at request time rather than at boot. */
function validateNestedRequired(config: DenextConfig, fail: Fail): void {
  validateTailwind(config.tailwind, fail);
  validateI18n(config.i18n, fail);
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
  validateNestedRequired(config, fail);
}
