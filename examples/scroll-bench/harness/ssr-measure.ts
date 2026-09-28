#!/usr/bin/env -S deno run -A
/// <reference lib="dom" />
/**
 * ssr-measure.ts: the server-rendered list benchmark in headless Chromium. Serves the ssr/
 * App Router app (`denext start`, after `deno task build` there) behind a gzip proxy, and the
 * SPA export (web/out) for the `virtual-spa` reference, then loads every (profile, impl, kind,
 * n) cell `--runs` times, each in a cold browser, and writes results/ssr-<date>/.
 *
 *   (cd ssr && deno task build)
 *   deno run -A harness/ssr-measure.ts [--impls static,static-cv] [--kinds fixed,chat]
 *     [--sizes 100,1000] [--profiles desktop,mobile] [--runs 3] [--out results/ssr-<date>]
 *     [--resume] [--origin http://host:port] [--max-load 4] [--unusable-s 30] [--no-gzip]
 *     [--smoke]
 *
 * `--impls` takes impl ids and the groups `static`, `islands` (the pages whose rows' controls
 * are islands: static-cv-islands, -resumable, -delegated) and `virtual` (the VirtualList
 * impls and the SPA reference). `--resume` keeps the cells already in --out; every run rewrites results.json/.md from all
 * the cells there, so re-running a subset (`--impls virtual-island`) updates the report.
 * `--smoke`: one run, desktop, n=100 and 1000, every impl: a quick check that each page loads,
 * hydrates and answers its row control.
 *
 * METHOD, per run: a fresh browser profile (empty cache). `mobile` = a 412×915 viewport at DPR
 * 2.625 with touch, CPU throttled 4× (`Emulation.setCPUThrottlingRate`) and the network at
 * 9 Mbps down / 1.5 Mbps up / 60 ms RTT. A script injected before the page's own records
 * long tasks and LCP. After the load event the run waits until the page is settled (the
 * islands it waits for are hydrated and no long task for 700 ms), then reads the navigation
 * and resource timings, `Performance.getMetrics` (JS heap) and the renderers' private memory
 * (Linux `RssAnon`; RSS elsewhere),
 * clicks a row's like button twice (two rows; pointerdown → the frame after its
 * `aria-pressed` flipped), flings the list (`Input.synthesizeScrollGesture`, 5000 px/s, up to
 * 20 viewports) while recording requestAnimationFrame intervals (summarised like the SPA
 * harness's SurfaceFlinger intervals: p90 and % over 1.5 vsync), then probes find-in-page
 * (`window.find` of a phrase of row n−1, and `DOM.performSearch` for it) and counts the
 * non-ignored `listitem` nodes of the accessibility tree. A run that does not reach its load
 * event within the budget (60 s desktop, 180 s mobile), or whose renderer crashes, fails; a
 * cell whose runs all fail, or whose median time to interactive is over `--unusable-s`
 * (default 30 s), makes the larger sizes of that impl/kind/profile `skipped`.
 */

import { type Browser, launch } from "@astral/astral";
import { makeItems } from "../shared/data.ts";
import type { Kind } from "../shared/data.ts";
import {
  expandImpls,
  findSsrImpl,
  probeText,
  SSR_IMPLS,
  SSR_KINDS,
  SSR_SIZES,
  ssrCellPath,
  type SsrImplDef,
} from "../shared/ssr-cells.ts";
import { parseArgs } from "./parse.ts";
import {
  type CellId,
  cellId,
  type CellRecord,
  frameSummary,
  medians,
  type ProfileId,
  renderSsrMarkdown,
  type ReportMeta,
  type RunMetrics,
  skippedByFailure,
  summaryCell,
  timeToInteractive,
  totalBlockingTime,
} from "./ssr-report.ts";

const { flags } = parseArgs(Deno.args);
const list = (k: string, all: readonly string[]) =>
  typeof flags[k] === "string" ? (flags[k] as string).split(",") : [...all];
