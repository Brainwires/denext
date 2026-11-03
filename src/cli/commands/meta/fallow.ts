// The help text of `denext fallow` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../fallow.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { FALLOW_VERSION } from "../../../build/fallow-template.ts";

/** `denext fallow`. */
export const fallowMeta: CommandMeta = {
  name: "fallow",
  summary: "Add the fallow code-health gate to a project",
  usage: "  denext fallow init [dir] [--dry-run]\n\n" +
    `  init  writes fallow.toml, .githooks/pre-commit, scripts/coverage-to-istanbul.ts and\n` +
    `        AGENTS.md (each only when missing), adds the fallow / fallow:audit /\n` +
    `        coverage:fallow / hooks:install tasks to deno.json (npm:fallow@${FALLOW_VERSION})\n` +
    `        and coverage/ + .fallow/ to .gitignore. Run \`denext task hooks:install\` to\n` +
    `        enable the commit gate.`,
  positionals: [
    { name: "action", help: "init", required: true },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  flags: [
    { name: "dry-run", type: "boolean", help: "Print what would change; write nothing" },
  ],
};
