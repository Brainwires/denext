// The help text of `denext runtime` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../runtime.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext runtime`. */
export const runtimeMeta: CommandMeta = {
  name: "runtime",
  summary: "Manage denext's runtime: its Deno build (version | list | install | upgrade | use | …)",
  usage: "denext runs the commands that execute project code on its own Deno build (stock Deno\n" +
    "plus Deno.SQL and Vitest/Jest compat in deno test), downloaded and SHA-256 verified on first\n" +
    "use. Your own `deno` is never replaced. Which release runs: DENEXT_RUNTIME, else the project\n" +
    'pin ("denext": { "runtime": … } in deno.json), else your default, else the release this\n' +
    "denext bundles. New releases come from a signed channel, without a denext release.\n" +
    "  denext runtime version        What runs here and why, the bundled pin, the channel, Gleam,\n" +
    "                                fastlane (alias: info; --verify re-hashes the cache)\n" +
    "  denext runtime list           Installed releases; with the channel: available, held,\n" +
    "                                yanked, incompatible (--all: every listed release)\n" +
    "  denext runtime install [<version>]   Download + verify a release (default: the selected one)\n" +
    "  denext runtime install --with gleam,fastlane   …and the pinned Gleam / managed fastlane\n" +
    "  denext runtime upgrade        The newest compatible release past your dependency-age hold:\n" +
    "                                installs it and makes it your default (--project: the\n" +
    "                                project pin; --dry-run: say what it would do)\n" +
    "  denext runtime use <version|latest|bundled>   Install it and make it your default (kept\n" +
    "                                even under a newer denext), or the project pin (--project)\n" +
    "  denext runtime path           Print the selected release's binary (installs it first)\n" +
    "  denext runtime link           Put it on PATH as ~/.denext/bin/deno (opt-in;\n" +
    "                                $DENEXT_INSTALL/bin when that is set)\n" +
    "  denext runtime unlink         Remove that link (only what link created)\n" +
    "  denext runtime uninstall <version>   Remove a cached release (its Deno and Deno Desktop\n" +
    "                                runtime); one in use only with --force\n" +
    "  denext runtime uninstall --all       Remove every cached release but those in use\n" +
    "  denext runtime prune          Keep only what is in use here (the selected release, your\n" +
    "                                default, the bundled pin and its rollback, the project's\n" +
    "                                pins), Gleam and fastlane included\n" +
    "  (--json for scripts; uninstall and prune show the space freed, --dry-run lists it)",
  positionals: [{
    name: "action",
    help:
      "version | info | list | install | upgrade | use | path | link | unlink | uninstall | prune",
    required: true,
  }, {
    name: "versions",
    help: "install / use: the release (use: also latest or bundled); uninstall: the releases",
    variadic: true,
  }],
  flags: [{
    name: "verify",
    type: "boolean",
    help: "version: re-hash the cached binary instead of the size + mtime check",
  }, {
    name: "with",
    type: "string",
    valueName: "<tool>",
    repeatable: true,
    help: "install: also fetch these pinned tools (gleam, fastlane)",
  }, {
    name: "project",
    type: "boolean",
    help: "upgrade, use: write the project pin (deno.json) instead of your default",
  }, {
    name: "all",
    type: "boolean",
    help: "list: every release the channel lists; uninstall: every cached release",
  }, {
    name: "force",
    type: "boolean",
    help: "uninstall: remove a release even when it is in use",
  }, {
    name: "dry-run",
    type: "boolean",
    help: "upgrade: say what it would do; uninstall, prune: list what would be removed",
  }],
};
