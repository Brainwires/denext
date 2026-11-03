// `denext crash-report test` — check an opt-in crash-report pipeline end to end: the toolchain's
// `deno --version` panics on purpose (`DENEXT_CRASH_REPORT_SELFTEST=1`) and sends one report to
// `DENEXT_CRASH_REPORT_URL` (src/build/crash-report.ts).

import type { CommandSpec } from "../command.ts";
import { crashReportTest, type CrashReportTestOptions } from "../../build/crash-report.ts";
import { readEnv } from "../../build/idle-trim.ts";
import { VERSION } from "../../version.ts";
import { toolchainBinary } from "./deno-toolchain.ts";
import { commandMeta } from "../command-meta.ts";

/** What {@linkcode crashReportAction} reads and writes (seams for tests). */
export interface CrashReportActionDeps {
  /** The toolchain's `deno` and its marker (empty for stock Deno). */
  readonly binary: () => Promise<{ deno: string; marker: string }>;
  /** Reads the environment. */
  readonly env: (name: string) => string | undefined;
  /** Prints a line: to stdout, or (`error`) to stderr. */
  readonly print: (line: string, error: boolean) => void;
  /** Runs the self-test child (default: the real `deno --version`). */
  readonly run?: CrashReportTestOptions["run"];
}

/**
 * Run `denext crash-report <action>`.
 *
 * @param action The action (`test`).
 * @param deps The toolchain, the environment and the output.
 * @returns The exit code.
 */
export async function crashReportAction(
  action: string | undefined,
  deps: CrashReportActionDeps,
): Promise<number> {
  if (action !== "test") {
    deps.print(`denext: unknown crash-report action ${JSON.stringify(action ?? "")} (test)`, true);
    return 1;
  }
  const { deno, marker } = await deps.binary();
  const result = await crashReportTest({
    env: deps.env,
    deno,
    runtime: marker === "" ? undefined : marker,
    version: VERSION,
    ...(deps.run ? { run: deps.run } : {}),
  });
  for (const line of result.lines) deps.print(line, !result.ok);
  return result.ok ? 0 : 1;
}

/** `denext crash-report test`. */
export const crashReportCommand: CommandSpec = {
  ...commandMeta("crash-report"),
  run: async (ctx) => {
    const code = await crashReportAction(ctx.positionals[0], {
      binary: toolchainBinary,
      env: readEnv,
      print: (line, error) => (error ? console.error : console.log)(line),
    });
    if (code !== 0) Deno.exit(code);
  },
};
