// Terminal formatting for a profiling run — the self-time table (proportion bars, like
// `denext analyze`), the heap/leak summary, and the budget verdict. Pure: returns lines,
// prints nothing, so it is testable and the CLI owns the `console.log`.

import type { ProfileResult } from "./types.ts";
import type { ProfileComparison } from "./compare.ts";
import type { CpuFrame } from "./cpu.ts";
import { retainedBytes } from "./heap.ts";

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
    ...(h.warmBytes === undefined ? [] : [
      `  warm          ${formatBytes(h.warmBytes)}  (after the first run + GC: the leak baseline)`,
    ]),
    `  after GC      ${formatBytes(h.afterGcBytes)}  (retained ${formatBytes(retainedBytes(h))})`,
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
  })${result.filter ? `  filter ${JSON.stringify(result.filter)}` : ""}`;
  return [header, "", ...cpuLines(result), ...heapLines(result), ...budgetLines(result)];
}

/** A signed millisecond change (`+1.2ms`, `-0.4ms`, `±0.0ms`). */
function signedMs(n: number): string {
  if (Math.abs(n) < 0.05) return "±0.0ms";
  return `${n > 0 ? "+" : "-"}${Math.abs(n).toFixed(1)}ms`;
}

/** A signed byte change. */
function signedBytes(n: number): string {
  return n === 0 ? "±0 B" : `${n > 0 ? "+" : ""}${formatBytes(n)}`;
}

/**
 * The terminal report of a comparison with a saved run (`--compare`): totals, heap, and the
 * functions whose self-time changed most.
 *
 * @param cmp The comparison.
 * @param top Max function rows (default 20).
 * @returns The lines.
 */
export function comparisonLines(cmp: ProfileComparison, top = 20): string[] {
  const t = cmp.totalMs;
  const lines = [
    "",
    `Compare ▸ saved run of ${cmp.baseRoute}`,
    `  CPU total     ${t.base.toFixed(1)}ms → ${t.now.toFixed(1)}ms  (${signedMs(t.delta)})`,
    `  heap growth   ${formatBytes(cmp.heapGrowth.base)} → ${formatBytes(cmp.heapGrowth.now)}  (${
      signedBytes(cmp.heapGrowth.delta)
    })`,
    `  retained      ${formatBytes(cmp.retained.base)} → ${formatBytes(cmp.retained.now)}  (${
      signedBytes(cmp.retained.delta)
    })`,
  ];
  const rows = cmp.rows.slice(0, top);
  if (rows.length === 0) return lines;
  const nameW = Math.min(32, Math.max(...rows.map((r) => r.name.length)));
  for (const r of rows) {
    const name = r.name.length > nameW ? r.name.slice(0, nameW - 1) + "…" : r.name.padEnd(nameW);
    lines.push(
      `  ${name}  ${r.baseMs.toFixed(1).padStart(7)}ms → ${r.nowMs.toFixed(1).padStart(7)}ms  ${
        signedMs(r.deltaMs)
      }`,
    );
  }
  return lines;
}
