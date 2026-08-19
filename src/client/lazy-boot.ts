// The client:* island bootstrap, kept OFF the shared runtime chunk.
//
// The generated Flight entry dynamically imports this (via the `denext/lazy`
// subpath) only when a page actually carries a `#__denext_islands` payload, so
// apps with no lazy islands bundle none of the deferred-hydration runtime — the
// same "tiny by default" discipline the `denext/live` subpath follows.

import { hydrateRoot } from "./reconciler.ts";
import { type ClientRegistry, parseFlight } from "./flight-client.ts";
import { installDelegatedDispatch, registerLazyIsland } from "./lazy-hydrate.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import { type HydrationStrategy, ISLAND_TAG } from "../runtime/lazy-directive.ts";

/**
 * Register every `<dnx-island>` on the page for deferred hydration. The page root
 * has already adopted each wrapper as a foreign subtree (its server DOM intact);
 * here each island hydrates on its own strategy via a per-island `hydrateRoot`.
 *
 * @param registry The app's client-reference registry (`id → component`), passed
 *   in by the generated Flight entry.
 */
export function hydrateLazyIslands(registry: Map<string, unknown>): void {
  const reg = registry as ClientRegistry;
  const mapEl = document.getElementById("__denext_islands");
  if (!mapEl) return;
  let islands: Record<string, FlightNode> | null;
  try {
    islands = JSON.parse(mapEl.textContent || "null");
  } catch {
    return;
  }
  if (!islands) return;
  installDelegatedDispatch();
  const wrappers = document.querySelectorAll(`${ISLAND_TAG}[data-dnx-id]`);
  wrappers.forEach((wrapper) => {
    const id = wrapper.getAttribute("data-dnx-id");
    const strategy = wrapper.getAttribute("data-dnx-strategy");
    const islandFlight = id != null ? islands![id] : undefined;
    if (!strategy || islandFlight == null) return;
    registerLazyIsland({
      container: wrapper,
      strategy: strategy as HydrationStrategy,
      hydrate: () => {
        try {
          hydrateRoot(wrapper, parseFlight(islandFlight, reg) as never);
        } catch (err) {
          console.warn("denext: island hydration failed:", (err as Error)?.message);
        }
      },
    });
  });
}
