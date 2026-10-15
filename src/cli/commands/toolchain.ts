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
import { RAW_FLAG } from "../explain-output.ts";
import { rawDiagnostics } from "../../build/explain/mod.ts";

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

/**
 * The directory `deno test --coverage[=<dir>]` writes (`coverage` when the flag has no value),
 * or undefined without the flag.
 *
 * @param args The forwarded `deno test` arguments.
 * @returns The coverage directory, or undefined.
 */
export function coverageDir(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--coverage") return "coverage";
    if (arg.startsWith("--coverage=")) return arg.slice("--coverage=".length) || "coverage";
  }
  return undefined;
}

export const testCommand: CommandSpec = {
  name: "test",
  summary: "Run the app's tests (deno test)",
  passthrough: true,
  usage: "Forwards to `deno test -A`. Extra args/paths pass through:\n" +
    "  denext test                  Run every test\n" +
    "  denext test --watch          Re-run on change (deno test --watch)\n" +
    "  denext test --coverage=cov   Collect coverage, then `deno coverage cov`\n" +
    "  denext test --filter Auth    Forward deno test flags\n" +
    "  denext test routes/          Restrict to a path",
  positionals: [{ name: "paths", help: "Test files/dirs (default: all)" }],
  // `--coverage[=<dir>]` writes a coverage profile: lock that output dir, so two runs never
  // delete or interleave each other's profiles.
  locks: (ctx) => {
    const dir = coverageDir(ctx.rest);
    return dir === undefined ? undefined : { projectDir: commandCwd(ctx), outputDirs: [dir] };
  },
  run: (ctx) => runDeno("test", ctx, ["-A"]),
};

export const lintCommand: CommandSpec = {
  name: "lint",
  summary: "Lint the app (deno lint)",
  passthrough: true,
  usage: "Forwards to `deno lint`; each denext rule report is explained with a fix " +
    "(--raw for Deno's output unchanged).",
  flags: [RAW_FLAG],
  positionals: [{
    name: "paths",
    help: "Files/dirs to lint (default: project)",
  }],
  run: (ctx) => runDenoExplained("lint", ctx, true),
};

export const fmtCommand: CommandSpec = {
  name: "fmt",
  summary: "Format the app (deno fmt)",
  passthrough: true,
  usage: "Forwards to `deno fmt`. Pass `--check` to verify without writing.",
  positionals: [{
    name: "paths",
    help: "Files/dirs to format (default: project)",
  }],
  run: (ctx) => runDeno("fmt", ctx),
};

export const checkCommand: CommandSpec = {
  name: "check",
  summary: "Type-check the app (deno check)",
  passthrough: true,
  usage: "Forwards to `deno check`; each type error is explained in plain language with a " +
    "suggested fix, the original kept under it (--raw for Deno's output unchanged).",
  flags: [RAW_FLAG],
  positionals: [{ name: "paths", help: "Entry files to check" }],
  run: (ctx) => runDenoExplained("check", ctx),
};
