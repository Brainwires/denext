// Emit the generated type modules for an app: `<outDir>/routes.ts` (typed navigation) and
// `<outDir>/api.ts` (the typed API client's `ApiSchema`). Both `denext build` and the
// `denext dev` route-tree rescan call this, so the two lifecycles share one implementation.
//
// Best-effort by design: a failed write must never break a build or the dev loop — the app
// still runs; only the editor types go briefly stale until the next successful emit. Best
// effort is not silence, though: a failure is reported once per target so a read-only
// `.denext/` or a full disk shows up instead of leaving stale types with no signal.

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
  const routesFile = join(opts.outDir, "routes.ts");
  await Deno.writeTextFile(routesFile, generateRouteTypes(manifest))
    .catch((err) => reportOnce(routesFile, err));
  // Typed API client: calls to this app's own route handlers are type-checked end-to-end
  // (`createApiClient()`). A pure function of the manifest: the generated module imports each
  // route's TYPE and TypeScript infers the endpoint shapes (no `deno doc`, no subprocess).
  const apiFile = join(opts.outDir, "api.ts");
  await generateApiTypes(manifest, opts)
    .then((src) => Deno.writeTextFile(apiFile, src))
    .catch((err) => reportOnce(apiFile, err));
}

/** Targets already reported, so a persistent failure logs once, not once per rescan. */
const reported = new Set<string>();

function reportOnce(file: string, err: unknown): void {
  if (reported.has(file)) return;
  reported.add(file);
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`denext: could not write ${file} — ${detail} (editor types may be stale)`);
}
