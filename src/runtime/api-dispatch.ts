// The in-process dispatch seam for the typed API client — client-safe, ~no bytes.
//
// During SSR, a Server Component calling its own API through `createApiClient` should not go
// over loopback HTTP: the server installs a dispatcher here (`src/server/api-dispatcher.ts`)
// that runs the call as a sub-request through the full pipeline, with the current request's
// cookies and abort signal, and through the tag-aware fetch cache. The client runtime only
// knows this seam: in a browser bundle no dispatcher is ever installed and `apiRequest`
// falls straight through to `fetch`. Mirrors `setFlightParser` / `setRequestAdapter`.

import type { HttpMethod } from "../server/types.ts";

/** What the typed client hands the dispatcher for one call. */
export interface ApiDispatchInit {
  /** The HTTP method. */
  method: HttpMethod;
  /** The request headers the caller asked for (content-type / codec flag included). */
  headers: Headers;
  /** The encoded JSON body, when any. */
  body?: string;
  /** The caller's abort signal (composed with its timeout). */
  signal: AbortSignal;
  /** Next-style fetch cache mode (`"force-cache"` / `"no-store"`). */
  cache?: RequestCache;
  /** Next-style cache options: a revalidate window and/or tags. */
  next?: { revalidate?: number | false; tags?: string[] };
}

/**
 * Runs one typed API call in-process, or returns `null` to fall back to `fetch` (no ambient
 * request, a foreign origin, a reserved path).
 */
export type ApiDispatcher = (url: string, init: ApiDispatchInit) => Promise<Response> | null;

let dispatcher: ApiDispatcher | null = null;

/**
 * Install (or clear) the in-process dispatcher. The server calls this once at boot.
 *
 * @param fn The dispatcher, or `null` to remove it.
 */
export function setApiDispatcher(fn: ApiDispatcher | null): void {
  dispatcher = fn;
}

/**
 * The installed dispatcher, if any (always `null` in a browser bundle).
 *
 * @returns The dispatcher or `null`.
 */
export function getApiDispatcher(): ApiDispatcher | null {
  return dispatcher;
}
