// `desktop.packageHooks`: the project's own steps around a packaging run, kept in
// `denext.config.ts` and modules of the project's, never in the scaffolded `scripts/package-*.ts`
// (which `denext desktop package --regenerate-scripts` rewrites from the current template).
// `runDesktopPackageMain` runs `pre` before the script's work and `post` after it succeeded, each
// the default export of a module the config names, with the run's context.

import { join, toFileUrl } from "@std/path";
import type { DesktopOs } from "./desktop-capabilities.ts";
import type { DesktopPackageHooksConfig } from "../server/config.ts";
import { desktopPackageHooksProblem } from "../desktop/package-hooks-config.ts";

export type { DesktopPackageHooksConfig } from "../server/config.ts";

/** What a package hook receives. */
export interface DesktopPackageHookContext {
  /** `"pre"` before the build, `"post"` after it succeeded. */
  readonly stage: "pre" | "post";
  /** The OS being packaged for (`"darwin"`, `"windows"`, `"linux"`), not the host's. */
  readonly os: DesktopOs;
  /** The project folder (the parent of `scripts/`). */
  readonly projectDir: string;
  /** Where the artifacts go (`<project>/dist`). */
  readonly distDir: string;
  /** The script's command line (`--arch`, `--format`, …). */
  readonly args: readonly string[];
  /** `post` only: the artifacts the script reported, where it reports them (paths). */
  readonly artifacts?: readonly string[];
}

/** A package hook module's default export. */
export type DesktopPackageHook = (context: DesktopPackageHookContext) => void | Promise<void>;

/** Options for {@linkcode runDesktopPackageHook}. */
export interface DesktopPackageHookRun {
  /** The project config (`denext.config.ts`'s default export), or `undefined`. */
  readonly config: unknown;
  /** The hook's context. */
  readonly context: DesktopPackageHookContext;
  /** Load a module (tests; default `import()`). */
  readonly load?: (url: string) => Promise<unknown>;
}

/**
 * Run the configured hook of `context.stage`, if any: import the module (relative to the project)
 * and await its default export with the context. A hook that throws fails the packaging run.
 *
 * @param run The config, the context and the loader.
 * @returns Whether a hook ran.
 * @throws When `desktop.packageHooks` is invalid, the module has no default function, or it throws.
 */
export async function runDesktopPackageHook(run: DesktopPackageHookRun): Promise<boolean> {
  const hooks = (run.config as { desktop?: { packageHooks?: unknown } } | undefined)?.desktop
    ?.packageHooks;
  const problem = desktopPackageHooksProblem(hooks);
  if (problem) throw new Error(`denext: ${problem[0]} ${problem[1]}`);
  const path = (hooks as DesktopPackageHooksConfig | undefined)?.[run.context.stage];
  if (path === undefined) return false;
  const url = toFileUrl(join(run.context.projectDir, path)).href;
  const mod = await (run.load ?? ((u: string) => import(u)))(url) as { default?: unknown };
  if (typeof mod?.default !== "function") {
    throw new Error(
      `denext: desktop.packageHooks.${run.context.stage} (${path}) must default-export a function`,
    );
  }
  console.log(`\n  desktop.packageHooks.${run.context.stage}: ${path}`);
  await (mod.default as DesktopPackageHook)(run.context);
  return true;
}
