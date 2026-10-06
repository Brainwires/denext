// Dev server: each target's platform files (`BigButton.web.tsx`, or `.ios.tsx` for a shell that
// named its target) on the native App Router path, where neither `deno bundle` nor Deno's loader
// can probe: the same file-URL redirects the production build uses (see
// ../platform-extensions.ts), rescanned once per generation.

import { setModuleGraphRedirects } from "../module-graph.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import { devPlatformOf, type Platform, projectPlatformRedirects } from "../platform-extensions.ts";
import { currentContext } from "../../server/request-context.ts";
import type { DevState } from "./state.ts";

/**
 * The current generation's platform redirects for `platform` (empty for a next-compat app,
 * whose esbuild bundles probe them). The web target's are also installed for the boundary /
 * hydration graph crawls, which stay `web` in dev.
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
  if (platform === "web") setModuleGraphRedirects(st.paths.configPath, redirects);
  return redirects;
}

/**
 * The target of the request being rendered (the page's `?__denext_platform=` / cookie, or the
 * desktop proxy's header), `web` outside a request.
 */
export function renderPlatform(): Platform {
  const request = currentContext()?.request;
  return request ? devPlatformOf(request) : "web";
}
