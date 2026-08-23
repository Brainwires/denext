// The lazy-island foreign wrapper — shared by every dual HTML+Flight renderer
// (buffered `render-to-html-flight`, streamed `render-to-flight-stream`, and
// PPR `render-to-ppr-flight`) so the three never drift in how they carve an
// island. A `client:*` island's server DOM is nested in a layout-neutral
// `<div data-dnx-island style="display:contents">` the page root adopts but does
// not own (a foreign host); the client roots a per-island `hydrateRoot`
// (or `createRoot`, for `client:only`) on that wrapper when the strategy fires.

import { escapeHtml } from "./render-to-string.ts";
import type { FlightNode, FlightProps } from "./render-to-flight.ts";
import {
  FOREIGN_PROP,
  type HydrationStrategy,
  ISLAND_ID_ATTR,
  ISLAND_MARKER_ATTR,
  ISLAND_PARAM_ATTR,
  ISLAND_STRATEGY_ATTR,
  ISLAND_TAG,
} from "../runtime/lazy-directive.ts";

/** An island wrapper's dual output: server HTML + the page-Flight foreign host. */
export interface IslandWrapperDual {
  /** The `<div data-dnx-island …>` wrapper around the island's server HTML. */
  html: string;
  /** The matching foreign-host node in the page Flight (children owned per-island). */
  flight: FlightNode;
}

/**
 * Emit a lazy island's foreign wrapper (`<div data-dnx-island …>`) around its
 * server HTML (`bodyHtml` is empty for `client:only`, which skips SSR), plus the
 * matching foreign-host node for the page Flight. `prefix`/`strategy` are
 * framework-derived, but escaped anyway so the emission never relies on that
 * invariant to stay injection-safe.
 *
 * @param prefix The island's tree-path id (`data-dnx-id`).
 * @param strategy The resolved hydration strategy (`data-dnx-strategy`).
 * @param param Strategy parameter — the media query for a `media` island.
 * @param bodyHtml The island's server HTML (empty string for `client:only`).
 */
export function islandWrapper(
  prefix: string,
  strategy: HydrationStrategy,
  param: string | undefined,
  bodyHtml: string,
): IslandWrapperDual {
  const hasParam = strategy === "media" && param != null;
  const paramAttr = hasParam ? ` ${ISLAND_PARAM_ATTR}="${escapeHtml(param!)}"` : "";
  const p: FlightProps = {
    [FOREIGN_PROP]: true,
    [ISLAND_MARKER_ATTR]: true,
    [ISLAND_ID_ATTR]: prefix,
    [ISLAND_STRATEGY_ATTR]: strategy,
    style: "display:contents",
  };
  if (hasParam) p[ISLAND_PARAM_ATTR] = param!;
  return {
    html: `<${ISLAND_TAG} ${ISLAND_MARKER_ATTR} ${ISLAND_ID_ATTR}="${escapeHtml(prefix)}" ` +
      `${ISLAND_STRATEGY_ATTR}="${escapeHtml(strategy)}"${paramAttr} style="display:contents">` +
      `${bodyHtml}</${ISLAND_TAG}>`,
    flight: { $: "h", t: ISLAND_TAG, p, c: [] },
  };
}
