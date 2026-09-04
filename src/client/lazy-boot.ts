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
  const islands = islandsIn ? islandsByid(islandsIn) : readIslandsIsland();
  if (!islands) return;
  // Idempotent across re-runs (e.g. a dev HMR refresh re-imports the entry): drop any
  // still-pending registrations from a prior run, and never re-hydrate an island that is
  // already live — re-hydrating a live island would re-adopt now-stale server state (a
  // signal whose value has since advanced) and warn as a mismatch.
  resetLazyIslands();
  // A flat query finds every island wrapper, including one NESTED inside another island's
  // wrapper: each hydrates independently on its own strategy. An enclosing island adopts a
  // nested wrapper as a foreign host (adopt-not-own) rather than hydrating it, and
  // HYDRATED_ATTR guards against a second root — so a nested wrapper is always hydrated by
  // exactly one root (its own), in either firing order.
  const reg = registry as ClientRegistry;
  document.querySelectorAll(`[${ISLAND_MARKER_ATTR}]`).forEach((wrapper) => {
    if (!wrapper.hasAttribute(HYDRATED_ATTR)) scheduleIsland(wrapper, islands, reg, eager);
  });
}

function islandsByid(islands: IslandPayload[]): Record<string, FlightNode> {
  const out: Record<string, FlightNode> = {};
  for (const isl of islands) out[isl.id] = isl.flight;
  return out;
}

/** The `#__denext_islands` JSON island, or null when absent/malformed. */
function readIslandsIsland(): Record<string, FlightNode> | null {
  const mapEl = document.getElementById("__denext_islands");
  if (!mapEl) return null;
  try {
    return JSON.parse(mapEl.textContent || "null");
  } catch {
    return null;
  }
}

/**
 * Mount or hydrate one island from its own Flight. `client:only` never SSRs, so there is no
 * server DOM to adopt — it mounts fresh with createRoot (same as the soft-nav path), never
 * hydrateRoot. Marks the wrapper first, so a re-run skips it.
 */
function hydrateIsland(
  wrapper: Element,
  flight: FlightNode,
  reg: ClientRegistry,
  mount: boolean,
): void {
  wrapper.setAttribute(HYDRATED_ATTR, "");
  try {
    const tree = parseFlight(flight, reg) as never;
    if (mount) createRoot(wrapper).render(tree);
    else hydrateRoot(wrapper, tree);
  } catch (err) {
    console.warn("denext: island hydration failed:", (err as Error)?.message);
  }
}

/** An island wrapper's strategy + Flight, or null when it isn't a hydratable island. */
function islandOf(
  wrapper: Element,
  islands: Record<string, FlightNode>,
): { strategy: string; param: string | undefined; flight: FlightNode } | null {
  const strategy = wrapper.getAttribute("data-dnx-strategy");
  const flight = islands[wrapper.getAttribute("data-dnx-id") ?? ""];
  if (!strategy || flight == null) return null;
  return { strategy, param: attr(wrapper, "data-dnx-strategy-param"), flight };
}

/** An attribute's value, or undefined when absent. */
function attr(el: Element, name: string): string | undefined {
  return el.getAttribute(name) ?? undefined;
}

/**
 * Hydrate one island wrapper now (soft nav renders island content immediately) or when its
 * `client:*` strategy fires.
 */
function scheduleIsland(
  wrapper: Element,
  islands: Record<string, FlightNode>,
  reg: ClientRegistry,
  eager: boolean,
): void {
  const island = islandOf(wrapper, islands);
  if (!island) return;
  const mountFresh = eager || island.strategy === "only";
  const hydrate = () => hydrateIsland(wrapper, island.flight, reg, mountFresh);
  if (eager) return hydrate();
  registerLazyIsland({
    container: wrapper,
    strategy: island.strategy as HydrationStrategy,
    param: island.param,
    hydrate,
  });
}
