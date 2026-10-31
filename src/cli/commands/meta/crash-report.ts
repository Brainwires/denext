// The help text of `denext crash-report` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../crash-report.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`).
// Not published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext crash-report`. */
export const crashReportMeta: CommandMeta = {
  name: "crash-report",
  summary: "Check opt-in crash reports end to end (test)",
  usage:
    "test: run denext's Deno toolchain with DENEXT_CRASH_REPORT_SELFTEST=1, which panics on\n" +
    'purpose just after start-up and sends one report (kind "selftest") to\n' +
    "DENEXT_CRASH_REPORT_URL (an https:// endpoint or a file:///absolute/path.jsonl). For a\n" +
    "file it shows the line written; an endpoint's answer is not read, so look for the report\n" +
    "there. Exits 1 when the URL is unset or refused, the runtime has no crash reports, or no\n" +
    "report was written. The URL's value is never printed.",
  positionals: [{ name: "action", help: "test" }],
};
