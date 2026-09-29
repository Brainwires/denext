/**
 * Pure parsers and statistics for measure.ts: every function here takes text (adb output,
 * logcat, dumpsys) and returns numbers, so it is unit-tested without a device
 * (parse_test.ts). measure.ts does the adb I/O.
 */

import { parseMarkerLine } from "../shared/scenarios.ts";

// ─── args ────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

// ─── am start / wm size / meminfo ───────────────────────────────────────────────────────

export interface StartSample {
  totalTimeMs: number | null;
  waitTimeMs: number | null;
  launchState: string | null;
}

/** `am start -W` output → TotalTime / WaitTime / LaunchState. */
export function parseAmStart(out: string): StartSample {
  const pick = (re: RegExp) => {
    const m = out.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    totalTimeMs: pick(/TotalTime:\s*(\d+)/),
    waitTimeMs: pick(/WaitTime:\s*(\d+)/),
    launchState: out.match(/LaunchState:\s*(\w+)/)?.[1] ?? null,
  };
}

/** `wm size` → the override size if set, else the physical size. */
export function parseWmSize(out: string): { w: number; h: number } | null {
  const m = out.match(/Override size: (\d+)x(\d+)/) ??
    out.match(/Physical size: (\d+)x(\d+)/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** `dumpsys meminfo <pkg|pid>` → TOTAL PSS in kB. */
export function parseTotalPss(meminfo: string): number | null {
  const m = meminfo.match(/TOTAL PSS:\s*(\d+)/) ??
    meminfo.match(/^\s*TOTAL\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

/** `ps -A -o PID,NAME` → WebView renderer processes (sandboxed / privileged). */
export function parseRendererPids(ps: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const line of ps.split("\n")) {
    const [pid, name] = line.trim().split(/\s+/, 2);
    if (name && /sandboxed_process|:privileged_process/.test(name)) {
      m.set(Number(pid), name);
    }
  }
  return m;
}

// ─── gfxinfo ─────────────────────────────────────────────────────────────────────────────

export interface GfxSummary {
  totalFrames: number | null;
  jankyFrames: number | null;
  jankyPct: number | null;
  jankyLegacyPct: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  gpuP50Ms: number | null;
  gpuP99Ms: number | null;
}

/** `dumpsys gfxinfo <pkg>` → the first (the app window's) stats block. */
export function parseGfx(text: string): GfxSummary {
  const n = (re: RegExp) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    totalFrames: n(/Total frames rendered:\s*(\d+)/),
    jankyFrames: n(/Janky frames:\s*(\d+)/),
    jankyPct: n(/Janky frames:\s*\d+\s*\(([\d.]+)%\)/),
    jankyLegacyPct: n(/Janky frames \(legacy\):\s*\d+\s*\(([\d.]+)%\)/),
    p50Ms: n(/^\s*50th percentile:\s*([\d.]+)ms/m),
    p90Ms: n(/^\s*90th percentile:\s*([\d.]+)ms/m),
    p95Ms: n(/^\s*95th percentile:\s*([\d.]+)ms/m),
    p99Ms: n(/^\s*99th percentile:\s*([\d.]+)ms/m),
    gpuP50Ms: n(/50th gpu percentile:\s*([\d.]+)ms/),
    gpuP99Ms: n(/99th gpu percentile:\s*([\d.]+)ms/),
  };
}

// ─── SurfaceFlinger ──────────────────────────────────────────────────────────────────────

/**
 * `dumpsys SurfaceFlinger --list` → the app's candidate layers. API 34+ prints
 * `RequestedLayerState{<name>#<id> parentId=… z=…}`; --latency wants the bare `<name>#<id>`.
 * Older releases print the bare name, which passes through unchanged.
 */
export function parseSfLayers(list: string, pkg: string): string[] {
  const names = list.split("\n").map((l) => {
    const t = l.trim();
    const m = t.match(
      /^RequestedLayerState\{(.*?#\d+)(?:\s+parentId=\d+)?(?:\s+z=-?\d+)?\}$/,
    );
    return m ? m[1] : t;
  });
  return [...new Set(names)].filter((l) =>
    l.includes(pkg) &&
    !/Splash|Background for|ActivityRecord|WindowToken|Task=|animation-leash|InputSink/
      .test(l)
  );
}

/** `dumpsys SurfaceFlinger --latency <layer>` → vsync period and sorted present times (ns). */
export function parseSfLatency(
  out: string,
): { periodNs: number; present: number[] } {
  const lines = out.trim().split("\n");
  const periodNs = Number(lines[0]) || 16_666_667;
  const present: number[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/).map(Number);
    if (cols.length < 3) continue;
    const actual = cols[1];
    if (!actual || actual >= 9e18) continue;
    present.push(actual);
  }
  present.sort((a, b) => a - b);
  return { periodNs, present };
}

/** Frame-to-frame intervals (ms) inside active bursts (split at gaps > 100 ms). */
export function burstIntervals(present: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < present.length; i++) {
    const d = (present[i] - present[i - 1]) / 1e6;
    if (d > 0 && d <= 100) out.push(d);
  }
  return out;
}

/** Nearest-rank percentile of an ascending array, rounded to 0.01. */
export function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
}

export interface SfSummary {
  vsyncPeriodMs: number;
  intervals: number;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** % of intervals longer than 1.5 vsync periods. */
  missedVsyncPct: number | null;
  /** Longest single interval (ms): the worst hitch. */
  maxMs: number | null;
}

export function summarizeIntervals(
  intervals: number[],
  periodNs: number,
): SfSummary {
  const sorted = [...intervals].sort((a, b) => a - b);
  const periodMs = periodNs / 1e6;
  return {
    vsyncPeriodMs: Math.round(periodMs * 100) / 100,
    intervals: sorted.length,
    p50Ms: pct(sorted, 50),
    p90Ms: pct(sorted, 90),
    p95Ms: pct(sorted, 95),
    p99Ms: pct(sorted, 99),
    missedVsyncPct: sorted.length
      ? Math.round(
        (sorted.filter((d) => d > periodMs * 1.5).length / sorted.length) *
          1000,
      ) / 10
      : null,
    maxMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : null,
  };
}

// ─── logcat ──────────────────────────────────────────────────────────────────────────────

export type Failure = "crashed" | "anr" | "oom" | "webview-renderer-gone";

/** The PID column of a `logcat -v epoch` line (`<epoch> <pid> <tid> <level> <tag>: …`). */
export function logcatPid(line: string): number | null {
  const m = line.match(/^\s*\d+\.\d+\s+(\d+)\s+\d+\s/);
  return m ? Number(m[1]) : null;
}

/**
 * Classify a logcat excerpt (`adb logcat -d -v epoch -b main,system,crash,events`) for the app
 * `pkg` (running as `pid`, when known): an out-of-memory kill, an ANR, a Java or native crash,
 * or a dead WebView renderer. Only lines that name the package, or come from its PID, count,
 * so another process crashing on the emulator never fails a cell. OOM wins over a plain crash
 * (an OutOfMemoryError is also a FATAL EXCEPTION). Null when none.
 */
export function classifyLogcat(
  log: string,
  pkg: string,
  pid: number | null = null,
): { failure: Failure; line: string } | null {
  const lines = log.split("\n");
  const esc = pkg.replaceAll(".", "\\.");
  const ours = (l: string) => pid !== null && logcatPid(l) === pid;
  const find = (pred: (l: string) => boolean) => lines.find(pred)?.trim();
  const oom = find((l) =>
    (ours(l) && /java\.lang\.OutOfMemoryError/.test(l)) ||
    new RegExp(
      `(lowmemorykiller|lmkd).*${esc}|am_kill.*${esc}.*(lmk|oom|low mem)`,
      "i",
    ).test(l)
  );
  if (oom) return { failure: "oom", line: oom };
  const anr = find((l) => new RegExp(`ANR in ${esc}\\b|am_anr.*${esc}`).test(l));
  if (anr) return { failure: "anr", line: anr };
  const crash = find((l) =>
    new RegExp(`Process: ${esc}, PID|>>> ${esc} <<<|am_crash.*${esc}`).test(
      l,
    ) ||
    (ours(l) && /FATAL EXCEPTION|Fatal signal \d+/.test(l))
  );
  if (crash) return { failure: "crashed", line: crash };
  const renderer = find((l) =>
    ours(l) &&
    /Render process .*(gone|crash)|onRenderProcessGone|renderer.*crash/i.test(l)
  );
  if (renderer) return { failure: "webview-renderer-gone", line: renderer };
  return null;
}

// ─── report helpers ──────────────────────────────────────────────────────────────────────

export function stats(xs: (number | null | undefined)[]): {
  n: number;
  median: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
} {
  const v = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) {
    return { n: 0, median: null, mean: null, min: null, max: null };
  }
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return {
    n: v.length,
    median,
    mean: Math.round(mean * 10) / 10,
    min: v[0],
    max: v[v.length - 1],
  };
}

