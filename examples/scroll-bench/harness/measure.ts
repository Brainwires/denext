#!/usr/bin/env -S deno run -A
/**
 * measure.ts — the scroll benchmark on Android: the denext app (Capacitor WebView) vs the
 * React Native twin, on the SAME emulator with the SAME recipe. Derived from the T3 Code
 * Capacitor-vs-RN harness (same cold-start / PSS / SurfaceFlinger / gfxinfo method); the
 * T3-specific pairing and thread commands are dropped, `matrix` is new.
 *
 *   deno run -A harness/measure.ts doctor                  # adb, device, WebView, root, APKs
 *   deno run -A harness/measure.ts install [--apks <dir>]  # install both APKs (+ grant perms)
 *   deno run -A harness/measure.ts coldstart [--runs 5]    # cold start + PSS of both launchers
 *   deno run -A harness/measure.ts matrix [--config harness/matrix.json] [--dry-run]
 *
 * `matrix` flags:
 *   --config <file>     JSON, any subset of MatrixConfig (harness/matrix.ts); defaults cover
 *                       every app × impl × kind × size of shared/scenarios.ts
 *   --only <substr,…>   run only cells whose id (`<app>-<impl>-<kind>-<n>`) contains one
 *   --resume <dir>      reuse a previous run dir: cells with a JSON there are not re-run
 *   --compile speed-profile|speed|none   ART compile step per app before the cells
 *   --dry-run           print every cell's plan and deep links; no adb at all
 *   --out <dir>         output root (default examples/scroll-bench/results)
 *   --apks <dir>        where scroll-bench-{denext,rn}-release.apk are (default: harness/)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * METHOD (see also the T3 harness notes; the same caveats apply)
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * Per cell: force-stop both apps, clear logcat, print a `SCROLLBENCH_HARNESS launch-<id>`
 *   line with `log`, then `am start -W -a VIEW -d <scheme>://run?list=…&kind=…&n=… <pkg>`
 *   (cold start straight into the cell). The app prints `SCROLLBENCH_READY {json}` on the
 *   first frame with rows painted (chat: after positioning at its newest message), which the
 *   harness finds in `logcat -v epoch`. launch→ready = the two logcat timestamps, so it is the
 *   same clock for both apps (the in-app `ms` of the marker uses different bases: page start
 *   in the WebView, JS start in RN, and is kept only as data).
 *   A skipped cell (the catalogue's caps, or an impl that prints SCROLLBENCH_SKIPPED) costs no
 *   device time. A process that dies, an ANR, an OOM kill or a dead WebView renderer is
 *   classified from logcat (main, system, crash, events buffers), recorded with the phase it
 *   happened in, and the matrix continues with the next cell.
 * Scroll: gfxinfo reset, then N flings forward + N back (chat starts at its end, so it flings
 *   backward first), then slow drags (a 1.5 s `input swipe`), each with SurfaceFlinger
 *   --latency sampled around it on the app's window layer (discovered on the first fling:
 *   every candidate layer is cleared and read, the one that presented the most frames wins).
 * Actions: deep links `<scheme>://action?op=scrollToIndex&i=…` (jumps), `op=append&k=…`
 *   (streaming chat append at the end), `op=prepend&k=…` (history at the start). The app
 *   prints `SCROLLBENCH_ACTION {op, ok, ms}` two frames after the action committed; ms is the
 *   app's own measure. SurfaceFlinger is sampled around each action too.
 * Memory: TOTAL PSS of the app plus the WebView renderer processes that appeared after the
 *   launch, after ready and at the end of the cell.
 *
 * Output: <out>/<stamp>/cells/<cell>.json (one per cell, written as soon as the cell ends),
 *   results.json, results.md, raw/ (gfxinfo, meminfo, screenshots).
 */

import { type AppId, PACKAGES } from "../shared/scenarios.ts";
import {
  type Cell,
  type CellResult,
  cellSteps,
  expandMatrix,
  loadConfig,
  type MatrixConfig,
  type PhaseResult,
  renderMarkdown,
  type Step,
} from "./matrix.ts";
import {
  burstIntervals,
  classifyLogcat,
  findMarkers,
  fmt,
  harnessLineMs,
  type MarkerHit,
  mb,
  parseAmStart,
  parseArgs,
  parseGfx,
  parseRendererPids,
  parseSfLatency,
  parseSfLayers,
  parseTotalPss,
  parseWmSize,
  stats,
  summarizeIntervals,
} from "./parse.ts";

