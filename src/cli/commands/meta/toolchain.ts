// The help text of `denext test`, `denext lint`, `denext fmt` and `denext check` (the verb's
// summary, usage, flags and positionals: what `--help`, `denext --help`, shell completions and the
// CLI reference print), implemented in ../toolchain.ts. Edit it here, then run `deno task
// gen:command-table` (or `deno task regen`). Not published: scripts/gen-command-table.ts packs it
// into src/cli/command-meta.packed.ts, and the verb's spec reads it back with
// `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { RAW_FLAG } from "./serve.ts";

/** `denext test`. */
export const testMeta: CommandMeta = {
  name: "test",
  summary: "Run the app's tests (deno test)",
  passthrough: true,
  usage: "Forwards to `deno test -A`. Extra args/paths pass through. With no path named, the\n" +
    "project's `*.vitest.ts` files run as a second pass, and --coverage reports both as one.\n" +
    "  denext test                  Run every test (Deno.test files, then *.vitest.ts)\n" +
    "  denext test --watch          Re-run on change (deno test --watch)\n" +
    "  denext test --coverage=cov   Collect coverage from both passes into one report\n" +
    "  denext test --filter Auth    Forward deno test flags\n" +
    "  denext test routes/          Restrict to a path",
  positionals: [{ name: "paths", help: "Test files/dirs (default: all)" }],
};

/** `denext lint`. */
export const lintMeta: CommandMeta = {
  name: "lint",
  summary: "Lint the app (deno lint)",
  passthrough: true,
  usage: "Forwards to `deno lint`; each denext rule report is explained with a fix " +
    "(--raw for Deno's output unchanged).",
  flags: [RAW_FLAG],
  positionals: [{
    name: "paths",
    help: "Files/dirs to lint (default: project)",
  }],
};

/** `denext fmt`. */
export const fmtMeta: CommandMeta = {
  name: "fmt",
  summary: "Format the app (deno fmt)",
  passthrough: true,
  usage: "Forwards to `deno fmt`. Pass `--check` to verify without writing.",
  positionals: [{
    name: "paths",
    help: "Files/dirs to format (default: project)",
  }],
};

/** `denext check`. */
export const checkMeta: CommandMeta = {
  name: "check",
  summary: "Type-check the app (deno check)",
  passthrough: true,
  usage: "Forwards to `deno check`; each type error is explained in plain language with a " +
    "suggested fix, the original kept under it (--raw for Deno's output unchanged).",
  flags: [RAW_FLAG],
  positionals: [{ name: "paths", help: "Entry files to check" }],
};
