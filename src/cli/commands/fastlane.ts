// `denext fastlane <lane…>`: run denext's managed fastlane (src/build/fastlane-toolchain.ts) — a
// pinned fastlane on a pinned portable Ruby, installed on first use into the toolchain cache — in
// the current directory (or `--cwd`), with the arguments verbatim. `DENEXT_FASTLANE=<path>` runs
// another fastlane instead. The CLI hands `denext [globals…] fastlane …` here before parsing
// (cli.ts), so fastlane's own flags (`--verbose`, `--env`, `--help`) reach it untouched.

import type { CommandSpec } from "../command.ts";
import { commandCwd, relayingSignals } from "../shared.ts";
import {
  FASTLANE_ENV,
  FASTLANE_TOOLCHAIN,
  type FastlaneInvocation,
  pluginfileGems,
  resolveFastlane,
} from "../../build/fastlane-toolchain.ts";
import { commandMeta } from "../command-meta.ts";

/** Seams for {@linkcode runFastlane} (tests). */
export interface RunFastlaneOptions {
  /** Default {@linkcode resolveFastlane}. */
  readonly resolve?: () => Promise<FastlaneInvocation>;
  /** Runs the child to completion and returns its exit code (default: spawn, stdio inherited). */
  readonly spawn?: (invocation: FastlaneInvocation, args: string[], cwd: string) => Promise<number>;
  /** Messages (default `console.error`). */
  readonly log?: (line: string) => void;
}

/** Spawn the fastlane with inherited stdio; its exit code. */
async function spawnFastlane(
  invocation: FastlaneInvocation,
  args: string[],
  cwd: string,
): Promise<number> {
  const child = new Deno.Command(invocation.command, {
    args: [...invocation.args, ...args],
    cwd,
    env: invocation.env,
    clearEnv: true,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await relayingSignals(child)).code;
}

/**
 * Run fastlane with `args` in `cwd`: resolve it (installing the managed one on first use), warn
 * when the project's Pluginfile lists plugins the managed bundle won't load, and return the
 * child's exit code (1 when no fastlane can be had, with the reason).
 *
 * @param args fastlane's arguments, verbatim (`ios beta flavor:staging`).
 * @param cwd The directory fastlane runs in (it finds `./fastlane/` there).
 * @param options Seams.
 * @returns The exit code.
 */
export async function runFastlane(
  args: string[],
  cwd: string,
  options: RunFastlaneOptions = {},
): Promise<number> {
  const log = options.log ?? ((l: string) => console.error(l));
  let invocation: FastlaneInvocation;
  try {
    invocation = await (options.resolve ?? (() => resolveFastlane()))();
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (invocation.warning) log(invocation.warning);
  if (invocation.version !== "path") {
    const plugins = await pluginfileGems(cwd);
    if (plugins.length > 0) {
      log(
        `denext: fastlane/Pluginfile lists ${plugins.join(", ")}; denext's managed fastlane ` +
          `${FASTLANE_TOOLCHAIN.fastlane} runs its own pinned gems and does not load plugins. ` +
          `Run \`bundle exec fastlane\` with your own Ruby, or set ${FASTLANE_ENV} to a fastlane ` +
          "that has them.",
      );
    }
  }
  return await (options.spawn ?? spawnFastlane)(invocation, args, cwd);
}

export const fastlaneCommand: CommandSpec = {
  ...commandMeta("fastlane"),
  run: async (ctx) => {
    Deno.exit(await runFastlane([...ctx.positionals, ...ctx.rest], commandCwd(ctx)));
  },
};
