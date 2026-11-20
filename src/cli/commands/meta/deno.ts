// The help text of `denext deno` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../deno.ts. Edit
// it here, then run `deno task gen:command-table` (or `deno task regen`). Not published: scripts/gen-command-table.ts packs it into
// src/cli/command-meta.packed.ts, and the verb's spec reads it back with `...commandMeta("<verb>")`
// (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext deno`. */
export const denoMeta: CommandMeta = {
  name: "deno",
  summary: "Run denext's runtime (its Deno) with the given arguments",
  passthrough: true,
  usage:
    "Runs the Deno of denext's selected runtime (downloaded and verified on first use) with\n" +
    "the arguments verbatim, and exits with its code:\n" +
    "  denext deno test              deno test on the runtime (Vitest/Jest compat)\n" +
    "  denext deno task check        a deno task whose `deno …` steps run on it too\n" +
    "  denext deno --version",
  positionals: [{ name: "args", help: "Arguments for deno", variadic: true }],
};
