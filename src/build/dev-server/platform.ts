// Dev server: the web target's platform files (`BigButton.web.tsx`) on the native App Router
// path, where neither `deno bundle` nor Deno's loader can probe: the same file-URL redirects
// the production build uses (see ../platform-extensions.ts), rescanned once per generation.

import { setModuleGraphRedirects } from "../module-graph.ts";
import { projectPlatformRedirects } from "../platform-extensions.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import type { DevState } from "./state.ts";

/**
 * The current generation's platform redirects (empty for a next-compat app, whose esbuild
 * bundles probe them), also installed for the boundary / hydration graph crawls.
 *
 * @param st The dev state.
 */
export async function devPlatformRedirects(st: DevState): Promise<Record<string, string>> {
  if (st.platformGen === st.generation) return st.platformRedirects;
  // `isCompat` (./compat.ts) reads the same memo; importing it would close a module cycle.
  st.platformRedirects = await (st.compatP ??= detectNextCompat(st.paths))
    ? {}
    : await projectPlatformRedirects(st.paths.projectDir, st.paths.config, "web");
  st.platformGen = st.generation;
  setModuleGraphRedirects(st.paths.configPath, st.platformRedirects);
  return st.platformRedirects;
}
