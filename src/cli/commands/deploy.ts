// `denext deploy` — run a deploy adapter (src/deploy): `prepare` writes the target's files from
// the deploy manifest the last `denext build` wrote; bare `deploy` prepares and then pushes with
// the target's own CLI (credentials from the environment only). Deno's own `deno deploy` stays
// reachable as `denext deno deploy`.

import { resolve } from "@std/path";
import { deployPrepare, deployPush } from "../../build/deploy-flow.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { runBuildStep } from "../shared.ts";

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
  name: "deploy",
  envTier: "production",
  summary: "Prepare (and push) the app for a deploy target: docker, fly, deno-deploy, …",
  usage: [
    "Usage: denext deploy [prepare] [dir] [--preset <name>] [--dry-run] [--force]",
    "",
    "  prepare  Run the deploy adapter's prepare: write the target's files from the deploy",
    "           manifest (.denext/deploy-manifest.json) the last `denext build` wrote",
    "  (none)   prepare, then push with the target's CLI — fly (flyctl + FLY_API_TOKEN),",
    "           deno-deploy (deno deploy + DENO_DEPLOY_TOKEN), docker (docker build [+ push])",
    "",
    "The adapter is denext.config's `deploy.adapter` (presets in denext/deploy), else one a",
    "plugin contributed, else --preset: docker | fly | deno-deploy | generic-host | static.",
    "`denext build` runs the configured adapter's prepare after every build. Credentials are",
    "read from the environment only, and nothing is pushed without `denext deploy`.",
    "Deno's own `deno deploy`: `denext deno deploy`. Docs: https://denext.dev/docs/deploy#deploy-adapters",
  ].join("\n"),
  loadsModules: true,
  moduleDir: (ctx) => parseArgs(ctx).dir,
  locks: (ctx) => ({ projectDir: parseArgs(ctx).dir, buildDir: "exclusive" }),
  positionals: [
    { name: "action", help: "prepare (else: prepare, then push)" },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  flags: [
    {
      name: "preset",
      type: "string",
      valueName: "<name>",
      help: "Use this preset (default options) instead of the configured adapter",
    },
    { name: "dry-run", type: "boolean", help: "Say what would be written and run; do neither" },
    {
      name: "force",
      type: "boolean",
      help: "Also replace project files that were not generated (or were edited)",
    },
  ],
  run: async (ctx) => {
    const { prepareOnly, dir } = parseArgs(ctx);
    const options = {
      preset: ctx.flags.preset as string | undefined,
      dryRun: ctx.flags["dry-run"] === true,
      force: ctx.flags.force === true,
    };
    console.log(`\n  denext deploy${prepareOnly ? " prepare" : ""}  ▸  ${dir}\n`);
    if (prepareOnly) await runBuildStep(() => deployPrepare(dir, options), "deploy prepare");
    else await runBuildStep(() => deployPush(dir, options), "deploy");
  },
};
