// `deno test` in two passes: every test file in parallel except the ones that change
// process-wide state (`tests/serial-tests.ts`), then those one at a time, so no test reads an
// environment variable or working directory another test file set for itself.
//
//   deno run -A scripts/test-run.ts [--ignore=a/,b.ts] [deno test flags...] [paths...] [-- args]
//
// Paths and `--ignore` entries are relative to the repo root (where `deno task` runs); with no
// path, every test under the root. A flag's value may be its own argument (`--filter foo`), and
// what follows `--` goes to the tests. Both passes run; the exit code is non-zero when either
// fails.

import { SERIAL_TESTS } from "../tests/serial-tests.ts";

/** Whether `file` is `entry` or lies under it (a directory, with or without its trailing `/`). */
function covers(entry: string, file: string): boolean {
  const e = entry.replace(/^\.\//, "").replace(/\/$/, "");
  return e === "" || e === "." || file === e || file.startsWith(`${e}/`);
}

/** The `deno test` flags whose value may be the next argument (`--filter foo`). */
const VALUE_FLAGS = new Set([
  "--filter",
  "--coverage-threshold",
  "--reporter",
  "--junit-path",
  "--retry",
  "--repeats",
  "--shard",
  "--related",
  "--ext",
  "--import-map",
  "--node-modules-linker",
  "-c",
  "--config",
  "--cert",
  "--min-dep-age",
  "--inspect-publish-uid",
  "--location",
  "--seed",
  "--preload",
  "--require",
  "--conditions",
]);

/** `args` split into `--ignore` entries, flags (with their values), paths and the `--` tail. */
function splitArgs(args: readonly string[]) {
  const ignores: string[] = [];
  const flags: string[] = [];
  const paths: string[] = [];
  const end = args.indexOf("--");
  const own = end === -1 ? args : args.slice(0, end);
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a.startsWith("--ignore=")) {
      ignores.push(...a.slice("--ignore=".length).split(",").filter(Boolean));
    } else if (!a.startsWith("-")) paths.push(a);
    else if (VALUE_FLAGS.has(a) && i + 1 < own.length) flags.push(a, own[++i]);
    else flags.push(a);
  }
  return { ignores, flags, paths, rest: end === -1 ? [] : args.slice(end) };
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
  const { ignores, flags, paths, rest } = splitArgs(args);
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
      ...rest,
    ],
    serial: inScope.length > 0 ? [...base, ...inScope, ...rest] : null,
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
