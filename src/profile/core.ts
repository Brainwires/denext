// The profiler engine behind `denext profile` (CLI) and `denext_profile` (MCP): build
// the app unminified, serve it on an ephemeral port, drive headless Chromium via the
// CDP `Profiler` + `HeapProfiler` domains, and return a structured CPU self-time + heap
// result (optionally gated against a budget). No `Deno.exit`, no argv, no printing — the
// callers own presentation and the exit code.
//
// astral is imported lazily so nothing that merely imports this module pulls Chromium in
// (the MCP server keeps every other tool browser-free until this one is invoked).

import { resolveProject } from "../build/paths.ts";
import { build } from "../build/build.ts";
import { buildSpa } from "../build/spa/build.ts";
import { serveEphemeral } from "../build/prod-server.ts";
import { aggregateSelfTime, type RawCpuProfile } from "./cpu.ts";
import { type HeapResult, isLeak } from "./heap.ts";
import { evaluateBudget } from "./budget.ts";
import type { ProfileOptions, ProfileResult } from "./types.ts";

/** Run `fn` with `DENEXT_NO_MINIFY` forced to match `minify`, restoring the prior value. */
async function withMinifyEnv<T>(minify: boolean, fn: () => Promise<T>): Promise<T> {
  const key = "DENEXT_NO_MINIFY";
  const prior = Deno.env.get(key);
  if (minify) Deno.env.delete(key);
  else Deno.env.set(key, "1");
  try {
    return await fn();
  } finally {
    if (prior === undefined) Deno.env.delete(key);
    else Deno.env.set(key, prior);
  }
}

/** Build the project (SPA or App Router) with the chosen minify setting. */
async function buildForProfile(dir: string, minify: boolean): Promise<void> {
  const paths = await resolveProject(dir);
  await withMinifyEnv(minify, async () => {
    if (paths.config?.mode === "spa") await buildSpa(paths);
    else await build(dir);
  });
}

// deno-lint-ignore no-explicit-any
type Cdp = any;

/** Read the page's used JS-heap size (precise with `--enable-precise-memory-info`). */
// deno-lint-ignore no-explicit-any
async function readHeapBytes(page: any): Promise<number> {
  const v = await page.evaluate(
    "(performance && performance.memory) ? performance.memory.usedJSHeapSize : 0",
  );
  return typeof v === "number" ? v : 0;
}

/** Force a full GC via CDP and give the heap a moment to settle. */
async function forceGc(cdp: Cdp): Promise<void> {
  await cdp.HeapProfiler.collectGarbage();
  await new Promise((r) => setTimeout(r, 150));
}

/** A short settle so post-`load` hydration/first-render + effects are captured. */
const settle = () => new Promise((r) => setTimeout(r, 300));

/** The CPU profile + heap reading captured by one of the two modes. */
interface Capture {
  profile: RawCpuProfile;
  heap: HeapResult;
}

/**
 * Stop the profiler and read the post-workload heap: the pre-GC peak, then a forced GC
 * and the retained size. `leakCheck` distinguishes the modes — true for interaction mode
 * (post-load baseline → a real leak signal), false for startup mode (blank baseline).
 */
async function stopAndMeasure(
  // deno-lint-ignore no-explicit-any
  page: any,
  cdp: Cdp,
  beforeBytes: number,
  leakCheck: boolean,
): Promise<Capture> {
  const { profile } = await cdp.Profiler.stop() as { profile: RawCpuProfile };
  const afterBytes = await readHeapBytes(page);
  await forceGc(cdp);
  const afterGcBytes = await readHeapBytes(page);
  const leaked = leakCheck ? isLeak(beforeBytes, afterGcBytes) : false;
  return { profile, heap: { beforeBytes, afterBytes, afterGcBytes, leaked } };
}

/**
 * INTERACTION mode (`--interact` given): load and settle the app so the heap baseline is
 * the idle, loaded app, then profile the interaction repeated `iterations` times. Because
 * the baseline is post-load, the post-GC delta is a real leak signal — a repeated
 * interaction that keeps growing after GC retained something it shouldn't.
 */
async function captureInteraction(
  // deno-lint-ignore no-explicit-any
  page: any,
  cdp: Cdp,
  url: string,
  interact: string,
  iterations: number,
): Promise<Capture> {
  await page.goto(url);
  await settle();
  await forceGc(cdp);
  const beforeBytes = await readHeapBytes(page);
  await cdp.Profiler.start();
  for (let i = 0; i < iterations; i++) await page.evaluate(interact);
  return stopAndMeasure(page, cdp, beforeBytes, true);
}

/**
 * STARTUP mode (default, no `--interact`): profile the initial load + hydration + first
 * render — the startup window. The profiler is armed on the blank page and the navigation
 * happens inside the window, so the reconciler/hydration work is captured (it isn't in
 * interaction mode, which starts profiling after load). The heap baseline is the blank
 * page, so the delta is the app's own startup allocation — informative, but not a leak
 * signal, so `leaked` is reported false here.
 */
async function captureStartup(
  // deno-lint-ignore no-explicit-any
  page: any,
  cdp: Cdp,
  url: string,
  iterations: number,
): Promise<Capture> {
  await forceGc(cdp);
  const beforeBytes = await readHeapBytes(page);
  await cdp.Profiler.start();
  for (let i = 0; i < iterations; i++) {
    await page.goto(url);
    await settle();
  }
  return stopAndMeasure(page, cdp, beforeBytes, false);
}

/**
 * Build, serve, and profile `dir`. Returns CPU self-time, heap growth + leak verdict,
 * and (when `options.budget` is set) the budget verdict.
 */
export async function profileApp(
  dir: string,
  options: ProfileOptions = {},
): Promise<ProfileResult> {
  const route = options.route ?? "/";
  const minify = options.minify ?? false;
  const iterations = Math.max(1, options.iterations ?? 1);
  const samplingMicros = options.samplingMicros ?? 100;

  await buildForProfile(dir, minify);
  const { origin, close: closeServer } = await serveEphemeral(dir);

  // Lazy so importing this module never pulls Chromium in.
  const { launchManagedBrowser } = await import("./browser.ts");
  const browser = await launchManagedBrowser(["--enable-precise-memory-info"]);
  try {
    const page = await browser.newPage();
    const cdp: Cdp = page.unsafelyGetCelestialBindings();
    await cdp.HeapProfiler.enable();
    await cdp.Profiler.enable();
    await cdp.Profiler.setSamplingInterval({ interval: samplingMicros });

    const url = origin + route;
    const { profile, heap } = options.interact
      ? await captureInteraction(page, cdp, url, options.interact, iterations)
      : await captureStartup(page, cdp, url, iterations);

    const cpu = aggregateSelfTime(profile, options.topN ?? 20);
    const budget = options.budget ? evaluateBudget(options.budget, cpu, heap) : undefined;
    return { route, origin, cpu, heap, budget, minified: minify };
  } finally {
    await browser.close().catch(() => {});
    await closeServer();
  }
}
