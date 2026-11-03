// `denext task <name> [args…]` — Deno's meaning: run a task from deno.json / package.json, on
// denext's Deno toolchain. (Background and scheduled work is `denext job`, src/cli/commands/job.ts.)
//
// The CLI hands `task` to Deno before parsing (cli.ts), so every token after the verb reaches
// `deno task` verbatim — a task's own arguments may be anything, `--quiet` and `--config`
// included. This spec is what help, completions and `denext commands` describe; its `run` is the
// same forward, for a caller that dispatches the spec directly.
//
// Inside the task, `deno` is the toolchain Deno twice over: Deno's task shell runs its own
// executable for a `deno …` step, and the child's PATH starts with that binary as `deno`
// (src/cli/deno-path.ts), so a script or tool the task starts that spawns `deno` gets it too.

import type { CommandSpec } from "../command.ts";
import { commandCwd, denoGlobalArgs } from "../shared.ts";
import { runDenoPassthrough } from "./deno-toolchain.ts";
import { commandMeta } from "../command-meta.ts";

export const taskCommand: CommandSpec = {
  ...commandMeta("task"),
  run: (ctx) =>
    runDenoPassthrough(["task", ...denoGlobalArgs(ctx), ...ctx.rest], commandCwd(ctx), true),
};
