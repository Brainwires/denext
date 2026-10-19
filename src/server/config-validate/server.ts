// The request-serving parts of denext.config: routing, images, security headers (CSP, HSTS,
// CORS, app links), the production-server knobs, the API batch, caches and job history.

import { type DenextConfig, isHeaderName, isOrigin, resolveCacheLifeProfiles } from "../config.ts";
import { validateCacheLifeProfile } from "../cache-scope.ts";
import { resolveCors } from "../cors.ts";
import { ROUTE_CSP_KEYS } from "../segment-config.ts";
import { validateAppLinks } from "../app-links.ts";
import { parseCidr } from "../remote-addr.ts";
import { isForwardableBatchHeader } from "../../runtime/api-batch-protocol.ts";
import { didYouMean, unknownKeyMessage } from "./keys.ts";
import { type Fail, num, numArray, type NumOpts } from "./shared.ts";

/** `basePath`: empty, or a "/"-rooted path without a trailing slash. */
function validateBasePath(basePath: DenextConfig["basePath"], fail: Fail): void {
  if (basePath === undefined) return;
  if (typeof basePath !== "string") fail("basePath", "must be a string");
  else if (basePath !== "" && (!basePath.startsWith("/") || basePath.endsWith("/"))) {
    fail("basePath", 'must start with "/" and not end with "/" (e.g. "/docs")');
  }
}

