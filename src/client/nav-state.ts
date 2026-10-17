// The soft-navigation state navigation.ts shares with the modules it hands a navigation to: the
// retained page root, the per-navigation module stamp and the hooks the resumability runtime
// installs. A leaf module, so the on-demand soft-nav commit (nav-document.ts), which
// navigation.ts imports dynamically, reaches it without an import cycle.

import type { IslandPayload } from "../jsx/render-to-html-flight.ts";
import type { Root } from "./reconciler.ts";

let navCounter = 0;

/** The next per-navigation `?nav=` stamp that makes a re-injected module URL evaluate again. */
export function nextNavStamp(): string {
  return String(navCounter++);
}

/** Options controlling a soft (client-side) navigation. */
export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Scroll to the top after navigating (defaults to true). */
  scroll?: boolean;
  /** Internal: set when responding to popstate (don't push history). */
  history?: boolean;
}

/**
 * Before an isomorphic navigation re-runs a route entry, give a root-less islands page a fresh
 * root to render into (its islands are unmounted first). Installed by flight-nav.ts's
 * `setRootlessMount` once the resumability runtime registers its mount, so it is null in an app
 * with no Flight route, which can never render a root-less page.
 */
export let rootlessPrepare: (() => void) | null = null;

/** Install the root-less page hook (called by flight-nav.ts's `setRootlessMount`). */
export function setRootlessPrepare(fn: () => void): void {
  rootlessPrepare = fn;
}

/**
 * Retain `root` as the page root (flight-nav.ts: a root-less page's first navigation), or forget
 * it (`null`, nav-document.ts's `discardRetainedRoot`).
 */
export function retainRoot(root: Root | null): void {
  retainedRoot = globalWin.__dnxRoot = root;
}

/**
 * The resumability re-boot hook, registered by the resumability runtime
 * (`bootResumability`) on first load so a Flight soft nav can re-wire the new
 * route's islands/handlers. Kept as an injected callback so `navigation.ts` (shared
 * chunk) never statically imports the resumability runtime — an app without islands
 * bundles none of it. See {@link setResumabilityReboot}.
 */
export let resumabilityReboot:
  | ((islands?: IslandPayload[], signalState?: Record<string, unknown>) => void)
  | null = null;

/** Register the resumability re-boot hook (called by the resumability runtime). */
export function setResumabilityReboot(
  fn: (islands?: IslandPayload[], signalState?: Record<string, unknown>) => void,
): void {
  resumabilityReboot = fn;
}

/**
 * The retained reconciler root for the hydration container. Kept across soft
 * navigations so a nav reconciles the new route in place (`root.render`) instead
 * of re-mounting — preserving state, skipping a re-hydrate, and (crucially) avoiding
 * hydrating the NEW tree against the PREVIOUS page's stale DOM.
 *
 * `startClient` reads/writes the root through `globalWin.__dnxRoot` (below), not
 * this module-local, because a soft nav re-runs the route bundle and in dev that
 * bundle carries its OWN copy of this module (it is not code-split to share the
 * runtime chunk a production build has). A module-local would reset to `null` on
 * every soft nav, so `startClient` would fall into the `hydrateRoot` branch —
 * adopting the outgoing page's DOM as the incoming tree and flooding the console
 * with hydration mismatches. The global bridges those separate module instances.
 * The other readers here (`navigateSameOrigin`, flight-nav.ts's commit) always run in the
 * persistent initial module, so they keep using this cheap local mirror.
 */
export let retainedRoot: Root | null = null;

/**
 * The document-global slot the retained root lives on; see {@link retainedRoot}.
 * denext is single-root per document (one `#__denext` container), so one slot is
 * correct. Embedding two independent denext apps on one page is unsupported — the
 * second `startClient` would reconcile its tree into the first app's container.
 */
export const globalWin = globalThis as { __dnxRoot?: Root | null; __dnxRootless?: boolean };
