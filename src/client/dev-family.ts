/**
 * Fast Refresh families for FRAMEWORK components (dev-only seam).
 *
 * On the bundled dev paths a refresh re-imports the rebuilt entry, and a framework module that
 * only the app's code reaches (`VirtualList`, say) is bundled into the app's chunk — so the
 * refresh evaluates it again and its components are new function references. The app's own
 * components are registered as families (the refresh footer), but a framework component is
 * not, so the reconciler would see a different type and remount its subtree: a list back at
 * its top, its rows' state gone. A framework module wraps its components in {@linkcode devFamily}
 * at evaluation, under an id stable across bundles, so the fresh copy reconciles
 * onto the live fiber like any edited component.
 *
 * It goes through `globalThis` because the registrar (`refresh-runtime.ts`) is dev-only and
 * never imported by production code: `enableFastRefresh()` installs it and drains the
 * registrations made before it ran. Off the dev browser this is a no-op.
 *
 * @module
 */

/** A family registration: the component and its stable id. */
type Registration = readonly [type: unknown, id: string];

/** The globals of the seam. */
interface FamilyGlobals {
  __denextDev?: boolean;
  /** The installed registrar (`registerFamily`), dev only. */
  __denextRegisterFamily?: (type: unknown, id: string) => void;
  /** Registrations made before the registrar was installed. */
  __denextPendingFamilies?: Registration[];
  document?: unknown;
}

/**
 * Register a framework component as a Fast Refresh family under `id` (e.g.
 * `"denext:virtual-list#VirtualList"`) and return it unchanged. A no-op in production and on
 * the server. Call it as `/* @__PURE__ *\/ devFamily(function X() {…}, id)` so a bundle that
 * never uses the component still drops it (a bare top-level call would keep the module).
 */
export function devFamily<F>(type: F, id: string): F {
  const g = globalThis as FamilyGlobals;
  if (g.__denextRegisterFamily) g.__denextRegisterFamily(type, id);
  else if (g.__denextDev === true && g.document !== undefined) {
    (g.__denextPendingFamilies ??= []).push([type, id]);
  }
  return type;
}

/** Install the registrar (dev: `enableFastRefresh`) and register what was queued before it. */
export function installDevFamilies(register: (type: unknown, id: string) => void): void {
  const g = globalThis as FamilyGlobals;
  g.__denextRegisterFamily = register;
  const pending = g.__denextPendingFamilies;
  g.__denextPendingFamilies = undefined;
  for (const [type, id] of pending ?? []) register(type, id);
}
