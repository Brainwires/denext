// Route segment parsing and matching — pure functions, no filesystem access.
//
// Conventions (Next.js App Router style):
//   static           "about"
//   dynamic          "[slug]"        -> params.slug = "value"
//   catch-all        "[...rest]"     -> params.rest = ["a", "b", "c"]   (Next.js shape)
//   optional         "[[...rest]]"   -> params.rest may be absent

/** The category of a route segment, determining how it matches path parts. */
export type SegmentKind = "static" | "dynamic" | "catchAll" | "optionalCatchAll";

/** A single parsed route pattern segment. */
export interface Segment {
  /** Which kind of segment this is (static, dynamic, catch-all, etc.). */
  kind: SegmentKind;
  /** Literal text for static segments; param name otherwise. */
  value: string;
}

/**
 * Extracted dynamic route parameters, keyed by segment name. A `[slug]` segment yields a
 * string; a `[...rest]` / `[[...rest]]` catch-all yields the remaining parts as a
 * `string[]` (Next.js's shape — `params.rest.join("/")` for the path form).
 */
export type RouteParams = Record<string, string | string[]>;

/** A param value as the URL-path form (`string[]` catch-all parts joined with `/`). */
export function paramPath(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("/") : (value ?? "");
}

/** Parse a single path segment (a directory name) into a Segment descriptor. */
export function parseSegment(raw: string): Segment {
  const optionalCatchAll = raw.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optionalCatchAll) {
    return { kind: "optionalCatchAll", value: optionalCatchAll[1] };
  }
  const catchAll = raw.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) {
    return { kind: "catchAll", value: catchAll[1] };
  }
  const dynamic = raw.match(/^\[(.+)\]$/);
  if (dynamic) {
    return { kind: "dynamic", value: dynamic[1] };
  }
  return { kind: "static", value: raw };
}

/** Parse a route pattern like "blog/[slug]" into an ordered segment list. */
export function parsePattern(pattern: string): Segment[] {
  return splitPath(pattern).map(parseSegment);
}

/**
 * A parallel-route slot folder (`@name`). Slots don't contribute a URL segment;
 * their subtree is passed to the owning layout as a prop named `name`. `@children`
 * is reserved (it aliases the default `children` slot).
 *
 * @param raw A directory name.
 * @returns The slot name, or null if `raw` is not a slot folder.
 */
export function parseSlot(raw: string): string | null {
  if (raw.length > 1 && raw[0] === "@") return raw.slice(1);
  return null;
}

/**
 * An intercepting-route marker parsed from a folder name like `(.)photo`,
 * `(..)photo`, `(..)(..)photo`, or `(...)photo`.
 */
export interface Intercept {
  /**
   * How far up the segment tree the intercept reaches: `"same"` for `(.)`,
   * a positive integer for one-or-more `(..)`, or `"root"` for `(...)`.
   */
  level: "same" | "root" | number;
  /** The intercepted folder name (e.g. `"photo"`). */
  name: string;
}

const INTERCEPT_RE = /^(\(\.\)|(?:\(\.\.\))+|\(\.\.\.\))(.+)$/;

/**
 * Parse an intercepting-route marker off a folder name. Returns null when the
 * name carries no intercept marker (including plain route groups like
 * `(marketing)`).
 *
 * @param raw A directory name.
 * @returns The parsed {@link Intercept}, or null.
 */
export function parseIntercept(raw: string): Intercept | null {
  const m = INTERCEPT_RE.exec(raw);
  if (!m) return null;
  const marker = m[1];
  const name = m[2];
  if (marker === "(.)") return { level: "same", name };
  if (marker === "(...)") return { level: "root", name };
  // One or more "(..)" groups.
  const ups = marker.length / 4; // each "(..)" is 4 chars
  return { level: ups, name };
}

/** Split a URL path or pattern into non-empty segments. */
export function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Attempt to match a request pathname against a parsed pattern.
 * Returns extracted params on success, or null if the pattern doesn't match.
 */
export function matchSegments(
  pattern: Segment[],
  pathname: string,
): RouteParams | null {
  const parts = splitPath(pathname);
  const params: RouteParams = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    // A catch-all consumes every remaining part, so the match is complete here.
    if (seg.kind === "catchAll" || seg.kind === "optionalCatchAll") {
      return matchCatchAll(seg, parts.slice(i), params);
    }
    // static / dynamic consume exactly one part
    if (i >= parts.length || !matchOne(seg, parts[i], params)) return null;
  }
  // All pattern segments consumed; path must be fully consumed too.
  return pattern.length === parts.length ? params : null;
}

/** A catch-all must consume at least one part; an optional one may consume none. */
function matchCatchAll(seg: Segment, rest: string[], params: RouteParams): RouteParams | null {
  if (rest.length === 0) return seg.kind === "optionalCatchAll" ? params : null;
  params[seg.value] = rest.map(decodeSegment);
  return params;
}

/** A static segment must equal the part; a dynamic one captures it. */
function matchOne(seg: Segment, part: string, params: RouteParams): boolean {
  if (seg.kind === "static") return seg.value === part;
  params[seg.value] = decodeSegment(part);
  return true;
}

function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Per-position rank for route ordering (higher = more specific). */
const KIND_RANK: Record<SegmentKind, number> = {
  static: 3,
  dynamic: 2,
  catchAll: 1,
  optionalCatchAll: 0,
};

/**
 * Order two patterns by specificity the way Next.js does: compare segment by segment from
 * the left, and at the first position that differs the more specific kind wins
 * (static > dynamic > catch-all > optional catch-all). A pattern that has run out of
 * segments (its catch-all consumed the rest) ranks below one that still has a concrete
 * segment there. Returns negative when `a` should be tried first.
 */
export function compareSpecificity(a: Segment[], b: Segment[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ra = a[i] ? KIND_RANK[a[i].kind] : -1;
    const rb = b[i] ? KIND_RANK[b[i].kind] : -1;
    if (ra !== rb) return rb - ra;
  }
  return 0;
}

/**
 * Specificity score for ordering routes: more specific (static) patterns
 * should be tried before less specific (dynamic/catch-all) ones. Higher wins.
 * Position-blind (a sum) — prefer {@linkcode compareSpecificity} for ordering.
 */
export function specificity(pattern: Segment[]): number {
  let score = 0;
  for (const seg of pattern) {
    switch (seg.kind) {
      case "static":
        score += 1000;
        break;
      case "dynamic":
        score += 100;
        break;
      case "catchAll":
        score += 10;
        break;
      case "optionalCatchAll":
        score += 1;
        break;
    }
  }
  // Longer concrete patterns edge out shorter ones at equal kind-weight.
  return score + pattern.length;
}

/**
 * Fill a route pattern with params to produce a concrete pathname (a catch-all param may
 * carry slash-joined segments already).
 */
export function fillPattern(pattern: Segment[], params: RouteParams): string {
  const parts: string[] = [];
  for (const seg of pattern) {
    if (seg.kind === "static") parts.push(seg.value);
    else if (params[seg.value]) parts.push(paramPath(params[seg.value]));
  }
  return "/" + parts.join("/");
}
