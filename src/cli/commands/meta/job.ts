// The help text of `denext job` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../job.ts. Edit
// it here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext job`. */
export const jobMeta: CommandMeta = {
  name: "job",
  summary: "Run a background job by name, or list them (--list)",
  loadsModules: true,
  flags: [
    { name: "list", alias: "l", type: "boolean", help: "List the app's jobs and exit" },
    {
      name: "history",
      type: "boolean",
      help: "Print the run history (jobs.history) through its configured store",
    },
    {
      name: "clear-history",
      type: "boolean",
      help: "Delete every recorded run through the configured history store",
    },
    {
      name: "read-only",
      type: "boolean",
      help: "With --history: read without changing anything; refuses --clear-history",
    },
    {
      name: "payload",
      type: "string",
      valueName: "<json>",
      help: "JSON passed to the job's ctx.payload",
    },
  ],
  positionals: [{ name: "name", help: "Job name (its path under jobs/, e.g. cleanup)" }],
  usage: "denext job <name> [--payload '<json>']\ndenext job --list [--json]\n" +
    "denext job --history [--read-only] [--json]\ndenext job --clear-history [--json]",
};
