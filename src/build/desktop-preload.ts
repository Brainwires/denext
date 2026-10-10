// `desktop.preload`: Electron-preload parity for Deno Desktop. The configured module is bundled
// into ONE classic script (`deno bundle --format=iife`: no imports left, dynamic imports inlined)
// at `out/_denext/desktop-preload.js`, and the desktop runtime (`runDesktop`) inlines it as the
// FIRST script of every top-level document it serves over the memory transport, right after the
// `__denext` global and before any page script, with its own CSP hash.
//
// TRUST: the preload is the app's own code. It runs in the page's world (a webview has no
// isolated world, unlike an Electron preload under contextIsolation), with exactly the page's
// privileges, so it is no sandbox. Its job is to run EARLY: expose bridges (`window.desktopBridge`,
// Clerk's `__clerk_internal_electron`) before the page's own scripts read them.

import { dirname, fromFileUrl, join } from "@std/path";
import { bundleFailureMessage, denoExecutable, minDepAgeArgs } from "./bundle.ts";
import type { ProjectPaths } from "./paths.ts";
import type { Platform } from "./platform-extensions.ts";
import { DESKTOP_PRELOAD_FILE } from "../desktop/preload.ts";

export { DESKTOP_PRELOAD_ENV } from "../desktop/preload.ts";

/** Inputs of {@linkcode bundleDesktopPreload}. */
export interface DesktopPreloadBundle {
  /** The project root (`desktop.preload` resolves against it). */
  readonly projectDir: string;
  /** `desktop.preload` as configured (`"./desktop/preload.ts"`). */
  readonly preload: string;
  /** The project's deno.json (a path or a `file:` URL), for the import map. */
  readonly configPath?: string;
  /** The bundle to write. */
  readonly outFile: string;
  /** Minify (the export does; the dev build does not). */
  readonly minify: boolean;
  /** The setting named in errors. Default `desktop.preload` (`spa.shell.bootScript` reuses it). */
  readonly label?: string;
}

/** `configPath` as a filesystem path, when it is one (a remote framework config is skipped). */
function localConfigPath(configPath: string | undefined): string | undefined {
  if (configPath === undefined) return undefined;
  if (configPath.startsWith("file:")) return fromFileUrl(configPath);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(configPath) ? undefined : configPath;
}

/**
 * The `deno bundle` argv for the preload: a browser IIFE (a classic script, so it runs
 * synchronously where it is inlined; a module script would be deferred past the page's own
 * scripts) with every import, dynamic ones included, inlined into the one file.
 *
 * @param input What to bundle.
 * @returns The argv after the `deno` executable.
 */
export function desktopPreloadBundleArgs(input: DesktopPreloadBundle): string[] {
  const config = localConfigPath(input.configPath);
  return [
    "bundle",
    "--unstable-sloppy-imports",
    "--platform=browser",
    "--format=iife",
    ...(config ? ["--config", config] : []),
    ...minDepAgeArgs(),
    ...(input.minify ? ["--minify"] : []),
    "-o",
    input.outFile,
    join(input.projectDir, input.preload),
  ];
}

/**
 * Bundle `desktop.preload` into one classic script at `outFile`.
 *
 * @param input What to bundle and where.
 * @throws {Error} When the module is missing or `deno bundle` fails (with its stderr).
 */
export async function bundleDesktopPreload(input: DesktopPreloadBundle): Promise<void> {
  const entry = join(input.projectDir, input.preload);
  try {
    if (!(await Deno.stat(entry)).isFile) throw new Error("not a file");
  } catch {
    throw new Error(`${input.label ?? "desktop.preload"}: no module at ${entry}`);
  }
  await Deno.mkdir(dirname(input.outFile), { recursive: true });
  const { code, stderr } = await new Deno.Command(denoExecutable(), {
    args: desktopPreloadBundleArgs(input),
    cwd: input.projectDir,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `${input.label ?? "desktop.preload"}: ${
        bundleFailureMessage(code, new TextDecoder().decode(stderr))
      }`,
    );
  }
}

/** The export targets a Deno Desktop window loads: the only ones that carry the preload. */
const DESKTOP_TARGETS: ReadonlySet<Platform> = new Set(["macos", "windows", "linux"]);

/**
 * The export step: when `desktop.preload` is configured and the export is for a desktop target
 * (`macos` / `windows` / `linux`, what `denext desktop run` and the package scripts export),
 * bundle it (minified) into the export directory at {@link DESKTOP_PRELOAD_FILE}. A web, iOS or
 * Android export never loads it, so it does not carry it. Shared by the SPA and App Router
 * exports.
 *
 * @param paths The project.
 * @param outDir The export (staging) directory.
 * @param platform The export's target.
 */
export async function writeDesktopPreload(
  paths: ProjectPaths,
  outDir: string,
  platform: Platform,
): Promise<void> {
  const preload = paths.config?.desktop?.preload;
  if (!preload) return;
  if (!DESKTOP_TARGETS.has(platform)) {
    console.log(
      `  desktop preload: not bundled into the ${platform} export (only a macos / windows / ` +
        "linux export, as `denext desktop run` and the package scripts make, carries it)",
    );
    return;
  }
  console.log(`  desktop preload: bundling ${preload} -> ${DESKTOP_PRELOAD_FILE}`);
  await bundleDesktopPreload({
    projectDir: paths.projectDir,
    preload,
    configPath: paths.configPath,
    outFile: join(outDir, DESKTOP_PRELOAD_FILE),
    minify: true,
  });
}
