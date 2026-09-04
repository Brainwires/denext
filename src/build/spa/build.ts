// SPA mode: the production build (`.denext/client/`) and the static export (`out/`).

import { copy, ensureDir } from "@std/fs";
import { join } from "@std/path";
import { prepareDesktopIcon } from "../desktop-icon.ts";
import type { ProjectPaths } from "../paths.ts";
import { bundleSpaInto } from "./bundle.ts";
import {
  assertEntryExists,
  CLIENT_PREFIX,
  ENTRY_FILE,
  SHELL_FILE,
  spaEntryPath,
  spaShellHtml,
  STYLE_FILE,
} from "./shared.ts";

/** Bundle the entry into `clientDir` and write the shell into `shellDir`. */
async function bundleAndShell(
  paths: ProjectPaths,
  entryPath: string,
  clientDir: string,
  shellDir: string,
): Promise<void> {
  const { hasStyles } = await bundleSpaInto(paths, entryPath, clientDir, true);
  const html = await spaShellHtml({
    spa: paths.config!.spa!,
    scriptSrc: `${CLIENT_PREFIX}${ENTRY_FILE}`,
    styleHref: hasStyles ? `${CLIENT_PREFIX}${STYLE_FILE}` : undefined,
  });
  await Deno.writeTextFile(join(shellDir, SHELL_FILE), html);
}

/**
 * Production build for SPA mode: bundle the entry into `.denext/client/` and write
 * the HTML shell. Mirrors the App Router build's staging + atomic-swap so a failed
 * build never destroys the previous working output.
 */
export async function buildSpa(paths: ProjectPaths): Promise<{ outDir: string }> {
  const { spa, entryPath } = spaEntryPath(paths);
  await assertEntryExists(entryPath);
  const finalClientDir = join(paths.outDir, "client");
  const staging = join(paths.outDir, ".client.staging");
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  await ensureDir(staging);
  try {
    console.log(`  SPA mode: bundling ${spa.entry} -> client/${ENTRY_FILE}`);
    await bundleAndShell(paths, entryPath, staging, staging);
    await Deno.remove(finalClientDir, { recursive: true }).catch(() => {});
    await Deno.rename(staging, finalClientDir);
  } catch (err) {
    // A failed build must not leave a half-written staging dir behind (the atomic swap
    // above never ran, so the previous working output is still intact).
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw err;
  }
  console.log(`\n  Built SPA into ${paths.outDir}`);
  return { outDir: paths.outDir };
}

/** True if `path` is an existing file. */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** Copy the public directory's contents into the output directory. */
async function copyPublic(publicDir: string, outDir: string): Promise<void> {
  try {
    await Deno.stat(publicDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return; // no public/ directory — nothing to copy
    throw err;
  }
  // A real per-file copy failure must NOT be swallowed — otherwise `export` would
  // silently ship missing public assets. Only the "no public/ dir" case is benign.
  for await (const entry of Deno.readDir(publicDir)) {
    await copy(join(publicDir, entry.name), join(outDir, entry.name), { overwrite: true });
  }
}

/** Static export for SPA mode: `out/index.html` + `out/_denext/client/*` + public/. */
export async function exportSpa(
  paths: ProjectPaths,
  options: { outDir?: string } = {},
): Promise<{ outDir: string; pages: number; skipped: string[] }> {
  const { spa, entryPath } = spaEntryPath(paths);
  await assertEntryExists(entryPath);
  const outDir = join(paths.projectDir, options.outDir ?? "out");
  const clientOut = join(outDir, "_denext", "client");
  await ensureDir(clientOut);
  console.log(`  SPA mode: bundling ${spa.entry} -> _denext/client/${ENTRY_FILE}`);
  await bundleAndShell(paths, entryPath, clientOut, outDir);
  await copyPublic(paths.publicDir, outDir);
  // Prepare the desktop app icon when this is a desktop app (a `desktop.ts` entry, or an
  // explicit `spa.desktop.icon`). Config-driven and done here — in `export`, which the
  // `deno task desktop` chain runs right before `deno desktop` — so editing
  // `spa.desktop.icon` and rebuilding changes the icon with no re-migration.
  if (spa.desktop?.icon || await fileExists(join(paths.projectDir, "desktop.ts"))) {
    await prepareDesktopIcon(paths.projectDir, spa);
  }
  return { outDir, pages: 1, skipped: [] };
}
