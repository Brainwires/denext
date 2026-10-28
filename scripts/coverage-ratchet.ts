// A per-file coverage ratchet over an lcov report: every module under RATCHETED keeps at least the
// line / branch / function coverage scripts/coverage-baseline.json records for it, so a file's
// coverage can only go up. coverage-floor.ts holds a few surfaces to a fixed 85%; this holds the
// rest of the CLI, the server, the compat layer, the DevTools panel's panes and the plugin
// packages to where they are.
//
//   deno run --allow-read scripts/coverage-ratchet.ts coverage/lcov.info            # check
//   deno run --allow-read --allow-write scripts/coverage-ratchet.ts coverage/lcov.info --update
//
// The check fails when a recorded file drops below its baseline (by more than one line, branch or
// function: a timing-dependent branch must not fail a run), or a file new to the baseline is under
// NEW_FILE_FLOOR. `--update` raises every recorded number the report beats, adds new files at what
// they reach and drops files that no longer exist; it never lowers a number. A lowered number is a
// hand edit of the baseline, visible in review. Raise it from CI's report without re-running the
// suite: `gh run download <run> -n coverage-lcov -D coverage`, then `deno task coverage:ratchet:update`.

import { join, relative, resolve } from "@std/path";
import { type FileCoverage, parseLcov, pct } from "./coverage-floor.ts";

/** The trees the ratchet covers (relative to the project root): `.ts` / `.tsx` modules in them. */
export const RATCHETED: readonly string[] = [
  "src/cli",
  "src/server",
  "src/compat",
  "src/client/devtools-panel",
  "packages",
];

/** Paths under {@linkcode RATCHETED} that are not source: generated wasm-bindgen glue, npm trees. */
const SKIPPED = /(^|\/)(lib|node_modules)\/|\.d\.ts$/;

/** The floor a module new to the baseline must reach (the project's per-file target). */
export const NEW_FILE_FLOOR = 85;

/** Where the baseline lives (relative to the project root). */
export const BASELINE_FILE = "scripts/coverage-baseline.json";

/** The kinds of coverage, in the order a baseline entry lists them. */
const KINDS = ["lines", "branches", "functions"] as const;

/** One file's recorded floors: whole percentages of lines, branches and functions. */
export type BaselineEntry = [lines: number, branches: number, functions: number];

/** File (relative, POSIX separators) → its floors. */
export type Baseline = Record<string, BaselineEntry>;

/** Whether `rel` (relative to the root) is a module the ratchet covers. */
export function ratcheted(rel: string): boolean {
  return RATCHETED.some((dir) => rel.startsWith(`${dir}/`)) && /\.tsx?$/.test(rel) &&
    !SKIPPED.test(rel);
}

/**
 * The project root an lcov report was written under: the directory holding the report's own
 * `src/server/` (the shortest such prefix, so an example's `src/server` never wins). A report CI
 * wrote (`/home/runner/work/denext/denext/...`) is then read on another machine as it is in CI.
 *
 * @param paths The report's source paths.
 * @returns The root, or `null` when no path is under a `src/server/`.
 */
export function lcovRoot(paths: Iterable<string>): string | null {
  let best: string | null = null;
  for (const path of paths) {
    const at = path.replaceAll("\\", "/").indexOf("/src/server/");
    if (at === -1) continue;
    const root = path.slice(0, at);
    if (best === null || root.length < best.length) best = root;
  }
  return best;
}

/** Every covered module in `lcov`, relative to `root`, with its coverage. */
export function ratchetedCoverage(
  lcov: Map<string, FileCoverage>,
  root: string,
): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  for (const [abs, cov] of lcov) {
    const rel = relative(root, abs).replaceAll("\\", "/");
    if (ratcheted(rel)) out.set(rel, cov);
  }
  return out;
}

/**
 * A file's whole-percentage floors (rounded down, so the run that recorded them passes). A kind
 * with nothing counted records 0, not 100: `deno coverage` lists the branches of the functions
 * that ran, so a module no test called into counts none yet, and its first real tests must not
 * read as a drop.
 */
export function floors(cov: FileCoverage): BaselineEntry {
  return KINDS.map((k) => cov[k][1] === 0 ? 0 : Math.floor(pct(cov[k]))) as BaselineEntry;
}

/**
 * How far below its floor a kind may read before it fails: one item's worth (one line, branch or
 * function of the file) and at least one point, so a timing-dependent branch does not flip a run.
 */
export function slack([, found]: [number, number]): number {
  return found === 0 ? 0 : Math.max(1, 100 / found);
}

/** One file's verdict. */
export interface RatchetResult {
  readonly file: string;
  /** Why it fails (empty: it passes). */
  readonly failures: string[];
  /** The kinds it now beats its floor on by at least a whole point (the baseline can rise). */
  readonly raised: string[];
}

/**
 * Check `coverage` (relative path → coverage) against `baseline`.
 *
 * @param coverage The covered modules this run loaded.
 * @param baseline The recorded floors.
 * @param exists Whether a recorded file still exists (a deleted one is no failure).
 */
