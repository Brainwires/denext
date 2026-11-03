// The help text of `denext task` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../task.ts. Edit
// it here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext task`. */
export const taskMeta: CommandMeta = {
  name: "task",
  summary: "Run a deno.json / package.json task on denext's Deno (deno task)",
  passthrough: true,
  usage: "Runs `deno task` on denext's Deno toolchain, every argument verbatim:\n" +
    "  denext task                   List the project's tasks\n" +
    "  denext task check             Run the `check` task\n" +
    "  denext task test --filter x   Extra arguments go to the task\n" +
    "Every `deno` the task runs — its own `deno …` steps and any a script it starts spawns — is\n" +
    "the same Deno. Background and scheduled jobs (jobs/) are `denext job`.",
  positionals: [
    { name: "name", help: "The task (default: list them)" },
    { name: "args", help: "Arguments for the task", variadic: true },
  ],
};
