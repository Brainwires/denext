// The help text of `denext plugin` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../plugin.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext plugin`. */
export const pluginMeta: CommandMeta = {
  name: "plugin",
  summary: "Manage denext plugins (add, remove, list)",
  usage: "  denext plugin add <pkg> [dir]\n" +
    "  denext plugin remove <pkg> [dir]\n" +
    "  denext plugin list [dir]\n\n" +
    "  add     adds the dependency (deno add) and wires the plugin into denext.config.ts\n" +
    "  remove  unwires the plugin from denext.config.ts and drops the dependency\n" +
    "  list    show the plugins wired into denext.config.ts\n\n" +
    "  denext plugin add @denext/htmx\n" +
    "  denext plugin remove @denext/htmx\n" +
    "  denext plugin list\n" +
    "  denext plugin add my-plugin --export configureMyPlugin",
  positionals: [
    { name: "action", help: "add | remove | list", required: true },
    { name: "pkg", help: "Plugin package for add/remove (e.g. @denext/htmx)" },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  flags: [
    {
      name: "export",
      type: "string",
      valueName: "<name>",
      help: "Factory export name (default: camelCased package name)",
    },
    {
      name: "no-call",
      type: "boolean",
      help: "Plugin is a ready value, not a factory — omit ()",
    },
  ],
};
