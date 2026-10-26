// Dependency-management verbs the CLI owns rather than telling the user to "now run
// deno install": `add`, `remove`, `update`. Each delegates to the matching Deno
// subcommand in the project directory, so the app's `deno.json` import map is what
// changes — keeping one tool for the whole dependency workflow.

import type { CommandContext, CommandSpec } from "../command.ts";
import { commandCwd, denoGlobalArgs, relayingSignals, spawnDenoAndExit } from "../shared.ts";
import { denoExecutable } from "../../build/bundle.ts";
import { applyJailExceptions, npmPackageName } from "../../build/jail-scripts.ts";

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
  if (gleamPkgs.length === 0) return await addNpm(ctx);
  const { addGleamPackages } = await import("../../build/gleam.ts");
  const ok = await addGleamPackages(
    commandCwd(ctx),
    gleamPkgs.map((a) => a.slice(GLEAM_SPEC.length)).filter(Boolean),
  );
  if (!ok) Deno.exit(1);
  const rest = ctx.rest.filter((a) => !a.startsWith(GLEAM_SPEC));
  if (!rest.some((a) => !a.startsWith("-"))) Deno.exit(0);
  return await addNpm({ ...ctx, rest });
}

/**
 * The npm packages a `deno add` argument list names: `npm:` specifiers, and bare names under
 * `--npm`.
 *
 * @param args `denext add`'s arguments.
 * @returns The package names.
 */
export function addedNpmPackages(args: readonly string[]): string[] {
  const bareIsNpm = args.includes("--npm");
  return args.filter((a) => !a.startsWith("-")).flatMap((a) => {
    const name = npmPackageName(a) ??
      (bareIsNpm && !/^[a-z]+:/.test(a) ? npmPackageName(`npm:${a}`) : null);
    return name ? [name] : [];
  });
}

/** Runs `deno add` with these arguments in `cwd`, resolving its exit code. */
export type DenoAddRunner = (args: string[], cwd: string) => Promise<number>;

const runDenoAdd: DenoAddRunner = async (args, cwd) => {
  const child = new Deno.Command(denoExecutable(), {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await relayingSignals(child)).code;
};

/**
 * `deno add` with the lifecycle-script jail prepared: the exceptions the added packages need
 * (src/build/jail-exceptions.ts) go into deno.json first, since `deno add` runs the approved
 * install scripts itself. When the add fails, those exceptions are taken out again (the
 * config is put back, unless `deno add` changed it too), and with the jail on a hint says how to
 * have the failure explained.
 *
 * @param ctx The invocation.
 * @param run Runs `deno add` (test seam).
 * @returns `deno add`'s exit code.
 */
export async function addWithJail(
  ctx: CommandContext,
  run: DenoAddRunner = runDenoAdd,
): Promise<number> {
  const cwd = commandCwd(ctx);
  const jail = await applyJailExceptions(cwd, { deps: addedNpmPackages(ctx.rest) })
    .catch(() => null);
  const [first, ...more] = jail?.lines ?? [];
  if (first) console.error(`denext add: ${[first, ...more.map((l) => `  ${l}`)].join("\n")}`);
  const path = jail?.action === "written" ? jail.configPath : undefined;
  const after = path === undefined ? null : await Deno.readTextFile(path).catch(() => null);
  const code = await run(["add", ...denoGlobalArgs(ctx), ...ctx.rest], cwd);
  if (code !== 0 && path !== undefined && jail?.before !== undefined) {
    await undoJailExceptions(path, jail.before, after);
  }
  if (code !== 0 && jail?.effective) console.error(JAIL_FAILURE_HINT);
  return code;
}

/** Put the config back as it was before the exceptions, when nothing else has changed it since. */
async function undoJailExceptions(
  path: string,
  before: string,
  after: string | null,
): Promise<void> {
  const now = await Deno.readTextFile(path).catch(() => null);
  if (now !== null && now === after) {
    await Deno.writeTextFile(path, before);
    console.error("denext add: the add failed, so deno.json's new jail exceptions were taken out.");
  } else if (now !== null) {
    console.error(
      "denext add: the add failed; deno.json changed during it, so the jail exceptions written " +
        "before it were left in place (remove them from supplyChain.jailScripts if unneeded).",
    );
  }
}

async function addNpm(ctx: CommandContext): Promise<never> {
  Deno.exit(await addWithJail(ctx));
}

/** What `denext add` prints when the install fails with the jail on. */
export const JAIL_FAILURE_HINT = "denext add: if a dependency's install script failed above " +
  "(error: script '…' failed), the lifecycle-script jail may have stopped it; " +
  "`denext install 2>&1 | tee install.log`, then `denext doctor --install-log install.log` " +
  "explains it and names the exception to add";

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
