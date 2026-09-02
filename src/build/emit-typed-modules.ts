// Emit the generated type modules for an app: `<outDir>/routes.ts` (typed navigation) and
// `<outDir>/api.ts` (the typed API client's `ApiSchema`). Both `denext build` and the
// `denext dev` route-tree rescan call this, so the two lifecycles share one implementation.
//
// Best-effort by design: a failed write (or a `deno doc` hiccup while reading handler
// signatures) must never break a build or the dev loop — the app still runs; only the
// editor types go briefly stale until the next successful emit.

import { join } from "@std/path";
import type { RouteManifest } from "../router/manifest.ts";
import { generateRouteTypes } from "./route-types.ts";
import { generateApiTypes } from "./api-types.ts";

/**
 * Write the typed-routes and typed-API-client modules for a scanned manifest.
 *
 * @param manifest The scanned route manifest.
 * @param opts `outDir` (where the modules live; imports are made relative to it) and the
 *   `configPath` for `deno doc`'s import-map resolution when reading handler signatures.
 */
export async function emitTypedModules(
  manifest: RouteManifest,
  opts: { outDir: string; configPath: string },
): Promise<void> {
  // Typed routes: navigation is type-checked against the routes that actually exist
  // (import { Routes, ParamsOf } from "./.denext/routes.ts").
  await Deno.writeTextFile(join(opts.outDir, "routes.ts"), generateRouteTypes(manifest))
    .catch(() => {});
  // Typed API client: calls to this app's own route handlers are type-checked end-to-end
  // (createApiClient<ApiSchema>()). Reads each handler's TypedRequest/TypedResponse via
  // `deno doc`. (Follow-up: re-`deno doc` only the route files that actually changed.)
  await generateApiTypes(manifest, opts)
    .then((src) => Deno.writeTextFile(join(opts.outDir, "api.ts"), src))
    .catch(() => {});
}
