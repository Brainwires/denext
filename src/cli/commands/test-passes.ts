// `denext test` in two passes when the project has Vitest files: the `Deno.test` files Deno's
// discovery finds, then the `*.vitest.ts` files it skips (named so a plain `deno test` never
// loads `vitest`). With `--coverage[=<dir>]` both passes write raw profiles into one directory
// and ONE report is made from them on denext's Deno toolchain, whose `deno coverage` maps each
// profile back through the source map of the form its module was emitted in (the Vitest layer
// rewrites the code a module emits) and merges the two line for line. Pure planning here; the
// verb in `toolchain.ts` runs the plan.

import { join } from "@std/path";

/** A Vitest test file: `<name>.vitest.ts` (or `.tsx` / `.js` / `.mjs` / …). */
const VITEST_FILE = /\.vitest\.[cm]?[jt]sx?$/;

/** Directories never searched for Vitest files (dependencies, dot dirs, build / coverage output). */
const SKIP_DIR = /^(?:node_modules|\..+|out|dist|coverage)$/;

/** The `deno test` flags whose value may be the next argument (`--filter foo`). */
export const TEST_VALUE_FLAGS: ReadonlySet<string> = new Set([
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

/** `deno test` arguments split into flags (with their values), paths and the `--` tail. */
export interface TestArgs {
  /** Flags, each followed by its value when it takes one as the next argument. */
  readonly flags: readonly string[];
  /** Test files / directories named on the command line. */
  readonly paths: readonly string[];
  /** `--` and what follows it (arguments for the tests). */
  readonly tail: readonly string[];
}

/**
 * Split forwarded `deno test` arguments.
 *
 * @param args The arguments after `denext test`.
 * @returns The flags, paths and `--` tail.
 */
export function splitTestArgs(args: readonly string[]): TestArgs {
  const end = args.indexOf("--");
  const own = end === -1 ? args : args.slice(0, end);
  const flags: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (!a.startsWith("-")) paths.push(a);
    else if (TEST_VALUE_FLAGS.has(a) && i + 1 < own.length) flags.push(a, own[++i]);
    else flags.push(a);
  }
  return { flags, paths, tail: end === -1 ? [] : args.slice(end) };
}

/**
 * The directory `--coverage[=<dir>]` writes (`coverage` without a value), or undefined.
 *
 * @param args The forwarded `deno test` arguments.
 * @returns The coverage directory, or undefined.
 */
export function coverageDir(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--coverage") return "coverage";
    if (arg.startsWith("--coverage=")) return arg.slice("--coverage=".length) || "coverage";
  }
  return undefined;
}

/** What `denext test` runs: `deno` argument lists, in order. */
export interface TestPlan {
  /** The test passes (`deno test …`), every one run even when an earlier one fails. */
  readonly passes: readonly string[][];
  /**
   * The coverage directory whose raw profiles go before the passes (a combined report only): see
   * {@link clearCoverageProfiles} — never the directory itself.
   */
  readonly clean?: string;
  /** The `deno coverage …` runs that make the combined report, after the passes. */
  readonly report: readonly string[][];
  /** Why the Vitest files were left out, when they were. */
  readonly note?: string;
}

/**
 * Plan `denext test`. Paths named on the command line, or a project with no Vitest files, run as
 * one `deno test -A` exactly as typed. Otherwise the `Deno.test` files run, then the Vitest
 * files; with coverage both add `--coverage-raw-data-only`, and the combined report (summary,
 * `<dir>/lcov.info`, `<dir>/html/`) is made afterwards, as `deno test --coverage` makes it for
 * one pass. The verb runs on denext's Deno toolchain, whose `deno test` has Vitest's API.
 *
 * @param args The arguments after `denext test`.
 * @param vitestFiles The project's Vitest files (see {@link findVitestFiles}).
 * @returns The plan.
 */
export function planTestRun(args: readonly string[], vitestFiles: readonly string[]): TestPlan {
  const { flags, paths, tail } = splitTestArgs(args);
  const single: TestPlan = { passes: [["test", "-A", ...args]], report: [] };
  const help = flags.includes("--help") || flags.includes("-h");
  if (paths.length > 0 || vitestFiles.length === 0 || help) return single;
  const skipped = (why: string): TestPlan => ({
    ...single,
    note: `${vitestFiles.length} Vitest file(s) not run: ${why}`,
  });
  // A watched pass never ends, so a second could never start: name the Vitest files to watch them.
  if (flags.includes("--watch") || flags.some((f) => f.startsWith("--watch="))) {
    return skipped("--watch runs one pass (name the Vitest files to watch them)");
  }
  const dir = coverageDir(flags);
  const combine = dir !== undefined && !flags.includes("--coverage-raw-data-only");
  const passFlags = combine ? [...flags, "--coverage-raw-data-only"] : [...flags];
  return {
    passes: [
      ["test", "-A", ...passFlags, ...tail],
      ["test", "-A", ...passFlags, ...vitestFiles, ...tail],
    ],
    ...(combine ? { clean: dir } : {}),
    report: combine
      ? [
        ["coverage", dir],
        ["coverage", dir, "--lcov", `--output=${dir}/lcov.info`],
        ["coverage", dir, "--html"],
      ]
      : [],
  };
}

/** A raw coverage profile `deno test --coverage` writes: `<uuid>.json`. */
const PROFILE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

/**
 * Remove the raw profiles an earlier run left in `dir` (so the combined report covers this run
 * only), and nothing else: `--coverage=.` or `--coverage=src` names a directory that holds the
 * project, which must survive. Returns how many profiles went.
 *
 * @param dir The coverage directory (absolute).
 * @returns The number of files removed.
 */
export async function clearCoverageProfiles(dir: string): Promise<number> {
  let removed = 0;
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !PROFILE_FILE.test(e.name)) continue;
      await Deno.remove(join(dir, e.name));
      removed++;
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return removed;
}

/**
 * Every Vitest file (`*.vitest.ts`, …) under `root`, relative to it with `/` separators, sorted.
 * `node_modules`, dot directories and build / coverage output are skipped.
 *
 * @param root The project directory.
 * @returns The files.
 */
export async function findVitestFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, rel: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return;
    }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory && !SKIP_DIR.test(e.name)) await visit(join(dir, e.name), path);
      else if (e.isFile && VITEST_FILE.test(e.name)) out.push(path);
    }
  };
  await visit(root, "");
  return out.sort();
}
