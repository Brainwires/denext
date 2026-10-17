// Dependency-management verbs the CLI owns rather than telling the user to "now run
// deno install": `add`, `remove`, `update`. Each delegates to the matching Deno
// subcommand in the project directory, so the app's `deno.json` import map is what
// changes — keeping one tool for the whole dependency workflow.

import type { CommandContext, CommandSpec } from "../command.ts";
import { commandCwd, denoGlobalArgs, spawnDenoAndExit } from "../shared.ts";

function runDeno(
  sub: string,
  ctx: CommandContext,
  leading: string[] = [],
): Promise<never> {
  // Passthrough verbs fold positionals + unknown flags into `rest` in original
  // order (see CommandRegistry.parse), so forward `rest` alone — no reordering. `--config` and
  // `--quiet`, which denext parses as global flags, are Deno's too and handed back.
  const args = [sub, ...leading, ...denoGlobalArgs(ctx), ...ctx.rest];
  return spawnDenoAndExit(args, commandCwd(ctx));
}

/** The `gleam:` prefix `denext add` takes a Gleam (Hex) package under. */
const GLEAM_SPEC = "gleam:";

/**
 * `denext add`: `deno add` for `jsr:` / `npm:` specifiers; a `gleam:<package>` is added to the
 * app's Gleam project and compiled to JavaScript instead (see `src/build/gleam.ts`).
 */
async function runAdd(ctx: CommandContext): Promise<never> {
  const gleamPkgs = ctx.rest.filter((a) => a.startsWith(GLEAM_SPEC));
  if (gleamPkgs.length === 0) return runDeno("add", ctx);
  const { addGleamPackages } = await import("../../build/gleam.ts");
  const ok = await addGleamPackages(
    commandCwd(ctx),
    gleamPkgs.map((a) => a.slice(GLEAM_SPEC.length)).filter(Boolean),
  );
  if (!ok) Deno.exit(1);
  const rest = ctx.rest.filter((a) => !a.startsWith(GLEAM_SPEC));
  if (!rest.some((a) => !a.startsWith("-"))) Deno.exit(0);
  return runDeno("add", { ...ctx, rest });
}

export const addCommand: CommandSpec = {
  name: "add",
  summary: "Add a dependency (deno add, or a Gleam package)",
  passthrough: true,
  usage: "  denext add jsr:@std/assert\n  denext add npm:zod\n" +
    "  denext add gleam:gleam_json   Compile a Gleam package to JavaScript (@gleam/…)",
  positionals: [{ name: "packages", help: "Packages to add", required: true }],
  run: runAdd,
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
