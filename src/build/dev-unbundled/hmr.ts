// Unbundled dev: HMR change computation over the reverse import graph.

import { bump, FS_PREFIX, norm, type UnbundledState, versionOf } from "./state.ts";

/**
 * Find the accept boundaries an edit to `abs` propagates to: `abs` itself if it
 * self-accepts, else its importers (transitively) up to the nearest self-accepting
 * modules. Returns null when propagation reaches a module the client graph never
 * imported (nothing to re-import → full reload).
 */
export function propagate(
  st: UnbundledState,
  abs: string,
  seen: Set<string>,
): Set<string> | null {
  if (seen.has(abs)) return new Set();
  seen.add(abs);
  // Never seen in the client graph (a server-only module, or edited before load) → reload.
  if (!st.known.has(abs) && !st.importers.has(abs)) return null;
  // A component module self-accepts: its edit swaps in place via family substitution.
  if (st.accepting.has(abs)) return new Set([abs]);
  const ups = st.importers.get(abs);
  if (!ups || ups.size === 0) return null; // dead end, no accepting boundary
  const out = new Set<string>();
  for (const up of ups) {
    if (up.startsWith("entry:")) return null; // reached the route entry → reload
    const r = propagate(st, up, seen);
    if (r === null) return null;
    for (const b of r) out.add(b);
  }
  return out;
}

/** The HMR decision for a batch of edits (see {@linkcode onChange}). */
export interface HmrChange {
  /** Accept-boundary module dev URLs to re-import in place. */
  updates: string[];
  /** A changed module propagates to the route entry (structural) → full page reload. */
  reload: boolean;
  /** NONE of the changed modules is in the unbundled client graph → caller falls back. */
  unknownOnly: boolean;
}

/**
 * Compute the HMR action for a batch of changed first-party paths. `unknownOnly` is set
 * when none of the changed modules is in the unbundled client graph (a flight-route
 * island, a bundled/MDX route's module, or a server-only file): the caller falls back to
 * the bundled whole-entry Fast Refresh, which those routes still honor — so a default-on
 * unbundled loop never downgrades an island edit to a full reload.
 */
export function onChange(st: UnbundledState, changedRaw: string[]): HmrChange {
  const boundaries = new Set<string>();
  let anyKnown = false;
  let structuralReload = false;
  for (const abs of changedRaw.map(norm)) {
    bump(st, abs);
    st.cache.delete(abs); // force re-transform on next serve
    if (!st.known.has(abs) && !st.importers.has(abs)) continue; // not ours — caller falls back
    anyKnown = true;
    const found = propagate(st, abs, new Set());
    if (found === null) {
      structuralReload = true;
      continue;
    }
    for (const b of found) boundaries.add(b);
  }
  const epoch = Date.now();
  const updates = [...boundaries].map((abs) =>
    `${FS_PREFIX}${abs}?t=${epoch}&v=${versionOf(st, abs)}`
  );
  return { updates, reload: structuralReload, unknownOnly: !anyKnown };
}
