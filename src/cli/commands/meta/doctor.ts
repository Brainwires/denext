// The help text of `denext info` and `denext doctor` (the verb's summary, usage, flags and
// positionals: what `--help`, `denext --help`, shell completions and the CLI reference print),
// implemented in ../doctor.ts. Edit it here, then run `deno task gen:command-table` (or `deno task
// regen`). Not published: scripts/gen-command-table.ts packs it into
// src/cli/command-meta.packed.ts, and the verb's spec reads it back with `...commandMeta("<verb>")`
// (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext info`. */
export const infoMeta: CommandMeta = {
  name: "info",
  summary: "Print environment + project facts; with a module, Deno's info",
  passthrough: true,
  usage: "  denext info [dir]              denext, Deno and platform versions + the project's\n" +
    "                                 config, mode and app dir (--json)\n" +
    "  denext info <module|file|URL>  Deno's `deno info` for that module (its flags pass through)\n" +
    "Deno's cache locations (`deno info` with no argument): `denext deno info`.",
  positionals: [{ name: "target", help: "Project directory (default: .), or a module for Deno" }],
};

/** `denext doctor`. */
export const doctorMeta: CommandMeta = {
  name: "doctor",
  summary: "Diagnose the project (supersedes probe)",
  aliases: ["probe"],
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [{
    name: "report",
    type: "boolean",
    help: "Print a markdown health report (checks, every route's conformance, the last " +
      "build's client bundle by chunk); with --json, the same data as JSON",
  }, {
    name: "install-log",
    type: "string",
    valueName: "<file>",
    help: "Explain the dependencies' lifecycle scripts that failed in this captured install " +
      "output (`denext install 2>&1 | tee install.log`) as lifecycle-script jail failures",
  }],
};
