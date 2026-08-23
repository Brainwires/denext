// The client:* island bootstrap, kept OFF the shared runtime chunk.
//
// The generated Flight entry dynamically imports this (via the `denext/lazy`
// subpath) only when a page actually carries a `#__denext_islands` payload, so
// apps with no lazy islands bundle none of the deferred-hydration runtime — the
// same "tiny by default" discipline the `denext/live` subpath follows.

import { createRoot, hydrateRoot } from "./reconciler.ts";
import { type ClientRegistry, parseFlight } from "./flight-client.ts";
import { registerLazyIsland, resetLazyIslands } from "./lazy-hydrate.ts";
import { installQrlDispatch } from "./qrl-dispatch.ts";
import { setResumabilityReboot } from "./navigation.ts";
import { adoptSignalState } from "../runtime/signal-state.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import type { IslandPayload } from "../jsx/render-to-html-flight.ts";
import { type HydrationStrategy, ISLAND_MARKER_ATTR } from "../runtime/lazy-directive.ts";

/** Attribute marking an island wrapper whose hydration has already run. */
const HYDRATED_ATTR = "data-dnx-hydrated";

/**
 * Boot the deferred half of resumability: install delegated qrl dispatch (so
 * serialized `data-dnx-h` handlers run without hydration), then register every
 * island wrapper for deferred per-island hydration. The generated Flight entry
 * dynamically imports and calls this only when a page carries lazy islands or
 * resumable handlers, so non-resumable apps bundle none of it.
 *
 * @param registry The app's client-reference registry (`id → component`).
 * @param eager Soft-navigation re-boot. On the initial load islands are *deferred*
 *   (server HTML adopted, hydration runs per strategy). After a soft nav the retained
 *   root reconciled each island wrapper **empty** (it is a foreign host in the route
 *   Flight), so there is no server DOM to adopt and no benefit to deferring — each
 *   island is mounted immediately from its own Flight, rendering its content and
 *   wiring it up.
 * @param islandsIn Soft-nav islands (from the Flight-nav payload). When given, used
 *   directly instead of re-reading `#__denext_islands` from the DOM.
 * @param signalStateIn Soft-nav signal state, adopted (sanitized) before mounting.
 */
export function bootResumability(
  registry: Map<string, unknown>,
  eager = false,
  islandsIn?: IslandPayload[],
  signalStateIn?: Record<string, unknown>,
): void {
  // Register the soft-nav re-boot hook once (navigation.ts calls it after a Flight
  // nav renders the new route). Re-registering with the same registry is harmless.
  setResumabilityReboot((islands, signalState) =>
    bootResumability(registry, true, islands, signalState)
  );
  installQrlDispatch();
  if (eager) adoptSignalState(signalStateIn ?? null); // initial load adopted in the entry
  const reg = registry as ClientRegistry;
  let islands: Record<string, FlightNode> | null;
  if (islandsIn) {
    islands = {};
    for (const isl of islandsIn) islands[isl.id] = isl.flight;
  } else {
    const mapEl = document.getElementById("__denext_islands");
    if (!mapEl) return;
    try {
      islands = JSON.parse(mapEl.textContent || "null");
    } catch {
      return;
    }
  }
  if (!islands) return;
  // Idempotent across re-runs (e.g. a dev HMR refresh re-imports the entry): drop
  // any still-pending registrations from a prior run, and never re-hydrate an island
  // that is already live — re-hydrating a live island would re-adopt now-stale
  // server state (a signal whose value has since advanced) and warn as a mismatch.
  resetLazyIslands();
  const wrappers = document.querySelectorAll(`[${ISLAND_MARKER_ATTR}]`);
  wrappers.forEach((wrapper) => {
    if (wrapper.hasAttribute(HYDRATED_ATTR)) return; // already hydrated
    const id = wrapper.getAttribute("data-dnx-id");
    const strategy = wrapper.getAttribute("data-dnx-strategy");
    const param = wrapper.getAttribute("data-dnx-strategy-param") ?? undefined;
    const islandFlight = id != null ? islands![id] : undefined;
    if (!strategy || islandFlight == null) return;
    // `client:only` never SSRs, so there is no server DOM to adopt — mount fresh
    // with createRoot (same as the soft-nav path), never hydrateRoot.
    const clientOnly = strategy === "only";
    const run = () => {
      wrapper.setAttribute(HYDRATED_ATTR, ""); // mark before, so a re-run skips it
      try {
        const tree = parseFlight(islandFlight, reg) as never;
        if (eager || clientOnly) createRoot(wrapper).render(tree);
        else hydrateRoot(wrapper, tree);
      } catch (err) {
        console.warn("denext: island hydration failed:", (err as Error)?.message);
      }
    };
    if (eager) run(); // soft nav renders island content immediately
    else {registerLazyIsland({
        container: wrapper,
        strategy: strategy as HydrationStrategy,
        param,
        hydrate: run,
      });}
  });
}
