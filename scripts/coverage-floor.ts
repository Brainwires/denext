// Per-file coverage floor over an lcov report: `deno coverage --threshold` gates only the
// aggregate, so a small, poorly tested module can hide behind the well-tested rest. This checks
// every source file under the floored prefixes on its own — lines, branches and functions — and
// fails when one is below the floor or was never loaded by any test at all.
//
//   deno run --allow-read scripts/coverage-floor.ts coverage/lcov.info [--floor 85] [--full] [--report]
//
// `--full` (the whole-suite run, `deno task coverage:floor`) also floors FLOORED_FULL, files the
// desktop-only run never loads. `--report` prints every floored file's numbers (not only the
// failures) and always exits 0.

import { join, relative, resolve } from "@std/path";
import { canonicalPath } from "./coverage-to-istanbul.ts";

export { canonicalPath };

/** The source trees held to the per-file floor (relative to the project root). */
export const FLOORED: readonly { dir: string; match: RegExp }[] = [
  { dir: "src/desktop", match: /\.ts$/ }, // recursive (caps/ included)
  // top level only (no "/" in the match): the desktop build/package code, the full-app update
  // format, the archive extractor it unpacks with, and the project/file locks
  {
    dir: "src/build",
    match: /^(desktop[^/]*|app-update|safe-extract|file-lock|project-locks)\.ts$/,
  },
  { dir: "src/cli/commands", match: /^desktop[^/]*\.ts$/ }, // the `denext desktop` verbs
  // the desktop paths of the shared mobile/desktop client modules
  { dir: "src/mobile", match: /^(desktop-queue|open-file|notification-trigger)\.ts$/ },
  { dir: "src/react-native", match: /^desktop\.ts$/ }, // React Native's desktop runtime
];

/**
 * Floored only on the whole-suite run (`--full`): files outside the desktop surface, added as
 * their tests reach the floor. A ratchet for the 4.x files that sat under 50% lines: the rest of
 * them (src/deploy/adapter.ts, tanstack-start's toolchain.ts, src/build/deploy-flow.ts,
 * src/cli/commands/profile.ts and dashboard.ts) join this list as their tests land.
 */
export const FLOORED_FULL: readonly { dir: string; match: RegExp }[] = [
  { dir: "src/cli", match: /^cli-cache\.ts$/ }, // the remote CLI's offline module cache
  { dir: "packages/tanstack-start/src", match: /^use-server\.ts$/ }, // a "use server" module's browser half
];

/** One file's totals from an lcov record. */
export interface FileCoverage {
  lines: [hit: number, found: number];
  branches: [hit: number, found: number];
  functions: [hit: number, found: number];
}

/** Whether an lcov hit count (`-` = never evaluated) counts as covered. */
const hit = (count: string | undefined): boolean => count !== "-" && Number(count) > 0;

/** A counted lcov record line: which total it feeds, the point it names, and whether it ran. */
type Point = [kind: keyof FileCoverage, key: string, covered: boolean];

/** How each counted lcov record line names its point (DA / BRDA / FNDA). */
const COUNTERS: Record<string, (rest: string) => Point> = {
  "DA:": (rest) => {
    const [line, count] = rest.split(",");
    return ["lines", line, hit(count)];
  },
  "BRDA:": (rest) => {
    const [line, block, branch, count] = rest.split(",");
    return ["branches", `${line},${block},${branch}`, hit(count)];
  },
  "FNDA:": (rest) => {
    const at = rest.indexOf(",");
    return ["functions", rest.slice(at + 1), hit(rest.slice(0, at))];
  },
};

/** A file's points (`<key>#<occurrence>` → covered), across every record naming it. */
type Points = Record<keyof FileCoverage, Map<string, boolean>>;

