// Route segment config — the module-level exports a page/layout/route file may
// declare to control rendering and caching (Next.js "Route Segment Config"):
//
//   export const dynamic = "force-static";
//   export const revalidate = 60;         // seconds, or false to cache forever
//   export const dynamicParams = false;
//
// denext reads these to decide static vs dynamic rendering and ISR behavior.
// `runtime`/`preferredRegion`/`maxDuration`/`fetchCache` are accepted for
// source-compatibility with Next.js but are informational in a single Deno
// runtime.

/** Per-route Content-Security-Policy opt-ins: external sources a route allows. */
export interface RouteCsp {
  /** Extra `script-src` sources (external script hosts). */
  scriptSrc?: string[];
  /** Extra `style-src` sources (external stylesheet hosts). */
  styleSrc?: string[];
  /** Extra `img-src` sources (`<Image>` is already same-origin via the optimizer). */
  imgSrc?: string[];
  /** Extra `connect-src` sources (fetch/XHR/EventSource/WebSocket targets). */
  connectSrc?: string[];
}

/**
 * How a scope's Content-Security-Policy is decided (three-state):
 * - `"strict"` — denext's default hash-based strict policy.
 * - `"off"` — emit **no** CSP header for this scope (e.g. Next.js-compat, or to set
 *   the policy entirely at the edge/proxy).
 * - a {@link RouteCsp} object — the strict policy plus the listed external opt-ins.
 *
 * Settable globally (`denext.config` `csp`) and per file (a route's `csp` export);
 * the per-file setting overrides the global one for that route.
 */
export type CspSetting = "strict" | "off" | RouteCsp;

/**
 * How a segment is rendered:
 * - `"auto"` — the default; static unless the code opts into dynamic behavior.
 * - `"force-dynamic"` — always render per request (never statically exported/cached).
 * - `"force-static"` — always render statically; dynamic APIs return empty values.
 * - `"error"` — like auto, but using a dynamic API is an error (treated as auto here).
 */
export type RouteDynamic = "auto" | "force-dynamic" | "force-static" | "error";

/** Revalidation period in seconds, or `false` to cache indefinitely. */
export type Revalidate = number | false;

/** The resolved route segment configuration for a module. */
export interface SegmentConfig {
  /** Static/dynamic rendering mode. */
  dynamic: RouteDynamic;
  /** Whether params outside `generateStaticParams` are allowed (else 404). */
  dynamicParams: boolean;
  /** Revalidation period in seconds, or `false` for no time-based revalidation. */
  revalidate: Revalidate;
  /** Target runtime hint (informational in denext). */
  runtime?: string;
  /** Preferred region hint (informational in denext). */
  preferredRegion?: string | string[];
  /** Max execution duration hint in seconds (informational in denext). */
  maxDuration?: number;
  /** Default fetch cache policy hint (informational in denext). */
  fetchCache?: string;
  /** Per-route CSP setting (three-state): `"strict"`, `"off"`, or opt-in sources. */
  csp?: CspSetting;
}

/** Optional route-segment-config exports a module may declare. */
export interface SegmentConfigExports {
  /** See {@link RouteDynamic}. */
  dynamic?: RouteDynamic;
  /** See {@link SegmentConfig.dynamicParams}. */
  dynamicParams?: boolean;
  /** See {@link Revalidate}. */
  revalidate?: Revalidate;
  /** Target runtime hint. */
  runtime?: string;
  /** Preferred region hint. */
  preferredRegion?: string | string[];
  /** Max execution duration hint in seconds. */
  maxDuration?: number;
  /** Default fetch cache policy hint. */
  fetchCache?: string;
  /**
   * Per-route CSP setting, overriding the global `denext.config` `csp` for this
   * route (three-state). Opt specific external hosts into the strict policy, e.g.
   * `export const csp = { scriptSrc: ["https://plausible.io"] }`; disable the CSP
   * for this route with `export const csp = "off"` (or `false`); or force the strict
   * policy with `"strict"` (or `true`) even when the global default is `"off"`.
   */
  csp?: CspSetting | boolean;
}

/** The default segment config applied when a module declares nothing. */
export const DEFAULT_SEGMENT_CONFIG: SegmentConfig = {
  dynamic: "auto",
  dynamicParams: true,
  revalidate: false,
};

const DYNAMIC_VALUES = new Set<RouteDynamic>([
  "auto",
  "force-dynamic",
  "force-static",
  "error",
]);

