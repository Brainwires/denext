// `denext deploy` — run a deploy adapter (src/deploy): `prepare` writes the target's files from
// the deploy manifest the last `denext build` wrote; bare `deploy` prepares and then pushes with
// the target's own CLI (credentials from the environment only). Deno's own `deno deploy` stays
// reachable as `denext deno deploy`.

import { resolve } from "@std/path";
import { deployPrepare, deployPush } from "../../build/deploy-flow.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { runBuildStep } from "../shared.ts";
import { commandMeta } from "../command-meta.ts";

/** The actions, as the help lists them. */
const ACTIONS = ["prepare"];

/** `deploy [prepare] [dir]`: the action (when the first positional names one) and the dir. */
function parseArgs(ctx: CommandContext): { prepareOnly: boolean; dir: string } {
  const [first, second] = ctx.positionals;
  const prepareOnly = first !== undefined && ACTIONS.includes(first);
  const dirArg = prepareOnly ? second : first;
  return { prepareOnly, dir: resolve(ctx.global.cwd ?? dirArg ?? ".") };
}

export const deployCommand: CommandSpec = {
  ...commandMeta("deploy"),
  moduleDir: (ctx) => parseArgs(ctx).dir,
  locks: (ctx) => ({ projectDir: parseArgs(ctx).dir, buildDir: "exclusive" }),
  run: async (ctx) => {
    const { prepareOnly, dir } = parseArgs(ctx);
    const options = {
      preset: ctx.flags.preset as string | undefined,
      domain: ctx.flags.domain as string | undefined,
      dryRun: ctx.flags["dry-run"] === true,
      force: ctx.flags.force === true,
    };
    console.log(`\n  denext deploy${prepareOnly ? " prepare" : ""}  ▸  ${dir}\n`);
    if (prepareOnly) await runBuildStep(() => deployPrepare(dir, options), "deploy prepare");
    else await runBuildStep(() => deployPush(dir, options), "deploy");
  },
};