/**
 * Parse lcov text into absolute path → totals (counted from the DA / BRDA / FNDA lines).
 *
 * Records whose paths `canonical` maps to one file are merged: a point counts once, covered when
 * any record covered it (a run under a symlinked directory writes both spellings of a path).
 *
 * @param text The lcov report.
 * @param canonical Maps each `SF:` path to its key (default: as written; the CLIs pass
 *   {@linkcode canonicalPath}).
 */
export function parseLcov(
  text: string,
  canonical: (path: string) => string = (p) => p,
): Map<string, FileCoverage> {
  const files = new Map<string, Points>();
  let cur: Points | undefined;
  // Within one record each line is its own point (`<key>#<n>`), as it always counted; across
  // records the n-th occurrence of a key is the same point.
  let seen = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      cur = pointsOf(files, canonical(line.slice(3)));
      seen = new Map();
    } else if (line === "end_of_record") {
      cur = undefined;
    } else if (cur) {
      recordPoint(cur, seen, line);
    }
  }
  const out = new Map<string, FileCoverage>();
  for (const [path, points] of files) {
    out.set(path, {
      lines: totals(points.lines),
      branches: totals(points.branches),
      functions: totals(points.functions),
    });
  }
  return out;
}

/** The points recorded for `path` so far, created empty on its first record. */
function pointsOf(files: Map<string, Points>, path: string): Points {
  let points = files.get(path);
  if (!points) {
    points = { lines: new Map(), branches: new Map(), functions: new Map() };
    files.set(path, points);
  }
  return points;
}

/** Count one record line (a DA / BRDA / FNDA; any other is ignored) into `points`. */
function recordPoint(points: Points, seen: Map<string, number>, line: string): void {
  const tag = line.slice(0, line.indexOf(":") + 1);
  if (!Object.hasOwn(COUNTERS, tag)) return;
  const [kind, key, covered] = COUNTERS[tag](line.slice(tag.length));
  const id = `${kind}:${key}`;
  const n = (seen.get(id) ?? 0) + 1;
  seen.set(id, n);
  const point = `${key}#${n}`;
  points[kind].set(point, covered || (points[kind].get(point) ?? false));
}

/** `[covered, total]` over a file's points of one kind. */
function totals(points: Map<string, boolean>): [number, number] {
  let covered = 0;
  for (const c of points.values()) if (c) covered++;
  return [covered, points.size];
}

/** A percentage (100 when there is nothing to cover). */
export function pct([hit, found]: [number, number]): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

/** Every file under `dir` (recursively), as absolute paths; none when `dir` does not exist. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    await Deno.stat(dir);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return out;
    throw e;
  }
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) out.push(...await walk(p));
    else if (e.isFile) out.push(p);
  }
  return out;
}

/**
 * The floored source files on disk, relative to `root` (POSIX separators), sorted.
 *
 * @param root The project root.
 * @param full Include {@linkcode FLOORED_FULL} (the whole-suite run).
 */
export async function flooredFiles(root: string, full = false): Promise<string[]> {
  const files: string[] = [];
  for (const { dir, match } of full ? [...FLOORED, ...FLOORED_FULL] : FLOORED) {
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
 * @param args `<lcov.info> [--floor <percent>] [--full] [--report]`.
 * @param root The project root (default: the working directory).
 */
export async function main(args: string[], root: string = resolve(".")): Promise<number> {
  const input = args.find((a) => !a.startsWith("--"));
  if (!input) {
    console.error("usage: coverage-floor.ts <lcov.info> [--floor 85] [--full] [--report]");
    return 2;
  }
  const at = args.indexOf("--floor");
  const floor = at === -1 ? 85 : Number(args[at + 1]);
  // Both sides resolved: a root reached through a symlink (macOS `/var` → `/private/var`) and
  // the report's paths, which may spell it either way, must meet.
  const real = canonicalPath(root);
  const results = checkFloor(
    await flooredFiles(real, args.includes("--full")),
    parseLcov(await Deno.readTextFile(input), canonicalPath),
    real,
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
