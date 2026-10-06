// Dev server: each target's platform files (`BigButton.web.tsx`, or `.ios.tsx` for a shell that
// named its target) on the native App Router path, where neither `deno bundle` nor Deno's loader
// can probe: the same file-URL redirects the production build uses (see
// ../platform-extensions.ts), rescanned once per generation.

import { join } from "@std/path";
import { setModuleGraphRedirects } from "../module-graph.ts";
import { type PlatformImportMap, platformImportMap } from "../platform-imports.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import { devPlatformOf, type Platform, projectPlatformRedirects } from "../platform-extensions.ts";
import { currentContext } from "../../server/request-context.ts";
import type { DevState } from "./state.ts";

/**
 * The current generation's platform redirects for `platform` (empty for a next-compat app,
 * whose esbuild bundles probe them): what the server render's loader resolves through.
 *
 * @param st The dev state.
 * @param platform The target.
 */
export async function devPlatformRedirects(
  st: DevState,
  platform: Platform = "web",
): Promise<Record<string, string>> {
  const cached = st.platformRedirects.get(platform);
  if (cached?.gen === st.generation) return cached.redirects;
  // `isCompat` (./compat.ts) reads the same memo; importing it would close a module cycle.
  const redirects = await (st.compatP ??= detectNextCompat(st.paths))
    ? {}
    : await projectPlatformRedirects(st.paths.projectDir, st.paths.config, platform);
  st.platformRedirects.set(platform, { gen: st.generation, redirects });
  return redirects;
}

/**
 * The current generation's client import map for `platform`: its redirects plus rewritten
 * copies of the app modules that reach a variant through an import-map alias (see
 * ../platform-imports.ts), for its `deno bundle` passes and graph crawls. The web target's are
 * also installed for the boundary / hydration crawls of every request.
 *
 * @param st The dev state.
 * @param platform The target.
 */
export async function devPlatformImports(
  st: DevState,
  platform: Platform = "web",
): Promise<PlatformImportMap> {
  const cached = st.platformImports.get(platform);
  if (cached?.gen === st.generation) return cached.imports;
  const root = join(st.paths.outDir, "platform-imports");
  const imports = await platformImportMap(
    st.paths.projectDir,
    await devPlatformRedirects(st, platform),
    join(root, `dev-${st.generation}-${platform}`),
  );
  if (cached) {
    await Deno.remove(join(root, `dev-${cached.gen}-${platform}`), { recursive: true })
      .catch(() => {});
  }
  st.platformImports.set(platform, { gen: st.generation, imports });
  if (platform === "web") setModuleGraphRedirects(st.paths.configPath, imports);
  return imports;
}

/**
 * The target of the request being rendered (the page's `?__denext_platform=` / cookie, or the
 * desktop proxy's header), `web` outside a request.
 */
export function renderPlatform(): Platform {
  const request = currentContext()?.request;
  return request ? devPlatformOf(request) : "web";
}
