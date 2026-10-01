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

export { DESKTOP_PRELOAD_ENV, DESKTOP_PRELOAD_FILE } from "../desktop/preload.ts";

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
    throw new Error(`desktop.preload: no module at ${entry}`);
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
      `desktop.preload: ${bundleFailureMessage(code, new TextDecoder().decode(stderr))}`,
    );
  }
}
