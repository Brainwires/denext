// Toolchain verbs that promote the maintainer-only `deno task`s to first-class
// app-author commands: `test`, `lint`, `fmt`, `check`. Each is a thin, passthrough
// wrapper that spawns the corresponding `deno` subcommand in the project directory
// (so the app's own `deno.json` config applies), forwarding positionals and any
// unrecognized flags verbatim, and exits with the child's status code — so
// `denext test --filter x path/to.test.ts` behaves exactly like the `deno` original.

import type { CommandContext, CommandSpec } from "../command.ts";
import { commandCwd, spawnDenoAndExit } from "../shared.ts";

/**
 * Forward to `deno <sub> [...leading] [...positionals] [...passthrough]` in the
 * project directory. `--config` is forwarded when the global flag is set. The
 * positionals are files/dirs handed to `deno` (not a project dir), so cwd comes from
 * `--cwd` (or the real cwd). Never returns.
 */
function runDeno(sub: string, ctx: CommandContext, leading: string[] = []): Promise<never> {
  const args = [sub, ...leading];
  if (ctx.global.config) args.push("--config", ctx.global.config);
  // Passthrough verbs fold positionals + unknown flags into `rest` in original
  // order (see CommandRegistry.parse), so forward `rest` alone — no reordering.
  args.push(...ctx.rest);
  return spawnDenoAndExit(args, commandCwd(ctx));
}

export const testCommand: CommandSpec = {
  name: "test",
  summary: "Run the app's tests (deno test)",
  passthrough: true,
  usage: "Forwards to `deno test -A`. Extra args/paths pass through:\n" +
    "  denext test                  Run every test\n" +
    "  denext test --filter Auth    Forward deno test flags\n" +
    "  denext test routes/          Restrict to a path",
  positionals: [{ name: "paths", help: "Test files/dirs (default: all)" }],
  run: (ctx) => runDeno("test", ctx, ["-A"]),
};

export const lintCommand: CommandSpec = {
  name: "lint",
  summary: "Lint the app (deno lint)",
  passthrough: true,
  positionals: [{ name: "paths", help: "Files/dirs to lint (default: project)" }],
  run: (ctx) => runDeno("lint", ctx),
};

export const fmtCommand: CommandSpec = {
  name: "fmt",
  summary: "Format the app (deno fmt)",
  passthrough: true,
  usage: "Forwards to `deno fmt`. Pass `--check` to verify without writing.",
  positionals: [{ name: "paths", help: "Files/dirs to format (default: project)" }],
  run: (ctx) => runDeno("fmt", ctx),
};

export const checkCommand: CommandSpec = {
  name: "check",
  summary: "Type-check the app (deno check)",
  passthrough: true,
  positionals: [{ name: "paths", help: "Entry files to check" }],
  run: (ctx) => runDeno("check", ctx),
};
