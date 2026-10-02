// Per-file coverage floor over an lcov report: `deno coverage --threshold` gates only the
// aggregate, so a small, poorly tested module can hide behind the well-tested rest. This checks
// every source file under the floored prefixes on its own — lines, branches and functions — and
// fails when one is below the floor or was never loaded by any test at all.
//
//   deno run --allow-read scripts/coverage-floor.ts coverage/lcov.info [--floor 85] [--report]
//
// `--report` prints every floored file's numbers (not only the failures) and always exits 0.

import { join, relative, resolve } from "@std/path";

/** The source trees held to the per-file floor (relative to the project root). */
export const FLOORED: readonly { dir: string; match: RegExp }[] = [
  { dir: "src/desktop", match: /\.ts$/ }, // recursive (caps/ included)
  { dir: "src/build", match: /^desktop[^/]*\.ts$/ }, // top level only: no "/" in the match
];

/** One file's totals from an lcov record. */
export interface FileCoverage {
  lines: [hit: number, found: number];
  branches: [hit: number, found: number];
  functions: [hit: number, found: number];
}

/** Whether an lcov hit count (`-` = never evaluated) counts as covered. */
const hit = (count: string | undefined): boolean => count !== "-" && Number(count) > 0;

/** How each counted lcov record line updates a file's totals. */
const COUNTERS: Record<string, (cov: FileCoverage, rest: string) => void> = {
  "DA:": (cov, rest) => tally(cov.lines, hit(rest.split(",")[1])),
  "BRDA:": (cov, rest) => tally(cov.branches, hit(rest.split(",")[3])),
  "FNDA:": (cov, rest) => tally(cov.functions, hit(rest.split(",")[0])),
};

function tally(pair: [number, number], covered: boolean): void {
  pair[1]++;
  if (covered) pair[0]++;
}

/** Parse lcov text into absolute path → totals (counted from the DA / BRDA / FNDA lines). */
export function parseLcov(text: string): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  let cur: FileCoverage | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      cur = { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
      out.set(line.slice(3), cur);
      continue;
    }
    if (line === "end_of_record") cur = undefined;
    const tag = line.slice(0, line.indexOf(":") + 1);
    if (cur && Object.hasOwn(COUNTERS, tag)) COUNTERS[tag](cur, line.slice(tag.length));
  }
  return out;
}

/** A percentage (100 when there is nothing to cover). */
export function pct([hit, found]: [number, number]): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

/** Every file under `dir` (recursively), as absolute paths. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) out.push(...await walk(p));
    else if (e.isFile) out.push(p);
  }
  return out;
}

/** The floored source files on disk, relative to `root` (POSIX separators), sorted. */
export async function flooredFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const { dir, match } of FLOORED) {
    for (const p of await walk(join(root, dir))) {
      const rel = relative(join(root, dir), p).replaceAll("\\", "/");
      if (match.test(rel)) files.push(`${dir}/${rel}`);
    }
  }
  return files.sort();
}

/** One floored file's verdict. */
export interface FloorResult {
  file: string;
  coverage?: FileCoverage;
  failures: string[];
}

/**
 * Check every floored file against `floor` percent.
 *
 * @param files The floored files (relative to `root`).
 * @param lcov The parsed lcov report (absolute paths).
 * @param root The project root.
 * @param floor The per-file minimum, in percent.
 */
export function checkFloor(
  files: readonly string[],
  lcov: Map<string, FileCoverage>,
  root: string,
  floor: number,
): FloorResult[] {
  return files.map((file) => {
    const coverage = lcov.get(resolve(root, file));
    if (!coverage) return { file, failures: ["never loaded by a test"] };
    const failures: string[] = [];
    for (const kind of ["lines", "branches", "functions"] as const) {
      const p = pct(coverage[kind]);
      if (p < floor) failures.push(`${kind} ${p.toFixed(1)}%`);
    }
    return { file, coverage, failures };
  });
}

function row(r: FloorResult): string {
  const c = r.coverage;
  const cell = (k: keyof FileCoverage) => c ? pct(c[k]).toFixed(1).padStart(6) : "     -";
  return `${cell("lines")} ${cell("branches")} ${cell("functions")}  ${r.file}` +
    (r.failures.length ? `   <- ${r.failures.join(", ")}` : "");
}

/**
 * The CLI: check (or, with `--report`, print) the floor; returns the exit code.
 *
 * @param args `<lcov.info> [--floor <percent>] [--report]`.
 * @param root The project root (default: the working directory).
 */
export async function main(args: string[], root: string = resolve(".")): Promise<number> {
  const input = args.find((a) => !a.startsWith("--"));
  if (!input) {
    console.error("usage: coverage-floor.ts <lcov.info> [--floor 85] [--report]");
    return 2;
  }
  const at = args.indexOf("--floor");
  const floor = at === -1 ? 85 : Number(args[at + 1]);
  const results = checkFloor(
    await flooredFiles(root),
    parseLcov(await Deno.readTextFile(input)),
    root,
    floor,
  );
  const failing = results.filter((r) => r.failures.length > 0);
  if (args.includes("--report")) {
    console.log(" lines branch  funcs  file");
    for (const r of results) console.log(row(r));
    return 0;
  }
  if (failing.length === 0) {
    console.log(`coverage floor: ${results.length} files at or above ${floor}% each`);
    return 0;
  }
  console.error(`coverage floor: ${failing.length} file(s) below ${floor}% (lines branch funcs):`);
  for (const r of failing) console.error(row(r));
  return 1;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
