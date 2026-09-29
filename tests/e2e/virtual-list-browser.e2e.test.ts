// Real-browser checks for VirtualList behaviour a layout-less DOM cannot show, in headless
// Chromium: horizontal RTL (visual order, scroll offsets, scrollToIndex, edge callbacks),
// sticky-header push, FLIP layout animations, print mode, a real text selection keeping its
// rows mounted, the window-scroll page-offset cache (content above the list resizing), the
// keyboard inset, and progressive rendering's per-frame work on heavy rows (reported as JSON).
//
// Opt-in (launches Chromium): run with `deno task test:e2e`, or directly:
//   deno test -A tests/e2e/virtual-list-browser.e2e.test.ts

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import * as esbuild from "esbuild";
import { launchManagedBrowser } from "../../src/profile/browser.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));

/** The fixture: scenario functions on `window`, each mounting a list and returning facts. */
const ENTRY = `
import { h } from ${JSON.stringify(join(FW, "src/jsx/jsx-runtime.ts"))};
import { createRoot, flushSync } from ${JSON.stringify(join(FW, "src/client/reconciler.ts"))};
import { VirtualList } from ${JSON.stringify(join(FW, "src/client/virtual/virtual-list.ts"))};

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
let root = null;
let host = null;
function mount(props, wrap) {
  if (root) root.unmount();
  if (host) host.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (p) => flushSync(() => root.render(wrap ? wrap(h(VirtualList, p)) : h(VirtualList, p)));
  render(props);
  return render;
}
const sc = () => host.querySelector("[data-denext-virtual-list]");
const row = (i) => host.querySelector('[data-vl-row][data-index="' + i + '"]');
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: "r" + i, text: "row " + i }));
const cell = (r) => h("div", { style: { height: "40px", boxSizing: "border-box" } }, r.text);

window.scenarios = {
  async rtl() {
    let handle = null;
    let ends = 0;
    const wrap = (el) => h("div", { dir: "rtl" }, el);
    mount({
      data: rowsOf(1000), horizontal: true, style: { width: "500px", height: "60px" },
      ref: (x) => { handle = x; }, onEndReached: () => { ends++; },
      renderItem: (r) => h("div", { style: { width: "100px", height: "50px" } }, r.text),
    }, wrap);
    await frames(3);
    const s = sc();
    const sr = s.getBoundingClientRect();
    const firstRight = row(0).getBoundingClientRect().right;
    const secondRight = row(1).getBoundingClientRect().right;
    s.scrollLeft = -2000;
    await frames(4);
    const at20 = row(20) ? row(20).getBoundingClientRect().right - sr.right : null;
    handle.scrollToIndex(300);
    await frames(6);
    const at300 = row(300) ? row(300).getBoundingClientRect().right - sr.right : null;
    const rangeFirst = handle.getRange().first;
    s.scrollLeft = -(s.scrollWidth - s.clientWidth);
    await frames(4);
    s.dispatchEvent(new Event("scroll"));
    await frames(2);
    return {
      firstAtRightEdge: Math.round(firstRight - sr.right),
      secondLeftOfFirst: Math.round(secondRight - firstRight),
      at20: at20 === null ? null : Math.round(at20),
      at300: at300 === null ? null : Math.round(at300),
      rangeFirst, ends, lastRendered: !!row(999),
      scrollLeftSign: Math.sign(s.scrollLeft),
    };
  },

  async sticky() {
    mount({
      data: rowsOf(1000), style: { height: "400px" }, stickyIndices: [0, 10, 20], overscan: 0,
      renderItem: (r) => h("div", { style: { height: "40px", background: "#fff" } }, r.text),
    });
    await frames(3);
    const s = sc();
    s.scrollTop = 380;
    await frames(4);
    const top = s.getBoundingClientRect().top;
    const h0 = row(0).getBoundingClientRect().top - top;
    const h10 = row(10).getBoundingClientRect().top - top;
    s.scrollTop = 500;
    await frames(4);
    const h10b = row(10).getBoundingClientRect().top - s.getBoundingClientRect().top;
    const focusable = document.activeElement !== null;
    row(10).focus();
    const stillFocused = document.activeElement === row(10);
    return { h0: Math.round(h0), h10: Math.round(h10), h10b: Math.round(h10b), focusable, stillFocused };
  },

  async animate() {
    let data = rowsOf(30);
    const render = mount({ data, style: { height: "400px" }, itemLayoutAnimation: { duration: 300 }, renderItem: cell });
    await frames(3);
    data = [data[0], ...data.slice(2, 4), { id: "n", text: "new" }, ...data.slice(4)];
    render({ data, style: { height: "400px" }, itemLayoutAnimation: { duration: 300 }, renderItem: cell });
    const running = document.getAnimations().length;
    const ghost = !!host.querySelector("[data-vl-ghost]");
    const r0 = row(0).getBoundingClientRect().top - sc().getBoundingClientRect().top;
    await new Promise((r) => setTimeout(r, 450));
    await frames(2);
    return { running, ghost, ghostGone: !host.querySelector("[data-vl-ghost]"), row0: Math.round(r0) };
  },

  async print() {
    mount({ data: rowsOf(5000), getItemSize: () => 40, style: { height: "400px" }, printLimit: 1000, renderItem: cell });
    await frames(3);
    sc().scrollTop = 40 * 2000;
    await frames(4);
    window.dispatchEvent(new Event("beforeprint"));
    await Promise.resolve();
    await Promise.resolve();
    const printing = host.querySelectorAll("[data-vl-row]").length;
    const first = Number(host.querySelector("[data-vl-row]").getAttribute("data-index"));
    const cs = getComputedStyle(sc());
    const overflow = cs.overflowY;
    const height = sc().getBoundingClientRect().height;
    window.dispatchEvent(new Event("afterprint"));
    await frames(4);
    const after = host.querySelectorAll("[data-vl-row]").length;
    const back = !!row(2000);
    return { printing, first, overflow, height: Math.round(height), after, back };
  },

  async selection() {
    mount({ data: rowsOf(2000), style: { height: "400px" }, renderItem: cell });
    await frames(3);
    const a = row(3).firstChild.firstChild;
    const b = row(8).firstChild.firstChild;
    const range = document.createRange();
    range.setStart(a, 1);
    range.setEnd(b, 2);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await frames(3);
    const el3 = row(3);
    sc().scrollTop = 40 * 1500;
    await frames(6);
    const kept = row(3) === el3 && !!row(8);
    const text = sel.toString().length;
    sel.removeAllRanges();
    await frames(3);
    sc().scrollTop = 40 * 1500 + 40;
    await frames(6);
    return { kept, text, released: !row(3) };
  },

  async windowScroll() {
    document.body.style.margin = "0";
    const wrap = (el) => h("div", null, h("div", { id: "above", style: { height: "300px" } }), el);
    mount({ data: rowsOf(5000), getItemSize: () => 40, scrollElement: "window", renderItem: cell }, wrap);
    await frames(3);
    scrollTo(0, 300 + 40 * 1000);
    await frames(4);
    const topRow = () => {
      const rows = [...host.querySelectorAll("[data-vl-row]")];
      const r = rows.find((el) => el.getBoundingClientRect().top >= -0.5);
      return r ? [Number(r.getAttribute("data-index")), Math.round(r.getBoundingClientRect().top)] : null;
    };
    const before = topRow();
    document.getElementById("above").style.height = "700px";
    await frames(4);
    scrollTo(0, 700 + 40 * 2000);
    await frames(4);
    const after = topRow();
    scrollTo(0, 0);
    document.body.style.margin = "";
    return { before, after };
  },

  async keyboard() {
    const base = { data: rowsOf(200), anchor: "end", style: { height: "400px" }, renderItem: cell };
    const render = mount({ ...base, keyboardInset: 0 });
    await frames(4);
    const bottom = () => row(199).getBoundingClientRect().bottom - sc().getBoundingClientRect().top;
    const b0 = bottom();
    render({ ...base, keyboardInset: 300 });
    await frames(4);
    const b1 = bottom();
    render({ ...base, keyboardInset: 0 });
    await frames(4);
    return { b0: Math.round(b0), b1: Math.round(b1), b2: Math.round(bottom()) };
  },

  async scrollToExact(mvcp) {
    // Variable rows, none measured up front; each target lands in a never-rendered region. An
    // over-estimate (200 px) is the hard case: the rows above measure smaller, the window grows
    // upward after the target first lands, and those rows report a frame later.
    const size = (i) => 24 + ((i * 53) % 170);
    const out = [];
    for (const estimate of [60, 200]) {
      let handle = null;
      mount({
        data: rowsOf(20000), estimatedItemSize: estimate, style: { height: "600px" },
        maintainVisibleContentPosition: mvcp, ref: (x) => { handle = x; },
        renderItem: (r, i) => h("div", { style: { height: size(i) + "px", boxSizing: "border-box" } }, r.text),
      });
      await frames(3);
      for (const [index, align] of [[12000, "start"], [4000, "end"], [17000, "center"], [9000, "start"], [150, "start"]]) {
        handle.scrollToIndex(index, { align });
        await frames(12);
        const early = row(index) ? row(index).getBoundingClientRect() : null;
        await frames(30);
        const el = row(index);
        const sr = sc().getBoundingClientRect();
        if (!el) { out.push({ estimate, index, missing: true }); continue; }
        const r = el.getBoundingClientRect();
        const err = align === "start" ? r.top - sr.top : align === "end" ? r.bottom - sr.bottom
          : (r.top + r.bottom) / 2 - (sr.top + sr.bottom) / 2;
        out.push({ estimate, index, err: Math.round(err * 10) / 10, drift: early ? Math.round((r.top - early.top) * 10) / 10 : null });
      }
    }
    return out;
  },

  async mvcpSplit(mvcp) {
    // Variable rows from the end (unmeasured above): scroll up in steps; then prepend 10 rows.
    const size = (id) => 24 + ((id * 53) % 170);
    let data = rowsOf(5000).map((r, i) => ({ ...r, n: i }));
    const props = () => ({
      data, estimatedItemSize: 60, style: { height: "600px" }, initialScrollIndex: 4900,
      maintainVisibleContentPosition: mvcp, keyExtractor: (r) => r.id,
      renderItem: (r) => h("div", { style: { height: size(r.n) + "px", boxSizing: "border-box" } }, r.text),
    });
    const render = mount(props());
    await frames(6);
    const s = sc();
    const sr = () => s.getBoundingClientRect().top;
    const rowById = (id) => host.querySelector('[data-vl-row][data-key="' + id + '"]') ||
      [...host.querySelectorAll("[data-vl-row]")].find((e) => e.textContent === id.replace("r", "row "));
    const drift = [];
    for (let step = 0; step < 12; step++) {
      const ref = [...host.querySelectorAll("[data-vl-row]")].find((e) => e.getBoundingClientRect().top >= sr());
      const top = ref.getBoundingClientRect().top;
      s.scrollTop -= 400;
      await frames(4);
      drift.push(Math.round(ref.getBoundingClientRect().top - (top + 400)));
    }
    await frames(4);
    const ref = [...host.querySelectorAll("[data-vl-row]")].find((e) => e.getBoundingClientRect().top >= sr());
    const text = ref.textContent;
    const before = ref.getBoundingClientRect().top;
    data = [...Array.from({ length: 10 }, (_, i) => ({ id: "p" + i, text: "pre " + i, n: 90000 + i })), ...data];
    render(props());
    await frames(6);
    const same = [...host.querySelectorAll("[data-vl-row]")].find((e) => e.textContent === text);
    return { drift, prependMove: same ? Math.round(same.getBoundingClientRect().top - before) : null };
  },

  async progressive(on) {
    const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* heavy row */ } };
    mount({
      count: 1000000, getItem: (i) => i, estimatedItemSize: 40, style: { height: "600px" },
      progressive: on,
      renderItem: (i) => { busy(1.5); return h("div", { style: { height: "40px" } }, "row " + i); },
    });
    await frames(4);
    const s = sc();
    // Frame gaps (rAF to rAF) over the fling AND the settle after it: progressive slices run
    // between frames, so they show here, not in the scroll-to-frame work below.
    let maxGap = 0;
    let gapLast = performance.now();
    let gapOn = true;
    const gapLoop = () => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - gapLast);
      gapLast = t;
      if (gapOn) requestAnimationFrame(gapLoop);
    };
    requestAnimationFrame(gapLoop);
    let maxWork = 0;
    let workStart = -1;
    const onScroll = () => { if (workStart < 0) workStart = performance.now(); };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    let placeholders = 0;
    for (let f = 0; f < 60; f++) {
      s.scrollTop += 900;
      requestAnimationFrame(() => {
        if (workStart >= 0) maxWork = Math.max(maxWork, performance.now() - workStart);
        workStart = -1;
      });
      await frame();
      placeholders = Math.max(placeholders, host.querySelectorAll("[data-vl-placeholder]").length);
    }
    document.removeEventListener("scroll", onScroll, { capture: true });
    await new Promise((r) => setTimeout(r, 400));
    await frames(3);
    gapOn = false;
    const left = host.querySelectorAll("[data-vl-placeholder]").length;
    return { maxWork: Math.round(maxWork), maxGap: Math.round(maxGap), placeholders, left };
  },
};
window.__ready = true;
`;