const HERE = new URL(".", import.meta.url).pathname;
const { positional, flags } = parseArgs(Deno.args);
const str = (
  k: string,
  d: string,
) => (typeof flags[k] === "string" ? flags[k] as string : d);
const num = (
  k: string,
  d: number,
) => (typeof flags[k] === "string" ? Number(flags[k]) : d);

interface AppDef {
  key: AppId;
  label: string;
  pkg: string;
  apk: string;
}

const APK_DIR = str("apks", HERE).replace(/\/?$/, "/");
const APPS: Record<AppId, AppDef> = {
  denext: {
    key: "denext",
    label: "denext (Capacitor WebView)",
    pkg: PACKAGES.denext,
    apk: `${APK_DIR}scroll-bench-denext-release.apk`,
  },
  rn: {
    key: "rn",
    label: "React Native",
    pkg: PACKAGES.rn,
    apk: `${APK_DIR}scroll-bench-rn-release.apk`,
  },
};

// ─── adb ─────────────────────────────────────────────────────────────────────────────────

function adbPath(): string {
  const home = Deno.env.get("ANDROID_HOME") ??
    Deno.env.get("ANDROID_SDK_ROOT") ??
    `${Deno.env.get("HOME")}/Library/Android/sdk`;
  const candidate = `${home}/platform-tools/adb`;
  try {
    Deno.statSync(candidate);
    return candidate;
  } catch {
    return "adb";
  }
}
const ADB = adbPath();
const SERIAL = Deno.env.get("ANDROID_SERIAL");

