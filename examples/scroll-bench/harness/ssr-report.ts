/**
 * ssr-report.ts: the pure half of harness/ssr-measure.ts. Load-metric math (time to
 * interactive, total blocking time), the medians of a cell's runs, the skip rule for sizes past
 * a failure, and the results.md renderer. No browser, no I/O, so harness/ssr-report_test.ts
 * covers it.
 */

import { shortN, summarizeIntervals } from "./parse.ts";

export type ProfileId = "desktop" | "mobile";

export interface LongTask {
  start: number;
  duration: number;
}

/**
 * Time to interactive: from first contentful paint, the end of the last long task that is
 * followed by `quietMs` without one, and never before DOMContentLoaded or the moment the last
 * island the page waits for was hydrated.
 */
export function timeToInteractive(input: {
  fcp: number;
  dcl: number;
  longTasks: readonly LongTask[];
  hydratedAt?: number | null;
  quietMs?: number;
}): number {
  const quiet = input.quietMs ?? 500;
  let t = input.fcp;
  // Sorted by start: a task that ended before `t` leaves it unchanged; the first one that
  // starts `quiet` ms after `t` closes the search.
  for (const task of [...input.longTasks].sort((x, y) => x.start - y.start)) {
    if (task.start - t >= quiet) break;
    t = Math.max(t, task.start + task.duration);
  }
  return Math.max(t, input.dcl, input.hydratedAt ?? 0);
}

/** Total blocking time: the part over 50 ms of every long task between FCP and TTI. */
export function totalBlockingTime(
  fcp: number,
  tti: number,
  longTasks: readonly LongTask[],
): number {
  let sum = 0;
  for (const t of longTasks) {
    const end = t.start + t.duration;
    if (end <= fcp || t.start >= tti) continue;
    sum += Math.max(0, t.duration - 50);
  }
  return sum;
}

/** rAF frame intervals (ms) → the SPA harness's SurfaceFlinger summary at 60 Hz. */
export function frameSummary(intervals: readonly number[]) {
  const s = summarizeIntervals(intervals.filter((d) => d > 0 && d <= 1000), 16_666_667);
  return { frames: s.intervals, p90Ms: s.p90Ms, missedPct: s.missedVsyncPct, maxMs: s.maxMs };
}

/** One page load of one cell. `null` = not measured (or not applicable to the impl). */
export interface RunMetrics {
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  ttiMs: number | null;
  tbtMs: number | null;
  /** Wall time from navigation to the load event. */
  loadMs: number | null;
  htmlTransferBytes: number | null;
  htmlDecodedBytes: number | null;
  jsTransferBytes: number | null;
  jsDecodedBytes: number | null;
  domElements: number | null;
  jsHeapUsedBytes: number | null;
  /** Renderer memory: private resident (Linux `RssAnon`), else RSS. */
  rendererRssBytes: number | null;
  /** Islands hydrated when the page settled (the probe's counter). */
  hydrated: number | null;
  frames: number | null;
  frameP90Ms: number | null;
  frameMissedPct: number | null;
  frameMaxMs: number | null;
  /** First click on a row control → the frame after its state changed (resume/hydrate included). */
  clickMs: number | null;
  /** A second click on another row. */
  click2Ms: number | null;
  /** `window.find` of a phrase of row n−1 lands in row n−1. */
  findOk: boolean | null;
  /** DOM.performSearch hits for the same phrase (text in the DOM at all). */
  findDomHits: number | null;
  /** Non-ignored `listitem` nodes in the accessibility tree. */
  axListItems: number | null;
}

export const METRIC_KEYS = [
  "ttfbMs",
  "fcpMs",
  "lcpMs",
  "ttiMs",
  "tbtMs",
  "loadMs",
  "htmlTransferBytes",
  "htmlDecodedBytes",
  "jsTransferBytes",
  "jsDecodedBytes",
  "domElements",
  "jsHeapUsedBytes",
  "rendererRssBytes",
  "hydrated",
  "frames",
  "frameP90Ms",
  "frameMissedPct",
  "frameMaxMs",
  "clickMs",
  "click2Ms",
  "findDomHits",
  "axListItems",
] as const satisfies readonly (keyof RunMetrics)[];

export interface CellId {
  impl: string;
  kind: string;
  n: number;
  profile: ProfileId;
}

export interface CellRecord extends CellId {
  id: string;
  /** Runs that completed. */
  runs: RunMetrics[];
  /** Why a run failed (timeout, crash); the cell is unusable when every run failed. */
  failures: string[];
  median: Partial<Record<(typeof METRIC_KEYS)[number], number | null>> & {
    findOk?: boolean | null;
  };
  /** JSON bytes of every row, had the page shipped them as island props (virtual impls). */
  dataJsonBytes?: number;
}