/**
 * Read the route segment config from a loaded module, validating each field and
 * falling back to {@link DEFAULT_SEGMENT_CONFIG} for anything absent or invalid.
 *
 * @param mod A loaded page/layout/route module (may be undefined).
 * @returns The resolved {@link SegmentConfig}.
 */
export function readSegmentConfig(mod: unknown): SegmentConfig {
  const m = (mod ?? {}) as SegmentConfigExports;
  const cfg: SegmentConfig = { ...DEFAULT_SEGMENT_CONFIG };

  if (typeof m.dynamic === "string" && DYNAMIC_VALUES.has(m.dynamic)) {
    cfg.dynamic = m.dynamic;
  }
  if (typeof m.dynamicParams === "boolean") cfg.dynamicParams = m.dynamicParams;
  if (m.revalidate === false || (typeof m.revalidate === "number" && m.revalidate >= 0)) {
    cfg.revalidate = m.revalidate;
  }
  if (typeof m.runtime === "string") cfg.runtime = m.runtime;
  if (typeof m.preferredRegion === "string" || Array.isArray(m.preferredRegion)) {
    cfg.preferredRegion = m.preferredRegion;
  }
  if (typeof m.maxDuration === "number") cfg.maxDuration = m.maxDuration;
  if (typeof m.fetchCache === "string") cfg.fetchCache = m.fetchCache;
  const csp = normalizeCspSetting(m.csp);
  if (csp !== undefined) cfg.csp = csp;

  // `force-static` implies caching forever unless an explicit revalidate is set.
  if (cfg.dynamic === "force-static" && cfg.revalidate === false) {
    cfg.revalidate = false;
  }
  return cfg;
}

/**
 * Merge a parent segment config with a child's, mirroring Next.js precedence:
 * the child overrides the parent, and the *shortest* revalidate wins.
 *
 * @param parent The inherited config (outer segment).
 * @param child The child module's config (inner segment).
 * @returns The effective config for the child segment.
 */
export function mergeSegmentConfig(
  parent: SegmentConfig,
  child: SegmentConfig,
): SegmentConfig {
  const revalidate = shortestRevalidate(parent.revalidate, child.revalidate);
  // CSP: a child's on/off toggle overrides; opt-in objects UNION down the chain (a
  // layout's allowed hosts and the page's both apply).
  const csp = mergeCsp(parent.csp, child.csp);
  const merged = { ...parent, ...child, revalidate };
  if (csp !== undefined) merged.csp = csp;
  else delete merged.csp;
  return merged;
}

/** Keep only the string[] source lists from a (possibly invalid) `csp` export. */
/**
 * Normalize a raw `csp` export into a {@link CspSetting}: `false`/`"off"` → `"off"`,
 * `true`/`"strict"` → `"strict"`, an object → validated {@link RouteCsp} opt-ins,
 * anything else → `undefined` (unset ⇒ inherit).
 */
function normalizeCspSetting(raw: unknown): CspSetting | undefined {
  if (raw === false || raw === "off") return "off";
  if (raw === true || raw === "strict") return "strict";
  return normalizeRouteCsp(raw);
}

/**
 * Merge a parent's CSP setting with a child's. A child's on/off toggle
 * (`"off"`/`"strict"`) overrides the inherited value; a child opt-in object implies
 * CSP is on and UNIONs with any inherited opt-ins; an unset child inherits.
 */
function mergeCsp(parent?: CspSetting, child?: CspSetting): CspSetting | undefined {
  if (child === "off" || child === "strict") return child;
  if (child && typeof child === "object") {
    const parentObj = parent && typeof parent === "object" ? parent : undefined;
    return mergeRouteCsp(parentObj, child) ?? "strict";
  }
  return parent;
}

function normalizeRouteCsp(raw: unknown): RouteCsp | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const out: RouteCsp = {};
  for (const key of ["scriptSrc", "styleSrc", "imgSrc", "connectSrc"] as const) {
    const v = src[key];
    if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === "string");
      if (list.length) out[key] = list;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Union two route CSP opt-in sets (dedupes each source list). */
function mergeRouteCsp(a: RouteCsp | undefined, b: RouteCsp | undefined): RouteCsp | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: RouteCsp = {};
  for (const key of ["scriptSrc", "styleSrc", "imgSrc", "connectSrc"] as const) {
    const merged = [...new Set([...(a[key] ?? []), ...(b[key] ?? [])])];
    if (merged.length) out[key] = merged;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The shorter of two revalidate periods (`false` = infinite). */
function shortestRevalidate(a: Revalidate, b: Revalidate): Revalidate {
  if (a === false) return b;
  if (b === false) return a;
  return Math.min(a, b);
}
