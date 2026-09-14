/**
 * The auth endpoint dispatcher — the one request handler the `denextAuth` plugin
 * registers. It does three things and nothing else: strip the configured `basePath`,
 * find the row in the {@link ./route-table.ts | route table}, and call it. Everything
 * substantive lives in the route modules (`routes-session`, `routes-oauth`,
 * `routes-credentials`) and their shared helpers (`routes-shared`).
 *
 * A path this table doesn't claim returns `null`, so denext falls through to the rest of
 * the app — an unknown `/auth/*` URL is a normal 404, not an auth error.
 *
 * @module
 */

import { resolveAuthOptions } from "./options.ts";
import { matchAuthRoute } from "./route-table.ts";
import type { AuthRouteContext } from "./routes-shared.ts";
import type { AuthConfig } from "./types.ts";

/**
 * Handle an auth request.
 *
 * @param request The incoming request.
 * @param config The app's auth config.
 * @returns A `Response` for a claimed endpoint, or `null` to let denext fall through
 * (any non-auth path, or an unknown path under the auth base path).
 */
export async function handleAuthRequest(
  request: Request,
  config: AuthConfig,
): Promise<Response | null> {
  const options = resolveAuthOptions(config);
  const url = new URL(request.url);
  if (!url.pathname.startsWith(options.prefix)) return null;
  const method = request.method.toUpperCase();
  const match = matchAuthRoute(method, url.pathname.slice(options.basePath.length));
  if (!match) return null;
  const ctx: AuthRouteContext = {
    request,
    config,
    options,
    url,
    method,
    params: match.params,
  };
  return await match.route.handler(ctx);
}
