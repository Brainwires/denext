// The help text of `denext deno` and `denext toolchain` (the verb's summary, usage, flags and
// positionals: what `--help`, `denext --help`, shell completions and the CLI reference print),
// implemented in ../deno-toolchain.ts. Edit it here, then run `deno task gen:command-table` (or
// `deno task regen`). Not published: scripts/gen-command-table.ts packs it into
// src/cli/command-meta.packed.ts, and the verb's spec reads it back with `...commandMeta("<verb>")`
// (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext deno`. */
export const denoMeta: CommandMeta = {
  name: "deno",
  summary: "Run denext's Deno toolchain with the given arguments",
  passthrough: true,
  usage: "Runs denext's pinned Deno (downloaded and verified on first use) with the arguments\n" +
    "verbatim, and exits with its code:\n" +
    "  denext deno test              deno test on the toolchain (Vitest/Jest compat)\n" +
    "  denext deno task check        a deno task whose `deno …` steps run on it too\n" +
    "  denext deno --version",
  positionals: [{ name: "args", help: "Arguments for deno", variadic: true }],
};

/** `denext toolchain`. */
export const toolchainMeta: CommandMeta = {
  name: "toolchain",
  summary:
    "Manage denext's Deno toolchain (install | status | path | link | unlink | uninstall | prune)",
  usage: "denext runs the commands that execute project code on its own pinned Deno build\n" +
    "(stock Deno plus Deno.SQL and Vitest/Jest compat in deno test), downloaded and SHA-256\n" +
    "verified on first use. Your own `deno` is never replaced. DENEXT_DENO=stock opts out.\n" +
    "  denext toolchain install      Download + verify it now (fails when it can't)\n" +
    "  denext toolchain install --with gleam   …and the pinned Gleam compiler\n" +
    "  denext toolchain install --with fastlane   …and the managed fastlane (Ruby + gems)\n" +
    "  denext toolchain status       Pinned versions (Deno, Gleam, fastlane), cache state (--json)\n" +
    "  denext toolchain path         Print the binary's path (installs it first)\n" +
    "  denext toolchain link         Put it on PATH as ~/.denext/bin/deno (opt-in;\n" +
    "                                $DENEXT_INSTALL/bin when that is set)\n" +
    "  denext toolchain unlink       Remove that link (only what link created)\n" +
    "  denext toolchain uninstall <version>   Remove a cached version (its Deno toolchain and\n" +
    "                                Deno Desktop runtime); the pinned one only with --force\n" +
    "  denext toolchain uninstall --all       Remove every cached version but the pinned one\n" +
    "  denext toolchain prune        Remove every version but the one this denext pins (and the\n" +
    "                                one the project here pins), Gleam and fastlane included\n" +
    "  (uninstall and prune show the space freed; --dry-run lists it, --json for scripts)",
  positionals: [{
    name: "action",
    help: "install | status | path | link | unlink | uninstall | prune",
    required: true,
  }, {
    name: "versions",
    help: "uninstall: the versions to remove",
    variadic: true,
  }],
  flags: [{
    name: "verify",
    type: "boolean",
    help: "status: re-hash the cached binary instead of the size + mtime check",
  }, {
    name: "with",
    type: "string",
    valueName: "<tool>",
    repeatable: true,
    help: "install: also fetch these pinned tools (gleam, fastlane)",
  }, {
    name: "all",
    type: "boolean",
    help: "uninstall: every cached version (the pinned one too with --force)",
  }, {
    name: "force",
    type: "boolean",
    help: "uninstall: remove a version even when it is the pinned one",
  }, {
    name: "dry-run",
    type: "boolean",
    help: "uninstall, prune: list what would be removed and the space it frees; remove nothing",
  }],
};
