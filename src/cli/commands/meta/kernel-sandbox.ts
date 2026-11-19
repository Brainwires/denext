// The help text of `denext kernel-sandbox` (the verb's summary, usage, flags and positionals:
// what `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../kernel-sandbox.ts. Edit it here, then run `deno task gen:command-table` (or `deno task
// regen`). Not published: scripts/gen-command-table.ts packs it into
// src/cli/command-meta.packed.ts, and the verb's spec reads it back with
// `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext kernel-sandbox`. */
export const kernelSandboxMeta: CommandMeta = {
  name: "kernel-sandbox",
  summary: "What the kernel sandbox would do here, and the grants a run needs under it",
  usage:
    "  denext kernel-sandbox [status]         this machine's kernel features, what the sandbox\n" +
    "                                         does for the project, and a dry run of the `start`\n" +
    "                                         task's grant (nothing of the app runs)\n" +
    "  denext kernel-sandbox check [-- cmd…]  run the app in warn mode (default: the `start`\n" +
    "                                         task) and print the grants to add before enforce;\n" +
    "                                         nothing is refused. Exits 1 when enforce would\n" +
    "                                         refuse something.\n" +
    "Docs: https://denext.dev/docs/kernel-sandbox-migrating",
  positionals: [{ name: "action", help: "status (default) or check" }],
  flags: [{
    name: "task",
    type: "string",
    valueName: "<name>",
    help: "The deno.json task to read the grant from and to run (default: start)",
  }, {
    name: "timeout",
    type: "number",
    valueName: "<seconds>",
    help: "check: stop the command after this long (a server never ends by itself)",
  }],
};