async function adb(
  args: string[],
  opts: { allowFail?: boolean } = {},
): Promise<string> {
  const full = SERIAL ? ["-s", SERIAL, ...args] : args;
  const out = await new Deno.Command(ADB, {
    args: full,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (!out.success && !opts.allowFail) {
    throw new Error(`adb ${full.join(" ")} failed:\n${text}`);
  }
  return text;
}

/** One remote shell command line. Quote arguments yourself with shq(). */
const sh = (cmd: string, allowFail = false) => adb(["shell", cmd], { allowFail });
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let RAW_DIR = "";
async function saveRaw(name: string, text: string) {
  if (!RAW_DIR) return;
  await Deno.writeTextFile(
    `${RAW_DIR}/${name.replace(/[^\w.-]+/g, "_")}.txt`,
    text,
  );
}

async function screenshot(name: string) {
  if (!RAW_DIR) return;
  const args = [
    ...(SERIAL ? ["-s", SERIAL] : []),
    "exec-out",
    "screencap",
    "-p",
  ];
  const out = await new Deno.Command(ADB, {
    args,
    stdout: "piped",
    stderr: "null",
  }).output();
  if (out.success) await Deno.writeFile(`${RAW_DIR}/${name}.png`, out.stdout);
}

let isRoot = false;
async function tryRoot() {
  await adb(["root"], { allowFail: true });
  await adb(["wait-for-device"]);
  isRoot = (await sh("id -u", true)).trim() === "0";
}

async function launcherComponent(pkg: string): Promise<string> {
  const out = await sh(
    `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`,
  );
  const line = out.trim().split("\n").pop()!.trim();
  if (!line.includes("/")) {
    throw new Error(`no launcher activity for ${pkg} (is it installed?)`);
  }
  return line;
}

async function screenSize(): Promise<{ w: number; h: number }> {
  const out = await sh("wm size");
  const s = parseWmSize(out);
  if (!s) throw new Error(`cannot parse wm size: ${out}`);
  return s;
}

async function keepAwake() {
  await sh("svc power stayon true", true);
  await sh("settings put system screen_off_timeout 1800000", true);
  await sh("input keyevent KEYCODE_WAKEUP", true);
  await sh("wm dismiss-keyguard", true);
}

async function forceStopAll() {
  for (const a of Object.values(APPS)) await sh(`am force-stop ${a.pkg}`, true);
}

const pidOf = async (pkg: string): Promise<number | null> => {
  const out = (await sh(`pidof ${pkg}`, true)).trim().split(/\s+/)[0];
  return out && /^\d+$/.test(out) ? Number(out) : null;
};
const isAlive = async (pkg: string) => (await pidOf(pkg)) !== null;

/** The app's PID for the current cell (crash lines are matched by it). */
let appPid: number | null = null;

// ─── memory ──────────────────────────────────────────────────────────────────────────────

const rendererPids = async () => parseRendererPids(await sh("ps -A -o PID,NAME", true));

async function pss(app: AppDef, attributed: Map<number, string>, tag: string) {
  const out = await sh(`dumpsys meminfo ${app.pkg}`, true);
  await saveRaw(`${tag}-meminfo`, out);
  let renderer = 0;
  for (const [pid] of attributed) {
    const r = await sh(`dumpsys meminfo ${pid}`, true);
    renderer += parseTotalPss(r) ?? 0;
  }
  const appPss = parseTotalPss(out);
  return appPss === null ? null : appPss + renderer;
}

// ─── SurfaceFlinger ──────────────────────────────────────────────────────────────────────

const sfClear = (layer: string) => sh(`dumpsys SurfaceFlinger --latency-clear ${shq(layer)}`, true);
const sfRead = async (layer: string) =>
  parseSfLatency(
    await sh(`dumpsys SurfaceFlinger --latency ${shq(layer)}`, true),
  );

/** Gesture area: clear of the status bar and the overlay (top) and the nav bar (bottom). */
function gestureSpan(size: { w: number; h: number }) {
  return {
    x: Math.round(size.w / 2),
    top: Math.round(size.h * 0.3),
    bottom: Math.round(size.h * 0.75),
  };
}

/** forward = toward the end of the list = finger moving UP. */
async function swipe(
  size: { w: number; h: number },
  forward: boolean,
  ms: number,
) {
  const g = gestureSpan(size);
  const [y1, y2] = forward ? [g.bottom, g.top] : [g.top, g.bottom];
  await sh(`input swipe ${g.x} ${y1} ${g.x} ${y2} ${ms}`);
}

/** Samples SurfaceFlinger around gestures/actions on one layer (discovered on first use). */
class FrameSampler {
  layer: string | null = null;
  candidates: string[] = [];
  counts: Record<string, number> = {};
  periodNs = 16_666_667;
  constructor(readonly pkg: string) {}

  async around(run: () => Promise<void>, waitMs: number): Promise<number[]> {
    if (!this.layer) {
      this.candidates = parseSfLayers(
        await sh("dumpsys SurfaceFlinger --list", true),
        this.pkg,
      );
      for (const c of this.candidates) await sfClear(c);
      await run();
      await sleep(waitMs);
      let best: { layer: string; present: number[]; periodNs: number } | null = null;
      for (const c of this.candidates) {
        const r = await sfRead(c);
        this.counts[c] = r.present.length;
        if (!best || r.present.length > best.present.length) {
          best = { layer: c, ...r };
        }
      }
      if (best && best.present.length > 0) {
        this.layer = best.layer;
        this.periodNs = best.periodNs;
        return burstIntervals(best.present);
      }
      return [];
    }
    await sfClear(this.layer);
    await run();
    await sleep(waitMs);
    const r = await sfRead(this.layer);
    this.periodNs = r.periodNs;
    return burstIntervals(r.present);
  }
}

// ─── logcat ──────────────────────────────────────────────────────────────────────────────

const logcatDump = () =>
  adb(["logcat", "-d", "-v", "epoch", "-b", "main,system,crash,events"], {
    allowFail: true,
  });

class CellFailure extends Error {
  constructor(
    readonly status: CellResult["status"],
    readonly phase: string,
    message: string,
  ) {
    super(message);
  }
}

/** Throws a CellFailure if the app died / ANR'd / OOM'd or its WebView renderer is gone. */
async function checkHealth(app: AppDef, phase: string) {
  const log = await logcatDump();
  const failure = classifyLogcat(log, app.pkg, appPid);
  const alive = await isAlive(app.pkg);
  if (failure) {
    throw new CellFailure(failure.failure, phase, failure.line.slice(0, 300));
  }
  if (!alive) throw new CellFailure("crashed", phase, "process not running");
}

/** Wait for the first marker matching `pred` that appears in logcat; null on timeout. */
async function waitMarker(
  app: AppDef,
  pred: (m: MarkerHit) => boolean,
  timeoutMs: number,
  phase: string,
  skip = 0,
): Promise<{ hit: MarkerHit; log: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = await logcatDump();
    const hits = findMarkers(log).filter(pred);
    if (hits.length > skip) return { hit: hits[skip], log };
    const failure = classifyLogcat(log, app.pkg, appPid);
    if (failure) {
      throw new CellFailure(failure.failure, phase, failure.line.slice(0, 300));
    }
    if (!(await isAlive(app.pkg))) {
      await sleep(500);
      const again = classifyLogcat(await logcatDump(), app.pkg, appPid);
      throw new CellFailure(
        again?.failure ?? "crashed",
        phase,
        again?.line ?? "process exited",
      );
    }
    await sleep(500);
  }
  return null;
}

// ─── compile ─────────────────────────────────────────────────────────────────────────────

async function compileStep(app: AppDef, mode: string) {
  if (mode === "none") return;
  const component = await launcherComponent(app.pkg);
  if (mode === "speed-profile") {
    for (let i = 0; i < 2; i++) {
      await sh(`am force-stop ${app.pkg}`);
      await sh(`am start -W -n ${component}`);
      await sleep(isRoot ? 8000 : 25000);
      if (isRoot) await sh(`killall -s SIGUSR1 ${app.pkg}`, true);
      await sleep(2000);
    }
  }
  const out = await sh(`cmd package compile -f -m ${mode} ${app.pkg}`, true);
  await saveRaw(`${app.key}-compile`, out);
  await sh(`am force-stop ${app.pkg}`);
}

// ─── one cell ────────────────────────────────────────────────────────────────────────────

async function runCell(
  cell: Cell,
  cfg: MatrixConfig,
  size: { w: number; h: number },
): Promise<CellResult> {
  const app = APPS[cell.app];
  const started = Date.now();
  const result: CellResult = {
    id: cell.id,
    app: cell.app,
    impl: cell.impl,
    kind: cell.kind,
    n: cell.n,
    status: "ok",
    startedAt: new Date().toISOString(),
  };
  if (!cell.plan.run) {
    return {
      ...result,
      status: "skipped",
      reason: cell.plan.reason,
      durationSec: 0,
    };
  }
  const steps = cellSteps(cell, cfg);
  const launch = steps[0] as Extract<Step, { type: "launch" }>;
  const sampler = new FrameSampler(app.pkg);
  const phases: NonNullable<CellResult["phases"]> = {};
  const addPhase = (
    name: keyof typeof phases,
    intervals: number[],
    action?: { ms?: number; fail?: string },
  ) => {
    const p: PhaseResult & { _i?: number[] } = phases[name] as PhaseResult & { _i?: number[] } ??
      { sf: null };
    p._i = [...(p._i ?? []), ...intervals];
    if (action?.ms !== undefined) {
      p.actionMs = [...(p.actionMs ?? []), action.ms];
    }
    if (action?.fail) {
      p.actionFailures = [...(p.actionFailures ?? []), action.fail];
    }
    phases[name] = p;
  };
  let phase = "launch";
  appPid = null;
  try {
    await forceStopAll();
    await sleep(1500);
    await adb(["logcat", "-c", "-b", "main,system,crash,events"], {
      allowFail: true,
    });
    const before = await rendererPids();
    const attribute = async () => {
      const now = await rendererPids();
      return new Map([...now].filter(([pid]) => !before.has(pid)));
    };
    const tag = `launch-${cell.id}`;
    await sh(`log -t SCROLLBENCH_HARNESS ${tag}`);
    const am = parseAmStart(
      await sh(
        `am start -W -a android.intent.action.VIEW -d ${shq(launch.link)} ${app.pkg}`,
      ),
    );
    result.amTotalTimeMs = am.totalTimeMs;
    appPid = await pidOf(app.pkg);

    phase = "ready";
    const ready = await waitMarker(
      app,
      (m) => m.marker === "ready" || m.marker === "skipped" || m.marker === "error",
      cfg.readyTimeoutSec * 1000,
      phase,
    );
    if (!ready) {
      await screenshot(`${cell.id}-timeout`);
      return {
        ...result,
        status: "timeout",
        failedPhase: phase,
        reason: `no ready marker in ${cfg.readyTimeoutSec} s`,
      };
    }
    if (ready.hit.marker === "skipped") {
      return {
        ...result,
        status: "skipped",
        reason: String(ready.hit.data.reason ?? "skipped by app"),
      };
    }
    if (ready.hit.marker === "error") {
      await screenshot(`${cell.id}-error`);
      return {
        ...result,
        status: "error",
        failedPhase: phase,
        reason: String(ready.hit.data.message),
      };
    }
    const t0 = harnessLineMs(ready.log, tag);
    result.launchToReadyMs = t0 !== null && ready.hit.epochMs !== null
      ? ready.hit.epochMs - t0
      : null;
    result.ready = ready.hit.data;
    await sleep(cfg.settleSec * 1000);
    await screenshot(`${cell.id}-ready`);
    result.pssReadyKb = await pss(app, await attribute(), `${cell.id}-ready`);

    await sh(`dumpsys gfxinfo ${app.pkg} reset`, true);
    let actionsSeen = findMarkers(await logcatDump()).filter((m) => m.marker === "action").length;
    for (const step of steps.slice(1)) {
      if (step.type === "fling" || step.type === "drag") {
        phase = step.type;
        for (let i = 0; i < step.count; i++) {
          const intervals = await sampler.around(
            () => swipe(size, step.forward, step.type === "fling" ? 120 : 1500),
            step.type === "fling" ? 1200 : 800,
          );
          addPhase(step.type, intervals);
        }
        await checkHealth(app, phase);
      } else if (step.type === "action") {
        phase = step.phase;
        let info: MarkerHit | null = null;
        const intervals = await sampler.around(async () => {
          await sh(
            `am start -a android.intent.action.VIEW -d ${shq(step.link)} ${app.pkg}`,
          );
          const got = await waitMarker(
            app,
            (m) => m.marker === "action",
            cfg.actionTimeoutSec * 1000,
            phase,
            actionsSeen,
          );
          if (got) {
            info = got.hit;
            actionsSeen++;
          }
        }, 600);
        const hit = info as MarkerHit | null;
        if (step.phase === "position") continue;
        if (!hit) {
          addPhase(step.phase, intervals, { fail: `${step.link}: timeout` });
        } else if (hit.data.ok === false) {
          addPhase(step.phase, intervals, {
            fail: `${step.link}: ${hit.data.reason}`,
          });
        } else addPhase(step.phase, intervals, { ms: Number(hit.data.ms) });
      }
    }
    phase = "end";
    await checkHealth(app, phase);
    const jsErrors = findMarkers(await logcatDump()).filter((m) => m.marker === "error");
    if (jsErrors.length) result.errors = jsErrors.map((m) => String(m.data.message).slice(0, 200));
    const gfxText = await sh(`dumpsys gfxinfo ${app.pkg}`, true);
    await saveRaw(`${cell.id}-gfxinfo`, gfxText);
    result.gfx = parseGfx(gfxText) as unknown as Record<string, number | null>;
    result.pssEndKb = await pss(app, await attribute(), `${cell.id}-end`);
    await screenshot(`${cell.id}-end`);
  } catch (e) {
    if (e instanceof CellFailure) {
      result.status = e.status;
      result.failedPhase = e.phase;
      result.reason = e.message;
      await saveRaw(`${cell.id}-failure-logcat`, await logcatDump());
      await screenshot(`${cell.id}-failure`);
      // Leave nothing behind for the next cell (an ANR dialog, a half-dead process).
      await sh("input keyevent KEYCODE_BACK", true);
    } else {
      result.status = "error";
      result.failedPhase = phase;
      result.reason = String((e as Error)?.message ?? e).slice(0, 300);
    }
  } finally {
    await sh(`am force-stop ${app.pkg}`, true);
  }
  for (const [name, p] of Object.entries(phases)) {
    const withI = p as PhaseResult & { _i?: number[] };
    withI.sf = withI._i && withI._i.length ? summarizeIntervals(withI._i, sampler.periodNs) : null;
    delete withI._i;
    phases[name as keyof typeof phases] = withI;
  }
  result.phases = phases;
  result.layer = sampler.layer;
  result.durationSec = Math.round((Date.now() - started) / 1000);
  return result;
}

// ─── commands ────────────────────────────────────────────────────────────────────────────

async function readConfig(): Promise<MatrixConfig> {
  const path = str("config", "");
  if (!path) return loadConfig({});
  return loadConfig(JSON.parse(await Deno.readTextFile(path)));
}

function filterCells(cells: Cell[]): Cell[] {
  const only = str("only", "");
  if (!only) return cells;
  const parts = only.split(",").map((s) => s.trim()).filter(Boolean);
  return cells.filter((c) => parts.some((p) => c.id.includes(p)));
}

async function matrix() {
  const cfg = await readConfig();
  const cells = filterCells(expandMatrix(cfg));
  const runnable = cells.filter((c) => c.plan.run);

  if (flags["dry-run"]) {
    console.log(
      `matrix: ${cells.length} cells, ${runnable.length} to run, ${
        cells.length - runnable.length
      } skipped by the catalogue\nconfig: ${JSON.stringify(cfg)}\n`,
    );
    for (const c of cells) {
      if (!c.plan.run) {
        console.log(`SKIP ${c.id}: ${c.plan.reason}`);
        continue;
      }
      console.log(`RUN  ${c.id}  (${APPS[c.app].pkg})`);
      for (const s of cellSteps(c, cfg)) {
        if (s.type === "launch") console.log(`       launch  ${s.link}`);
        else if (s.type === "action") {
          console.log(`       ${s.phase.padEnd(7)} ${s.link}`);
        } else {console.log(
            `       ${s.type.padEnd(7)} ${s.forward ? "forward" : "backward"} ×${s.count}`,
          );}
      }
    }
    return;
  }

  const resume = str("resume", "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = resume || `${str("out", `${HERE}../results`)}/${stamp}`;
  RAW_DIR = `${outDir}/raw`;
  await Deno.mkdir(RAW_DIR, { recursive: true });
  await Deno.mkdir(`${outDir}/cells`, { recursive: true });

  await tryRoot();
  await keepAwake();
  const size = await screenSize();
  const device = {
    model: (await sh("getprop ro.product.model")).trim(),
    sdk: (await sh("getprop ro.build.version.sdk")).trim(),
    size: `${size.w}x${size.h}`,
    root: isRoot,
    webview: (await sh(
      "dumpsys webviewupdate | grep -i 'Current WebView package'",
      true,
    )).trim(),
  };
  console.log(`device ${JSON.stringify(device)}; output ${outDir}`);

  const compile = str("compile", "speed-profile");
  for (const app of cfg.apps) {
    console.log(`[${app}] compile: ${compile}`);
    await compileStep(APPS[app], compile);
  }

  const results: CellResult[] = [];
  for (const [i, cell] of cells.entries()) {
    const file = `${outDir}/cells/${cell.id}.json`;
    if (resume) {
      try {
        results.push(JSON.parse(await Deno.readTextFile(file)));
        continue;
      } catch { /* not run yet */ }
    }
    const r = await runCell(cell, cfg, size);
    results.push(r);
    await Deno.writeTextFile(file, JSON.stringify(r, null, 2));
    console.log(
      `[${i + 1}/${cells.length}] ${cell.id}: ${r.status}${r.reason ? ` (${r.reason})` : ""}` +
        (r.status === "ok"
          ? ` ready ${fmt(r.launchToReadyMs, " ms")}, fling missed ${
            fmt(r.phases?.fling?.sf?.missedVsyncPct, "%")
          } p90 ${fmt(r.phases?.fling?.sf?.p90Ms, " ms")}, PSS ${mb(r.pssEndKb)}`
          : ""),
    );
  }
  await forceStopAll();

  const header = [
    "# Scroll bench matrix",
    "",
    `Device: ${device.model} (API ${device.sdk}), ${device.size}, root: ${device.root}. ` +
    `WebView: ${
      device.webview || "?"
    }. Compile: ${compile}. Flings: ${cfg.flings}×2, drags ${cfg.drags}×2 per cell.`,
  ].join("\n");
  await Deno.writeTextFile(
    `${outDir}/results.json`,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), device, config: cfg, results },
      null,
      2,
    ),
  );
  const md = renderMarkdown(results, header);
  await Deno.writeTextFile(`${outDir}/results.md`, md);
  console.log(`\n${md}\nwrote ${outDir}/results.json and results.md`);
}

