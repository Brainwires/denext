// A per-file ratchet over the test files' sanitizer opt-outs (`sanitizeOps` / `sanitizeResources`
// set to `false`): scripts/sanitizer-baseline.json records, for every test file under `tests/`, how
// many opt-outs it has and how many of them carry no reason, so neither number can go up. An
// opt-out hides a leaked timer, child process or socket from Deno's sanitizers, and a leak hidden
// that way has hung the watchdog and stalled Windows CI more than once.
//
//   deno run --allow-read scripts/sanitizer-ratchet.ts            # check
//   deno run --allow-read --allow-write scripts/sanitizer-ratchet.ts --update
//
// The check fails when a file has more opt-outs than its baseline records (a file new to the
// baseline records none), or more opt-outs without a reason. A reason is a `// sanitizer: <why>`
// comment on the opt-out's own line or in the comment block directly above it (other opt-out lines
// between them share it): an opt-out is kept only where the test means it, a deliberately detached
// child, say. `--update` (`deno task sanitizers:ratchet:update`) lowers every number the tree beats
// and drops the files that have none left; it never raises one. A raised number is a hand edit of
// the baseline, visible in review, next to the new opt-out's reason. tests/sanitizer-ratchet.test.ts
// is the drift test `deno task precheck` runs.

import { walk } from "@std/fs/walk";
import { fromFileUrl, join, relative, resolve } from "@std/path";

/** Where the baseline lives (relative to the project root). */
export const BASELINE_FILE = "scripts/sanitizer-baseline.json";

/** The tree whose files the ratchet scans (relative to the project root). */
export const SCANNED = "tests";

/** One sanitizer opt-out (the `false` of `sanitizeOps` or `sanitizeResources`). */
const OPT_OUT = /\bsanitize(?:Ops|Resources)\s*:\s*false\b/g;

/** A reason comment: `// sanitizer: <why>`, the why not empty. */
const REASON = /\/\/\s*sanitizer:\s*\S/;

/** A line that is nothing but opt-outs (`sanitizeOps: false,`), which shares the reason above it. */
const OPT_OUT_ONLY = /^\s*(?:sanitize(?:Ops|Resources)\s*:\s*false\s*,?\s*)+$/;

/** One file's recorded ceilings: its opt-outs, and those of them without a reason. */
export type BaselineEntry = [optOuts: number, unexplained: number];

/** File (relative, POSIX separators) → its ceilings. */
export type Baseline = Record<string, BaselineEntry>;

/** One file's opt-outs as the scan finds them. */
export interface FileOptOuts {
  /** Every opt-out in the file. */
  readonly optOuts: number;
  /** The 1-based lines of the opt-outs that carry no reason (a line once per opt-out on it). */
  readonly unexplained: number[];
}

/** Whether the line at `i` (0-based) has a reason: on itself or in the comment block above it. */
function hasReason(lines: readonly string[], i: number): boolean {
  if (REASON.test(lines[i])) return true;
  let j = i - 1;
  while (j >= 0 && OPT_OUT_ONLY.test(lines[j])) j--;
  for (; j >= 0 && /^\s*\/\//.test(lines[j]); j--) {
    if (REASON.test(lines[j])) return true;
  }
  return false;
}

/**
 * The opt-outs in one file's source.
 *
 * @param source The file's text.
 * @returns The count and the lines of the ones without a reason.
 */
export function scanOptOuts(source: string): FileOptOuts {
  const lines = source.split("\n");
  let optOuts = 0;
  const unexplained: number[] = [];
  lines.forEach((line, i) => {
    const n = line.match(OPT_OUT)?.length ?? 0;
    if (n === 0) return;
    optOuts += n;
    if (!hasReason(lines, i)) { for (let k = 0; k < n; k++) unexplained.push(i + 1); }
  });
  return { optOuts, unexplained };
}

/**
 * Every file under {@linkcode SCANNED} with at least one opt-out, by relative path.
 *
 * @param root The project root.
 */
