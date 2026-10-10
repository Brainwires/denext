// `spa.shell`: the prerendered, adoptable static shell ("type before React starts"). At build,
// export and dev the configured component is server-rendered into the SPA's mount element, the
// optional boot script is bundled into one classic script inlined ahead of it, and a small inline
// capture script records what the user types into the shell's `data-denext-shell-key` fields.
// The client half — staging the app off-screen and swapping it in — is
// src/client/shell-runtime.ts, installed by the generated entry ({@linkcode spaShellInstall}).

import { join, toFileUrl } from "@std/path";
import type { SpaConfig, SpaShellConfig } from "../../server/config.ts";
import { bundleSourceFiles, frameworkFileUrl } from "../bundle.ts";
import { bundleDesktopPreload } from "../desktop-preload.ts";
import type { ProjectPaths } from "../paths.ts";
import { type Platform, projectPlatformRedirects } from "../platform-extensions.ts";
import type { SpaShellParts } from "./shell-capture.ts";

/**
 * The configured shell when it applies to `platform` (`spa.shell.platforms`, default every
 * target), else null.
 *
 * @param spa The SPA config.
 * @param platform The build target.
 */
export function spaShellFor(spa: SpaConfig, platform: Platform): SpaShellConfig | null {
  const shell = spa.shell;
  if (!shell) return null;
  return shell.platforms === undefined || shell.platforms.includes(platform) ? shell : null;
}

/**
 * The generated entry's install line for the shell's client runtime (what triggers the swap),
 * or `""` without a shell. Data-URL safe: the options are JSON of an enum and a number.
 *
 * @param shell The shell config, or null.
 */
export function spaShellInstall(shell: SpaShellConfig | null): string {
  if (!shell) return "";
  const options: Record<string, unknown> = {};
  if (shell.readyOn !== undefined) options.readyOn = shell.readyOn;
  if (shell.maxHoldMs !== undefined) options.maxHoldMs = shell.maxHoldMs;
  return `import { installShellSupport } from "denext/client-runtime";\n` +
    `installShellSupport(${JSON.stringify(options)});\n`;
}

/**
 * The module the shell is rendered from: the component (resolved through the target's platform
 * files by the bundle's redirects) and the renderer of the running framework, so the component's
 * `denext` and the renderer are one copy (the bundle folds the app's copy into it).
 */
function shellRenderEntry(componentPath: string): string {
  return `// denext generated spa.shell renderer — do not edit.\n` +
    `import Shell from ${JSON.stringify(toFileUrl(componentPath).href)};\n` +
    `import { h } from ${JSON.stringify(frameworkFileUrl("src/jsx/jsx-runtime.ts"))};\n` +
    `import { renderToStringSync } from ${
      JSON.stringify(frameworkFileUrl("src/jsx/render-to-string.ts"))
    };\n` +
    `export default function render(props) {\n` +
    `  return renderToStringSync(h(Shell, props));\n}\n`;
}

/** Render the shell component (for `platform`) to HTML. */
async function renderShellMarkup(
  paths: ProjectPaths,
  shell: SpaShellConfig,
  platform: Platform,
): Promise<string> {
  const componentPath = join(paths.projectDir, shell.component);
  try {
    if (!(await Deno.stat(componentPath)).isFile) throw new Error("not a file");
  } catch {
    throw new Error(`spa.shell.component: no module at ${componentPath}`);
  }
  const bundle = await bundleSourceFiles(shellRenderEntry(componentPath), {
    configPath: paths.configPath,
    projectDir: paths.projectDir,
    redirects: await projectPlatformRedirects(paths.projectDir, paths.config, platform),
  });
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_shell_" });
  try {
    for (const [name, code] of bundle.files) await Deno.writeTextFile(join(dir, name), code);
    const mod = await import(toFileUrl(join(dir, bundle.entry)).href);
    const html = mod.default(shell.props ?? {});
    if (typeof html !== "string") throw new Error("the renderer returned no HTML");
    return html;
  } catch (err) {
    throw new Error(
      `spa.shell.component: rendering ${shell.component} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Bundle `bootScript` into one classic script's source (safe to inline in `<script>`). */
async function bundleBootScript(
  paths: ProjectPaths,
  bootScript: string,
  minify: boolean,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_boot_" });
  try {
    const outFile = join(dir, "boot.js");
    await bundleDesktopPreload({
      projectDir: paths.projectDir,
      preload: bootScript,
      configPath: paths.configPath,
      outFile,
      minify,
      label: "spa.shell.bootScript",
    });
    return escapeInlineScript((await Deno.readTextFile(outFile)).trim());
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Keep a script's source from closing its inline `<script>` element early. */
export function escapeInlineScript(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/**
 * Render `spa.shell` for `platform`: the component's markup and the bundled boot script. Null
 * when no shell is configured for that target.
 *
 * @param paths The project.
 * @param platform The build target.
 * @param minify Minify the boot script (production).
 */
export async function renderSpaShell(
  paths: ProjectPaths,
  platform: Platform,
  minify: boolean,
): Promise<SpaShellParts | null> {
  const shell = paths.config?.spa ? spaShellFor(paths.config.spa, platform) : null;
  if (!shell) return null;
  const [markup, bootScript] = await Promise.all([
    renderShellMarkup(paths, shell, platform),
    shell.bootScript ? bundleBootScript(paths, shell.bootScript, minify) : undefined,
  ]);
  return bootScript === undefined ? { markup } : { markup, bootScript };
}