const smoke = flags.smoke === true;
const IMPL_IDS = expandImpls(list("impls", SSR_IMPLS.map((d) => d.id)));
const KIND_IDS = list("kinds", SSR_KINDS) as Kind[];
const SIZES = smoke ? [100, 1000] : list("sizes", SSR_SIZES.map(String)).map(Number);
const PROFILES = (smoke ? ["desktop"] : list("profiles", ["desktop", "mobile"])) as ProfileId[];
const RUNS = smoke ? 1 : Number(flags.runs ?? 3);
const MAX_LOAD = Number(flags["max-load"] ?? 4);
/** A cell whose median time to interactive is over this is unusable: larger sizes are skipped. */
const UNUSABLE_MS = Number(flags["unusable-s"] ?? 30) * 1000;
const DATE = new Date().toISOString().slice(0, 10);
const OUT = typeof flags.out === "string"
  ? new URL(`${flags.out.replace(/\/?$/, "/")}`, `file://${Deno.cwd()}/`)
  : new URL(`../results/ssr-${smoke ? "smoke-" : ""}${DATE}/`, import.meta.url);
const SSR_DIR = new URL("../ssr/", import.meta.url);
const WEB_OUT = new URL("../web/out/", import.meta.url);
const CLI = new URL("../../../cli.ts", import.meta.url);

const PROFILE_TEXT: Record<ProfileId, string> = {
  desktop: "1280×800 viewport, DPR 1, no CPU or network throttling",
  mobile: "412×915 viewport, DPR 2.625, touch, CPU throttled 4×, network 9 Mbps down / " +
    "1.5 Mbps up / 60 ms RTT",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rejects with `label` when `p` takes longer than `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

// ─── machine ────────────────────────────────────────────────────────────────────────────

async function sh(cmd: string[]): Promise<string> {
  try {
    const out = await new Deno.Command(cmd[0], { args: cmd.slice(1), stderr: "null" }).output();
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return "";
  }
}

async function loadavg(): Promise<number[]> {
  const text = Deno.build.os === "linux"
    ? await Deno.readTextFile("/proc/loadavg").catch(() => "")
    : (await sh(["sysctl", "-n", "vm.loadavg"])).replace(/[{}]/g, "");
  return text.trim().split(/\s+/).slice(0, 3).map(Number);
}

async function machine(): Promise<string> {
  const cpu = Deno.build.os === "linux"
    ? (await Deno.readTextFile("/proc/cpuinfo").catch(() => "")).match(/model name\s*:\s*(.*)/)
      ?.[1]
    : await sh(["sysctl", "-n", "machdep.cpu.brand_string"]);
  const mem = Math.round(Deno.systemMemoryInfo().total / 1024 ** 3);
  // navigator.hardwareConcurrency is what Deno may use, not what the machine has.
  const cpus = Deno.build.os === "linux"
    ? (await Deno.readTextFile("/proc/cpuinfo").catch(() => "")).match(/^processor/gm)?.length
    : Number(await sh(["sysctl", "-n", "hw.logicalcpu"]));
  return `${Deno.hostname()} (${Deno.build.os} ${Deno.build.arch}, ${cpu ?? "?"}, ` +
    `${cpus ?? "?"} logical CPUs, ${mem} GB)`;
}

/** Waits (polling every 30 s) until the 1-minute load average is under --max-load. */
async function waitForQuiet(): Promise<void> {
  for (;;) {
    const [one] = await loadavg();
    if (!(one >= MAX_LOAD)) return;
    console.log(`  load ${one} ≥ ${MAX_LOAD}: waiting`);
    await sleep(30_000);
  }
}

// ─── servers ────────────────────────────────────────────────────────────────────────────

const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;

/** A gzip proxy in front of `upstream`, like a CDN: compresses what the origin sent plain. */
function gzipProxy(upstream: string, gzip: boolean): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const res = await fetch(`${upstream}${url.pathname}${url.search}`, {
      headers: { "accept-encoding": "identity" },
      redirect: "manual",
    });
    const headers = new Headers(res.headers);
    const type = headers.get("content-type") ?? "";
    const accepts = (req.headers.get("accept-encoding") ?? "").includes("gzip");
    if (!gzip || !accepts || !res.body || !COMPRESSIBLE.test(type)) {
      return new Response(res.body, { status: res.status, headers });
    }
    headers.delete("content-length");
    headers.set("content-encoding", "gzip");
    headers.append("vary", "accept-encoding");
    return new Response(res.body.pipeThrough(new CompressionStream("gzip")), {
      status: res.status,
      headers,
    });
  });
}

const MIME: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  png: "image/png",
  json: "application/json",
  wasm: "application/wasm",
};

/** Serves the SPA export (web/out) for the `virtual-spa` reference. */
function spaServer(): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = path === "/" || !path.includes(".") ? "index.html" : path.slice(1);
    try {
      const body = await Deno.readFile(new URL(file, WEB_OUT));
      const type = MIME[file.split(".").pop()!] ?? "application/octet-stream";
      return new Response(body, { headers: { "content-type": type } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

/** `denext start` for ssr/ on a free port; resolves once `/` answers. */
async function startSsr(): Promise<{ origin: string; stop: () => Promise<void> }> {
  try {
    await Deno.stat(new URL(".denext/", SSR_DIR));
  } catch {
    throw new Error("ssr/ is not built: run `cd ssr && deno task build` first");
  }
  const probe = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CLI.pathname, "start", ".", "--port", String(port)],
    cwd: SSR_DIR.pathname,
    stdout: "null",
    stderr: "null",
  }).spawn();
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${origin}/`).then((r) => (r.body?.cancel(), r.ok)).catch(() => false);
    if (ok) {
      return {
        origin,
        stop: async () => {
          child.kill("SIGTERM");
          await child.status;
        },
      };
    }
    await sleep(250);
  }
  child.kill("SIGKILL");
  throw new Error("denext start did not answer within 30 s");
}

