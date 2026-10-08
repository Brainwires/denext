// SPA mode: the production build (`.denext/client/`) and the static export (`out/`).

import { copy, ensureDir } from "@std/fs";
import { join } from "@std/path";
import { syncDesktopAppConfigAt } from "../desktop-app-config.ts";
import { prepareDesktopIcon } from "../desktop-icon.ts";
import { resolveExportOutDir, writeViaStaging } from "../export-pipeline/out-dir.ts";
import type { ProjectPaths } from "../paths.ts";
import type { Platform } from "../platform-extensions.ts";
import { type DenextConfig, reactNativeRootStyle } from "../../server/config.ts";
import { bundleSpaInto } from "./bundle.ts";
import { prodMinify } from "../minify.ts";
import { precompressDir } from "../precompress.ts";
import { writeOtaManifest, writePlatformStamp } from "../ota-manifest.ts";
import { loadOtaSigningKey } from "../ota-signing.ts";
import { stashSourceMapsIfHidden } from "../hidden-sourcemaps.ts";
import {
  assertEntryExists,
  CLIENT_PREFIX,
  collectSpaPreloads,
  ENTRY_FILE,
  SHELL_FILE,
  spaEntryPath,
  spaShellHtml,
  STYLE_FILE,
} from "./shared.ts";
import { writeMobileExportExtras } from "../mobile-export-extras.ts";
import { writeDesktopPreload } from "../desktop-preload.ts";

/** Bundle the entry into `clientDir` and write the shell into `shellDir`. */
async function bundleAndShell(
  paths: ProjectPaths,
  entryPath: string,
  clientDir: string,
  shellDir: string,
  platform: Platform = "web",
): Promise<void> {
  const { hasStyles } = await bundleSpaInto(
    paths,
    entryPath,
    clientDir,
    prodMinify(),
    false,
    platform,
  );
  // Precompress the client chunks (gzip `.gz` siblings) exactly like the App Router build's
  // finalize step, so the prod server serves them with zero per-request CPU — and so
  // `denext analyze` can report over-the-wire (gzip) sizes for a SPA bundle. `spa.precompress:
  // false` skips it for an export bundled into a native shell that never serves them.
  if (paths.config!.spa!.precompress !== false) {
    const gzCount = await precompressDir(clientDir);
    if (gzCount > 0) console.log(`  precompressed ${gzCount} client asset(s) -> .gz`);
  }
  // Preload the entry's static chunk graph so the browser fetches the runtime in parallel
  // with the entry (Vite parity) rather than discovering it after downloading + parsing.
  const preload = (await collectSpaPreloads(clientDir, ENTRY_FILE))
    .map((name) => `${CLIENT_PREFIX}${name}`);
  const html = await spaShellHtml({
    spa: paths.config!.spa!,
    scriptSrc: `${CLIENT_PREFIX}${ENTRY_FILE}`,
    styleHref: hasStyles ? `${CLIENT_PREFIX}${STYLE_FILE}` : undefined,
    preload,
    reactNativeRootStyle: reactNativeRootStyle(paths.config),
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

/**
 * Static export for SPA mode: `out/index.html` + `out/_denext/client/*` + public/. Written
 * through the same staging swap as the App Router export, so `out/` holds exactly this build
 * (content-hashed chunks from earlier builds never pile up) and a failed export leaves the
 * previous one intact.
 */
export async function exportSpa(
  paths: ProjectPaths,
  options: { outDir?: string; platform?: Platform } = {},
): Promise<{ outDir: string; pages: number; skipped: string[] }> {
  const platform = options.platform ?? "web";
  const { spa, entryPath } = spaEntryPath(paths);
  await assertEntryExists(entryPath);
  const outDir = await resolveExportOutDir(paths, options.outDir);
  await writeViaStaging(outDir, async (staging) => {
    const clientOut = join(staging, "_denext", "client");
    await ensureDir(clientOut);
    console.log(
      `  SPA mode: bundling ${spa.entry} -> _denext/client/${ENTRY_FILE}` +
        (platform === "web" ? "" : ` (platform: ${platform})`),
    );
    await bundleAndShell(paths, entryPath, clientOut, staging, platform);
    await copyPublic(paths.publicDir, staging);
    await writeMobileExportExtras(paths.projectDir, paths.config, staging);
    // `desktop.preload`: one classic script the desktop runtime inlines first into every page.
    await writeDesktopPreload(paths, staging);
    // A platform export names its target, before the OTA manifest hashes the tree.
    if (platform !== "web") await writePlatformStamp(staging, platform);
    // `--sourcemaps hidden`: the maps leave the web root before anything hashes it.
    await stashSourceMapsIfHidden(staging, paths.outDir);
    // Last, once every file of the export is in place: the OTA manifest hashes the final
    // tree (`*.gz` siblings excluded), so nothing may be written after it.
    // With DENEXT_OTA_SIGNING_KEY set (a CI secret), the manifest is signed too, and stamped
    // with a `sequence` (the Unix time) so installed apps refuse an older signed release.
    if (spa.ota === true) {
      const { version, files, signature, sequence } = await writeOtaManifest(
        staging,
        {},
        await loadOtaSigningKey(),
      );
      console.log(
        `  OTA manifest: _denext/ota.json (version ${version.slice(0, 12)}…, ${files.length} files${
          signature ? `, signed, sequence ${sequence}` : ""
        })`,
      );
    }
  });
  await prepareDesktopExport(paths.projectDir, paths.config);
  return { outDir, pages: 1, skipped: [] };
}

/**
 * What the migrated `deno task desktop` (`export && deno desktop … desktop.ts`) needs from
 * `export` when this is a desktop app (a `desktop.ts` entry, or an explicit `spa.desktop.icon`):
 * the app icon, and `desktop.app` (name, identifier, origin, deep links) brought into deno.json /
 * `.deno-desktop/app.json`, which is where a bare `deno desktop` reads them. Config-driven and
 * done here, right before `deno desktop`, so editing either and rebuilding takes effect with no
 * re-migration.
 *
 * @param projectDir The app's project root.
 * @param config The resolved project config.
 */
export async function prepareDesktopExport(
  projectDir: string,
  config: DenextConfig | null,
): Promise<void> {
  const spa = config?.spa;
  const hasEntry = await fileExists(join(projectDir, "desktop.ts"));
  if (spa?.desktop?.icon || hasEntry) await prepareDesktopIcon(projectDir, spa);
  if (hasEntry) await syncDesktopAppConfigAt(projectDir, config);
}
