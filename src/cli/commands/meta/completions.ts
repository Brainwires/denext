// The help text of `denext completions` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../completions.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`).
// Not published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext completions`. */
export const completionsMeta: CommandMeta = {
  name: "completions",
  summary: "Print a shell completion script (bash|zsh|fish)",
  usage: "Completes denext's verbs, the Deno verbs denext forwards and the project's own as\n" +
    "`denext commands` last listed them (it never imports the project's config).\n" +
    "Deno's own completion script (`deno completions`): `denext deno completions <shell>`.",
  positionals: [{ name: "shell", help: "bash | zsh | fish", required: true }],
};