async function doctor() {
  console.log(`adb: ${ADB}`);
  console.log((await adb(["devices", "-l"])).trim());
  console.log(
    `model: ${(await sh("getprop ro.product.model")).trim()}, API ${
      (await sh("getprop ro.build.version.sdk")).trim()
    }, abi ${(await sh("getprop ro.product.cpu.abi")).trim()}`,
  );
  console.log(
    `boot_completed: ${(await sh("getprop sys.boot_completed")).trim()}`,
  );
  console.log(
    `webview: ${
      (await sh(
        "dumpsys webviewupdate | grep -i 'Current WebView package'",
        true,
      )).trim()
    }`,
  );
  await tryRoot();
  console.log(`root: ${isRoot}`);
  for (const a of Object.values(APPS)) {
    let apk = "missing";
    try {
      apk = `${(Deno.statSync(a.apk).size / 1048576).toFixed(1)} MB`;
    } catch { /* missing */ }
    const installed = (await sh(`pm path ${a.pkg}`, true)).includes("package:");
    console.log(`${a.label}: ${a.apk} ${apk}, installed ${installed}`);
  }
}

async function install() {
  for (const a of Object.values(APPS)) {
    console.log(`installing ${a.label} …`);
    console.log((await adb(["install", "-r", "-g", a.apk])).trim());
  }
}

