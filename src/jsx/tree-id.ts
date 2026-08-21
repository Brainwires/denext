// Path-based `useId` — the shared id scheme for every renderer and the client.
//
// A component's id is derived from its POSITION in the component tree (its chain
// of slot indices from the render root), not from a global per-pass counter. The
// six server renderers and the client fiber reconciler all build the SAME path,
// so `useId()` matches across:
//   - a normal server render → client hydration,
//   - the PPR shell / per-request hole boundary (a hole re-rendered in isolation
//     at its known tree position yields the same ids the client computes over the
//     merged document),
//   - independent island hydration (the island is seeded with its path prefix).
//
// Why position instead of a counter: a counter only aligns when every id
// producer/consumer advances it over the exact same call sequence. An isolated
// subtree (a streamed hole, an island hydrated on its own) can't reconstruct that
// global sequence — but it CAN reconstruct its own position. Both engines already
// invoke components in identical depth-first order (that is what made the old
// counter work at all); scoping the count per component turns that shared order
// into a shared, position-derived id with no global coordination.
//
// Encoding: a component's path is its parent scope's prefix plus its slot index,
// joined by ".". `useId()` appends "_" and a per-component local index, so two
// `useId()` calls in one component differ, and a component's own ids never collide
// with a child's path (the "." vs "_" separators keep the namespaces disjoint).
// A root render's prefix is "" (its direct children are "0", "1", …); an island
// hydrated on its own is seeded with its full path as the prefix instead.

/**
 * A component's id scope: its position in the component tree plus the per-render
 * counters that assign child slots and local `useId` indices. One is created per
 * component render (via {@link enterScope}); host/fragment/Suspense/error-boundary
 * levels are id-transparent and reuse their enclosing component's scope.
 */
export interface IdScope {
  /** The enclosing component scope, or `null` at a render root. */
  readonly parent: IdScope | null;
  /** This component's slot index among the components entered in `parent`. */
  readonly slot: number;
  /** Child components entered in this scope so far — assigns their slots. */
  count: number;
  /** `useId()` calls in THIS component so far — assigns their local index. */
  local: number;
  /** Lazily built + cached path prefix string. */
  prefix?: string;
}

/** A mutable holder for the id scope currently rendering (read by `useId`). */
export interface IdHolder {
  scope: IdScope;
}

/**
 * The root scope of a render pass. Pass a non-empty `prefix` to seed an
 * independently-hydrated subtree (an island) with its full tree path, so its ids
 * match the same subtree rendered in place on the server.
 */
export function rootScope(prefix = ""): IdScope {
  return { parent: null, slot: -1, count: 0, local: 0, prefix };
}

/**
 * Enter a child component of `parent`, consuming the parent's next slot. Call
 * exactly once per component, in depth-first render order, on both the server and
 * the client — the shared order is what keeps slots aligned.
 */
export function enterScope(parent: IdScope): IdScope {
  return { parent, slot: parent.count++, count: 0, local: 0 };
}

/** This scope's path prefix (built once, then cached): `parentPrefix "." slot`. */
export function scopePrefix(scope: IdScope): string {
  if (scope.prefix !== undefined) return scope.prefix;
  const parentPrefix = scopePrefix(scope.parent!);
  return (scope.prefix = parentPrefix === ""
    ? String(scope.slot)
    : parentPrefix + "." + scope.slot);
}

/** The next `useId()` value for a component currently rendering in `scope`. */
export function nextId(scope: IdScope): string {
  return `:d${scopePrefix(scope)}_${scope.local++}:`;
}

/**
 * Recover the tree-path prefix from a {@link nextId} value (`:d{prefix}_{local}:`).
 * A component's first `useId()` therefore yields its own scope prefix — the stable,
 * server/client-agreed identity a Live boundary uses to address itself, without a
 * dedicated dispatcher primitive.
 *
 * @param id A value produced by {@link nextId} / `useId()`.
 * @returns The embedded scope prefix (e.g. `"0.2.1"`), or `""` if unparseable.
 */
export function prefixFromId(id: string): string {
  if (!id.startsWith(":d") || !id.endsWith(":")) return "";
  const body = id.slice(2, -1); // drop leading ":d" and trailing ":"
  const u = body.lastIndexOf("_");
  return u === -1 ? body : body.slice(0, u);
}

/**
 * Internal prop carrying a Flight client island's tree-path prefix. An island
 * hydrates on its own, so it can't derive its position from an enclosing tree;
 * the server tags it with this prefix and the client roots the island's id scope
 * there, so its `useId` values match the same subtree rendered in place.
 */
export const ID_PATH_PROP = "__dnxIdPath";
