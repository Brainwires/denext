/**
 * The Capacitor CLI as denext runs it: the project's own `@capacitor/cli`, never a registry
 * download. A bare `npx cap …` falls back to fetching the npm package named `cap` (an unrelated
 * package) when `@capacitor/cli` is not installed, and `npm exec` assumes `--yes` when stdin is
 * not a TTY or CI is detected; so every `cap` command carries npx's `--no` (refuse to install),
 * and the runners check first that `@capacitor/cli` resolves from the project, failing with an
 * "install @capacitor/cli" error instead.
 *
 * @module
 */

import { findInstalledPackage } from "./installed-package.ts";
import type { PlannedCommand } from "./mobile-capabilities.ts";

/** npx's flags in front of `cap`: `--no` refuses to install a missing package. */
const NPX_NO_INSTALL = ["--no"] as const;

/**
 * A Capacitor CLI command: `npx --no cap <args…>` in `cwd`. It runs the `cap` bin the project's
 * `@capacitor/cli` installs and never downloads one.
 *
 * @param args The `cap` arguments (`["sync", "ios"]`).
 * @param cwd The Capacitor project.
 */
export function capCommand(args: readonly string[], cwd: string): PlannedCommand {
  return { cmd: "npx", args: [...NPX_NO_INSTALL, "cap", ...args], cwd };
}

/**
 * The `cap` subcommand of a {@linkcode capCommand} (`"sync"`), or undefined for another command.
 *
 * @param c Any planned command.
 */
export function capSubcommand(c: Pick<PlannedCommand, "cmd" | "args">): string | undefined {
  if (c.cmd !== "npx") return undefined;
  const at = c.args.indexOf("cap");
  return at >= 0 && c.args.slice(0, at).every((a) => a.startsWith("-"))
    ? c.args[at + 1]
    : undefined;
}

/**
 * Throw unless `@capacitor/cli` resolves from `cwd` the way Node finds it (a `node_modules`
 * folder in `cwd` or above), so a missing CLI is a clear error rather than a registry fetch.
 *
 * @param cwd The Capacitor project.
 * @throws {Error} When `@capacitor/cli` is not installed.
 */
export async function assertCapacitorCli(cwd: string): Promise<void> {
  if (await findInstalledPackage(cwd, "@capacitor/cli") !== null) return;
  throw new Error(
    `@capacitor/cli is not installed in ${cwd} (or a node_modules above it): install it with ` +
      "your package manager (`npm install -D @capacitor/cli`, `pnpm add -D @capacitor/cli`, …). " +
      "denext runs the project's own Capacitor CLI and never fetches `cap` from the registry",
  );
}
