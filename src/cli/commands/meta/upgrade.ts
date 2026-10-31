// The help text of `denext upgrade` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../upgrade.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext upgrade`. */
export const upgradeMeta: CommandMeta = {
  name: "upgrade",
  summary: "Bump denext, its CLI tasks and the first-party @denext/* packages together",
  usage: "Reads every jsr:@denext/* pin in deno.json (the import map and the `deno task`s that\n" +
    "run the CLI) and moves them to the newest versions that work together: the newest denext\n" +
    "every pinned first-party package has a compatible version for (each package's own\n" +
    "@denext/denext range, from src/plugin/catalog.json or its published deno.json on JSR).\n" +
    "Nothing moves backwards; each pin keeps its ^ / ~ / exact operator. A package that imports\n" +
    "no denext stays within its own caret range unless --allow-major. Workspace members'\n" +
    "deno.json files move with the root. A JSR request that fails is an error, never read as\n" +
    "incompatible. --to picks the denext version (an older one needs --allow-downgrade);\n" +
    "--dry-run prints the plan; --check exits 1 when anything is out of date.\n" +
    "Only versions Deno's minimum dependency age already lets in are pinned (a newer one is\n" +
    "named, with when it becomes eligible; a pin still held moves down to one that resolves),\n" +
    'and the "jsr:@denext/*" entry older projects carry in minimumDependencyAge.exclude is removed\n' +
    '(any other @denext entry there, such as "jsr:@denext/denext", is flagged, never removed).\n' +
    'A missing ".deno/" entry is added to the top-level "exclude", and the lifecycle-script jail\n' +
    "exceptions the dependencies need (sharp, Prisma's engines, …) are written, as create does.\n" +
    'A .vscode/settings.json that turns the Deno LSP on and sets no "deno.unstable" gets\n' +
    '"deno.unstable": ["tsgo-lsp"] (the TypeScript 7 language server; DENEXT_TSGO_LSP=0 skips it).\n' +
    "Upgrading the Deno binary itself is Deno's `deno upgrade`: `denext deno upgrade`.",
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    { name: "dry-run", type: "boolean", help: "Print the plan without writing deno.json" },
    {
      name: "check",
      type: "boolean",
      help: "Write nothing; exit 1 when an upgrade is available (for CI)",
    },
    {
      name: "to",
      type: "string",
      valueName: "<version>",
      help: "The denext version to move to (default: the newest every package supports)",
    },
    {
      name: "allow-downgrade",
      type: "boolean",
      help: "Let --to name a denext version older than the current pin",
    },
    {
      name: "allow-major",
      type: "boolean",
      help: "Let a package that imports no denext move to a new major (breaking) version",
    },
  ],
};
