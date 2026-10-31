// The help text of `denext fastlane` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../fastlane.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { FASTLANE_ENV, FASTLANE_TOOLCHAIN } from "../../../build/fastlane-toolchain.ts";

/** `denext fastlane`. */
export const fastlaneMeta: CommandMeta = {
  name: "fastlane",
  summary: "Run denext's managed fastlane (pinned; installed on first use)",
  passthrough: true,
  usage: "Runs fastlane with the arguments verbatim, in the current directory (or --cwd):\n" +
    "  denext fastlane ios beta flavor:staging\n" +
    "  denext fastlane android release track:production\n" +
    `The first run installs fastlane ${FASTLANE_TOOLCHAIN.fastlane} on a pinned portable Ruby\n` +
    "into denext's toolchain cache (SHA-256-verified; the gems build C extensions, so it needs\n" +
    "the Command Line Tools on macOS or cc + make on Linux). Windows is not supported.\n" +
    "  denext toolchain install --with fastlane   install it ahead of time\n" +
    `  ${FASTLANE_ENV}=<path>                     run that fastlane instead (unverified)`,
  positionals: [{ name: "args", help: "fastlane's arguments", variadic: true }],
};
