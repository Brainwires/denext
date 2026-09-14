// The static export's output dir: where it may live, and the staging swap that replaces it.
//
// Every export (App Router and SPA) writes into a sibling `<out>.staging/` and swaps it into
// place only once complete. A failed export leaves the previous `out/` intact, and a
// successful one leaves exactly the current build's files — no content-hashed chunk, `.gz`
// sibling or deleted route from an earlier build lingers. Because the swap replaces the
// target wholesale, the target is validated first: it must be a dedicated directory strictly
// inside the project that neither holds nor sits inside the project's own sources, config,
// build output or dependencies.

import { ensureDir } from "@std/fs";
import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import type { ProjectPaths } from "../paths.ts";

/** True when absolute `child` is `parent` or lies beneath it. */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) && !isAbsolute(rel));
}

/** Project paths an export target must not be, contain, or sit inside (absolute). */
function protectedPaths(paths: ProjectPaths, root: string): string[] {
  const spa = paths.config?.mode === "spa" ? paths.config.spa : undefined;
  return [
    paths.appDir,
    paths.publicDir,
    paths.outDir, // `.denext/` build output
    join(root, "node_modules"),
    join(root, ".git"),
    ...(spa?.entry ? [resolve(root, spa.entry)] : []),
  ].map((p) => resolve(p));
}

/** Why `target` may not be replaced by an export, or null when it may. */
function unsafeReason(target: string, paths: ProjectPaths): string | null {
  const root = resolve(paths.projectDir);
  if (target === root) return "that is the project root";
  if (!isWithin(target, root)) return "that is outside the project";
  const hit = protectedPaths(paths, root).find((p) => isWithin(p, target) || isWithin(target, p));
  return hit ? `it overlaps the project's ${relative(root, hit) || "."}` : null;
}

/**
 * Resolve the export's output directory (`outDir`, relative to the project, default `out`)
 * and refuse one the staging swap must not replace: the project root, a directory outside
 * the project, or one that is, contains or sits inside `app/`, `public/`, `.denext/`,
 * `node_modules/`, `.git/` or the SPA entry.
 *
 * @param paths The resolved project.
 * @param outDir The output dir relative to the project root.
 * @returns The output dir path (`<projectDir>/<outDir>`).
 * @throws When the directory is not safe to replace wholesale.
 */
export function resolveExportOutDir(paths: ProjectPaths, outDir = "out"): string {
  const finalOutDir = join(paths.projectDir, outDir);
  const reason = unsafeReason(resolve(finalOutDir), paths);
  if (reason) {
    throw new Error(
      `denext export: refusing to write the export to ${finalOutDir} — ${reason}. The export ` +
        `replaces its output directory wholesale, so point it at a dedicated directory inside ` +
        `the project (the default is "out").`,
    );
  }
  return finalOutDir;
}

/**
 * Create an empty `<finalOutDir>.staging/` next to the target, clearing any leftover from an
 * interrupted run.
 *
 * @param finalOutDir The directory the staging dir will replace.
 * @returns The staging dir path.
 */
export async function freshStagingDir(finalOutDir: string): Promise<string> {
  const staging = `${finalOutDir}.staging`;
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  await ensureDir(staging);
  return staging;
}

/**
 * Swap a finished staging dir into place: the previous output (if any) is renamed aside,
 * the staging dir takes its name, and the old one is removed.
 *
 * @param stagingDir The complete new output.
 * @param finalOutDir The directory it replaces.
 */
export async function swapStagingDir(stagingDir: string, finalOutDir: string): Promise<void> {
  const previous = `${finalOutDir}.prev`;
  await Deno.remove(previous, { recursive: true }).catch(() => {});
  const had = await Deno.rename(finalOutDir, previous).then(() => true, () => false);
  await Deno.rename(stagingDir, finalOutDir);
  if (had) await Deno.remove(previous, { recursive: true }).catch(() => {});
}

/**
 * Write an output directory through a staging dir: `write` fills a fresh staging dir, which
 * is then swapped into `finalOutDir`. A throw removes the half-written staging dir and leaves
 * the previous output untouched.
 *
 * @param finalOutDir The directory to (re)place.
 * @param write Fills the staging dir it is given.
 */
export async function writeViaStaging(
  finalOutDir: string,
  write: (stagingDir: string) => Promise<void>,
): Promise<void> {
  const staging = await freshStagingDir(finalOutDir);
  try {
    await write(staging);
  } catch (err) {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw err;
  }
  await swapStagingDir(staging, finalOutDir);
}
