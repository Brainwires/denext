// SPA mode: the production build (`.denext/client/`) and the static export (`out/`).

import { copy, ensureDir, walk } from "@std/fs";
import { dirname, join, relative } from "@std/path";
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
  collectSpaPreloads,
  ENTRY_FILE,
  SHELL_FILE,
  spaClientPrefix,
  spaEntryPath,
  spaShellHtml,
  STYLE_FILE,
} from "./shared.ts";
import { renderSpaShell } from "./shell.ts";
import { writeMobileExportExtras } from "../mobile-export-extras.ts";
import { writeDesktopPreload } from "../desktop-preload.ts";
import { setupPlugins } from "../pipeline-shared.ts";
import {
  EMITTED_DIR,
  listBuiltFiles,
  type PluginPrepareContext,
  runPluginBuildSteps,
  runPluginPrepareSteps,
} from "../../plugin/mod.ts";
import { collectViteManifest, type ViteManifest, writeViteManifest } from "./vite-manifest.ts";

/**
 * Set up the config's plugins and run their prepare steps (codegen the app imports), before
 * the bundle — the same seams an App Router build runs. A SPA without plugins pays nothing.
 */
async function preparePlugins(paths: ProjectPaths, mode: "build" | "export"): Promise<void> {
  if ((paths.config?.plugins ?? []).length === 0) return;
  await setupPlugins(paths, mode);
  await runPluginPrepareSteps(pluginContext(paths));
}

/** The plugin step context of this SPA project. */
function pluginContext(paths: ProjectPaths): PluginPrepareContext {
  return {
    projectRoot: paths.projectDir,
    appDir: paths.appDir,
    outDir: paths.outDir,
    config: paths.config ?? {},
  };
}

/**
 * Bundle the entry into `clientDir` and write the shell into `shellDir`.
 *
 * @returns The modules the client bundle contains, when the build collected them.
 */
