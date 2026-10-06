// `deno test` in two passes: every test file in parallel except the ones that change
// process-wide state (`tests/serial-tests.ts`), then those one at a time, so no test reads an
// environment variable or working directory another test file set for itself.
//
//   deno run -A scripts/test-run.ts [--ignore=a/,b.ts] [deno test flags...] [paths...]
//
// Paths and `--ignore` entries are relative to the repo root (where `deno task` runs); with no
// path, every test under the root. Both passes run; the exit code is non-zero when either fails.

import { SERIAL_TESTS } from "../tests/serial-tests.ts";

/** Whether `file` is `entry` or lies under it (a directory, with or without its trailing `/`). */
function covers(entry: string, file: string): boolean {
  const e = entry.replace(/^\.\//, "").replace(/\/$/, "");
  return e === "" || e === "." || file === e || file.startsWith(`${e}/`);
}

/**
 * The two `deno test` argument lists for `args`: the parallel pass over the given paths (minus
 * the serial files), and the serial pass over the serial files in scope (null when none are).
 *
 * @param args This script's arguments.
 * @param serial The serial test files.
 */
export function testPasses(
  args: readonly string[],
  serial: readonly string[] = SERIAL_TESTS,
): { parallel: string[]; serial: string[] | null } {
  const ignores = args.filter((a) => a.startsWith("--ignore="))
    .flatMap((a) => a.slice("--ignore=".length).split(",")).filter(Boolean);
  const flags = args.filter((a) => a.startsWith("-") && !a.startsWith("--ignore="));
  const paths = args.filter((a) => !a.startsWith("-"));
  const inScope = serial.filter((f) =>
    (paths.length === 0 || paths.some((p) => covers(p, f))) && !ignores.some((i) => covers(i, f))
  );
  const base = ["test", "-A", "--unstable-kv", ...flags];
  const ignore = [...ignores, ...inScope];
  return {
    parallel: [
      ...base,
      "--parallel",
      ...(ignore.length > 0 ? [`--ignore=${ignore.join(",")}`] : []),
      ...paths,
    ],
    serial: inScope.length > 0 ? [...base, ...inScope] : null,
  };
}

/** Run `deno` with `args`, inheriting the terminal; true when it succeeded. */
async function deno(args: string[]): Promise<boolean> {
  const { success } = await new Deno.Command(Deno.execPath(), {
    args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return success;
}

if (import.meta.main) {
  const passes = testPasses(Deno.args);
  const parallel = await deno(passes.parallel);
  const serial = passes.serial ? await deno(passes.serial) : true;
  if (!parallel || !serial) Deno.exit(1);
}