/** `basePath`/`assetPrefix`/`trailingSlash` and the redirect/rewrite/header thunks. */
export function validateRouting(config: DenextConfig, fail: Fail): void {
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
export function validateImageAllowlists(images: DenextConfig["images"], fail: Fail): void {
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
export function validateImageNumerics(images: DenextConfig["images"], fail: Fail): void {
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

/**
 * `csp` / `spa.csp`: `"strict"` | `"off"` | an opt-in object whose values are string
 * arrays. An unknown opt-in key (a typo such as `frameSource`) warns with a suggestion —
 * the policy would otherwise stay strict for that directive with no signal.
 */
function validateCsp(field: string, csp: DenextConfig["csp"], fail: Fail): void {
  if (csp === undefined || csp === "strict" || csp === "off") return;
  if (typeof csp !== "object" || csp === null || Array.isArray(csp)) {
    fail(field, 'must be "strict", "off", or an opt-in object (e.g. `{ scriptSrc: [...] }`)');
  }
  for (const [key, value] of Object.entries(csp)) validateCspOptIn(field, key, value, fail);
}

/** One `csp` opt-in entry: a known directive key holding an array of source strings. */
function validateCspOptIn(field: string, key: string, value: unknown, fail: Fail): void {
  const known: readonly string[] = ROUTE_CSP_KEYS;
  if (!known.includes(key)) {
    console.warn(unknownKeyMessage(`\`${field}\``, key, didYouMean(key, known)));
  } else if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`${field}.${key}`, 'must be an array of source strings (e.g. `["https://x.io"]`)');
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
export function validateSecurity(config: DenextConfig, fail: Fail): void {
  validateCsp("csp", config.csp, fail);
  validateCsp("spa.csp", config.spa?.csp, fail);
  validateHsts(config.hsts, fail);
  validateApiBatch(config.apiBatch, fail, config.rateLimitHeader);
  validateCors(config.cors, fail);
  validateAppLinks(config.appLinks, fail);
  if (config.apiMaxBodyBytes !== undefined) {
    num(fail, "apiMaxBodyBytes", config.apiMaxBodyBytes, { int: true, min: 1 });
  }
  validateServerOptions(config, fail);
}

/** `compress`: a boolean, or `{ encodings }` listing `"gzip"` / `"br"`. */
function validateCompress(compress: unknown, fail: Fail): void {
  if (compress === undefined || typeof compress === "boolean") return;
  if (typeof compress !== "object" || compress === null || Array.isArray(compress)) {
    fail("compress", 'must be a boolean or { encodings: ("gzip" | "br")[] }');
  }
  const encodings = (compress as { encodings?: unknown }).encodings;
  if (
    encodings !== undefined &&
    (!Array.isArray(encodings) || !encodings.every((e) => e === "gzip" || e === "br"))
  ) {
    fail("compress.encodings", 'must be an array of "gzip" / "br"');
  }
}

/** `cdnCacheHeaders`: a boolean, or `{ evenWithMiddleware?: boolean }`. */
function validateCdnCacheHeaders(cdn: unknown, fail: Fail): void {
  if (cdn === undefined || typeof cdn === "boolean") return;
  if (typeof cdn !== "object" || cdn === null || Array.isArray(cdn)) {
    fail("cdnCacheHeaders", "must be a boolean or { evenWithMiddleware?: boolean }");
  }
  const even = (cdn as { evenWithMiddleware?: unknown }).evenWithMiddleware;
  if (even !== undefined && typeof even !== "boolean") {
    fail("cdnCacheHeaders.evenWithMiddleware", "must be a boolean");
  }
}

/**
 * `rateLimitHeader` (an HTTP header name), `rateLimitLocalAddresses` (a boolean) and
 * `rateLimitTrustedProxies` (CIDR ranges): a malformed header name could never match a request,
 * and a malformed range could never match a peer, silently leaving every limit on the fallback
 * address.
 */
function validateRateLimitAddress(config: DenextConfig, fail: Fail): void {
  const { rateLimitHeader, rateLimitLocalAddresses } = config;
  if (
    rateLimitHeader !== undefined &&
    (typeof rateLimitHeader !== "string" || !isHeaderName(rateLimitHeader))
  ) {
    fail("rateLimitHeader", 'must be an HTTP header name (e.g. "cf-connecting-ip")');
  }
  if (rateLimitLocalAddresses !== undefined && typeof rateLimitLocalAddresses !== "boolean") {
    fail("rateLimitLocalAddresses", "must be a boolean");
  }
  const proxies: unknown = config.rateLimitTrustedProxies;
  if (
    proxies !== undefined &&
    (!Array.isArray(proxies) || proxies.some((p) => typeof p !== "string" || !parseCidr(p)))
  ) {
    fail(
      "rateLimitTrustedProxies",
      'must be an array of CIDR ranges or addresses (e.g. ["173.245.48.0/20", "10.0.0.0/8"])',
    );
  }
}

/**
 * The production-server knobs (`canonicalOrigin`, `trustForwardedHeaders`, `rateLimitHeader`,
 * `rateLimitLocalAddresses`, `compress`,
 * `requestTimeout`, `maxConcurrency`, `slotBackstop`, `actionMaxBodyBytes`, `cacheKeyParams`):
 * a bare origin, booleans, whole numbers in range, a list of param names. A bad `canonicalOrigin` would
 * otherwise silently 403 every Server Action (the origin check compares against it).
 */
function validateServerOptions(config: DenextConfig, fail: Fail): void {
  const { canonicalOrigin, trustForwardedHeaders, cacheKeyParams } = config;
  if (
    canonicalOrigin !== undefined &&
    (typeof canonicalOrigin !== "string" || !isOrigin(canonicalOrigin))
  ) {
    fail(
      "canonicalOrigin",
      'must be an origin — scheme + host, no path (e.g. "https://example.com")',
    );
  }
  if (trustForwardedHeaders !== undefined && typeof trustForwardedHeaders !== "boolean") {
    fail("trustForwardedHeaders", "must be a boolean");
  }
  validateRateLimitAddress(config, fail);
  validateCdnCacheHeaders(config.cdnCacheHeaders, fail);
  validateCompress(config.compress, fail);
  if (config.requestTimeout !== undefined) {
    num(fail, "requestTimeout", config.requestTimeout, { int: true, min: 0 }); // ms; 0 disables
  }
  if (config.maxConcurrency !== undefined) {
    num(fail, "maxConcurrency", config.maxConcurrency, { int: true, min: 1 });
  }
  if (config.slotBackstop !== undefined) {
    num(fail, "slotBackstop", config.slotBackstop, { int: true, min: 1 });
  }
  if (config.actionMaxBodyBytes !== undefined) {
    num(fail, "actionMaxBodyBytes", config.actionMaxBodyBytes, { int: true, min: 1 });
  }
  if (cacheKeyParams !== undefined) {
    if (!Array.isArray(cacheKeyParams) || cacheKeyParams.some((p) => typeof p !== "string")) {
      fail("cacheKeyParams", "must be an array of query-parameter-name strings");
    }
  }
}

/**
 * `cors`: the same resolution `createApp` runs (exact origins, never `"null"`, `"*"` alone and
 * never with credentials, a sane `maxAge`), so a bad policy fails at config load.
 */
function validateCors(cors: DenextConfig["cors"], fail: Fail): void {
  if (cors === undefined) return;
  try {
    resolveCors(cors);
  } catch (error) {
    fail("cors", (error instanceof Error ? error.message : String(error)).replace(/^denext: /, ""));
  }
}

/**
 * `apiBatch.forwardHeaders`: header names a batch item may carry — never a credential, framing,
 * trust or proxy header (`isForwardableBatchHeader`), nor the `rateLimitHeader` a limiter keys on.
 */
function validateForwardHeaders(
  list: unknown,
  fail: Fail,
  rateLimitHeader: string | undefined,
): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    return fail("apiBatch.forwardHeaders", "must be an array of header names");
  }
  for (const name of list) {
    const lower = typeof name === "string" ? name.toLowerCase() : "";
    if (!isForwardableBatchHeader(lower) || lower === rateLimitHeader?.toLowerCase()) {
      fail(
        "apiBatch.forwardHeaders",
        `${JSON.stringify(name)} cannot be forwarded per batch item (a credential, framing, ` +
          "proxy or denext header, or not a header name)",
      );
    }
  }
}

/** `apiBatch` caps are finite whole numbers in sane ranges; `enabled` / `mutations` are booleans. */
function validateApiBatch(
  apiBatch: DenextConfig["apiBatch"],
  fail: Fail,
  rateLimitHeader: string | undefined,
): void {
  if (apiBatch === undefined) return;
  if (typeof apiBatch !== "object" || apiBatch === null) {
    return fail("apiBatch", "must be an object");
  }
  for (const key of ["enabled", "mutations"] as const) {
    if (apiBatch[key] !== undefined && typeof apiBatch[key] !== "boolean") {
      fail(`apiBatch.${key}`, "must be a boolean");
    }
  }
  validateForwardHeaders(apiBatch.forwardHeaders, fail, rateLimitHeader);
  if (apiBatch.maxItems !== undefined) {
    num(fail, "apiBatch.maxItems", apiBatch.maxItems, { int: true, min: 1, max: 100 });
  }
  if (apiBatch.maxBodyBytes !== undefined) {
    num(fail, "apiBatch.maxBodyBytes", apiBatch.maxBodyBytes, { int: true, min: 1 });
  }
  if (apiBatch.concurrency !== undefined) {
    num(fail, "apiBatch.concurrency", apiBatch.concurrency, { int: true, min: 1, max: 64 });
  }
  if (apiBatch.maxItemResponseBytes !== undefined) {
    num(fail, "apiBatch.maxItemResponseBytes", apiBatch.maxItemResponseBytes, {
      int: true,
      min: 1,
    });
  }
  if (apiBatch.maxTotalResponseBytes !== undefined) {
    num(fail, "apiBatch.maxTotalResponseBytes", apiBatch.maxTotalResponseBytes, {
      int: true,
      min: 1,
    });
  }
}

/** Cache eviction counts (finite whole numbers >= 1) and the `publicEnv` allowlist. */
export function validateCacheAndEnv(config: DenextConfig, fail: Fail): void {
  if (config.cache?.maxDataEntries !== undefined) {
    num(fail, "cache.maxDataEntries", config.cache.maxDataEntries, { int: true, min: 1 });
  }
  if (config.cache?.maxPageEntries !== undefined) {
    num(fail, "cache.maxPageEntries", config.cache.maxPageEntries, { int: true, min: 1 });
  }
  validateCacheLifeConfig(resolveCacheLifeProfiles(config), fail);
  if (config.publicEnv !== undefined) {
    if (!Array.isArray(config.publicEnv) || config.publicEnv.some((k) => typeof k !== "string")) {
      fail("publicEnv", "must be an array of env-variable-name strings");
    }
  }
}

/** `cacheLife`: an object of named profiles, each valid as Next.js checks one. */
function validateCacheLifeConfig(profiles: unknown, fail: Fail): void {
  if (profiles === undefined) return;
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) {
    return fail("cacheLife", "must be an object of named { stale, revalidate, expire } profiles");
  }
  for (const [name, profile] of Object.entries(profiles)) {
    try {
      validateCacheLifeProfile(profile, { config: name });
    } catch (err) {
      fail(`cacheLife.${name}`, (err as Error).message);
    }
  }
}

