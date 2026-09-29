/**
 * The matrix: which (app, impl, kind, n) cells to run, with what scenario, and how a finished
 * run is reported. Pure (no adb), so `measure.ts matrix --dry-run` and the tests use it as is.
 */

import type { Kind } from "../shared/data.ts";
import {
  actionLink,
  ANCHOR,
  type AppId,
  cellPlan,
  IMPLS,
  KINDS,
  runLink,
  SIZES,
} from "../shared/scenarios.ts";
import { fmt, mb, type SfSummary, shortN } from "./parse.ts";

export interface MatrixConfig {
  apps: AppId[];
  /** Impl ids per app (default: every impl the catalogue lists for the app). */
  impls?: Partial<Record<AppId, string[]>>;
  kinds: Kind[];
  sizes: number[];
  seed: number;
  /** Seconds to wait for the ready marker before recording a timeout. */
  readyTimeoutSec: number;
  /** Seconds to wait after ready (and after each phase) before measuring. */
  settleSec: number;
  /** Flings per direction. */
  flings: number;
  /** Slow drag-scrolls per direction. */
  drags: number;
  /** scrollToIndex targets as fractions of n (0 = first row, 1 = last). */
  jumps: number[];
  /** Streaming append (at the end), for these kinds. */
  append: { k: number; times: number; kinds: Kind[] };
  /** History prepend (at the start), for these kinds. */
  prepend: { k: number; times: number; kinds: Kind[] };
  /** Seconds to wait for an action's marker. */
  actionTimeoutSec: number;
}

export const DEFAULT_CONFIG: MatrixConfig = {
  apps: ["denext", "rn"],
  kinds: [...KINDS],
  sizes: [...SIZES],
  seed: 1,
  readyTimeoutSec: 90,
  settleSec: 2,
  flings: 6,
  drags: 2,
  jumps: [0.5, 1, 0, 0.25],
  append: { k: 20, times: 5, kinds: ["chat"] },
  prepend: { k: 50, times: 3, kinds: ["chat"] },
  actionTimeoutSec: 30,
};

/** Merge a (partial) config file over the defaults. */
export function loadConfig(partial: Partial<MatrixConfig>): MatrixConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    append: { ...DEFAULT_CONFIG.append, ...partial.append },
    prepend: { ...DEFAULT_CONFIG.prepend, ...partial.prepend },
  };
}

export interface Cell {
  app: AppId;
  impl: string;
  kind: Kind;
  n: number;
  id: string;
  plan: { run: true } | { run: false; reason: string };
}

const cellId = (
  app: AppId,
  impl: string,
  kind: Kind,
  n: number,
): string => `${app}-${impl}-${kind}-${shortN(n)}`;

/** Every cell of the config, in run order: app, impl, kind, n (small to large). */
export function expandMatrix(cfg: MatrixConfig): Cell[] {
  const cells: Cell[] = [];
  for (const app of cfg.apps) {
    const impls = cfg.impls?.[app] ??
      IMPLS.filter((d) => d.app === app).map((d) => d.id);
    for (const impl of impls) {
      for (const kind of cfg.kinds) {
        for (const n of [...cfg.sizes].sort((a, b) => a - b)) {
          cells.push({
            app,
            impl,
            kind,
            n,
            id: cellId(app, impl, kind, n),
            plan: cellPlan(app, impl, kind, n),
          });
        }
      }
    }
  }
  return cells;
}

/** One scripted step of a cell, as the device sees it. */
export type Step =
  | { type: "launch"; link: string }
  | { type: "fling"; forward: boolean; count: number }
  | { type: "drag"; forward: boolean; count: number }
  | {
    type: "action";
    link: string;
    phase: "jump" | "append" | "prepend" | "position";
  };

/**
 * The script of one runnable cell. "forward" = toward the end of the list (finger moving up).
 * Chat opens at its end, so its flings go backward first.
 */
export function cellSteps(cell: Cell, cfg: MatrixConfig): Step[] {
  const params = {
    list: cell.impl,
    kind: cell.kind,
    n: cell.n,
    seed: cfg.seed,
  };
  const startsAtEnd = ANCHOR[cell.kind] === "end";
  const steps: Step[] = [{ type: "launch", link: runLink(cell.app, params) }];
  const first = !startsAtEnd;
  steps.push({ type: "fling", forward: first, count: cfg.flings });
  steps.push({ type: "fling", forward: !first, count: cfg.flings });
  steps.push({ type: "drag", forward: first, count: cfg.drags });
  steps.push({ type: "drag", forward: !first, count: cfg.drags });
  for (const f of cfg.jumps) {
    const i = Math.round(Math.max(0, Math.min(1, f)) * Math.max(0, cell.n - 1));
    steps.push({
      type: "action",
      phase: "jump",
      link: actionLink(cell.app, { op: "scrollToIndex", i }),
    });
  }
  if (cfg.append.kinds.includes(cell.kind) && cfg.append.times > 0) {
    steps.push({
      type: "action",
      phase: "position",
      link: actionLink(cell.app, { op: "scrollToEnd" }),
    });
    for (let t = 0; t < cfg.append.times; t++) {
      steps.push({
        type: "action",
        phase: "append",
        link: actionLink(cell.app, { op: "append", k: cfg.append.k }),
      });
    }
  }
  if (cfg.prepend.kinds.includes(cell.kind) && cfg.prepend.times > 0) {
    steps.push({
      type: "action",
      phase: "position",
      link: actionLink(cell.app, { op: "scrollToStart" }),
    });
    for (let t = 0; t < cfg.prepend.times; t++) {
      steps.push({
        type: "action",
        phase: "prepend",
        link: actionLink(cell.app, { op: "prepend", k: cfg.prepend.k }),
      });
    }
  }
  return steps;
}