export const cellId = (c: CellId): string => `${c.impl}-${c.kind}-${shortN(c.n)}-${c.profile}`;

const median = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  const m = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return Math.round(m * 10) / 10;
};

/** The medians of a cell's completed runs (findOk: the majority). */
export function medians(runs: readonly RunMetrics[]): CellRecord["median"] {
  const out: CellRecord["median"] = {};
  for (const k of METRIC_KEYS) out[k] = median(runs.map((r) => r[k]));
  const finds = runs.map((r) => r.findOk).filter((f): f is boolean => f !== null);
  out.findOk = finds.length ? finds.filter(Boolean).length * 2 > finds.length : null;
  return out;
}

/** A cell that failed every run, or whose median time to interactive is over `unusableMs`. */
const unusable = (d: CellRecord, unusableMs: number) =>
  d.runs.length === 0 || (d.median.ttiMs ?? 0) > unusableMs;

/**
 * Why a cell is skipped, or null: a smaller size of the same (impl, kind, profile) already
 * failed every run or took over `unusableMs` to become interactive. A static list that could
 * not load 50k rows (or took a minute to) will not do better at 100k.
 */
export function skippedByFailure(
  cell: CellId,
  done: readonly CellRecord[],
  unusableMs = Infinity,
): string | null {
  const same = (d: CellRecord) =>
    d.impl === cell.impl && d.kind === cell.kind && d.profile === cell.profile && d.n < cell.n;
  const d = done.find((x) => same(x) && unusable(x, unusableMs));
  if (!d) return null;
  return d.runs.length
    ? `skipped: ${d.id} was unusable (time to interactive ${Math.round(d.median.ttiMs! / 1000)} s)`
    : `skipped: ${d.id} failed`;
}

// ─── report ─────────────────────────────────────────────────────────────────────────────

export interface ReportMeta {
  date: string;
  machine: string;
  chromium: string;
  loadavgStart: string;
  loadavgEnd: string;
  runsPerCell: number;
  profiles: Record<ProfileId, string>;
  notes: string[];
  /** Hand-written findings (Markdown), shown under the title: the out dir's findings.md. */
  findings?: string;
}

/** results.json's form of a cell: the medians and failures, without the raw runs. */
export function summaryCell(c: CellRecord): Omit<CellRecord, "runs"> & { runCount: number } {
  const { runs, ...rest } = c;
  return { ...rest, runCount: runs.length };
}

const kb = (b: number | null | undefined) =>
  b == null
    ? "—"
    : b >= 1024 * 1024
    ? `${(b / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(b / 1024)} KB`;
const ms = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}`);
const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-US"));
const pctFmt = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);

interface MetricView {
  title: string;
  cell: (c: CellRecord) => string;
}

const yesNo = (v: boolean | null | undefined) => (v == null ? "—" : v ? "yes" : "no");
const find = (c: CellRecord) => `${yesNo(c.median.findOk)} (${num(c.median.findDomHits)} in DOM)`;
/** `a / b`, or `—` when neither was measured. */
const pair = (a: string, b: string) => (a === "—" && b === "—" ? "—" : `${a} / ${b}`);

const METRIC_VIEWS: readonly MetricView[] = [
  { title: "TTFB (ms)", cell: (c) => ms(c.median.ttfbMs) },
  { title: "FCP (ms)", cell: (c) => ms(c.median.fcpMs) },
  { title: "LCP (ms)", cell: (c) => ms(c.median.lcpMs) },
  { title: "Time to interactive (ms)", cell: (c) => ms(c.median.ttiMs) },
  { title: "Total blocking time (ms)", cell: (c) => ms(c.median.tbtMs) },
  { title: "Load event (ms)", cell: (c) => ms(c.median.loadMs) },
  { title: "HTML transferred", cell: (c) => kb(c.median.htmlTransferBytes) },
  { title: "HTML decoded", cell: (c) => kb(c.median.htmlDecodedBytes) },
  { title: "JS transferred", cell: (c) => kb(c.median.jsTransferBytes) },
  { title: "JS decoded", cell: (c) => kb(c.median.jsDecodedBytes) },
  { title: "DOM elements", cell: (c) => num(c.median.domElements) },
  { title: "JS heap used", cell: (c) => kb(c.median.jsHeapUsedBytes) },
  { title: "Renderer memory (private resident)", cell: (c) => kb(c.median.rendererRssBytes) },
  {
    title: "Scroll: p90 frame interval (ms) / missed frames",
    cell: (c) => pair(ms(c.median.frameP90Ms), pctFmt(c.median.frameMissedPct)),
  },
  { title: "Scroll: worst frame (ms)", cell: (c) => ms(c.median.frameMaxMs) },
  {
    title: "Row control: first click / second click → paint (ms)",
    cell: (c) => pair(ms(c.median.clickMs), ms(c.median.click2Ms)),
  },
  { title: "Find row n−1 (window.find; DOM hits)", cell: find },
  { title: "Rows in the accessibility tree", cell: (c) => num(c.median.axListItems) },
];

/** The cell's value, or why it has none (failed / skipped). */
function shown(c: CellRecord | undefined, view: MetricView): string {
  if (!c) return "";
  return c.runs.length ? view.cell(c) : failLabel(c);
}

const failLabel = (c: CellRecord) =>
  c.failures.some((f) => f.startsWith("skipped")) ? "skip" : "FAIL";

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const headerRow = (sizes: readonly number[], first: string) => [
  `| ${first} | ${sizes.map(shortN).join(" | ")} |`,
  `| --- | ${sizes.map(() => "---:").join(" | ")} |`,
];

function preamble(meta: ReportMeta): string[] {
  return [
    `# Server-rendered lists vs VirtualList (${meta.date})`,
    "",
    ...(meta.findings ? [meta.findings.trim(), ""] : []),
    `Machine: ${meta.machine}. Chromium ${meta.chromium} (headless). Load average at start ` +
    `${meta.loadavgStart}, at end ${meta.loadavgEnd}. Medians of ${meta.runsPerCell} runs per ` +
    `cell, each a cold browser (fresh profile, empty cache).`,
    "",
    ...Object.entries(meta.profiles).map(([p, d]) => `- **${p}**: ${d}`),
    "",
    ...meta.notes.map((n) => `- ${n}`),
    "",
    "`FAIL`: every run failed (the failures are listed at the end). `skip`: a smaller size of the " +
    "same impl already failed, or took over 30 s to become interactive. `—`: not measured or not " +
    "applicable (no row control, no scroll).",
    "",
  ];
}

