// Fast Refresh runtime (dev-only).
//
// The one thing that stops a re-imported module from preserving state is type
// identity: `sameType` (vnode-utils) is reference equality, so an edit — which
// re-imports the module and produces NEW function references — makes every
// component look like a different type, forcing a remount that discards
// `fiber.hooks`. This module gives each component a stable **family** identity
// (module URL + export name) so the new reference reconciles onto the existing
// fiber and its hook state survives.
//
// It is dev-only and DCE-friendly: production bundles never import it, so the
// reconciler's family hook (`setFamilyMatch`) is never installed and `sameType`
// stays pure reference equality. Any uncertainty at refresh time (a thrown
// render, a hook-order change) is handled by the caller falling back to a full
// page reload — this module never risks corrupt state.

import { setFamilyMatch, setSignatureChangeHandler } from "./vnode-utils.ts";

/** A component family: every function ref that is the "same component" across edits. */
interface Family {
  /** The most recently registered implementation (the post-edit function). */
  current: unknown;
}

// A component type → its family, and a stable family id → family. The WeakMap
// lets stale function refs be GC'd once no fiber references them.
const familiesByType = new WeakMap<object, Family>();
const familiesById = new Map<string, Family>();

/** Registrable component types are functions or the memo/forwardRef wrapper objects. */
function isRegistrable(type: unknown): type is object {
  return typeof type === "function" || (typeof type === "object" && type !== null);
}

/**
 * Register a component `type` under a stable family `id` (e.g. `moduleUrl#Export`).
 * Re-registering the same id with a new function ref binds that ref to the same
 * family and marks it current — the mechanism that lets an edited module's fresh
 * references reconcile onto existing fibers.
 */
export function registerFamily(type: unknown, id: string): void {
  if (!isRegistrable(type)) return;
  let fam = familiesById.get(id);
  if (!fam) {
    fam = { current: type };
    familiesById.set(id, fam);
  } else {
    fam.current = type;
  }
  familiesByType.set(type, fam);
}

/** The family for a component type, if it was registered. */
function familyOf(type: unknown): Family | undefined {
  return isRegistrable(type) ? familiesByType.get(type) : undefined;
}

/**
 * Whether two component types belong to the same family (so they reconcile in
 * place across a refresh). Two different components have different families, and
 * two uses of one component share a function ref (caught by `sameType`'s cheap
 * reference check before this is consulted) — so this only ever adds the
 * pre-edit-ref vs post-edit-ref match that Fast Refresh needs.
 */
export function sameFamily(a: unknown, b: unknown): boolean {
  const fa = familyOf(a);
  return fa !== undefined && fa === familyOf(b);
}

let installed = false;

/**
 * Install the family-identity check and hook-signature guard into the reconciler.
 * Idempotent; called once by the dev route entry before its first render. A no-op
 * in production (this module is never imported there).
 *
 * The signature guard fires during a refresh render when an edited component's
 * hook count changed — reusing its hook cells would be unsafe — so it falls back
 * to a full page reload (the correct, if blunt, recovery for a hooks-shape edit).
 */
export function enableFastRefresh(): void {
  if (installed) return;
  installed = true;
  setFamilyMatch(sameFamily);
  setSignatureChangeHandler(() => {
    if (typeof location !== "undefined") location.reload();
  });
}