async function bundleAndShell(
  paths: ProjectPaths,
  entryPath: string,
  clientDir: string,
  shellDir: string,
  platform: Platform = "web",
): Promise<readonly string[] | undefined> {
  const [{ hasStyles, modules }, shell] = await Promise.all([
    bundleSpaInto(paths, entryPath, clientDir, prodMinify(), false, platform),
    // `spa.shell`: the prerendered static shell for this target, in place of `spa.loading`.
    renderSpaShell(paths, platform, prodMinify()),
  ]);
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
  const prefix = spaClientPrefix(paths.config!.spa);
  const preload = (await collectSpaPreloads(clientDir, ENTRY_FILE, prefix))
    .map((name) => `${prefix}${name}`);
  const html = await spaShellHtml({
    spa: paths.config!.spa!,
    scriptSrc: `${prefix}${ENTRY_FILE}`,
    styleHref: hasStyles ? `${prefix}${STYLE_FILE}` : undefined,
    preload,
    reactNativeRootStyle: reactNativeRootStyle(paths.config),
    shell,
  });
  await Deno.writeTextFile(join(shellDir, SHELL_FILE), html);
  return modules;
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
    await preparePlugins(paths, "build");
    console.log(`  SPA mode: bundling ${spa.entry} -> client/${ENTRY_FILE}`);
    const clientModules = await bundleAndShell(paths, entryPath, staging, staging);
    await Deno.remove(finalClientDir, { recursive: true }).catch(() => {});
    await Deno.rename(staging, finalClientDir);
    // Plugin build steps; what they publish with `emitFile` lands in `<outDir>/emitted/`,
    // which `denext start` serves ahead of `public/`.
    await Deno.remove(join(paths.outDir, EMITTED_DIR), { recursive: true }).catch(() => {});
    await runPluginBuildSteps(pluginContext(paths), { clientModules });
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

/**
 * Copy the public directory's contents into the output directory. The client directory
 * (`clientRel`, e.g. `assets/` under `spa.assetsDir`) may hold public files too, merged in file by
 * file: one at a path the build wrote stays the build's, as `denext start` and `denext dev` serve
 * it. Everywhere else a public file is copied over.
 */
async function copyPublic(publicDir: string, outDir: string, clientRel: string): Promise<void> {
  try {
    await Deno.stat(publicDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return; // no public/ directory — nothing to copy
    throw err;
  }
  const clientTop = clientRel.split("/").filter(Boolean)[0];
  // A real per-file copy failure must NOT be swallowed — otherwise `export` would
  // silently ship missing public assets. Only the "no public/ dir" case is benign.
  for await (const entry of Deno.readDir(publicDir)) {
    const from = join(publicDir, entry.name);
    if (entry.name !== clientTop || !entry.isDirectory) {
      await copy(from, join(outDir, entry.name), { overwrite: true });
      continue;
    }
    for await (const file of walk(from, { includeDirs: false })) {
      const dest = join(outDir, entry.name, relative(from, file.path));
      if (await fileExists(dest)) continue; // the build's file wins
      await ensureDir(dirname(dest));
      await copy(file.path, dest);
    }
  }
}

/**
 * Static export for SPA mode: `out/index.html` + `out/_denext/client/*` (`out/<spa.assetsDir>/*`
 * when set) + public/. Written through the same staging swap as the App Router export, so `out/`
 * holds exactly this build (content-hashed chunks from earlier builds never pile up) and a failed
 * export leaves the previous one intact.
 */
export async function exportSpa(
  paths: ProjectPaths,
  options: { outDir?: string; platform?: Platform } = {},
): Promise<{ outDir: string; pages: number; skipped: string[] }> {
  const platform = options.platform ?? "web";
  const { spa, entryPath } = spaEntryPath(paths);
  await assertEntryExists(entryPath);
  const outDir = await resolveExportOutDir(paths, options.outDir);
  await preparePlugins(paths, "export");
  // `spa.assetsDir` (Vite's `build.assetsDir`) moves the client from `_denext/client/`.
  const clientRel = spaClientPrefix(spa).slice(1);
  await writeViaStaging(outDir, async (staging) => {
    const clientOut = join(staging, ...clientRel.split("/").filter(Boolean));
    await ensureDir(clientOut);
    console.log(
      `  SPA mode: bundling ${spa.entry} -> ${clientRel}${ENTRY_FILE}` +
        (platform === "web" ? "" : ` (platform: ${platform})`),
    );
    const clientModules = await bundleAndShell(paths, entryPath, clientOut, staging, platform);
    // `spa.viteManifest` lists the build's own hashed files, taken before `public/` is copied in:
    // a `public/assets/x-ABCD1234.png` merges into the same directory and must never be listed.
    const viteManifest: ViteManifest | null = spa.viteManifest === true
      ? await collectViteManifest(staging, spaClientPrefix(spa))
      : null;
    // What the build wrote (the shell, the client): no build step may replace it.
    const builtFiles = await listBuiltFiles(staging);
    await copyPublic(paths.publicDir, staging, clientRel);
    // Plugin build steps, after `public/`: a file published with `emitFile` lands at the
    // export's root (replacing a same-named public file, as a Vite-emitted asset does).
    await runPluginBuildSteps(pluginContext(paths), {
      emitDir: staging,
      clientModules,
      builtFiles,
    });
    await writeMobileExportExtras(paths.projectDir, paths.config, staging);
    // `desktop.preload`: one classic script the desktop runtime inlines first into every page.
    await writeDesktopPreload(paths, staging, platform);
    // A platform export names its target, before the OTA manifest hashes the tree.
    if (platform !== "web") await writePlatformStamp(staging, platform);
    // `--sourcemaps hidden`: the maps leave the web root before anything hashes it.
    await stashSourceMapsIfHidden(staging, paths.outDir);
    // `spa.viteManifest`: `.vite/manifest.json` listing the content-hashed client files, for a
    // server that reads Vite's manifest to serve them as immutable.
    if (viteManifest) {
      const count = await writeViteManifest(staging, viteManifest);
      console.log(
        `  Vite manifest: .vite/manifest.json (${count} hashed file${count === 1 ? "" : "s"})`,
      );
    }
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
