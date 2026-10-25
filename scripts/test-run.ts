// `deno test` in three passes: every test file in parallel except the ones that change
// process-wide state (`tests/serial-tests.ts`), then those one at a time, so no test reads an
// environment variable or working directory another test file set for itself; then the Vitest
// files (`tests/**/*.vitest.ts`) on denext's Deno toolchain.
//
//   deno run -A scripts/test-run.ts [--ignore=a/,b.ts] [--vitest-allow-env=A,B] [deno test flags...]
//     [paths...] [-- args]
//
// Paths and `--ignore` entries are relative to the repo root (where `deno task` runs); with no
// path, every test under the root. A flag's value may be its own argument (`--filter foo`), and
// what follows `--` goes to the tests. Every pass runs; the exit code is non-zero when any fails.
// `--vitest-allow-env=A,B` grants the Vitest pass (which runs least-privilege) reads of those
// environment variables, for a `--preload` that reads them (`deno task test:stress`'s jitter).
//
// The Vitest files use Vitest's API (`vi.useFakeTimers()`, `vi.mock()`), which only denext's
// Deno toolchain (the `2.9.7-denext.N` fork) provides. Deno's default test discovery never picks
// a `.vitest.ts` file up, so stock `deno test` (and every task that runs it directly) is
// unaffected; this script finds them under `tests/` and runs them with the toolchain binary —
// the running Deno when it already is one, else the pinned build `resolveDenoToolchain` downloads
// and verifies. `DENEXT_DENO=stock` skips that pass with a note; any other reason the toolchain
// is unavailable fails it. Outside CI (`CI` unset) that pass runs with `--no-check`: one
// `DENO_DIR` holds one type-check cache, which each Deno version wipes when the other opened it.
//
// The parallel and serial passes run on the toolchain too whenever it resolves (the running Deno
// when it is one, else the pinned build, downloaded and verified on first use), so the suite runs
// on the Deno users run: its type-checker (native TypeScript 7 from runtime 3.0.0-rc.2), its
// `Deno.SQL` and its fixes. Only `DENEXT_DENO=stock` — or, outside a coverage run, a toolchain
// that can't be had (offline on first use) — runs them on the running Deno, with a note.
//
// With `--coverage=<dir>` (the coverage gates) every pass runs on the toolchain and adds
// `--coverage-raw-data-only`, so the profiles accumulate in `<dir>` and `deno coverage <dir>` on
// the toolchain (`scripts/toolchain-deno.ts`) merges them: from 2.9.7-denext.17 its
// `deno coverage` merges a module's plain-run and Vitest-run profiles per emitted form, as the
// union of their lines. The stock files then run in one pass without `--parallel`, the serial
// ones included (a coverage run stays deterministic). `DENEXT_DENO=stock` runs them on the
// running Deno and skips the Vitest files, as without coverage.
//
// Every pass runs with `TMPDIR` / `TMP` / `TEMP` pointing at one temp root of this run's own, which
// is removed when the run ends: the temp dirs tests (and the builds, CLIs and browsers they start)
// make and never remove — scaffolds, build output, profiles — go with it instead of piling up
// in the machine's temp dir. Each test still gets its own directory inside the root.
//
// The parallel and serial passes preload `tests/helpers/watchdog-preload.ts`: every test of every
// stock file gets a stall deadline (10 min by default, `DENEXT_TEST_DEADLINE_MS` to change it, `0`
// to turn it off; a file's own `watchTests(ms)` sets its own), past which it fails with the
// subprocesses it left open and the process tree under the test process, and the run goes on,
// instead of a hung test holding the CI job until its timeout.

import { walk } from "@std/fs/walk";
import { fromFileUrl, join, relative } from "@std/path";
import { SERIAL_TESTS } from "../tests/serial-tests.ts";
import { resolveDenoToolchain, TOOLCHAIN_ENV } from "../src/build/deno-toolchain.ts";
import {
  currentDenoIdentity,
  type DenoIdentity,
  isDenextDenoVersion,
} from "../src/build/deno-version.ts";
import { TEST_VALUE_FLAGS } from "../src/cli/commands/test-passes.ts";

