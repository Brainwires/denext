// `deno test` in three passes: every test file in parallel except the ones that change
// process-wide state (`tests/serial-tests.ts`), then those one at a time, so no test reads an
// environment variable or working directory another test file set for itself; then the Vitest
// files (`tests/**/*.vitest.ts`) on denext's Deno toolchain.
//
//   deno run -A scripts/test-run.ts [--ignore=a/,b.ts] [deno test flags...] [paths...] [-- args]
//
// Paths and `--ignore` entries are relative to the repo root (where `deno task` runs); with no
// path, every test under the root. A flag's value may be its own argument (`--filter foo`), and
// what follows `--` goes to the tests. Every pass runs; the exit code is non-zero when any fails.
//
// The Vitest files use Vitest's API (`vi.useFakeTimers()`, `vi.mock()`), which only denext's
// Deno toolchain (the `2.9.7-denext.N` fork) provides. Deno's default test discovery never picks
// a `.vitest.ts` file up, so stock `deno test` (and every task that runs it directly) is
// unaffected; this script finds them under `tests/` and runs them with the toolchain binary —
// the running Deno when it already is one, else the pinned build `resolveDenoToolchain` downloads
// and verifies. `DENEXT_DENO=stock` skips that pass with a note; any other reason the toolchain
// is unavailable fails it. Outside CI (`CI` unset) that pass runs with `--no-check`: one
// `DENO_DIR` holds one type-check cache, which each Deno version wipes when the other opened it.

import { walk } from "@std/fs/walk";
import { fromFileUrl, join, relative } from "@std/path";
import { SERIAL_TESTS } from "../tests/serial-tests.ts";
import { resolveDenoToolchain, TOOLCHAIN_ENV } from "../src/build/deno-toolchain.ts";

/** The file-name suffix of a test file that runs on denext's Deno toolchain (Vitest's API). */
export const VITEST_SUFFIX = ".vitest.ts";

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

/** `files` within `paths` (all of them when there is none) and outside every `ignores` entry. */
function inScope(
  files: readonly string[],
  paths: readonly string[],
  ignores: readonly string[],
): string[] {
  return files.filter((f) =>
    (paths.length === 0 || paths.some((p) => covers(p, f))) && !ignores.some((i) => covers(i, f))
  );
}

/**
 * The Vitest pass's own flags. Coverage never reaches it: under the pinned toolchain
 * (2.9.7-denext.15) `deno coverage` cannot map a module the Vitest transform emitted, and a profile
 * of one makes the whole file drop out of a report it is merged into, so the Vitest files stay out
 * of every coverage run until the pin carries the fork's fix (see CONTRIBUTING.md).
 *
 * Type-checking is skipped (`--no-check`) unless `typeCheck` — CI — or the flags already decide.
 * Deno keeps one type-check cache per `DENO_DIR` and wipes it whenever another Deno version opens
 * it, so a toolchain build type-checking here would cost the next stock pass its whole cache
 * (~25 s for the suite) on every local run.
 */
function vitestFlags(flags: readonly string[], typeCheck: boolean): string[] {
  const own = flags.filter((f) => !/^--coverage(?:=|$)/.test(f));
  const decided = own.some((f) => /^--(?:no-)?check(?:=|$)/.test(f));
  return typeCheck || decided ? own : [...own, "--no-check"];
}

/** What {@linkcode testPasses} hands back: a pass's `deno test` arguments, or null to skip it. */
export interface TestPasses {
  /** Every stock test file in scope except the serial ones, in parallel. */
  parallel: string[] | null;
  /** The serial files in scope, one at a time. */
  serial: string[] | null;
  /** The Vitest files in scope, on denext's Deno toolchain. */
  vitest: string[] | null;
}

/**
 * The `deno test` argument lists for `args`: the parallel pass over the given paths (minus the
 * serial and Vitest files), the serial pass over the serial files in scope, and the Vitest pass
 * over the Vitest files in scope (each null when it has nothing to run).
 *
 * @param args This script's arguments.
 * @param serial The serial test files.
 * @param vitest The Vitest test files (`tests/**\/*.vitest.ts`, repo-relative).
 * @param typeCheckVitest Type-check the Vitest files (CI); else the pass runs with `--no-check`.
 */
