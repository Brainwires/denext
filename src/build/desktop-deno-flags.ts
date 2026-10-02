// `desktop.denoFlags` for the commands that run `deno desktop`: the scaffolded package scripts read
// them beside their own `import.meta.url` ({@linkcode desktopDenoFlagArgs}), and `denext desktop
// run | dev | package` print a hint for a pnpm workspace that has not set them
// ({@linkcode desktopPnpmWorkspaceHint}). The allow-list itself is `src/desktop/deno-flags.ts`.

import { dirname, join } from "@std/path";
import { desktopDenoFlags } from "../desktop/deno-flags.ts";
import { readJson } from "./json-edit.ts";

/**
 * The project's `desktop.denoFlags`, checked, for a scaffolded packaging script: reads
 * `denext.config.ts` next to `entryUrl`'s folder (a script in `scripts/` → `../`), like
 * `desktopPackageFlags`. A project without a config gets `[]`; a refused flag throws.
 *
 * @param entryUrl The packaging script's `import.meta.url`.
 * @returns The flags, ready to splice into the `deno desktop` argv before the entry.
 */
export async function desktopDenoFlagArgs(entryUrl: string): Promise<string[]> {
  let config: unknown;
  try {
    const mod = await import(new URL("../denext.config.ts", entryUrl).href);
    config = (mod as { default?: unknown }).default;
  } catch {
    return []; // no denext.config.ts (or it exports no config): no extra flags
  }
  return desktopDenoFlags(config);
}

/** Whether `name` exists in `dir` or any folder above it. */
async function existsUp(dir: string, name: string): Promise<boolean> {
  for (let at = dir;; at = dirname(at)) {
    try {
      await Deno.stat(join(at, name));
      return true;
    } catch { /* not here */ }
    if (dirname(at) === at) return false;
  }
}

/** `nodeModulesDir` of the nearest deno.json / deno.jsonc at or above `dir`, if it sets one. */
async function nodeModulesDir(dir: string): Promise<unknown> {
  for (let at = dir;; at = dirname(at)) {
    for (const name of ["deno.json", "deno.jsonc"]) {
      const text = await Deno.readTextFile(join(at, name)).catch(() => undefined);
      if (text === undefined) continue;
      const value = (readJson(text) as { nodeModulesDir?: unknown } | null)?.nodeModulesDir;
      if (value !== undefined) return value;
    }
    if (dirname(at) === at) return undefined;
  }
}

/**
 * A hint for a pnpm workspace (a `pnpm-workspace.yaml` at or above the project, and a deno.json
 * `nodeModulesDir: "manual"`) whose `desktop.denoFlags` does not choose a `--node-modules-dir`:
 * `deno desktop` would type-check against the pnpm `node_modules` and rewrite the root
 * `package.json`. denext does not add `--node-modules-dir=none` by itself: that changes where npm
 * packages resolve from (Deno's global cache instead of the workspace's `node_modules`, so pnpm
 * patches, overrides and linked packages no longer apply), which the project should choose.
 *
 * @param projectDir The project.
 * @param flags The project's `desktop.denoFlags`.
 * @returns The hint, or `undefined` when none applies.
 */
export async function desktopPnpmWorkspaceHint(
  projectDir: string,
  flags: readonly string[],
): Promise<string | undefined> {
  if (flags.some((f) => f === "--node-modules-dir" || f.startsWith("--node-modules-dir="))) {
    return undefined;
  }
  if ((await nodeModulesDir(projectDir)) !== "manual") return undefined;
  if (!(await existsUp(projectDir, "pnpm-workspace.yaml"))) return undefined;
  return 'this is a pnpm workspace (nodeModulesDir: "manual"): `deno desktop` type-checks ' +
    "against its node_modules and may rewrite the root package.json. If it fails, add\n" +
    '      desktop: { denoFlags: ["--node-modules-dir=none", "--exclude-unused-npm"] }\n' +
    "    to denext.config.ts (npm packages then resolve from Deno's cache, without pnpm's " +
    "patches or overrides).";
}
