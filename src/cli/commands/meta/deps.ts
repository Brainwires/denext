// The help text of `denext add`, `denext remove` and `denext update` (the verb's summary, usage,
// flags and positionals: what `--help`, `denext --help`, shell completions and the CLI reference
// print), implemented in ../deps.ts. Edit it here, then run `deno task gen:command-table` (or `deno
// task regen`). Not published: scripts/gen-command-table.ts packs it into
// src/cli/command-meta.packed.ts, and the verb's spec reads it back with `...commandMeta("<verb>")`
// (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext add`. */
export const addMeta: CommandMeta = {
  name: "add",
  summary: "Add a dependency (deno add, or a Gleam package)",
  passthrough: true,
  usage: "  denext add jsr:@std/assert\n  denext add npm:zod\n" +
    "  denext add gleam:gleam_json   Compile a Gleam package to JavaScript (@gleam/…)",
  positionals: [{ name: "packages", help: "Packages to add", required: true }],
};

/** `denext remove`. */
export const removeMeta: CommandMeta = {
  name: "remove",
  summary: "Remove a dependency (deno remove)",
  passthrough: true,
  positionals: [{
    name: "packages",
    help: "Packages to remove",
    required: true,
  }],
};

/** `denext update`. */
export const updateMeta: CommandMeta = {
  name: "update",
  summary: "Update dependencies to latest (deno outdated --update)",
  passthrough: true,
  usage: "Forwards to `deno outdated --update`. Pass package names to scope it,\n" +
    "or `--latest` to cross semver ranges.",
  positionals: [{
    name: "packages",
    help: "Packages to update (default: all)",
  }],
};
