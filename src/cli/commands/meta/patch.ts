// The help text of `denext patch` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../patch.ts. Edit
// it here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext patch`. */
export const patchMeta: CommandMeta = {
  name: "patch",
  summary: "Patch npm packages — or denext itself (patches/*.patch)",
  usage: "  denext patch create <package|denext> [dir]\n" +
    "  denext patch list [dir]\n" +
    "  denext patch delete <name|index> [dir]\n" +
    "  denext patch apply [dir]\n" +
    "  denext patch edit <package|denext> <file> [dir]\n\n" +
    "  create  diff the package's installed files (node_modules/<pkg>) — or denext's working\n" +
    "          copies (patches/.work/denext/) — against pristine → patches/<name>+<version>.patch\n" +
    "          (added and deleted files are recorded; a file over 2 MiB / 50k lines is skipped)\n" +
    "  list    the patches, indexed\n" +
    "  delete  remove a patch and undo it (npm files reverted, denext mapping dropped)\n" +
    "  apply   apply every patch now (dev/build/start/export do this at boot)\n" +
    "  edit    for denext: copy a framework file to patches/.work/denext/ to edit;\n" +
    "          for a package: print the installed file's path\n\n" +
    "  denext patch edit denext src/server/document.ts\n" +
    "  denext patch create denext\n" +
    "  denext patch create left-pad\n" +
    "  denext patch delete 2",
  positionals: [
    { name: "action", help: "create | list | delete | apply | edit", required: true },
    { name: "name", help: "Package name, `denext`, or (delete) a list index" },
    { name: "file", help: "(edit) path inside the package" },
    { name: "dir", help: "Project directory (default: .)" },
  ],
};