const HTML = (script: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head>` +
  `<body><script type="module">${script}</script></body></html>`;

Deno.test({
  name:
    "browser: RTL, sticky push, animations, print, selection, window cache, keyboard inset, scrollToIndex, MVCP, progressive",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
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
    await tab.evaluate(
      `(async () => { for (let i = 0; i < 100 && !window.__ready; i++) await new Promise((r) => setTimeout(r, 20)); })()`,
    );
    const run = async <R>(expr: string): Promise<R> =>
      JSON.parse(
        await tab.evaluate(`(async () => JSON.stringify(await ${expr}))()`) as string,
      ) as R;
    const report: Record<string, unknown> = {};

    await t.step(
      "RTL horizontal: visual order, scroll offsets, scrollToIndex, onEndReached (E5, T19)",
      async () => {
        const r = await run<Record<string, number | boolean | null>>("window.scenarios.rtl()");
        report.rtl = r;
        assertEquals(r.firstAtRightEdge, 0, "row 0 at the inline start (right edge)");
        assertEquals(r.secondLeftOfFirst, -100, "row 1 to its left");
        assertEquals(r.at20, 0, "scrollLeft -2000 shows row 20 at the right edge");
        assertEquals(r.at300, 0, "scrollToIndex lands at the inline start");
        assertEquals(r.rangeFirst, 300);
        assert(r.lastRendered, "the far (left) end is reachable");
        assertEquals(r.ends, 1, "onEndReached at the left end");
      },
    );

    await t.step(
      "sticky: the next header pushes the stuck one; it stays the real, focusable row (E1)",
      async () => {
        const r = await run<Record<string, number | boolean>>("window.scenarios.sticky()");
        report.sticky = r;
        assertEquals(r.h0, -20, "header 0 pushed 20 px up");
        assertEquals(r.h10, 20, "header 10 right below it");
        assertEquals(r.h10b, 0, "header 10 stuck at the top");
        assert(r.stillFocused, "the stuck header is focusable");
      },
    );

    await t.step(
      "itemLayoutAnimation: animations run, a ghost fades and is removed, anchored row still (K1, T33)",
      async () => {
        const r = await run<Record<string, number | boolean>>("window.scenarios.animate()");
        report.animate = r;
        assert((r.running as number) >= 3, `animations running (${r.running})`);
        assert(r.ghost, "the removed row's ghost");
        assert(r.ghostGone, "removed when done");
        assertEquals(r.row0, 0, "row 0 did not move");
      },
    );

    await t.step(
      "print: up to printLimit rows in flow, scroller unclipped; restored after (G6, T29)",
      async () => {
        const r = await run<Record<string, number | boolean | string>>("window.scenarios.print()");
        report.print = r;
        assertEquals(r.printing, 1000);
        assertEquals(r.first, 2000, "from the first visible row");
        assertEquals(r.overflow, "visible");
        assert((r.height as number) >= 1000 * 40, "the rows take their full height");
        assert((r.after as number) < 100 && r.back, "virtualized again, at the same place");
      },
    );

    await t.step(
      "selection: a real selection's end rows stay mounted when scrolled away (G5, T28)",
      async () => {
        const r = await run<Record<string, number | boolean>>("window.scenarios.selection()");
        report.selection = r;
        assert(r.kept, "rows 3 and 8 still mounted");
        // Rows between the two ends unmounted, so the text shrinks (a documented limitation),
        // but the selection itself (its anchor and focus) survives.
        assert((r.text as number) > 0, "the selection survives");
        assert(r.released, "released after the selection is cleared");
      },
    );

    await t.step(
      "window scroll: cached page offset follows content above resizing (E8)",
      async () => {
        const r = await run<{ before: [number, number]; after: [number, number] }>(
          "window.scenarios.windowScroll()",
        );
        report.windowScroll = r;
        assertEquals(r.before, [1000, 0]);
        assertEquals(r.after, [2000, 0], "re-read after the header above grew (ResizeObserver)");
      },
    );

    await t.step("keyboardInset: last row above the keyboard, back after (B8, T9)", async () => {
      const r = await run<Record<string, number>>("window.scenarios.keyboard()");
      report.keyboard = r;
      assertEquals(r.b0, 400);
      assertEquals(r.b1, 100);
      assertEquals(r.b2, 400);
    });

    for (const mvcp of [true, false]) {
      await t.step(
        `scrollToIndex is exact on unmeasured variable rows, maintainVisibleContentPosition: ${mvcp} (C1, T10)`,
        async () => {
          const r = await run<{ index: number; err?: number; drift?: number | null }[]>(
            `window.scenarios.scrollToExact(${mvcp})`,
          );
          report[`scrollToExact_${mvcp}`] = r;
          for (const x of r) {
            assert(x.err !== undefined, `row ${x.index} rendered`);
            assert(Math.abs(x.err!) <= 1, `row ${x.index} lands within 1px (${x.err})`);
            assert(Math.abs(x.drift ?? 0) <= 1, `row ${x.index} stays put after landing`);
          }
        },
      );
    }

    for (const mvcp of [true, false]) {
      await t.step(
        `maintainVisibleContentPosition: ${mvcp} — scrolling up into unmeasured rows never drifts; a prepend ${
          mvcp ? "keeps" : "shifts"
        } the view (A2, B1)`,
        async () => {
          const r = await run<{ drift: number[]; prependMove: number | null }>(
            `window.scenarios.mvcpSplit(${mvcp})`,
          );
          report[`mvcpSplit_${mvcp}`] = r;
          assertEquals(r.drift, r.drift.map(() => 0), "no drift scrolling up");
          assert(r.prependMove !== null, "the reference row is still rendered");
          if (mvcp) assertEquals(r.prependMove, 0, "MVCP keeps the visible row");
          else assert(r.prependMove! > 0, `MVCP off shifts the content (${r.prependMove})`);
        },
      );
    }

    await t.step(
      "progressive: heavy rows — per-frame list work with and without (A6, T1)",
      async () => {
        const off = await run<Record<string, number>>("window.scenarios.progressive(false)");
        const on = await run<Record<string, number>>("window.scenarios.progressive(true)");
        report.progressive = { off, on };
        assert(on.placeholders > 0, "placeholders were shown while flinging");
        assertEquals(on.left, 0, "every row rendered its content after the fling");
        assert(
          on.maxWork < off.maxWork,
          `progressive frames are lighter (${on.maxWork} < ${off.maxWork} ms)`,
        );
        // Whole-frame gaps are wall-clock: asserted only on an idle machine.
        const [load1] = Deno.loadavg();
        if (load1 < 4) {
          assert(on.maxGap < off.maxGap, `shorter frame gaps (${on.maxGap} < ${off.maxGap} ms)`);
        }
      },
    );

    console.log(`virtual-list browser: ${JSON.stringify(report)}`);
  } finally {
    await browser.close();
    await server.shutdown();
  }
});
