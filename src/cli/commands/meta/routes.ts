// The help text of `denext routes` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../routes.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext routes`. */
export const routesMeta: CommandMeta = {
  name: "routes",
  summary: "List the app's pages and API routes (a table, or --json)",
  usage: "Scans app/ (or src/app/) without importing any route module: each route's kind,\n" +
    "path, HTTP methods (an API route's exported handlers, read from its source), dynamic\n" +
    "params and file. --json prints { pages, api } for scripts.",
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
};