export function testPasses(
  args: readonly string[],
  serial: readonly string[] = SERIAL_TESTS,
  vitest: readonly string[] = [],
  typeCheckVitest = true,
): TestPasses {
  const { ignores, flags, paths, rest } = splitArgs(args);
  const serialFiles = inScope(serial, paths, ignores);
  const vitestFiles = inScope(vitest, paths, ignores);
  // A `.vitest.ts` path named on its own is the Vitest pass's alone: stock Deno runs an explicitly
  // named file whatever its name, and cannot resolve `vitest`.
  const stockPaths = paths.filter((p) => !p.endsWith(VITEST_SUFFIX));
  const base = ["test", "-A", "--unstable-kv", ...flags];
  const ignore = [...ignores, ...serialFiles];
  return {
    parallel: paths.length > 0 && stockPaths.length === 0 ? null : [
      ...base,
      "--parallel",
      ...(ignore.length > 0 ? [`--ignore=${ignore.join(",")}`] : []),
      ...stockPaths,
      ...rest,
    ],
    serial: serialFiles.length > 0 ? [...base, ...serialFiles, ...rest] : null,
    vitest: vitestFiles.length > 0
      ? [
        "test",
        "-A",
        "--unstable-kv",
        ...vitestFlags(flags, typeCheckVitest),
        "--parallel",
        ...vitestFiles,
        ...rest,
      ]
      : null,
  };
}

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Every `*.vitest.ts` under `tests/` (repo-relative, `/`-separated), fixtures excluded. */
export async function findVitestFiles(root: string = ROOT): Promise<string[]> {
  const out: string[] = [];
  for await (
    const e of walk(join(root, "tests"), {
      includeDirs: false,
      match: [/\.vitest\.ts$/],
      skip: [/[/\\](?:fixtures|node_modules)[/\\]/],
    })
  ) {
    out.push(relative(root, e.path).replaceAll("\\", "/"));
  }
  return out.sort();
}

/** Whether `version` (`Deno.version.deno`) is a denext toolchain build (`2.9.7-denext.15`). */
export function isToolchainBuild(version: string): boolean {
  return /-denext\.\d+$/.test(version);
}

/** The Deno the Vitest pass runs on, or null when `DENEXT_DENO=stock` opted out. */
async function vitestDeno(): Promise<string | null> {
  if (isToolchainBuild(Deno.version.deno)) return Deno.execPath();
  const choice = await resolveDenoToolchain();
  if (choice.kind === "toolchain") {
    if (choice.warning) console.error(choice.warning);
    return choice.deno;
  }
  if (choice.reason === `${TOOLCHAIN_ENV}=stock`) return null;
  throw new Error(
    `the Vitest test files need denext's Deno toolchain, which is unavailable: ${choice.reason}` +
      (choice.warning ? `\n${choice.warning}` : ""),
  );
}

/** Run `deno` (the binary at `bin`) with `args`, inheriting the terminal; true when it succeeded. */
async function deno(args: string[], bin: string = Deno.execPath()): Promise<boolean> {
  const { success } = await new Deno.Command(bin, {
    args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return success;
}

/** The Vitest pass: true when it passed or was skipped on purpose. */
async function runVitestPass(args: string[]): Promise<boolean> {
  let bin: string | null;
  try {
    bin = await vitestDeno();
  } catch (err) {
    console.error(`test-run: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (bin === null) {
    console.error(`test-run: ${TOOLCHAIN_ENV}=stock — skipping the Vitest test files.`);
    return true;
  }
  return await deno(args, bin);
}

if (import.meta.main) {
  const ci = (Deno.env.get("CI") ?? "") !== "";
  const passes = testPasses(Deno.args, SERIAL_TESTS, await findVitestFiles(), ci);
  const parallel = passes.parallel ? await deno(passes.parallel) : true;
  const serial = passes.serial ? await deno(passes.serial) : true;
  const vitest = passes.vitest ? await runVitestPass(passes.vitest) : true;
  if (!parallel || !serial || !vitest) Deno.exit(1);
}