/** Cold start (launcher, no deep link) ×N interleaved + PSS after launch, per app. */
async function coldstart() {
  const runs = num("runs", 5);
  const settle = num("settle", 10) * 1000;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = `${str("out", `${HERE}../results`)}/coldstart-${stamp}`;
  RAW_DIR = `${outDir}/raw`;
  await Deno.mkdir(RAW_DIR, { recursive: true });
  await tryRoot();
  await keepAwake();
  const keys = Object.keys(APPS) as AppId[];
  const components = {} as Record<AppId, string>;
  for (const k of keys) components[k] = await launcherComponent(APPS[k].pkg);
  const compile = str("compile", "speed-profile");
  for (const k of keys) await compileStep(APPS[k], compile);
  const samples: Record<string, (number | null)[]> = { denext: [], rn: [] };
  for (let i = 0; i < runs; i++) {
    for (const k of keys) {
      await forceStopAll();
      if (flags["drop-caches"] && isRoot) {
        await sh("sync; echo 3 > /proc/sys/vm/drop_caches", true);
      }
      await sleep(2000);
      const s = parseAmStart(await sh(`am start -W -n ${components[k]}`));
      samples[k].push(s.totalTimeMs);
      console.log(
        `[${k}] cold start ${i + 1}/${runs}: TotalTime ${s.totalTimeMs} ms`,
      );
      await sleep(3000);
    }
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    await forceStopAll();
    await sleep(2000);
    const before = await rendererPids();
    await sh(`am start -W -n ${components[k]}`);
    await sleep(settle);
    const now = await rendererPids();
    const kb = await pss(
      APPS[k],
      new Map([...now].filter(([p]) => !before.has(p))),
      `${k}-launch`,
    );
    out[k] = { totalTime: stats(samples[k]), pssAfterLaunchKb: kb };
    console.log(
      `[${k}] TotalTime median ${stats(samples[k]).median} ms, PSS ${mb(kb)}`,
    );
  }
  await forceStopAll();
  await Deno.writeTextFile(
    `${outDir}/coldstart.json`,
    JSON.stringify(out, null, 2),
  );
  console.log(`wrote ${outDir}/coldstart.json`);
}

const cmd = positional[0] ?? "help";
if (cmd === "doctor") await doctor();
else if (cmd === "install") await install();
else if (cmd === "coldstart") await coldstart();
else if (cmd === "matrix") await matrix();
else {
  console.log(
    "usage: deno run -A harness/measure.ts doctor | install | coldstart | matrix [--config f] [--only s] [--dry-run]\nSee the header of this file.",
  );
}
