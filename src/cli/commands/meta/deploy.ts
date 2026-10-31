// The help text of `denext deploy` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../deploy.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext deploy`. */
export const deployMeta: CommandMeta = {
  name: "deploy",
  envTier: "production",
  summary: "Prepare (and push) the app for a deploy target: docker, fly, deno-deploy, …",
  usage: [
    "Usage: denext deploy [prepare] [dir] [--preset <name>] [--domain <host>] [--dry-run] [--force]",
    "",
    "  prepare  Run the deploy adapter's prepare: write the target's files from the deploy",
    "           manifest (.denext/deploy-manifest.json) the last `denext build` wrote",
    "  (none)   prepare, then push with the target's CLI — fly (flyctl + FLY_API_TOKEN),",
    "           deno-deploy (deno deploy + DENO_DEPLOY_TOKEN), docker (docker build [+ push])",
    "",
    "The adapter is denext.config's `deploy.adapter` (presets in denext/deploy), else one a",
    "plugin contributed, else --preset: docker | fly | deno-deploy | generic-host | static.",
    "`denext build` runs the configured adapter's prepare after every build. Credentials are",
    "read from the environment only, and nothing is pushed without `denext deploy`.",
    "Deno's own `deno deploy`: `denext deno deploy`. Docs: https://denext.dev/docs/deploy#deploy-adapters",
  ].join("\n"),
  loadsModules: true,
  positionals: [
    { name: "action", help: "prepare (else: prepare, then push)" },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  flags: [
    {
      name: "preset",
      type: "string",
      valueName: "<name>",
      help: "Use this preset (default options) instead of the configured adapter",
    },
    {
      name: "domain",
      type: "string",
      valueName: "<host>",
      help: "The public domain, for --preset generic-host (its unit, nginx and Caddy files)",
    },
    { name: "dry-run", type: "boolean", help: "Say what would be written and run; do neither" },
    {
      name: "force",
      type: "boolean",
      help: "Also replace project files that were not generated (or were edited)",
    },
  ],
};
