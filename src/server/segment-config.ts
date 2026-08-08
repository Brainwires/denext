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
  return { ...parent, ...child, revalidate };
}

/** The shorter of two revalidate periods (`false` = infinite). */
function shortestRevalidate(a: Revalidate, b: Revalidate): Revalidate {
  if (a === false) return b;
  if (b === false) return a;
  return Math.min(a, b);
}