/** One metric's table for one (profile, kind): impls as rows, sizes as columns. */
function metricTable(
  view: MetricView,
  at: (impl: string, n: number) => CellRecord | undefined,
  impls: readonly string[],
  sizes: readonly number[],
): string[] {
  const rows = impls
    .map((impl) => ({ impl, cells: sizes.map((n) => shown(at(impl, n), view)) }))
    .filter((r) => r.cells.some((v) => v !== ""))
    .map((r) => `| ${r.impl} | ${r.cells.join(" | ")} |`);
  return [`### ${view.title}`, "", ...headerRow(sizes, "impl"), ...rows, ""];
}

function failuresSection(cells: readonly CellRecord[]): string[] {
  const failed = cells.filter((c) => c.failures.length);
  if (!failed.length) return [];
  return [
    "## Failures",
    "",
    ...failed.map((c) => `- ${cellId(c)}: ${uniq(c.failures).join("; ")}`),
    "",
  ];
}

function dataSection(cells: readonly CellRecord[], sizes: readonly number[]): string[] {
  const data = cells.filter((c) => c.dataJsonBytes);
  if (!data.length) return [];
  const rows = uniq(data.map((c) => c.kind)).map((kind) =>
    `| ${kind} | ${
      sizes.map((n) => kb(data.find((d) => d.kind === kind && d.n === n)?.dataJsonBytes)).join(
        " | ",
      )
    } |`
  );
  return [
    "## Row data as island props",
    "",
    "The virtual impls generate rows from the seed on the client, so no row data crosses the " +
    "Flight boundary. An app that passes its rows to the island as props ships their JSON on " +
    "top (uncompressed):",
    "",
    ...headerRow(sizes, "kind"),
    ...rows,
    "",
  ];
}

/** results.md: one table per metric, per (profile, kind): impls as rows, sizes as columns. */
export function renderSsrMarkdown(meta: ReportMeta, cells: readonly CellRecord[]): string {
  const impls = uniq(cells.map((c) => c.impl));
  const sizes = uniq(cells.map((c) => c.n)).sort((a, b) => a - b);
  const byId = new Map(cells.map((c) => [cellId(c), c]));
  const out = preamble(meta);
  for (const profile of uniq(cells.map((c) => c.profile))) {
    for (const kind of uniq(cells.map((c) => c.kind))) {
      const at = (impl: string, n: number) => byId.get(cellId({ impl, kind, n, profile }));
      out.push(`## ${profile} · ${kind}`, "");
      for (const view of METRIC_VIEWS) out.push(...metricTable(view, at, impls, sizes));
    }
  }
  out.push(...failuresSection(cells), ...dataSection(cells, sizes));
  return out.join("\n");
}
