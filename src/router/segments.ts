// Route segment parsing and matching — pure functions, no filesystem access.
//
// Conventions (Next.js App Router style):
//   static           "about"
//   dynamic          "[slug]"        -> params.slug = "value"
//   catch-all        "[...rest]"     -> params.rest = "a/b/c"
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

/** Extracted dynamic route parameters, keyed by segment name. */
export type RouteParams = Record<string, string>;

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

  let pi = 0; // pattern index
  let si = 0; // segment (path part) index

  while (pi < pattern.length) {
    const seg = pattern[pi];

    if (seg.kind === "catchAll") {
      // Must consume at least one remaining part.
      const rest = parts.slice(si);
      if (rest.length === 0) return null;
      // A catch-all consumes every remaining part, so it always reaches the end of
      // `parts` — the match is complete here.
      params[seg.value] = rest.map(decodeSegment).join("/");
      return params;
    }

    if (seg.kind === "optionalCatchAll") {
      const rest = parts.slice(si);
      if (rest.length > 0) params[seg.value] = rest.map(decodeSegment).join("/");
      return params;
    }

    // static / dynamic consume exactly one part
    if (si >= parts.length) return null;
    const part = parts[si];

    if (seg.kind === "static") {
      if (seg.value !== part) return null;
    } else {
      // dynamic
      params[seg.value] = decodeSegment(part);
    }
    pi++;
    si++;
  }

  // All pattern segments consumed; path must be fully consumed too.
  return si === parts.length ? params : null;
}

function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Specificity score for ordering routes: more specific (static) patterns
 * should be tried before less specific (dynamic/catch-all) ones. Higher wins.
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
