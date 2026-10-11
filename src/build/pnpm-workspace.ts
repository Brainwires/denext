// A pnpm workspace and the `deno` processes denext starts in one. Deno 2.9 reads
// `pnpm-workspace.yaml` only to "migrate" it: when a process in a manual / BYONM `node_modules`
// project (a pnpm workspace member) cannot find an `npm:` package in `node_modules` (the denext
// CLI's own esbuild, say), Deno rewrites the workspace's root `package.json` with a `workspaces`
// field before it fails. `--node-modules-dir=none` resolves npm packages from Deno's global
// cache instead, so nothing is looked up in (or rewritten beside) the pnpm tree. A leaf module:
// sync, no imports beyond @std/path, so `cliInvocation` (the UI's argv builder) can use it.

import { dirname, join, resolve } from "@std/path";

/** The flag that keeps a `deno` child off the pnpm `node_modules` (and the root package.json). */
const NODE_MODULES_DIR_NONE = "--node-modules-dir=none";

/**
 * Whether `dir` is inside a pnpm workspace: a `pnpm-workspace.yaml` in it or a folder above it.
 *
 * @param dir The project (relative paths resolve against the cwd).
 * @returns True when a `pnpm-workspace.yaml` is found.
 */
export function inPnpmWorkspace(dir: string): boolean {
  for (let at = resolve(dir);; at = dirname(at)) {
    try {
      if (Deno.statSync(join(at, "pnpm-workspace.yaml")).isFile) return true;
    } catch { /* not here */ }
    if (dirname(at) === at) return false;
  }
}

/**
 * The npm-mode args for a `deno run` of the denext CLI on the project at `dir`: `--node-modules-dir=none`
 * inside a pnpm workspace, else none (the CLI runs as before). The CLI process never needs the
 * app's `node_modules` for its own modules: the build children it re-execs run under the merged
 * config, in the app's own mode.
 *
 * @param dir The project the CLI child acts on; `undefined` adds nothing.
 * @returns The args to put before the CLI module.
 */
export function cliNpmModeArgs(dir: string | undefined): string[] {
  return dir !== undefined && inPnpmWorkspace(dir) ? [NODE_MODULES_DIR_NONE] : [];
}
