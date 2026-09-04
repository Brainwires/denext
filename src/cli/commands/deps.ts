// Dependency-management verbs the CLI owns rather than telling the user to "now run
// deno install": `add`, `remove`, `update`. Each delegates to the matching Deno
// subcommand in the project directory, so the app's `deno.json` import map is what
// changes — keeping one tool for the whole dependency workflow.

import type { CommandContext, CommandSpec } from "../command.ts";
import { commandCwd, spawnDenoAndExit } from "../shared.ts";

function runDeno(
  sub: string,
  ctx: CommandContext,
  leading: string[] = [],
): Promise<never> {
  // Passthrough verbs fold positionals + unknown flags into `rest` in original
  // order (see CommandRegistry.parse), so forward `rest` alone — no reordering.
  const args = [sub, ...leading, ...ctx.rest];
  return spawnDenoAndExit(args, commandCwd(ctx));
}

export const addCommand: CommandSpec = {
  name: "add",
  summary: "Add a dependency (deno add)",
  passthrough: true,
  usage: "  denext add jsr:@std/assert\n  denext add npm:zod",
  positionals: [{ name: "packages", help: "Packages to add", required: true }],
  run: (ctx) => runDeno("add", ctx),
};

export const removeCommand: CommandSpec = {
  name: "remove",
  summary: "Remove a dependency (deno remove)",
  passthrough: true,
  positionals: [{
    name: "packages",
    help: "Packages to remove",
    required: true,
  }],
  run: (ctx) => runDeno("remove", ctx),
};

export const updateCommand: CommandSpec = {
  name: "update",
  summary: "Update dependencies to latest (deno outdated --update)",
  passthrough: true,
  usage: "Forwards to `deno outdated --update`. Pass package names to scope it,\n" +
    "or `--latest` to cross semver ranges.",
  positionals: [{
    name: "packages",
    help: "Packages to update (default: all)",
  }],
  run: (ctx) => runDeno("outdated", ctx, ["--update"]),
};
