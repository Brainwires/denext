// The help text of `denext db-admin` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../db-admin.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext db-admin`. */
export const dbAdminMeta: CommandMeta = {
  name: "db-admin",
  summary: "The database child process behind denext ui (JSON on stdin)",
  hidden: true,
  loadsModules: true,
  usage: "denext db-admin --json --cwd <dir> < request.json",
};