/** The file-name suffix of a test file that runs on denext's Deno toolchain (Vitest's API). */
export const VITEST_SUFFIX = ".vitest.ts";

/** Whether `file` is `entry` or lies under it (a directory, with or without its trailing `/`). */
function covers(entry: string, file: string): boolean {
  const e = entry.replace(/^\.\//, "").replace(/\/$/, "");
  return e === "" || e === "." || file === e || file.startsWith(`${e}/`);
}

/** The `deno test` flags whose value may be the next argument (`--filter foo`). */
const VALUE_FLAGS = TEST_VALUE_FLAGS;

/**
 * `args` split into `--ignore` entries, `--vitest-allow-env` names, flags (with their values),
 * paths and the `--` tail.
 */
function splitArgs(args: readonly string[]) {
  const ignores: string[] = [];
  const vitestEnv: string[] = [];
  const flags: string[] = [];
  const paths: string[] = [];
  const end = args.indexOf("--");
  const own = end === -1 ? args : args.slice(0, end);
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a.startsWith("--ignore=")) {
      ignores.push(...a.slice("--ignore=".length).split(",").filter(Boolean));
    } else if (a.startsWith("--vitest-allow-env=")) {
      vitestEnv.push(...a.slice("--vitest-allow-env=".length).split(",").filter(Boolean));
    } else if (!a.startsWith("-")) paths.push(a);
    else if (VALUE_FLAGS.has(a) && i + 1 < own.length) flags.push(a, own[++i]);
    else flags.push(a);
  }
  return { ignores, vitestEnv, flags, paths, rest: end === -1 ? [] : args.slice(end) };
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
 * The Vitest pass's grants: least privilege. From 2.9.7-denext.16 the Vitest layer's own reads
 * (its config, `__mocks__`, automock) and environment reads need no permission, so these are only
 * what the Vitest files themselves use (temp directories they write and read back). A new Vitest
 * file that needs more adds it here; a preload that reads environment variables names them with
 * `--vitest-allow-env`.
 */
const VITEST_GRANTS: readonly string[] = ["--allow-read", "--allow-write"];

/**
 * The Vitest pass's own flags. A coverage flag stays (see the module header: the toolchain's
 * `deno coverage` merges the Vitest run's profiles with the plain run's from 2.9.7-denext.17).
 *
 * Type-checking is skipped (`--no-check`) unless `typeCheck` — CI — or the flags already decide.
 * Deno keeps one type-check cache per `DENO_DIR` and wipes it whenever another Deno version opens
 * it, so a toolchain build type-checking here would cost the next stock pass its whole cache
 * (~25 s for the suite) on every local run.
 */
function vitestFlags(flags: readonly string[], typeCheck: boolean): string[] {
  const decided = flags.some((f) => /^--(?:no-)?check(?:=|$)/.test(f));
  return typeCheck || decided ? [...flags] : [...flags, "--no-check"];
}

/** Whether `flags` ask for coverage (`--coverage` / `--coverage=<dir>`). */
export function wantsCoverage(flags: readonly string[]): boolean {
  return flags.some((f) => /^--coverage(?:=|$)/.test(f));
}

