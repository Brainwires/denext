// The help text of `denext analyze` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../analyze.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext analyze`. */
export const analyzeMeta: CommandMeta = {
  name: "analyze",
  summary: "Build, then break down client bundle sizes by chunk",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [{
    name: "md",
    type: "boolean",
    help: "Print a markdown bundle report (with each chunk's top modules); pipe to a file",
  }],
};
