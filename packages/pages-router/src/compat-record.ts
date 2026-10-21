// The compat (npm React) server bundles a build makes for the Pages Router, recorded so a
// production server loads them instead of building them at startup: `denext start` skips that
// work, and a compiled app (`denext build --compile`) could not do it (it has no bundler, and its
// embedded `.denext` is read-only).

import { join, relative } from "@std/path";

/** Where a build writes the compat server bundles, under the build directory. */
export const COMPAT_DIR = "pages-compat";
/** The record of them: project-relative source → build-dir-relative bundle ref. */
export const COMPAT_RECORD = "modules.json";

/** Whether this process is a compiled app (`denext build --compile`; the framework's global slot). */
export function compiledApp(): boolean {
  return (globalThis as Record<symbol, unknown>)[Symbol.for("denext.standalone")] !== undefined;
}

/**
 * The compat server bundles the build recorded for `modules`, as the loader's module map, or
 * `null` when there is no record or it misses one of them (a stale or older build).
 */
export async function recordedCompatModules(
  projectRoot: string,
  outDir: string,
  modules: readonly string[],
): Promise<Map<string, string> | null> {
  let record: Record<string, string>;
  try {
    record = JSON.parse(await Deno.readTextFile(join(outDir, COMPAT_DIR, COMPAT_RECORD)));
  } catch {
    return null;
  }
  const map = new Map<string, string>();
  for (const [src, ref] of Object.entries(record)) {
    map.set(join(projectRoot, src), join(outDir, ref));
  }
  return modules.every((m) => map.has(m)) ? map : null;
}

/** Record a build's compat server bundles, relative, for `denext start` and a compiled app. */
export async function recordCompatModules(
  projectRoot: string,
  outDir: string,
  moduleMap: ReadonlyMap<string, string>,
): Promise<void> {
  const slash = (p: string) => p.replaceAll("\\", "/");
  const record = Object.fromEntries(
    [...moduleMap].map((
      [src, ref],
    ) => [slash(relative(projectRoot, src)), slash(relative(outDir, ref))]),
  );
  await Deno.writeTextFile(
    join(outDir, COMPAT_DIR, COMPAT_RECORD),
    JSON.stringify(record, null, 2),
  );
}
