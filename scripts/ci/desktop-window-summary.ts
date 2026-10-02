// Merge the desktop window test's per-OS results (`.github/workflows/desktop-window.yml`) into one
// Markdown table: every check of every phase against every OS, skips with their reasons, and an OS
// whose run produced no results at all. Prints to stdout (the workflow appends it to the job
// summary).
//
//   deno run --allow-read scripts/ci/desktop-window-summary.ts <dir of downloaded artifacts>
//
// Each artifact folder (`desktop-window-<label>`) holds the runner's `results.json`
// (examples/desktop-kitchen-sink/e2e/window-test.ts).

import { join } from "@std/path";

interface Result {
  readonly phase: string;
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
  readonly detail: string;
}

interface RunFile {
  readonly results: Result[];
  readonly problems: string[];
}

/** One OS's run: its label, and its results (`null` when it produced none). */
interface OsRun {
  readonly label: string;
  readonly run: RunFile | null;
}

/** A Markdown table cell (no pipes or newlines). */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").slice(0, 200);
}

async function readRuns(dir: string): Promise<OsRun[]> {
  const runs: OsRun[] = [];
  // No artifacts at all (every OS job failed before uploading) is a run with nothing to report,
  // not a crash: the table then lists every OS as missing.
  const entries = await Array.fromAsync(Deno.readDir(dir)).catch(() => [] as Deno.DirEntry[]);
  for (const e of entries) {
    if (!e.isDirectory) continue;
    const label = e.name.replace(/^desktop-window-/, "");
    const text = await Deno.readTextFile(join(dir, e.name, "results.json")).catch(() => null);
    runs.push({ label, run: text === null ? null : JSON.parse(text) as RunFile });
  }
  return runs.sort((a, b) => a.label.localeCompare(b.label));
}

/** Every (phase, check) any OS reported, in first-seen order. */
function checkKeys(runs: readonly OsRun[]): Array<[phase: string, name: string]> {
  const keys = new Map<string, [string, string]>();
  for (const r of runs.flatMap(({ run }) => run?.results ?? [])) {
    keys.set(`${r.phase}\u0000${r.name}`, [r.phase, r.name]);
  }
  return [...keys.values()];
}

/** One OS's cell for a check: its status, `missing` when that run did not report it. */
function statusCell(run: RunFile | null, phase: string, name: string): string {
  if (!run) return "no run";
  const r = run.results.find((x) => x.phase === phase && x.name === name);
  return r ? r.status.toUpperCase() : "missing";
}

/** The check × OS table. */
function matrix(runs: readonly OsRun[]): string[] {
  const lines = [
    `| Phase | Check | ${runs.map((r) => r.label).join(" | ")} |`,
    `| --- | --- | ${runs.map(() => "---").join(" | ")} |`,
  ];
  for (const [phase, name] of checkKeys(runs)) {
    const cells = runs.map(({ run }) => statusCell(run, phase, name));
    lines.push(`| ${phase} | ${cell(name)} | ${cells.join(" | ")} |`);
  }
  return [...lines, ""];
}

/** One OS's skips (with reasons), failures and other problems; nothing when it is clean. */
function osNotes({ label, run }: OsRun): string[] {
  if (!run) return [`### ${label}: no results (the run failed before reporting; see its logs)`, ""];
  const skips = run.results.filter((r) => r.status === "skip");
  const fails = run.results.filter((r) => r.status === "fail");
  const others = run.problems.filter((p) => !fails.some((r) => p.startsWith(`${r.name}:`)));
  if (skips.length + fails.length + others.length === 0) return [];
  return [
    `### ${label}`,
    "",
    ...skips.map((r) => `- SKIP **${cell(r.name)}**: ${cell(r.detail)}`),
    ...fails.map((r) => `- FAIL **${cell(r.name)}**: ${cell(r.detail)}`),
    ...others.map((p) => `- problem: ${cell(p)}`),
    "",
  ];
}

/** The summary Markdown for `runs`. */
function summarize(runs: readonly OsRun[]): string {
  const head = ["## Desktop window test: every check, every OS", ""];
  if (runs.length === 0) return [...head, "No results were uploaded.", ""].join("\n");
  return [...head, ...matrix(runs), ...runs.flatMap(osNotes)].join("\n");
}

if (import.meta.main) {
  const dir = Deno.args[0];
  if (!dir) {
    console.error("usage: desktop-window-summary.ts <artifacts dir>");
    Deno.exit(2);
  }
  console.log(summarize(await readRuns(dir)));
}
