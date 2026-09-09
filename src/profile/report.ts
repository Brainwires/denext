// Terminal formatting for a profiling run — the self-time table (proportion bars, like
// `denext analyze`), the heap/leak summary, and the budget verdict. Pure: returns lines,
// prints nothing, so it is testable and the CLI owns the `console.log`.

import type { ProfileResult } from "./types.ts";
import type { CpuFrame } from "./cpu.ts";

/** Human-readable byte size. */
function formatBytes(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
  return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MB`;
}

/** A proportion bar `█████░░░░░` of `width` cells for `pct` (0–100). */
function bar(pct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** The basename of a frame's source URL (drop the long client-chunk prefix). */
function frameSource(f: CpuFrame): string {
  if (!f.url) return "(native)";
  const base = f.url.split("/").pop() || f.url;
  return f.line > 0 ? `${base}:${f.line}` : base;
}

/** Format the top self-time rows into aligned table lines. */
function cpuLines(result: ProfileResult): string[] {
  const rows = result.cpu.topSelfTime;
  if (rows.length === 0) return ["(no CPU samples captured)"];
  const nameW = Math.min(32, Math.max(...rows.map((r) => r.name.length)));
  const lines = [
    `CPU  ▸  ${result.cpu.totalMs.toFixed(1)} ms over ${result.cpu.sampleCount} samples`,
  ];
  for (const r of rows) {
    const name = r.name.length > nameW ? r.name.slice(0, nameW - 1) + "…" : r.name.padEnd(nameW);
    const pct = `${r.pct.toFixed(1)}%`.padStart(6);
    lines.push(`  ${name}  ${bar(r.pct)} ${pct}  ${r.selfMs.toFixed(1)}ms  ${frameSource(r)}`);
  }
  return lines;
}

/** Format the heap + leak summary. */
function heapLines(result: ProfileResult): string[] {
  const h = result.heap;
  return [
    "",
    "Heap ▸",
    `  before        ${formatBytes(h.beforeBytes)}`,
    `  after         ${formatBytes(h.afterBytes)}  (peak growth ${
      formatBytes(h.afterBytes - h.beforeBytes)
    })`,
    `  after GC      ${formatBytes(h.afterGcBytes)}  (retained ${
      formatBytes(h.afterGcBytes - h.beforeBytes)
    })`,
    `  leak          ${h.leaked ? "⚠ retained growth after GC" : "✔ none"}`,
  ];
}

/** Format the budget verdict, when present. */
function budgetLines(result: ProfileResult): string[] {
  if (!result.budget) return [];
  if (result.budget.passed) return ["", "Budget ▸ ✔ within budget"];
  return [
    "",
    "Budget ▸ ✖ exceeded",
    ...result.budget.violations.map((v) => `  ✖ ${v.detail}`),
  ];
}

/** The full terminal report for a profiling run. */
export function profileReportLines(result: ProfileResult): string[] {
  const header = `denext profile ▸ ${result.route}  (${
    result.minified ? "minified" : "unminified"
  })`;
  return [header, "", ...cpuLines(result), ...heapLines(result), ...budgetLines(result)];
}
