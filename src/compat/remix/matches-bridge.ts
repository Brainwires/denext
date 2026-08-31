// Isomorphic seam for `useMatches`/`useRouteLoaderData` (no `"use client"`/server directive).
//
// The streaming Flight renderer renders a client boundary's children twice: once for
// first-paint HTML (the ancestor `RemixRouteProvider`'s `MatchesContext` is in scope) and
// once to serialize the boundary's `children` into the Flight payload, where the nested
// route's server wrappers are re-expanded in the OUTER scope — so the parent provider's
// client context is missing and a `useMatches` there sees only the current route. A read
// of an ancestor route's loader data (e.g. `useUser` → root loader) then throws and
// crashes SSR.
//
// The fix is a RENDER-SCOPED matches store the SERVER wrappers populate as they render
// (request-isolated, so it persists across both passes within one request — the outer
// layout registered in the HTML pass is still present when the child re-renders for the
// Flight pass). This module is the seam: the server side registers a resolver here (from
// `matches-server.ts`, which alone touches request context / `node:async_hooks`), and the
// `"use client"` hook reads through here. On the client the resolver is never set, so the
// hook falls back to React context — correct there, since the client hydrates one tree.

import type { RemixMatch } from "./client.ts";

/** Reads the current server render's matches, or null when unavailable (always on the client). */
type MatchesResolver = () => RemixMatch[] | null;

// The resolver lives on `globalThis`, not a module `let`: the client boundary and the
// server wrappers can be split into SEPARATE bundles (e.g. next-compat SSR), each with its
// own copy of this module, so a module-scoped resolver set by one wouldn't be visible to
// the other. A process-global seam is shared across every copy. It holds only the resolver
// function (set once, server-side); the actual matches stay request-isolated behind it (a
// WeakMap keyed by request context in `matches-server.ts`). On the client the server module
// is never bundled, so the global stays unset and {@link serverRenderMatches} returns null.
interface MatchesGlobal {
  __denextRemixMatchesResolver?: MatchesResolver | null;
}
const store = globalThis as unknown as MatchesGlobal;

/**
 * Wire the server-side render-scoped matches resolver. Called once at import time by the
 * server-only `matches-server.ts`; never on the client (that module isn't in the client
 * bundle), so {@link serverRenderMatches} stays null there.
 */
export function setServerMatchesResolver(fn: MatchesResolver): void {
  store.__denextRemixMatchesResolver = fn;
}

/**
 * The current server render's full matches chain (outermost first), or null on the client
 * or before any wrapper has registered. `useMatches` prefers this over React context when
 * it is at least as complete, so an ancestor read resolves in the Flight-serialization
 * pass where context is missing.
 */
export function serverRenderMatches(): RemixMatch[] | null {
  const resolver = store.__denextRemixMatchesResolver;
  return resolver ? resolver() : null;
}
