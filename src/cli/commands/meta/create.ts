// The help text of `denext create` and `denext init` (the verb's summary, usage, flags and
// positionals: what `--help`, `denext --help`, shell completions and the CLI reference print),
// implemented in ../create.ts. Edit it here, then run `deno task gen:command-table` (or `deno task
// regen`). Not published: scripts/gen-command-table.ts packs it into
// src/cli/command-meta.packed.ts, and the verb's spec reads it back with `...commandMeta("<verb>")`
// (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { SCAFFOLD_TEMPLATES } from "../../../build/scaffold.ts";
import { FEATURES } from "../create.ts";

export const SCAFFOLD_FLAGS = [
  ...FEATURES.map((f) => ({
    name: f.flag,
    type: "boolean" as const,
    help: f.label,
  })),
  {
    name: "template",
    type: "string" as const,
    valueName: "<name>",
    help: `Starter template (${SCAFFOLD_TEMPLATES.join(" | ")}; default: default)`,
  },
  {
    name: "no-vscode",
    type: "boolean" as const,
    help: "Don't write .vscode/settings.json + extensions.json (Deno LSP)",
  },
  {
    name: "yes",
    alias: "y",
    type: "boolean" as const,
    help: "Skip prompts, use flags/defaults",
  },
];

/** `denext create`. */
export const createMeta: CommandMeta = {
  name: "create",
  summary: "Scaffold a new app",
  usage: "Scaffolds a denext app. Deno's `deno create` (a project from a template):\n" +
    "`denext deno create`.",
  flags: SCAFFOLD_FLAGS,
  positionals: [{ name: "dir", help: "New app directory", required: true }],
};

/** `denext init`. */
export const initMeta: CommandMeta = {
  name: "init",
  summary: "Scaffold into the current directory",
  usage: "Scaffolds a denext app into an existing directory. Deno's `deno init`:\n" +
    "`denext deno init`.",
  flags: SCAFFOLD_FLAGS,
  positionals: [{ name: "dir", help: "Existing directory (default: .)" }],
};
