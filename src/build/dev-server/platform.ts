// Dev server: each target's platform files (`BigButton.web.tsx`, or `.ios.tsx` for a shell that
// named its target) on the native App Router path, where neither `deno bundle` nor Deno's loader
// can probe: the same file-URL redirects the production build uses (see
// ../platform-extensions.ts), from one project scan the dev server keeps until a file is
// created, removed or renamed (../platform-watch.ts).

import { join } from "@std/path";
import { setModuleGraphRedirects } from "../module-graph.ts";
import {
  type PlatformImportMap,
  platformImportMap,
  stylesheetImportMap,
} from "../platform-imports.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import { devPlatformOf, keepPlatformScanner, type Platform } from "../platform-extensions.ts";
import { watchProjectStructure } from "../platform-watch.ts";
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
  // `isCompat` (./compat.ts) reads the same memo; importing it would close a module cycle.
  if (await (st.compatP ??= detectNextCompat(st.paths))) return {};
  return await st.platformScanner.redirects(st.paths.config, platform);
}

/**
 * Start watching which project files exist (../platform-watch.ts): a created, removed or
 * renamed platform file (or the plain file of a module that has them) forgets the scan and
 * calls `onChange`, so the next request resolves the new set. The same project-wide watch
 * reports every changed path (content edits included, the skipped folders left out) to `onEdit`.
 *
 * @param st The dev state.
 * @param onChange Called after the scan was forgotten.
 * @param onEdit Called with each burst of changed paths.
 */
export function watchPlatformFiles(
  st: DevState,
  onChange: () => void,
  onEdit?: (paths: string[]) => void,
): void {
  // Every other caller for this project (the alias-import pass) shares the session's scan.
  keepPlatformScanner(st.platformScanner, st.options.signal);
  watchProjectStructure(
    st.paths.projectDir,
    (paths) => {
      if (st.platformScanner.invalidate(paths)) onChange();
    },
    st.options.signal,
    onEdit,
  );
}

/** Import maps per target, each for the generation it was computed in. */
type GenerationImports = Map<Platform, { gen: number; imports: PlatformImportMap }>;

/**
 * `cache`'s import map for `platform` when it is the current generation's, else `make`'s, written
 * into `<prefix>-<generation>-<platform>` under the session's platform-imports dir (the previous
 * generation's dir is removed).
 */
async function generationImports(
  st: DevState,
  cache: GenerationImports,
  platform: Platform,
  prefix: string,
  make: (copyDir: string) => Promise<PlatformImportMap>,
): Promise<PlatformImportMap> {
  const cached = cache.get(platform);
  if (cached?.gen === st.generation) return cached.imports;
  const root = join(st.paths.outDir, "platform-imports");
  const imports = await make(join(root, `${prefix}-${st.generation}-${platform}`));
  if (cached) {
    await Deno.remove(join(root, `${prefix}-${cached.gen}-${platform}`), { recursive: true })
      .catch(() => {});
  }
  cache.set(platform, { gen: st.generation, imports });
  return imports;
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
export function devPlatformImports(
  st: DevState,
  platform: Platform = "web",
): Promise<PlatformImportMap> {
  return generationImports(st, st.platformImports, platform, "dev", async (copyDir) => {
    const imports = await platformImportMap(
      st.paths.projectDir,
      await devPlatformRedirects(st, platform),
      copyDir,
    );
    if (platform === "web") setModuleGraphRedirects(st.paths.configPath, imports);
    return imports;
  });
}

/**
 * The import map `platform`'s route stylesheets are crawled through: {@linkcode devPlatformImports}
 * on the native path; for a next-compat app (whose esbuild bundles probe the platform files, so
 * it has no redirects there) the target's redirects all the same, so a stylesheet only
 * `Badge.ios.tsx` imports is the iOS session's.
 *
 * @param st The dev state.
 * @param platform The target.
 */
export async function devStylesheetImports(
  st: DevState,
  platform: Platform,
): Promise<PlatformImportMap> {
  if (!(await (st.compatP ??= detectNextCompat(st.paths)))) {
    return await devPlatformImports(st, platform);
  }
  return await generationImports(
    st,
    st.stylesheetImports,
    platform,
    "css-dev",
    (copyDir) => stylesheetImportMap(st.paths.projectDir, st.paths.config, platform, copyDir),
  );
}

/**
 * The target of the request being rendered (the page's `?__denext_platform=` / cookie, or the
 * desktop proxy's header), `web` outside a request.
 */
export function renderPlatform(): Platform {
  const request = currentContext()?.request;
  return request ? devPlatformOf(request) : "web";
}
