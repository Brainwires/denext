// The CachedPage fields a durable cache store keeps in one JSON column instead of columns of
// their own — the PPR/Flight extras a shell carries (holeIds, flightShell, …). Shared by the
// SQLite and Postgres stores, so a cached PPR shell round-trips intact through either; dropping
// them would serve a shell verbatim (no hole splicing).

import type { CachedPage } from "./cache.ts";

const PPR_FIELDS = [
  "holeIds",
  "routeCsp",
  "headExtras",
  "inTreeTitle",
  "documentAttrs",
  "flightShell",
  "flightIslands",
  "flightSignalState",
] as const;

/**
 * The page's PPR/Flight extras as JSON, or `null` when it has none.
 *
 * @param page The cached page.
 * @returns The JSON for the extras column.
 */
export function encodePprExtras(page: CachedPage): string | null {
  const extras: Record<string, unknown> = {};
  for (const f of PPR_FIELDS) {
    const v = (page as unknown as Record<string, unknown>)[f];
    if (v !== undefined) extras[f] = v;
  }
  return Object.keys(extras).length ? JSON.stringify(extras) : null;
}
