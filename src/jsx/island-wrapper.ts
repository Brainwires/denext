// The lazy-island foreign wrapper — shared by every dual HTML+Flight renderer
// (buffered `render-to-html-flight`, streamed `render-to-flight-stream`, and
// PPR `render-to-ppr-flight`) so the three never drift in how they carve an
// island. A `client:*` island's server DOM is nested in a layout-neutral
// `<div data-dnx-island style="display:contents">` the page root adopts but does
// not own (a foreign host); the client roots a per-island `hydrateRoot`
// (or `createRoot`, for `client:only`) on that wrapper when the strategy fires.

import { escapeHtml } from "./render-to-string.ts";
import type { FlightNode, FlightProps } from "./render-to-flight.ts";
import type { VNodeChildren } from "./types.ts";
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

/** Intrinsic tags whose presence in a `client:only` child tree signals lost SEO content. */
const SEO_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "article", "section"]);

/** Distinct `client:only` islands already warned about this process (dev only). */
const warnedClientOnly = new Set<string>();

/** Whether a child tree contains an SEO-significant tag or a run of real text (bounded depth). */
function hasSeoContent(children: unknown, depth: number): boolean {
  if (depth > 6 || children == null || children === false || children === true) return false;
  if (Array.isArray(children)) {
    return children.some((c) => hasSeoContent(c, depth));
  }
  if (typeof children === "string") return children.trim().length >= 40;
  if (typeof children !== "object") return false; // number, etc.
  const node = children as { type?: unknown; props?: { children?: unknown } };
  if (typeof node.type === "string" && SEO_TAGS.has(node.type)) return true;
  return hasSeoContent(node.props?.children, depth + 1);
}

/**
 * Dev-only warning: a `client:only` island renders no server HTML, so any
 * SEO-relevant content it carries as children (a heading, a paragraph, or a
 * substantial run of text) is invisible to crawlers and absent from first paint.
 * A best-effort heuristic over the passed-in children — content the island
 * renders internally can't be seen without running it. De-duplicated per island.
 *
 * @param children The island's JSX children.
 * @param islandId The island's tree-path id (for the message + dedup key).
 */
export function warnClientOnlySeoContent(children: VNodeChildren, islandId: string): void {
  if ((globalThis as { __denextDev?: boolean }).__denextDev !== true) return;
  if (!hasSeoContent(children, 0)) return;
  if (warnedClientOnly.has(islandId)) return;
  // Bound the set so per-request-varying ids can't leak; it may then re-warn.
  if (warnedClientOnly.size >= 256) warnedClientOnly.clear();
  warnedClientOnly.add(islandId);
  console.warn(
    `denext: a client:only island (${islandId}) has SEO-relevant content (a heading ` +
      `or paragraph) in its children, which is not server-rendered — crawlers won't ` +
      `see it and it won't appear on first paint. Use client:idle / client:visible / ` +
      `client:interaction to keep the server HTML. (dev-only warning)`,
  );
}