/** The `JobHistoryStore` methods a `jobs.history.store` must have. */
const HISTORY_STORE_METHODS = ["record", "read", "listRuns", "prune", "clear"] as const;

/**
 * `jobs.historyMaxRuns` / `jobs.history.maxRuns` are finite whole numbers >= 1; `jobs.history`
 * is a boolean or `{ store?, maxRuns? }`, and a `store` has every `JobHistoryStore` method.
 */
export function validateJobs(jobs: DenextConfig["jobs"], fail: Fail): void {
  if (jobs?.historyMaxRuns !== undefined) {
    num(fail, "jobs.historyMaxRuns", jobs.historyMaxRuns, { int: true, min: 1 });
  }
  const history: unknown = jobs?.history;
  if (history === undefined || typeof history === "boolean") return;
  if (history === null || typeof history !== "object" || Array.isArray(history)) {
    fail("jobs.history", "must be a boolean or { store?, maxRuns? }");
    return;
  }
  const { store, maxRuns } = history as { store?: unknown; maxRuns?: unknown };
  if (maxRuns !== undefined) num(fail, "jobs.history.maxRuns", maxRuns, { int: true, min: 1 });
  if (store === undefined) return;
  const missing = store !== null && typeof store === "object"
    ? HISTORY_STORE_METHODS.filter((m) =>
      typeof (store as Record<string, unknown>)[m] !== "function"
    )
    : HISTORY_STORE_METHODS;
  if (missing.length > 0) {
    fail("jobs.history.store", `must be a JobHistoryStore (missing ${missing.join(", ")})`);
  }
}