// ─── results ─────────────────────────────────────────────────────────────────────────────

export type CellStatus =
  | "ok"
  | "skipped"
  | "timeout"
  | "crashed"
  | "anr"
  | "oom"
  | "webview-renderer-gone"
  | "error";

export interface PhaseResult {
  sf: SfSummary | null;
  /** Action durations the app reported (ms), for action phases. */
  actionMs?: number[];
  /** Actions that failed or timed out. */
  actionFailures?: string[];
}

export interface CellResult {
  id: string;
  app: AppId;
  impl: string;
  kind: Kind;
  n: number;
  status: CellStatus;
  /** Why skipped / what failed, and in which phase. */
  reason?: string;
  failedPhase?: string;
  /** Launch (harness logcat line) → ready marker, from logcat timestamps. */
  launchToReadyMs?: number | null;
  /** `am start -W` TotalTime for the deep-link launch. */
  amTotalTimeMs?: number | null;
  /** The ready marker's own payload (in-app ms, mounted rows, notes). */
  ready?: Record<string, unknown>;
  pssReadyKb?: number | null;
  pssEndKb?: number | null;
  layer?: string | null;
  phases?: Partial<
    Record<"fling" | "drag" | "jump" | "append" | "prepend", PhaseResult>
  >;
  gfx?: Record<string, number | null>;
  /** Non-fatal JS errors the app reported (SCROLLBENCH_ERROR) while the cell ran. */
  errors?: string[];
  startedAt: string;
  durationSec?: number;
}

const avg = (xs: number[] | undefined) =>
  xs && xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

const sfCell = (p: PhaseResult | undefined) =>
  p?.sf
    ? `${fmt(p.sf.p50Ms)}/${fmt(p.sf.p90Ms)}/${fmt(p.sf.p99Ms)} · ${fmt(p.sf.missedVsyncPct, "%")}`
    : "—";

/** The markdown table of a matrix run (one row per cell). */
export function renderMarkdown(results: CellResult[], header: string): string {
  const rows = results.map((r) => {
    const status = r.status === "ok"
      ? "ok"
      : `**${r.status}**${r.failedPhase ? ` (${r.failedPhase})` : ""}${
        r.reason ? `: ${r.reason.replaceAll("|", "\\|").slice(0, 80)}` : ""
      }`;
    const notes = [
      ...(Array.isArray(r.ready?.notes) ? (r.ready!.notes as string[]) : []),
      ...(r.errors?.length ? [`${r.errors.length} JS error(s): ${r.errors[0]}`] : []),
    ].join("; ");
    return `| ${r.app} | ${r.impl} | ${r.kind} | ${shortN(r.n)} | ${status} | ${
      fmt(r.launchToReadyMs, " ms")
    } | ${mb(r.pssReadyKb)} → ${mb(r.pssEndKb)} | ${sfCell(r.phases?.fling)} | ${
      sfCell(r.phases?.drag)
    } | ${fmt(r.gfx?.jankyPct, "%")} | ${fmt(avg(r.phases?.jump?.actionMs), " ms")} | ${
      fmt(avg(r.phases?.append?.actionMs), " ms")
    } | ${fmt(avg(r.phases?.prepend?.actionMs), " ms")} | ${notes.replaceAll("|", "\\|")} |`;
  });
  return [
    header,
    "",
    "| app | impl | kind | n | status | launch→ready | PSS ready → end | fling SF p50/p90/p99 · missed | drag SF p50/p90/p99 · missed | gfx janky | jump | append | prepend | notes |",
    "|---|---|---|---:|---|---:|---|---|---|---:|---:|---:|---:|---|",
    ...rows,
    "",
    "SF = SurfaceFlinger present intervals of the app's window layer during the phase (ms), " +
    "missed = % of intervals > 1.5 vsync. jump/append/prepend = mean time the app reports " +
    "from the action to the second frame after it. Emulator numbers are only meaningful " +
    "RELATIVE to each other.",
    "",
  ].join("\n");
}