export function checkRatchet(
  coverage: Map<string, FileCoverage>,
  baseline: Baseline,
  exists: (file: string) => boolean,
): RatchetResult[] {
  const files = [...new Set([...coverage.keys(), ...Object.keys(baseline)])].sort();
  const results: RatchetResult[] = [];
  for (const file of files) {
    const cov = coverage.get(file);
    const floor = Object.hasOwn(baseline, file) ? baseline[file] : undefined;
    if (!cov) {
      // Recorded, but no test loaded it this run (a module that was deleted is fine).
      if (floor && exists(file) && floor.some((n) => n > 0)) {
        results.push({ file, failures: ["never loaded by a test"], raised: [] });
      }
      continue;
    }
    const failures: string[] = [];
    const raised: string[] = [];
    KINDS.forEach((kind, i) => {
      const p = pct(cov[kind]);
      if (!floor) {
        if (p < NEW_FILE_FLOOR) {
          failures.push(`${kind} ${p.toFixed(1)}% (a new file: at least ${NEW_FILE_FLOOR}%)`);
        }
        return;
      }
      if (p + slack(cov[kind]) < floor[i]) {
        failures.push(`${kind} ${p.toFixed(1)}% (baseline ${floor[i]}%)`);
      } else if (cov[kind][1] > 0 && Math.floor(p) > floor[i]) {
        raised.push(`${kind} ${floor[i]} → ${Math.floor(p)}`);
      }
    });
    results.push({ file, failures, raised });
  }
  return results;
}

/**
 * The baseline after this run: every number the run beats is raised, new files are added at what
 * they reach, files that no longer exist are dropped, and nothing is lowered.
 */
export function updateBaseline(
  coverage: Map<string, FileCoverage>,
  baseline: Baseline,
  exists: (file: string) => boolean,
): Baseline {
  const next: Baseline = {};
  for (const [file, floor] of Object.entries(baseline)) if (exists(file)) next[file] = floor;
  for (const [file, cov] of coverage) {
    const now = floors(cov);
    const old = next[file];
    next[file] = old ? old.map((n, i) => Math.max(n, now[i])) as BaselineEntry : now;
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

/** The baseline as it is written: one file per line, so a raise is a one-line diff. */
export function formatBaseline(baseline: Record<string, readonly number[]>): string {
  const rows = Object.entries(baseline).map(([f, e]) =>
    `  ${JSON.stringify(f)}: [${e.join(", ")}]`
  );
  return `{\n${rows.join(",\n")}\n}\n`;
}

/** The baseline JSON at `path` (none: empty); the sanitizer ratchet reads its own with it too. */
export async function readBaseline<T = Baseline>(path: string): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {} as T;
    throw e;
  }
}

function existsIn(root: string): (file: string) => boolean {
  return (file) => {
    try {
      return Deno.statSync(join(root, file)).isFile;
    } catch {
      return false;
    }
  };
}

/**
 * The CLI: check the ratchet, or with `--update` rewrite the baseline; returns the exit code.
 *
 * @param args `<lcov.info> [--update] [--baseline <path>]`.
 * @param root The project root (default: the working directory).
 */
export async function main(args: string[], root: string = resolve(".")): Promise<number> {
  const at = args.indexOf("--baseline");
  const input = args.find((a, i) => !a.startsWith("--") && (at === -1 || i !== at + 1));
  if (!input) {
    console.error("usage: coverage-ratchet.ts <lcov.info> [--update] [--baseline <path>]");
    return 2;
  }
  const baselinePath = at === -1 ? join(root, BASELINE_FILE) : resolve(root, args[at + 1]);
  const lcov = parseLcov(await Deno.readTextFile(input));
  const coverage = ratchetedCoverage(lcov, lcovRoot(lcov.keys()) ?? root);
  const baseline = await readBaseline(baselinePath);
  const exists = existsIn(root);
  if (args.includes("--update")) {
    const next = updateBaseline(coverage, baseline, exists);
    await Deno.writeTextFile(baselinePath, formatBaseline(next));
    console.log(`coverage ratchet: ${Object.keys(next).length} files recorded in ${baselinePath}`);
    return 0;
  }
  const results = checkRatchet(coverage, baseline, exists);
  const failing = results.filter((r) => r.failures.length > 0);
  const raised = results.filter((r) => r.raised.length > 0 && r.failures.length === 0);
  if (raised.length > 0) {
    console.log(
      `coverage ratchet: ${raised.length} file(s) above their baseline; record them with ` +
        "`deno task coverage:ratchet:update`:",
    );
    for (const r of raised) console.log(`  ${r.file}: ${r.raised.join(", ")}`);
  }
  if (failing.length === 0) {
    console.log(`coverage ratchet: ${results.length} files at or above their baseline`);
    return 0;
  }
  console.error(`coverage ratchet: ${failing.length} file(s) below their baseline:`);
  for (const r of failing) console.error(`  ${r.file}: ${r.failures.join(", ")}`);
  return 1;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
