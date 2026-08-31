// Server-only render-scoped matches store (the only piece that touches request context).
//
// The generated `page.tsx`/`layout.tsx` wrappers call {@link registerServerMatch} through
// `RemixRoute`/`RemixLayout` as each route renders (outer→inner). Entries are keyed by the
// current request's context object (a WeakMap), so they are request-isolated — no leak
// across concurrent SSR renders — and persist across the streaming renderer's two passes,
// which is what lets a nested route see its ancestors' matches even in the Flight pass
// where React context is missing. On the client this module is never imported (it lives on
// the `denext/remix/server` side), so `matches-bridge`'s resolver stays null and the hook
// uses React context. See {@link file://./matches-bridge.ts}.

import { currentContext } from "../../server/request-context.ts";
import type { RemixMatch } from "./client.ts";
import { setServerMatchesResolver } from "./matches-bridge.ts";

/** Per-request ordered matches (id → match), keyed by the request context object. */
const perRequest = new WeakMap<object, Map<string, RemixMatch>>();

function matchesFor(ctx: object): Map<string, RemixMatch> {
  let m = perRequest.get(ctx);
  if (!m) {
    m = new Map();
    perRequest.set(ctx, m);
  }
  return m;
}

/**
 * Record a route's match for the current request as it renders (server wrappers call this).
 * Re-registering the same id (the Flight pass re-renders a child) overwrites in place and
 * keeps insertion order, so the chain stays outermost-first.
 */
export function registerServerMatch(match: RemixMatch): void {
  const ctx = currentContext();
  if (ctx) matchesFor(ctx).set(match.id, match);
}

// Wire the isomorphic bridge so the `"use client"` `useMatches` hook can read the current
// request's matches during server render (returns null off-request / on the client).
setServerMatchesResolver(() => {
  const ctx = currentContext();
  if (!ctx) return null;
  const m = perRequest.get(ctx);
  return m ? [...m.values()] : null;
});
