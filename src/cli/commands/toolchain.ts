// Toolchain verbs that promote the maintainer-only `deno task`s to first-class
// app-author commands: `test`, `lint`, `fmt`, `check`. Each is a thin, passthrough
// wrapper that spawns the corresponding `deno` subcommand in the project directory
// (so the app's own `deno.json` config applies), forwarding positionals and any
// unrecognized flags verbatim, and exits with the child's status code — so
// `denext test --filter x path/to.test.ts` behaves exactly like the `deno` original.

import type { CommandContext, CommandSpec } from "../command.ts";
import {
  commandCwd,
  denoGlobalArgs,
  spawnDenoAndExit,
  spawnDenoExplainedAndExit,
} from "../shared.ts";
import { join } from "@std/path";
import { denoExecutable } from "../../build/deno-executable.ts";
import { currentDenoIdentity, isDenextDenoVersion } from "../../build/deno-version.ts";
import { clearCoverageProfiles, coverageDir, findVitestFiles, planTestRun } from "./test-passes.ts";
import { rawDiagnostics } from "../../build/explain/mod.ts";
import { commandMeta } from "../command-meta.ts";

/**
 * Forward to `deno <sub> [...leading] [...positionals] [...passthrough]` in the
 * project directory. The global flags denext parses that Deno's subcommand also has are
 * handed back: `--config` and `--quiet` always, `--json` where Deno's verb takes it (`lint`).
 * The positionals are files/dirs handed to `deno` (not a project dir), so cwd comes from
 * `--cwd` (or the real cwd). Never returns.
 */
function runDeno(
  sub: string,
  ctx: CommandContext,
  leading: string[] = [],
  json = false,
): Promise<never> {
  // Passthrough verbs fold positionals + unknown flags into `rest` in original
  // order (see CommandRegistry.parse), so forward `rest` alone — no reordering.
  const args = [sub, ...leading, ...denoGlobalArgs(ctx, { json }), ...ctx.rest];
  return spawnDenoAndExit(args, commandCwd(ctx));
}

/**
 * Like {@linkcode runDeno}, but the diagnostics are printed explained (src/build/explain) —
 * unless `--raw`, `DENEXT_RAW_DIAGNOSTICS=1`, or a machine-readable `--json` asks for Deno's
 * own output. Never returns.
 */
function runDenoExplained(sub: string, ctx: CommandContext, json = false): Promise<never> {
  const machine = (json && ctx.global.json) || ctx.rest.includes("--json");
  if (ctx.flags.raw === true || rawDiagnostics() || machine) return runDeno(sub, ctx, [], json);
  const args = [sub, ...denoGlobalArgs(ctx, { json }), ...ctx.rest];
  return spawnDenoExplainedAndExit(args, commandCwd(ctx));
}

export { coverageDir };

/**
 * Whether this Deno is denext's toolchain build (its `Deno.build.denext` marker, or a pre-marker
 * `3.0.0-rc.N` / `2.9.7-denext.N` build: Vitest's API in `deno test`).
 */
function onToolchain(): boolean {
  return isDenextDenoVersion(currentDenoIdentity());
}

/** Run one `deno` argument list in `cwd`, inheriting the terminal; its exit code. */
async function runDenoStep(args: string[], cwd: string): Promise<number> {
  const child = new Deno.Command(denoExecutable(), {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await child.status).code;
}

/**
 * `denext test`: one `deno test -A`, or, in a project with Vitest files and no paths named, the
 * `Deno.test` pass then the Vitest pass, with one coverage report over both (see
 * `test-passes.ts`). Exits non-zero when any pass or the report failed. Never returns.
 */
async function runTests(ctx: CommandContext): Promise<never> {
  const cwd = commandCwd(ctx);
  const args = [...denoGlobalArgs(ctx), ...ctx.rest];
  const plan = planTestRun(args, await findVitestFiles(cwd), onToolchain());
  if (plan.note) console.error(`denext test: ${plan.note}`);
  if (plan.passes.length === 1 && plan.report.length === 0) {
    return spawnDenoAndExit(plan.passes[0], cwd);
  }
  if (plan.clean) await clearCoverageProfiles(join(cwd, plan.clean)).catch(() => {});
  let code = 0;
  for (const pass of plan.passes) code = (await runDenoStep(pass, cwd)) || code;
  for (const report of plan.report) code = (await runDenoStep(report, cwd)) || code;
  Deno.exit(code);
}

export const testCommand: CommandSpec = {
  ...commandMeta("test"),
  // `--coverage[=<dir>]` writes a coverage profile: lock that output dir, so two runs never
  // delete or interleave each other's profiles.
  locks: (ctx) => {
    const dir = coverageDir(ctx.rest);
    return dir === undefined ? undefined : { projectDir: commandCwd(ctx), outputDirs: [dir] };
  },
  run: runTests,
};

export const lintCommand: CommandSpec = {
  ...commandMeta("lint"),
  run: (ctx) => runDenoExplained("lint", ctx, true),
};

export const fmtCommand: CommandSpec = {
  ...commandMeta("fmt"),
  run: (ctx) => runDeno("fmt", ctx),
};

export const checkCommand: CommandSpec = {
  ...commandMeta("check"),
  run: (ctx) => runDenoExplained("check", ctx),
};