/** What {@linkcode testPasses} hands back: a pass's `deno test` arguments, or null to skip it. */
export interface TestPasses {
  /**
   * Every stock test file in scope except the serial ones, in parallel — or, with coverage, every
   * stock file in scope (the serial ones included) in one pass without `--parallel`.
   */
  parallel: string[] | null;
  /** The serial files in scope, one at a time (null with coverage: the first pass ran them). */
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
  const split = splitArgs(args);
  const { ignores, paths, rest, vitestEnv } = split;
  const coverage = wantsCoverage(split.flags);
  // Coverage accumulates across the passes: no pass may empty the directory another wrote.
  const flags = coverage && !split.flags.includes("--coverage-raw-data-only")
    ? [...split.flags, "--coverage-raw-data-only"]
    : split.flags;
  const serialFiles = coverage ? [] : inScope(serial, paths, ignores);
  const vitestFiles = inScope(vitest, paths, ignores);
  // A `.vitest.ts` path named on its own is the Vitest pass's alone: stock Deno runs an explicitly
  // named file whatever its name, and cannot resolve `vitest`.
  const stockPaths = paths.filter((p) => !p.endsWith(VITEST_SUFFIX));
  const base = ["test", "-A", "--unstable-kv", ...flags];
  const ignore = [...ignores, ...serialFiles];
  return {
    parallel: paths.length > 0 && stockPaths.length === 0 ? null : [
      ...base,
      ...(coverage ? [] : ["--parallel"]),
      ...(ignore.length > 0 ? [`--ignore=${ignore.join(",")}`] : []),
      ...stockPaths,
      ...rest,
    ],
    serial: serialFiles.length > 0 ? [...base, ...serialFiles, ...rest] : null,
    vitest: vitestFiles.length > 0
      ? [
        "test",
        ...VITEST_GRANTS,
        ...(vitestEnv.length > 0 ? [`--allow-env=${vitestEnv.join(",")}`] : []),
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

/** The module every stock pass preloads: the per-test stall watchdog. */
export const WATCHDOG_PRELOAD = fromFileUrl(
  new URL("../tests/helpers/watchdog-preload.ts", import.meta.url),
);

/**
 * A stock pass's `deno test` arguments with the watchdog preloaded (null stays null).
 *
 * @param args The pass's arguments (`["test", ...]`), or null when it has nothing to run.
 * @param preload The watchdog module.
 */
export function withWatchdog(
  args: string[] | null,
  preload: string = WATCHDOG_PRELOAD,
): string[] | null {
  return args ? [args[0], "--preload", preload, ...args.slice(1)] : null;
}

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

/**
 * Whether a Deno is a denext toolchain build: its `Deno.build.denext` marker (3.0.0-rc.3 on), or a
 * pre-marker build's version (the pinned `3.0.0-rc.N`, or `2.9.7-denext.17` before the fork took
 * its own version). Upstream Deno of the same number is not.
 *
 * @param identity What the Deno says about itself (default: this process's).
 * @returns Whether it is the toolchain.
 */
export function isToolchainBuild(identity: DenoIdentity = currentDenoIdentity()): boolean {
  return isDenextDenoVersion(identity);
}

/**
 * denext's Deno toolchain binary (the running Deno when it already is one), or null when
 * `DENEXT_DENO=stock` opted out. Throws when the toolchain is otherwise unavailable.
 */
export async function toolchainDeno(): Promise<string | null> {
  if (isToolchainBuild()) return Deno.execPath();
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

/**
 * The environment that points a child's temp dir at `root`: `TMPDIR` (macOS, Linux) and
 * `TMP` / `TEMP` (Windows).
 *
 * @param root The directory.
 * @returns The variables.
 */
export function tempRootEnv(root: string): Record<string, string> {
  return { TMPDIR: root, TMP: root, TEMP: root };
}

/**
 * The `DENO_V8_FLAGS` a test pass runs with on Windows: the inherited flags plus a V8 heap of
 * three quarters of the machine's memory (4–8 GiB). Type-checking every test file at once in the
 * parallel pass outgrows V8's default heap on a small Windows host (a 2-CPU runner ran out of
 * memory at 2 GB). Elsewhere, or when the flags already set a heap size, nothing changes.
 *
 * @param os `Deno.build.os`.
 * @param flags The inherited `DENO_V8_FLAGS`, if any.
 * @param totalBytes The machine's memory (`Deno.systemMemoryInfo().total`).
 * @returns The variable to add to the pass's environment, or `{}`.
 */
export function heapEnv(
  os: string,
  flags: string | undefined,
  totalBytes: number,
): Record<string, string> {
  if (os !== "windows" || flags?.includes("--max-old-space-size")) return {};
  const mib = Math.min(8192, Math.max(4096, Math.floor((totalBytes / 1048576) * 0.75)));
  const heap = `--max-old-space-size=${mib}`;
  return { DENO_V8_FLAGS: flags ? `${flags},${heap}` : heap };
}

/**
 * Remove `root`, retrying while Windows reports a file in it still open (a child that is
 * exiting); a root that will not go is reported, never fatal.
 *
 * @param root The run's temp root.
 */
export async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 1;; attempt++) {
    try {
      return await Deno.remove(root, { recursive: true });
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      if (attempt >= 20) {
        console.error(`test-run: could not remove the run's temp root ${root}: ${err}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** The run's temp root, set once by the main block (unset when imported by a test). */
let runTempRoot: string | undefined;

/** Run `deno` (the binary at `bin`) with `args`, inheriting the terminal; true when it succeeded. */
async function deno(args: string[], bin: string = Deno.execPath()): Promise<boolean> {
  const { success } = await new Deno.Command(bin, {
    args,
    env: {
      ...(runTempRoot ? tempRootEnv(runTempRoot) : {}),
      ...heapEnv(Deno.build.os, Deno.env.get("DENO_V8_FLAGS"), Deno.systemMemoryInfo().total),
    },
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return success;
}

/** The Vitest pass: true when it passed or was skipped on purpose. */
async function runVitestPass(args: string[], bin: string | null): Promise<boolean> {
  if (bin === null) {
    console.error(`test-run: ${TOOLCHAIN_ENV}=stock — skipping the Vitest test files.`);
    return true;
  }
  return await deno(args, bin);
}

/**
 * The Deno the parallel and serial passes run on: the toolchain whenever one resolved, else the
 * running Deno (`DENEXT_DENO=stock`, or a toolchain that could not be had).
 *
 * @param toolchain What {@linkcode toolchainFor} resolved: a path, null (stock) or false (failed).
 * @param running The running Deno (`Deno.execPath()`).
 */
export function stockPassDeno(toolchain: string | null | false, running: string): string {
  return typeof toolchain === "string" ? toolchain : running;
}

/** The toolchain: a path, null (`DENEXT_DENO=stock`), or false (it could not be had). */
async function toolchainFor(): Promise<string | null | false> {
  try {
    return await toolchainDeno();
  } catch (err) {
    console.error(`test-run: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Every pass, in order; false when any failed (or the toolchain coverage needs is missing). */
async function runPasses(): Promise<boolean> {
  const ci = (Deno.env.get("CI") ?? "") !== "";
  const passes = testPasses(Deno.args, SERIAL_TESTS, await findVitestFiles(), ci);
  // Every pass runs on the toolchain when it resolves; with coverage it must (its `deno coverage`
  // merges the passes' profiles).
  const coverage = wantsCoverage(splitArgs(Deno.args).flags);
  const toolchain = await toolchainFor();
  if (toolchain === false && coverage) return false;
  // Without coverage an unavailable toolchain fails the Vitest pass alone.
  if (toolchain === false) {
    console.error(`test-run: the stock test files run on ${Deno.execPath()}.`);
  }
  const stock = stockPassDeno(toolchain, Deno.execPath());
  const parallel = await runPass(withWatchdog(passes.parallel), stock);
  const serial = await runPass(withWatchdog(passes.serial), stock);
  const vitest = await vitestPass(passes.vitest, toolchain); // every pass runs, whatever failed
  return parallel && serial && vitest;
}

/** One stock pass (none: passed). */
async function runPass(args: string[] | null, bin: string): Promise<boolean> {
  return args ? await deno(args, bin) : true;
}

/** The Vitest pass (none: passed; no toolchain: failed). */
async function vitestPass(args: string[] | null, toolchain: string | null | false) {
  if (!args) return true;
  return toolchain !== false && await runVitestPass(args, toolchain);
}

if (import.meta.main) {
  runTempRoot = await Deno.makeTempDir({ prefix: "dnx-tr-" });
  let ok = false;
  try {
    ok = await runPasses();
  } finally {
    await removeTempRoot(runTempRoot);
  }
  if (!ok) Deno.exit(1);
}
