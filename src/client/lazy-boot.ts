// The client:* island bootstrap, kept OFF the shared runtime chunk.
//
// The generated Flight entry dynamically imports this (via the `denext/lazy`
// subpath) only when a page actually carries a `#__denext_islands` payload, so
// apps with no lazy islands bundle none of the deferred-hydration runtime — the
// same "tiny by default" discipline the `denext/live` subpath follows.

import { hydrateRoot } from "./reconciler.ts";
import { type ClientRegistry, parseFlight } from "./flight-client.ts";
import { registerLazyIsland } from "./lazy-hydrate.ts";
import { installQrlDispatch } from "./qrl-dispatch.ts";
import type { FlightNode } from "../jsx/render-to-flight.ts";
import { type HydrationStrategy, ISLAND_TAG } from "../runtime/lazy-directive.ts";

/**
 * Boot the deferred half of resumability: install delegated qrl dispatch (so
 * serialized `data-dnx-h` handlers run without hydration), then register every
 * `<dnx-island>` for deferred per-island hydration. The generated Flight entry
 * dynamically imports and calls this only when a page carries lazy islands or
 * resumable handlers, so non-resumable apps bundle none of it.
 *
 * @param registry The app's client-reference registry (`id → component`).
 */
export function bootResumability(registry: Map<string, unknown>): void {
  installQrlDispatch();
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
