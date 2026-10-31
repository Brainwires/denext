// The help text of `denext commands` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../commands.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { COMMAND_LOAD_BUDGET_MS } from "../../plugin-commands.ts";

/** `denext commands`. */
export const commandsMeta: CommandMeta = {
  name: "commands",
  summary: "List this project's own CLI verbs (config commands: + plugin addCommand)",
  usage: "  denext commands [--json] [--timeout <ms>] [--cwd <dir>]\n\n" +
    "  Imports denext.config.ts and runs every plugin setup() to discover the verbs the\n" +
    "  project contributes, then exits. A plugin that hangs or throws degrades to a notice\n" +
    "  (--json: `timedOut` / `error`); the exit code stays 0 either way.",
  flags: [{
    name: "timeout",
    type: "number",
    valueName: "<ms>",
    default: COMMAND_LOAD_BUDGET_MS,
    help: "Budget for plugin discovery",
  }],
};