// ─── the page probe ─────────────────────────────────────────────────────────────────────

/** Injected before the page's own scripts: long tasks and LCP, buffered from the start. */
const PROBE = `(() => {
  const p = (globalThis.__sbPerf = { longTasks: [], lcp: 0 });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) p.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) p.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
})();`;

interface PageState {
  hydrated: number;
  hydratedAt: number | null;
  lastLongTaskEnd: number;
  now: number;
  readyState: string;
}

/** Islands the page waits for before it is settled. */
function expectedHydration(impl: SsrImplDef, n: number): number {
  if (impl.belowFold) return 0; // client:visible: hydrates when scrolled to (below)
  switch (impl.interactivity) {
    case "islands":
      return n;
    case "delegated":
    case "script":
    case "virtual":
      return 1;
    default:
      return impl.spa ? 1 : 0;
  }
}

// Celestial's CDP bindings, loosely typed: the domains this harness calls.
// deno-lint-ignore no-explicit-any
type Cdp = any;

interface EvalResult<T> {
  result?: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function evaluate<T>(cdp: Cdp, expression: string, timeoutMs = 30_000): Promise<T> {
  const res = await withTimeout(
    cdp.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }),
    timeoutMs,
    "page did not answer",
  ) as EvalResult<T> | undefined;
  if (!res) throw new Error("evaluate failed: no result");
  const ex = res.exceptionDetails;
  if (ex) throw new Error(`evaluate failed: ${ex.exception?.description ?? ex.text}`);
  return res.result?.value as T;
}

const STATE_JS = `(() => {
  const g = globalThis;
  const spaReady = g.__bench && g.__bench.ready;
  const tasks = (g.__sbPerf && g.__sbPerf.longTasks) || [];
  const last = tasks.reduce((m, t) => Math.max(m, t.start + t.duration), 0);
  return {
    hydrated: (g.__sbHydrated || 0) + (spaReady ? 1 : 0),
    hydratedAt: g.__sbHydratedAt ?? (spaReady ? g.__bench.info.ms : null),
    lastLongTaskEnd: last,
    now: performance.now(),
    readyState: document.readyState,
  };
})()`;

/** Polls until the expected islands are hydrated and no long task ran for 700 ms. */
async function settle(cdp: Cdp, expected: number, deadline: number): Promise<PageState> {
  let state = await evaluate<PageState>(cdp, STATE_JS);
  while (Date.now() < deadline) {
    const hydrated = state.hydrated >= expected;
    if (hydrated && state.readyState === "complete" && state.now - state.lastLongTaskEnd > 700) {
      return state;
    }
    await sleep(250);
    state = await evaluate<PageState>(cdp, STATE_JS);
  }
  throw new Error(`not settled: ${state.hydrated}/${expected} islands hydrated`);
}