export const fmt = (v: unknown, unit = ""): string =>
  v === null || v === undefined ? "—" : `${v}${unit}`;

export const mb = (kb: number | null | undefined): string =>
  kb == null ? "—" : `${(kb / 1024).toFixed(1)} MB`;

/** Short human size: 1000 → 1k, 1000000 → 1M. */
export function shortN(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

// ─── markers in logcat ───────────────────────────────────────────────────────────────────

/** The epoch timestamp (ms) of a `logcat -v epoch` line, or null. */
export function logcatEpochMs(line: string): number | null {
  const m = line.match(/^\s*(\d{9,}\.\d+)\s/);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

export interface MarkerHit {
  marker: "ready" | "skipped" | "action" | "error";
  data: Record<string, unknown>;
  epochMs: number | null;
  line: string;
}

/**
 * Every bench marker in a `logcat -v epoch` dump, in order. The Capacitor app logs through
 * `Capacitor/Console` ("… Msg: SCROLLBENCH_READY {…}"), the RN app through `ReactNativeJS`.
 */
export function findMarkers(log: string): MarkerHit[] {
  const out: MarkerHit[] = [];
  for (const line of log.split("\n")) {
    const hit = parseMarkerLine(line);
    if (hit) {
      out.push({ ...hit, epochMs: logcatEpochMs(line), line: line.trim() });
    }
  }
  return out;
}

/** The epoch (ms) of the harness's own `log -t SCROLLBENCH_HARNESS <tag>` line. */
export function harnessLineMs(log: string, tag: string): number | null {
  for (const line of log.split("\n")) {
    if (line.includes("SCROLLBENCH_HARNESS") && line.includes(tag)) {
      return logcatEpochMs(line);
    }
  }
  return null;
}