export async function scanTree(root: string): Promise<Map<string, FileOptOuts>> {
  const out = new Map<string, FileOptOuts>();
  for await (
    const e of walk(join(root, SCANNED), {
      exts: [".ts", ".tsx", ".js", ".mjs"],
      includeDirs: false,
      skip: [/[/\\]node_modules[/\\]/],
    })
  ) {
    const found = scanOptOuts(await Deno.readTextFile(e.path));
    if (found.optOuts > 0) out.set(relative(root, e.path).replaceAll("\\", "/"), found);
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** One file's verdict. */
export interface RatchetResult {
  readonly file: string;
  /** Why it fails (empty: it passes). */
  readonly failures: string[];
  /** Whether it is under its baseline (the baseline can be lowered). */
  readonly lowered: boolean;
}

/**
 * Check `scan` (relative path → opt-outs) against `baseline`.
 *
 * @param scan The files with opt-outs.
 * @param baseline The recorded ceilings.
 */
export function checkRatchet(scan: Map<string, FileOptOuts>, baseline: Baseline): RatchetResult[] {
  const files = [...new Set([...scan.keys(), ...Object.keys(baseline)])].sort();
  return files.map((file) => {
    const now = scan.get(file) ?? { optOuts: 0, unexplained: [] };
    const [maxOptOuts, maxUnexplained] = Object.hasOwn(baseline, file) ? baseline[file] : [0, 0];
    const failures: string[] = [];
    if (now.optOuts > maxOptOuts) {
      failures.push(`${now.optOuts} opt-outs (baseline ${maxOptOuts})`);
    }
    if (now.unexplained.length > maxUnexplained) {
      failures.push(
        `${now.unexplained.length} without a \`// sanitizer: <reason>\` comment (baseline ` +
          `${maxUnexplained}; lines ${[...new Set(now.unexplained)].join(", ")})`,
      );
    }
    const lowered = now.optOuts < maxOptOuts || now.unexplained.length < maxUnexplained;
    return { file, failures, lowered };
  });
}

/**
 * The baseline after this scan: every number the tree beats is lowered, files with no opt-out left
 * are dropped, and nothing is raised or added.
 */
export function lowerBaseline(scan: Map<string, FileOptOuts>, baseline: Baseline): Baseline {
  const next: Baseline = {};
  for (const [file, [optOuts, unexplained]] of Object.entries(baseline)) {
    const now = scan.get(file);
    if (!now) continue;
    next[file] = [Math.min(optOuts, now.optOuts), Math.min(unexplained, now.unexplained.length)];
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

/** The baseline as it is written: one file per line, so a change is a one-line diff. */
export function formatBaseline(baseline: Baseline): string {
  const rows = Object.entries(baseline).map(([f, e]) =>
    `  ${JSON.stringify(f)}: [${e.join(", ")}]`
  );
  return `{\n${rows.join(",\n")}\n}\n`;
}

/** The baseline at `path` (none: empty). */
export async function readBaseline(path: string): Promise<Baseline> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Baseline;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {};
    throw e;
  }
}

/** The totals of a scan: opt-outs, and those without a reason. */
export function totals(scan: Map<string, FileOptOuts>): [number, number] {
  let optOuts = 0;
  let unexplained = 0;
  for (const f of scan.values()) {
    optOuts += f.optOuts;
    unexplained += f.unexplained.length;
  }
  return [optOuts, unexplained];
}

/**
 * The CLI: check the ratchet, or with `--update` lower the baseline; returns the exit code.
 *
 * @param args `[--update] [--baseline <path>]`.
 * @param root The project root (default: this checkout).
 */
export async function main(
  args: string[],
  root: string = fromFileUrl(new URL("../", import.meta.url)),
): Promise<number> {
  const at = args.indexOf("--baseline");
  const baselinePath = at === -1 ? join(root, BASELINE_FILE) : resolve(root, args[at + 1]);
  const scan = await scanTree(root);
  const baseline = await readBaseline(baselinePath);
  const [optOuts, unexplained] = totals(scan);
  if (args.includes("--update")) {
    const next = lowerBaseline(scan, baseline);
    await Deno.writeTextFile(baselinePath, formatBaseline(next));
    console.log(
      `sanitizer ratchet: ${Object.keys(next).length} files recorded in ${baselinePath} ` +
        `(${optOuts} opt-outs, ${unexplained} without a reason)`,
    );
    return 0;
  }
  const results = checkRatchet(scan, baseline);
  const failing = results.filter((r) => r.failures.length > 0);
  const lowered = results.filter((r) => r.lowered && r.failures.length === 0);
  if (lowered.length > 0) {
    console.log(
      `sanitizer ratchet: ${lowered.length} file(s) under their baseline; lower it with ` +
        "`deno task sanitizers:ratchet:update`",
    );
  }
  if (failing.length === 0) {
    console.log(
      `sanitizer ratchet: ${scan.size} files at or under their baseline ` +
        `(${optOuts} opt-outs, ${unexplained} without a reason)`,
    );
    return 0;
  }
  console.error(`sanitizer ratchet: ${failing.length} file(s) over their baseline:`);
  for (const r of failing) console.error(`  ${r.file}: ${r.failures.join("; ")}`);
  console.error(
    "Fix the leak the opt-out hides (close the server, await the child, clear the timer). If the " +
      "opt-out is meant, give it a `// sanitizer: <reason>` comment and raise the file's count " +
      `in ${BASELINE_FILE} by hand.`,
  );
  return 1;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