const COLLECT_JS = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const js = performance.getEntriesByType("resource").filter((r) => /\\.m?js(\\?|$)/.test(r.name));
  const sum = (k) => js.reduce((a, r) => a + (r[k] || 0), 0);
  const p = globalThis.__sbPerf || { longTasks: [], lcp: 0 };
  return {
    ttfb: nav.responseStart,
    dcl: nav.domContentLoadedEventEnd,
    load: nav.loadEventEnd,
    htmlTransfer: nav.transferSize,
    htmlDecoded: nav.decodedBodySize,
    fcp: fcp ? fcp.startTime : null,
    lcp: p.lcp || null,
    longTasks: p.longTasks,
    jsTransfer: sum("transferSize"),
    jsDecoded: sum("decodedBodySize"),
    dom: document.getElementsByTagName("*").length,
  };
})()`;

interface Collected {
  ttfb: number;
  dcl: number;
  load: number;
  htmlTransfer: number;
  htmlDecoded: number;
  fcp: number | null;
  lcp: number | null;
  longTasks: { start: number; duration: number }[];
  jsTransfer: number;
  jsDecoded: number;
  dom: number;
}

/** The list's scroller: ssr pages give it `.sb-page`, the SPA is a bare VirtualList. */
const SCROLLER =
  `(document.querySelector(".sb-page") || document.querySelector("[data-denext-virtual-list]"))`;

/** Arms the click probe on the `which`-th like button in view; returns its centre. */
const ARM_CLICK_JS = (which: number) =>
  `(() => {
  // Document order = list order: stop at the first button below the viewport, so the rows
  // content-visibility skipped are never laid out by the probe itself.
  const inView = [];
  for (const b of document.querySelectorAll("button.sb-like")) {
    const r = b.getBoundingClientRect();
    if (r.top > innerHeight) break;
    if (r.top >= 0 && r.bottom <= innerHeight && r.width > 0) inView.push(b);
  }
  const b = inView[${which}];
  if (!b) return null;
  const row = b.parentElement;
  globalThis.__sbClick = null;
  let t0 = null;
  addEventListener("pointerdown", (e) => { t0 = e.timeStamp; }, { capture: true, once: true });
  const mo = new MutationObserver(() => {
    const now = row.querySelector("button.sb-like");
    if (now && now.getAttribute("aria-pressed") === "true") {
      mo.disconnect();
      requestAnimationFrame((t) => { globalThis.__sbClick = { t0, t1: t }; });
    }
  });
  mo.observe(row, { attributes: true, childList: true, subtree: true, characterData: true });
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

async function click(cdp: Cdp, which: number): Promise<number | null> {
  const at = await evaluate<{ x: number; y: number } | null>(cdp, ARM_CLICK_JS(which));
  if (!at) return null;
  const base = { x: at.x, y: at.y, button: "left", clickCount: 1 };
  await cdp.Input.dispatchMouseEvent({ type: "mouseMoved", x: at.x, y: at.y });
  await cdp.Input.dispatchMouseEvent({ type: "mousePressed", ...base });
  await cdp.Input.dispatchMouseEvent({ type: "mouseReleased", ...base });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const r = await evaluate<{ t0: number | null; t1: number } | null>(cdp, "globalThis.__sbClick");
    if (r) return r.t0 == null ? null : Math.round((r.t1 - r.t0) * 10) / 10;
    await sleep(50);
  }
  return null;
}

async function fling(cdp: Cdp, mobile: boolean, viewportH: number) {
  const at = await evaluate<{ x: number; y: number; max: number; top: number } | null>(
    cdp,
    `(() => {
      const el = ${SCROLLER};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      globalThis.__sbFrames = [];
      globalThis.__sbFramesOn = true;
      const tick = (t) => { if (!globalThis.__sbFramesOn) return; globalThis.__sbFrames.push(t); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      return { x: r.left + r.width / 2, y: Math.max(r.top, 0) + Math.min(r.bottom, innerHeight) / 2 - Math.max(r.top, 0) / 2, max: el.scrollHeight - el.clientHeight, top: el.scrollTop };
    })()`,
  );
  if (!at || at.max <= 0) return null;
  const down = at.top < at.max / 2;
  const distance = Math.min(down ? at.max - at.top : at.top, viewportH * 20);
  await withTimeout(
    cdp.Input.synthesizeScrollGesture({
      x: Math.round(at.x),
      y: Math.round(at.y),
      yDistance: down ? -distance : distance,
      speed: 5000,
      gestureSourceType: mobile ? "touch" : "mouse",
      preventFling: true,
    }),
    60_000,
    "fling did not finish",
  );
  const times = await evaluate<number[]>(
    cdp,
    `(() => { globalThis.__sbFramesOn = false; return globalThis.__sbFrames; })()`,
  );
  const intervals = times.slice(1).map((t, i) => t - times[i]);
  return frameSummary(intervals);
}

async function findProbe(cdp: Cdp, text: string, n: number) {
  const found = await evaluate<{ ok: boolean; row: number | null }>(
    cdp,
    `(async () => {
      const el = ${SCROLLER};
      if (el) el.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 300));
      getSelection().removeAllRanges();
      const ok = window.find(${JSON.stringify(text)}, true, false, false, false, false, false);
      const node = getSelection().anchorNode;
      const at = node && (node.nodeType === 1 ? node : node.parentElement);
      const row = at && at.closest("[data-i],[data-index],[data-vl-stub]");
      const idx = row ? Number(row.getAttribute("data-i") ?? row.getAttribute("data-index") ?? row.getAttribute("data-vl-stub")) : null;
      return { ok, row: idx };
    })()`,
  );
  await cdp.DOM.getDocument({ depth: 0 });
  const search = await withTimeout(
    cdp.DOM.performSearch({ query: text }),
    60_000,
    "DOM.performSearch timed out",
  ) as { searchId: string; resultCount: number } | undefined;
  if (search) await cdp.DOM.discardSearchResults({ searchId: search.searchId });
  return { findOk: found.ok && found.row === n - 1, hits: search?.resultCount ?? null };
}

async function axListItems(cdp: Cdp): Promise<number | null> {
  await cdp.Accessibility.enable();
  const doc = await cdp.DOM.getDocument({ depth: 0 }) as { root: { nodeId: number } };
  const res = await withTimeout(
    cdp.Accessibility.queryAXTree({ nodeId: doc.root.nodeId, role: "listitem" }),
    120_000,
    "accessibility tree timed out",
  ) as { nodes: { ignored: boolean }[] } | undefined;
  return res ? res.nodes.filter((x) => !x.ignored).length : null;
}

/** Private (anonymous) resident memory of one process, KB: Linux `RssAnon`, else `ps` RSS. */
async function privateKb(pid: number): Promise<number> {
  if (Deno.build.os !== "linux") return Number(await sh(["ps", "-o", "rss=", "-p", String(pid)]));
  const status = await Deno.readTextFile(`/proc/${pid}/status`).catch(() => "");
  return Number(status.match(/RssAnon:\s+(\d+)/)?.[1] ?? 0);
}

/**
 * Memory of the browser's renderer processes, bytes. On Linux the anonymous resident memory
 * (heap, DOM, layout, JS), without the ~400 MB of shared Chromium mappings RSS counts; on
 * macOS plain RSS.
 */
async function rendererRss(browser: Browser): Promise<number | null> {
  const info = await browser.unsafelyGetCelestialBindings().SystemInfo.getProcessInfo()
    .catch(() => null) as { processInfo: { type: string; id: number }[] } | null;
  const pids = info?.processInfo.filter((p) => p.type === "renderer").map((p) => p.id) ?? [];
  const kb = (await Promise.all(pids.map(privateKb))).reduce((a, b) => a + b, 0);
  return kb ? kb * 1024 : null;
}

// ─── one run ────────────────────────────────────────────────────────────────────────────

const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like " +
  "Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

async function emulate(cdp: Cdp, profile: ProfileId): Promise<number> {
  if (profile === "desktop") {
    await cdp.Emulation.setDeviceMetricsOverride({
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return 800;
  }
  await cdp.Emulation.setDeviceMetricsOverride({
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  await cdp.Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
  await cdp.Emulation.setUserAgentOverride({ userAgent: MOBILE_UA });
  await cdp.Emulation.setCPUThrottlingRate({ rate: 4 });
  await cdp.Network.emulateNetworkConditions({
    offline: false,
    latency: 60,
    downloadThroughput: 9_000_000 / 8,
    uploadThroughput: 1_500_000 / 8,
  });
  return 915;
}

interface Launched {
  browser: Browser;
  dir: string;
  /** The browser process, for a hard kill when it stops answering. */
  pid: number | null;
}

async function launchBrowser(): Promise<Launched> {
  const dir = await Deno.makeTempDir({ prefix: "ssr-measure-" });
  const args = [`--user-data-dir=${dir}`];
  if (Deno.build.os === "linux") args.push("--no-sandbox", "--disable-dev-shm-usage");
  const browser = await launch({ headless: true, args });
  const info = await browser.unsafelyGetCelestialBindings().SystemInfo.getProcessInfo()
    .catch(() => null) as { processInfo: { type: string; id: number }[] } | null;
  return { browser, dir, pid: info?.processInfo.find((p) => p.type === "browser")?.id ?? null };
}

/** Closes the browser; a browser that does not answer within 15 s is killed. */
async function closeBrowser(l: Launched): Promise<void> {
  await withTimeout(l.browser.close(), 15_000, "close timed out").catch(() => {
    if (l.pid) Deno.kill(l.pid, "SIGKILL");
  });
  await Deno.remove(l.dir, { recursive: true }).catch(() => {});
}

/**
 * One run in a fresh browser, bounded as a whole: a CDP call that never answers (a renderer
 * that died mid-step) fails the run instead of hanging the matrix.
 */
async function runOnce(origin: string, impl: SsrImplDef, cell: CellId): Promise<RunMetrics> {
  const launched = await launchBrowser();
  const limitMs = (cell.profile === "mobile" ? 180_000 : 60_000) + 420_000;
  try {
    return await withTimeout(
      measureRun(launched.browser, origin, impl, cell),
      limitMs,
      `run did not finish within ${limitMs / 1000} s`,
    );
  } finally {
    await closeBrowser(launched);
  }
}

async function measureRun(
  browser: Browser,
  origin: string,
  impl: SsrImplDef,
  cell: CellId,
): Promise<RunMetrics> {
  const page = await browser.newPage();
  const cdp: Cdp = page.unsafelyGetCelestialBindings();
  const viewportH = await emulate(cdp, cell.profile);
  await cdp.Performance.enable({});
  await cdp.Inspector.enable();
  await cdp.Page.addScriptToEvaluateOnNewDocument({ source: PROBE });
  const budget = cell.profile === "mobile" ? 180_000 : 60_000;
  const loaded = new Promise<string>((r) =>
    cdp.addEventListener("Page.loadEventFired", () => r("loaded"), { once: true })
  );
  const crashed = new Promise<string>((r) =>
    cdp.addEventListener("Inspector.targetCrashed", () => r("renderer crashed"), { once: true })
  );
  const started = Date.now();
  await cdp.Page.navigate({
    url: `${origin}${ssrCellPath(cell.impl, cell.kind as Kind, cell.n)}`,
  });
  const outcome = await Promise.race([
    loaded,
    crashed,
    sleep(budget).then(() => `no load event within ${budget / 1000} s`),
  ]);
  if (outcome !== "loaded") throw new Error(outcome);
  const deadline = started + budget + 60_000;
  const state = await Promise.race([
    settle(cdp, expectedHydration(impl, cell.n), deadline),
    crashed.then((m) => Promise.reject(new Error(m))),
  ]);
  // After the load a crashed renderer fails the run with what was known, instead of leaving a
  // CDP call waiting forever.
  const afterLoad = crashed.then((m) => Promise.reject(new Error(`${m} after the load event`)));
  return await Promise.race([afterLoad, measureLoaded(browser, cdp, impl, cell, state, viewportH)]);
}

/** Everything measured once the page settled: timings, memory, controls, fling, find, a11y. */
async function measureLoaded(
  browser: Browser,
  cdp: Cdp,
  impl: SsrImplDef,
  cell: CellId,
  state: PageState,
  viewportH: number,
): Promise<RunMetrics> {
  const c = await evaluate<Collected>(cdp, COLLECT_JS);
  const fcp = c.fcp ?? c.load;
  const tti = timeToInteractive({
    fcp,
    dcl: c.dcl,
    longTasks: c.longTasks,
    hydratedAt: expectedHydration(impl, cell.n) ? state.hydratedAt : null,
  });
  const perf = await cdp.Performance.getMetrics() as {
    metrics: { name: string; value: number }[];
  };
  const metric = (name: string) => perf.metrics.find((m) => m.name === name)?.value ?? null;
  const rss = await rendererRss(browser);

  if (impl.belowFold) {
    await evaluate(cdp, `(${SCROLLER}).scrollIntoView({ block: "start" })`);
    await settle(cdp, 1, Date.now() + 60_000);
  }
  const interactive = impl.interactivity !== "none";
  const clickMs = interactive ? await click(cdp, 1) : null;
  const click2Ms = interactive ? await click(cdp, 2) : null;
  const frames = await fling(cdp, cell.profile === "mobile", viewportH).catch(() => null);
  const probe = probeText(makeItems(cell.kind as Kind, cell.n, 1).getItem(cell.n - 1));
  const find = await findProbe(cdp, probe, cell.n).catch(() => null);
  const ax = await axListItems(cdp).catch(() => null);
  return {
    ttfbMs: c.ttfb,
    fcpMs: c.fcp,
    lcpMs: c.lcp,
    ttiMs: Math.round(tti),
    tbtMs: Math.round(totalBlockingTime(fcp, tti, c.longTasks)),
    loadMs: c.load,
    htmlTransferBytes: c.htmlTransfer,
    htmlDecodedBytes: c.htmlDecoded,
    jsTransferBytes: c.jsTransfer,
    jsDecodedBytes: c.jsDecoded,
    domElements: c.dom,
    jsHeapUsedBytes: metric("JSHeapUsedSize"),
    rendererRssBytes: rss,
    hydrated: state.hydrated,
    frames: frames?.frames ?? null,
    frameP90Ms: frames?.p90Ms ?? null,
    frameMissedPct: frames?.missedPct ?? null,
    frameMaxMs: frames?.maxMs ?? null,
    clickMs,
    click2Ms,
    findOk: find?.findOk ?? null,
    findDomHits: find?.hits ?? null,
    axListItems: ax,
  };
}

/** JSON bytes of every row of a cell (what shipping them as island props would add). */
function dataJsonBytes(kind: Kind, n: number): number {
  const l = makeItems(kind, n, 1);
  let bytes = 2;
  for (let i = 0; i < n; i++) bytes += JSON.stringify(l.getItem(i)).length + (i ? 1 : 0);
  return bytes;
}

// ─── the matrix ─────────────────────────────────────────────────────────────────────────

async function readCells(): Promise<CellRecord[]> {
  const cells: CellRecord[] = [];
  try {
    for await (const e of Deno.readDir(new URL("cells/", OUT))) {
      if (e.name.endsWith(".json")) {
        cells.push(JSON.parse(await Deno.readTextFile(new URL(`cells/${e.name}`, OUT))));
      }
    }
  } catch { /* no cells yet */ }
  return cells;
}

const order = (c: CellId) =>
  [
    ["desktop", "mobile"].indexOf(c.profile),
    SSR_IMPLS.findIndex((d) => d.id === c.impl),
    SSR_KINDS.indexOf(c.kind as Kind),
    c.n,
  ] as const;

function sortCells(cells: CellRecord[]): CellRecord[] {
  return cells.sort((a, b) => {
    const x = order(a), y = order(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
}

interface Servers {
  ssrOrigin: string;
  spaOrigin: string;
  gzip: boolean;
  stop: () => Promise<void>;
}

/** denext start (or --origin), the SPA's static server, each behind the gzip proxy. */
async function startServers(): Promise<Servers> {
  const ssr = typeof flags.origin === "string"
    ? { origin: flags.origin, stop: () => Promise.resolve() }
    : await startSsr();
  const gzip = flags["no-gzip"] !== true;
  const proxy = gzipProxy(ssr.origin, gzip);
  const spa = IMPL_IDS.includes("virtual-spa") ? spaServer() : null;
  const spaProxy = spa && gzipProxy(`http://127.0.0.1:${spa.addr.port}`, gzip);
  return {
    ssrOrigin: `http://127.0.0.1:${proxy.addr.port}`,
    spaOrigin: spaProxy ? `http://127.0.0.1:${spaProxy.addr.port}` : "",
    gzip,
    stop: async () => {
      await proxy.shutdown();
      await spaProxy?.shutdown();
      await spa?.shutdown();
      await ssr.stop();
    },
  };
}

async function chromiumVersion(): Promise<string> {
  const launched = await launchBrowser();
  const v = await launched.browser.version();
  await closeBrowser(launched);
  return v;
}

/** All runs of one cell (the first failed run ends it), or `skipped` past a failed size. */
async function runCell(
  impl: SsrImplDef,
  cell: CellId,
  origin: string,
  done: readonly CellRecord[],
): Promise<CellRecord> {
  const record: CellRecord = { ...cell, id: cellId(cell), runs: [], failures: [], median: {} };
  const failedBefore = skippedByFailure(cell, done, UNUSABLE_MS);
  if (failedBefore) record.failures.push(failedBefore);
  for (let run = 0; run < RUNS && !failedBefore; run++) {
    await waitForQuiet();
    const result = await runOnce(origin, impl, cell).catch((e: Error) => e);
    if (result instanceof Error) record.failures.push(result.message);
    else record.runs.push(result);
    if (record.runs.length === 0) break; // the first run failed: do not retry
  }
  record.median = medians(record.runs);
  if (impl.virtual && cell.profile === PROFILES[0]) {
    record.dataJsonBytes = dataJsonBytes(cell.kind as Kind, cell.n);
  }
  return record;
}

function logCell(r: CellRecord): void {
  const m = r.median;
  const summary = r.runs.length
    ? `tti ${m.ttiMs} ms, html ${Math.round((m.htmlDecodedBytes ?? 0) / 1024)} KB, ` +
      `dom ${m.domElements}, click ${m.clickMs} ms, p90 ${m.frameP90Ms} ms, ` +
      `find ${m.findOk}, ax ${m.axListItems}`
    : `FAILED ${r.failures.join("; ")}`;
  console.log(`${r.id.padEnd(44)} ${summary}`);
}

/** Every (profile, impl, kind, n) cell asked for, smallest n first (the skip rule needs it). */
function plannedCells(): { impl: SsrImplDef; cell: CellId }[] {
  const sizes = [...SIZES].sort((a, b) => a - b);
  return PROFILES.flatMap((profile) =>
    IMPL_IDS.flatMap((id) => {
      const impl = findSsrImpl(id);
      if (!impl) throw new Error(`unknown impl ${id}`);
      return KIND_IDS.flatMap((kind) =>
        sizes.map((n) => ({ impl, cell: { impl: id, kind, n, profile } }))
      );
    })
  );
}

/** results.json (medians, no raw runs) + results.md, with the out dir's findings.md if any. */
async function writeReport(base: ReportMeta): Promise<void> {
  const cells = sortCells(await readCells());
  const previous = await Deno.readTextFile(new URL("results.json", OUT))
    .then((t) => (JSON.parse(t) as { meta?: ReportMeta }).meta?.findings)
    .catch(() => undefined);
  const findings = await Deno.readTextFile(new URL("findings.md", OUT)).catch(() => previous);
  const meta = { ...base, findings };
  const json = { meta, cells: cells.map(summaryCell) };
  await Deno.writeTextFile(new URL("results.json", OUT), JSON.stringify(json, null, 2));
  await Deno.writeTextFile(new URL("results.md", OUT), renderSsrMarkdown(meta, cells));
  console.log(`\nwrote ${new URL("results.md", OUT).pathname}`);
}

function reportNotes(gzip: boolean): string[] {
  return [
    "The ssr/ app runs under `denext start` (production build), each request rendered " +
    'uncached (`dynamic = "force-dynamic"`), behind a gzip proxy (denext does not compress ' +
    "dynamic HTML itself; a CDN or reverse proxy would)." + (gzip ? "" : " This run: no gzip."),
    "Every list scrolls in its own full-viewport scroller and starts at row 0 (also chat). " +
    "The virtual-spa reference is the SPA's `denext` impl (web/out), where chat starts at " +
    "its end.",
    "Scroll: requestAnimationFrame intervals during the fling, i.e. main-thread frames. The " +
    "mobile fling is a touch gesture that Chromium scrolls on the compositor thread, so a page " +
    "whose main thread has nothing to do on scroll (static HTML) stays at 16.7 ms there even " +
    "when its raster falls behind; a VirtualList re-rendering its window shows up.",
    "Time to interactive: from FCP, the end of the last long task followed by 500 ms " +
    "without one, and not before the last island the page waits for is hydrated (every row " +
    "island for static-cv-islands, the one island for the delegated and virtual impls).",
  ];
}

async function main() {
  await Deno.mkdir(new URL("cells/", OUT), { recursive: true });
  const loadStart = (await loadavg()).join(" ");
  const servers = await startServers();
  const chromium = await chromiumVersion();
  const resume = flags.resume === true;
  const done = new Map((await readCells()).map((c) => [c.id, c]));
  try {
    for (const { impl, cell } of plannedCells()) {
      const origin = impl.spa ? servers.spaOrigin : servers.ssrOrigin;
      if (!origin || (resume && done.has(cellId(cell)))) continue;
      const record = await runCell(impl, cell, origin, [...done.values()]);
      done.set(record.id, record);
      const loadNow = (await loadavg()).join(" ");
      await Deno.writeTextFile(
        new URL(`cells/${record.id}.json`, OUT),
        JSON.stringify({ ...record, loadavg: loadNow }, null, 2),
      );
      logCell(record);
    }
  } finally {
    await servers.stop();
  }
  await writeReport({
    date: DATE,
    machine: await machine(),
    chromium,
    loadavgStart: loadStart,
    loadavgEnd: (await loadavg()).join(" "),
    runsPerCell: RUNS,
    profiles: PROFILE_TEXT,
    notes: reportNotes(servers.gzip),
  });
}

if (import.meta.main) await main();
