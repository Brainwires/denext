// Real-browser perf check for VirtualList: 1M variable-height rows (true heights from their
// content, measured by the real ResizeObserver) in headless Chromium. A scripted scroll —
// steady 400 px steps plus random scrollbar-style jumps across the scaled scroll space — must
// produce no frame gap over 50 ms (a long task blocks the next frame; a deliberate 80 ms task
// is the metric's control — the Long Tasks API reports nothing in headless Chromium, so its
// entries are only checked when present) and a bounded number of rendered rows. Afterwards
// `scrollToIndex` on a never-measured row lands on it to the pixel, and scrolling up into
// never-measured rows moves the visible row by exactly the scroll delta.
//
// Opt-in (launches Chromium): run with `deno task test:e2e`, or directly:
//   deno test -A tests/e2e/virtual-list-perf.e2e.test.ts

import { assert } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import * as esbuild from "esbuild";
import { launchManagedBrowser } from "../../src/profile/browser.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));

/** The fixture page's script: mounts the list and exposes its handle. */
const ENTRY = `
import { h } from ${JSON.stringify(join(FW, "src/jsx/jsx-runtime.ts"))};
import { createRoot } from ${JSON.stringify(join(FW, "src/client/reconciler.ts"))};
import { VirtualList } from ${JSON.stringify(join(FW, "src/client/virtual/virtual-list.ts"))};

const N = 1_000_000;
const lines = (i) => 1 + (Math.imul(i, 2654435761) >>> 0) % 5;
createRoot(document.getElementById("root")).render(h(VirtualList, {
  count: N,
  getItem: (i) => i,
  estimatedItemSize: 40,
  style: { height: "600px", width: "400px" },
  ref: (handle) => { window.__list = handle; },
  renderItem: (i) => h("div", { style: { lineHeight: "18px", padding: "4px 8px", borderBottom: "1px solid #ddd" } },
    Array.from({ length: lines(i) }, (_, k) => h("div", { key: k }, "row " + i + " line " + k))),
}));
`;

const HTML = (script: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style>
<script>
window.__longtasks = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longtasks.push(e.duration);
  }).observe({ entryTypes: ["longtask"] });
} catch (e) { window.__longtaskError = String(e); }
</script></head><body><div id="root"></div><script type="module">${script}</script></body></html>`;

/** The scripted scroll, run in the page. */
const SCROLL_SCRIPT = `(async () => {
  const sc = document.querySelector("[data-denext-virtual-list]");
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  for (let i = 0; i < 30 && !sc.querySelector("[data-vl-row]"); i++) await frame();
  await frame();
  window.__longtasks.length = 0;
  let maxRows = 0;
  let maxGap = 0;
  let last = performance.now();
  // The list's own work per frame: from the scroll event (captured first, on the document)
  // to the next animation-frame callback — its scroll handler, re-render and commit.
  let maxWork = 0;
  let workStart = -1;
  document.addEventListener("scroll", () => { if (workStart < 0) workStart = performance.now(); }, { capture: true, passive: true });
  const workEnd = () => requestAnimationFrame(() => {
    if (workStart >= 0) maxWork = Math.max(maxWork, performance.now() - workStart);
    workStart = -1;
  });
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let f = 0; f < 240; f++) {
    if (f % 40 === 39) sc.scrollTop = Math.floor(rand() * (sc.scrollHeight - sc.clientHeight));
    else sc.scrollTop += 400;
    workEnd();
    await frame();
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    maxRows = Math.max(maxRows, document.querySelectorAll("[data-vl-row]").length);
  }
  await new Promise((r) => setTimeout(r, 300));
  const longtasks = [...window.__longtasks];
  // Exact landing on a never-measured row deep in the scaled space.
  window.__list.scrollToIndex(777777);
  for (let i = 0; i < 20; i++) await frame();
  const row = document.querySelector('[data-index="777777"]');
  const delta = row ? row.getBoundingClientRect().top - sc.getBoundingClientRect().top : NaN;
  // Scroll up into never-measured rows: the first fully visible row must move by exactly the
  // scroll delta each step (anchoring absorbs every correction above it).
  const drift = [];
  for (let step = 0; step < 12; step++) {
    const scTop = sc.getBoundingClientRect().top;
    const ref = [...document.querySelectorAll("[data-vl-row]")]
      .find((el) => el.getBoundingClientRect().top >= scTop);
    const before = ref.getBoundingClientRect().top;
    sc.scrollTop -= 300;
    for (let i = 0; i < 4; i++) await frame();
    drift.push(Math.round(ref.getBoundingClientRect().top - before - 300));
  }
  // Control for the frame-gap metric: a frame holding a deliberate 80 ms task must show a gap
  // of at least 80 ms (proves the metric sees a long task).
  await frame();
  const g0 = performance.now();
  await new Promise((r) => requestAnimationFrame(() => {
    const t0 = performance.now();
    while (performance.now() - t0 < 80) { /* busy */ }
    r();
  }));
  await frame();
  const control = performance.now() - g0 >= 80;
  return JSON.stringify({
    longtasks, maxGap: Math.round(maxGap), maxWork: Math.round(maxWork), maxRows, scrollHeight: sc.scrollHeight, delta, drift, control,
    observerError: window.__longtaskError ?? null,
  });
})()`;

Deno.test({
  name: "perf: 1M variable rows scroll without long tasks and with bounded DOM (headless Chromium)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const result = await esbuild.build({
    stdin: { contents: ENTRY, loader: "js", resolveDir: FW },
    bundle: true,
    write: false,
    format: "esm",
    minify: true,
    logLevel: "silent",
  });
  await esbuild.stop();
  const page = HTML(
    new TextDecoder().decode(result.outputFiles![0].contents).replaceAll("</script", "<\\/script"),
  );
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  const browser = await launchManagedBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${server.addr.port}/`);
    const out = JSON.parse(await tab.evaluate(SCROLL_SCRIPT) as string) as {
      longtasks: number[];
      maxRows: number;
      scrollHeight: number;
      delta: number;
      drift: number[];
      control: boolean;
      maxGap: number;
      maxWork: number;
    };
    console.log(`virtual-list perf: ${JSON.stringify(out)}`);
    assert(out.scrollHeight <= 8_000_000 + 2000, `scaled physical height (${out.scrollHeight})`);
    assert(out.maxRows < 400, `bounded rendered rows (max ${out.maxRows})`);
    // Long-task entries where the engine reports them (headless Chromium often does not).
    const worst = Math.max(0, ...out.longtasks);
    assert(worst <= 50, `no long task over 50 ms during the scroll (worst ${worst.toFixed(0)} ms)`);
    assert(out.control, "the frame-gap metric sees a deliberate 80 ms task (control)");
    // The list's own per-frame work stays under a long task.
    assert(out.maxWork <= 50, `largest per-frame list work ${out.maxWork} ms`);
    // Whole-frame gaps are wall-clock: asserted only on an idle machine (a loaded one stalls
    // every frame regardless of the page), reported always.
    const [load1] = Deno.loadavg();
    if (load1 < 4) assert(out.maxGap <= 50, `largest gap between frames ${out.maxGap} ms`);
    else {console.log(
        `frame-gap gate skipped: 1-min load ${load1.toFixed(1)} (gap ${out.maxGap} ms)`,
      );}
    assert(Math.abs(out.delta) <= 1, `scrollToIndex landed on the row (off by ${out.delta})`);
    assert(out.drift.every((d) => Math.abs(d) <= 1), `no jump scrolling up (drift ${out.drift})`);
  } finally {
    await browser.close();
    await server.shutdown();
  }
});
