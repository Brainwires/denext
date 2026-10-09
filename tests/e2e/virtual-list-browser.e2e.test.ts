// Real-browser checks for VirtualList behaviour a layout-less DOM cannot show, in headless
// Chromium: horizontal RTL (visual order, scroll offsets, scrollToIndex, edge callbacks),
// sticky-header push, FLIP layout animations, print mode, a real text selection keeping its
// rows mounted, the window-scroll page-offset cache (content above the list resizing), the
// keyboard inset, progressive rendering's per-frame work on heavy rows (reported as JSON), and
// `lists: "denext"`'s LegendList DOM build as a chat (start at the end, follow appends and a
// growing last message, `getState().listen("totalSize")`, the scroll element's class) and as
// T3 Code's timeline (a 2,000-message thread opening at the end over rows measured after mount,
// with a header and a footer carrying the composer's inset).
//
// Opt-in (launches Chromium): run with `deno task test:e2e`, or directly:
//   deno test -A tests/e2e/virtual-list-browser.e2e.test.ts

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import * as esbuild from "esbuild";
import { launchManagedBrowser } from "../../src/profile/browser.ts";
import { domListsPlugin } from "../../src/build/dom-lists.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));

/** The fixture: scenario functions on `window`, each mounting a list and returning facts. */
const ENTRY = `
import { h } from ${JSON.stringify(join(FW, "src/jsx/jsx-runtime.ts"))};
import { createRoot, flushSync } from ${JSON.stringify(join(FW, "src/client/reconciler.ts"))};
import { useEffect, useState } from ${JSON.stringify(join(FW, "src/runtime/hooks.ts"))};
import { VirtualList } from ${JSON.stringify(join(FW, "src/client/virtual/virtual-list.ts"))};
// The app's own specifier: \`lists: "denext"\`'s alias plugin resolves it to denext's module.
import { LegendList } from "@legendapp/list/react";

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
// Poll each frame (at most \`max\`) until \`read()\` satisfies \`done\` on two frames in a row.
const settled = async (read, done, max = 120) => {
  let prev = null;
  for (let i = 0; i < max; i++) {
    await frame();
    const v = read();
    if (done(v) && prev !== null && done(prev)) return v;
    prev = v;
  }
  return read();
};
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

  async legendChat() {
    let ref = null;
    const totals = [];
    let data = rowsOf(300);
    let tall = 40;
    const msg = (r, i) => h("div", {
      style: { height: (i === data.length - 1 ? tall : 40) + "px", boxSizing: "border-box" },
    }, r.text);
    const legend = (p) => h(LegendList, p);
    if (root) root.unmount();
    if (host) host.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = () => flushSync(() => root.render(legend({
      data, ref: (x) => { ref = x; }, keyExtractor: (r) => r.id, estimatedItemSize: 90,
      initialScrollAtEnd: true, maintainScrollAtEnd: true, maintainScrollAtEndThreshold: 0.1,
      className: "chat-list", style: { height: "400px" },
      renderItem: ({ item, index }) => msg(item, index),
    })));
    render();
    const s = sc();
    const gap = () => Math.round(s.scrollHeight - s.clientHeight - s.scrollTop);
    // Measurement lands over a few frames: wait (bounded) for the end to hold still at gap 0.
    const atEnd = () => settled(gap, (g) => g === 0);
    const atStart = { gap: await atEnd(), isAtEnd: ref.getState().isAtEnd, cls: s.className };
    const stop = ref.getState().listen("totalSize", (v) => totals.push(v));
    data = [...data, ...rowsOf(310).slice(300)];
    render();
    const afterAppend = { gap: await atEnd(), last: !!row(309), isAtEnd: ref.getState().isAtEnd };
    const beforeGrow = totals.at(-1);
    tall = 400; // the last message grows as it streams
    render();
    await settled(() => totals.at(-1) - beforeGrow, (d) => d === 360);
    const afterGrow = {
      gap: await atEnd(),
      isAtEnd: ref.getState().isAtEnd,
      contentLength: Math.round(ref.getState().contentLength),
      scrollHeight: s.scrollHeight,
    };
    const grew = totals.at(-1) - beforeGrow;
    await ref.scrollToIndex({ index: 0, animated: false });
    await frames(4);
    const afterTop = { top: Math.round(s.scrollTop), first: !!row(0) };
    stop();
    return { atStart, afterAppend, afterGrow, afterTop, totals: totals.length, grew };
  },

  async legendNoPin(atEnd) {
    // LegendList without \`maintainScrollAtEnd\` (unset or false) opens at the end
    // (\`initialScrollAtEnd\`) but never follows later changes: an append leaves the view where
    // it was, so the new rows sit below it.
    let ref = null;
    let data = rowsOf(300);
    if (root) root.unmount();
    if (host) host.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const props = () => {
      const p = {
        data, ref: (x) => { ref = x; }, keyExtractor: (r) => r.id, estimatedItemSize: 40,
        initialScrollAtEnd: true, style: { height: "400px" },
        renderItem: ({ item }) => h("div", { style: { height: "40px", boxSizing: "border-box" } }, item.text),
      };
      if (atEnd !== undefined) p.maintainScrollAtEnd = atEnd;
      return p;
    };
    flushSync(() => root.render(h(LegendList, props())));
    const s = sc();
    const gap = () => Math.round(s.scrollHeight - s.clientHeight - s.scrollTop);
    const open = await settled(gap, (g) => g === 0);
    data = [...data, ...rowsOf(310).slice(300)];
    flushSync(() => root.render(h(LegendList, props())));
    await settled(() => s.scrollHeight, (h2) => h2 === 12400);
    await frames(10);
    return { open, gap: gap(), height: s.scrollHeight };
  },

  async legendTimeline(grow) {
    // T3 Code's MessagesTimeline: 2,000 messages of varying heights (none known up front; with
    // GROW each renders small and takes its real height a frame after mount), the props it
    // passes, a 16 px header, and a footer holding the composer's inset (172 px) above 16 px of
    // padding. Real rows are larger than the 90 px estimate, so the first window overflows its
    // estimated box and covers the footer while the sizes land.
    let ref = null;
    const N = 2000;
    const size = (i) => 40 + ((i * 97) % 360);
    function Message({ item }) {
      const [px, setPx] = useState(grow ? 24 : size(item.n));
      useEffect(() => {
        if (grow) requestAnimationFrame(() => setPx(size(item.n)));
      }, []);
      return h("div", { "data-message-id": item.id, style: { height: px + "px", boxSizing: "border-box" } }, item.text);
    }
    const data = rowsOf(N).map((r, n) => ({ ...r, n }));
    const footer = h("div", null,
      h("div", { "aria-hidden": "true", style: { height: "172px" } }),
      h("div", { "aria-hidden": "true", style: { height: "16px" } }));
    if (root) root.unmount();
    if (host) host.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    flushSync(() => root.render(h(LegendList, {
      ref: (x) => { ref = x; }, data, keyExtractor: (r) => r.id, getItemType: () => "message",
      renderItem: ({ item }) => h("div", { className: "frame" }, h(Message, { item })),
      estimatedItemSize: 90, initialScrollAtEnd: true, extraData: "t:" + N, dataVersion: "t",
      contentInsetEndAdjustment: 0, maintainScrollAtEndThreshold: 1,
      maintainScrollAtEnd: {
        animated: false,
        on: { dataChange: true, footerLayout: false, itemLayout: true, layout: true },
      },
      maintainVisibleContentPosition: { data: true, size: true, shouldRestorePosition: () => true },
      className: "messages-timeline-scroll",
      style: { height: "800px", minHeight: 0, overflowX: "hidden", overflowAnchor: "none" },
      ListHeaderComponent: h("div", { style: { height: "16px" } }),
      ListFooterComponent: footer,
    })));
    const s = sc();
    const gap = () => Math.round(s.scrollHeight - s.clientHeight - s.scrollTop);
    // Let the sizes land, then wait (bounded) for the view to hold still at the end.
    await frames(20);
    const fromEnd = await settled(gap, (g) => g === 0);
    const last = host.querySelector('[data-message-id="r' + (N - 1) + '"]');
    const open = {
      gap: fromEnd,
      lastAboveFooter: last
        ? Math.round(s.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom)
        : null,
      isAtEnd: ref.getState().isAtEnd,
      rows: host.querySelectorAll("[data-message-id]").length,
    };
    s.scrollTop -= 1500;
    await frames(4);
    const scrolledUp = { gap: gap(), isAtEnd: ref.getState().isAtEnd };
    await ref.scrollToEnd({ animated: false });
    const back = await settled(gap, (g) => g === 0);
    return { open, scrolledUp, back };
  },

  async legendFooter(footerLayout) {
    // T3 Code's timeline at its end, then the composer grows (its inset is in the footer).
    // LegendList's \`maintainScrollAtEnd.on.footerLayout: false\`: the footer's resize must not
    // move the visible messages; with \`true\` the view stays pinned to the very end.
    let ref = null;
    const N = 300;
    const size = (i) => 40 + ((i * 97) % 360);
    const data = rowsOf(N).map((r, n) => ({ ...r, n }));
    const footer = h("div", null,
      h("div", { id: "composer-inset", "aria-hidden": "true", style: { height: "172px" } }),
      h("div", { "aria-hidden": "true", style: { height: "16px" } }));
    if (root) root.unmount();
    if (host) host.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    flushSync(() => root.render(h(LegendList, {
      ref: (x) => { ref = x; }, data, keyExtractor: (r) => r.id, getItemType: () => "message",
      renderItem: ({ item }) => h("div", {
        "data-message-id": item.id, style: { height: size(item.n) + "px", boxSizing: "border-box" },
      }, item.text),
      estimatedItemSize: 90, initialScrollAtEnd: true, maintainScrollAtEndThreshold: 1,
      maintainScrollAtEnd: {
        animated: false,
        on: { dataChange: true, footerLayout, itemLayout: true, layout: true },
      },
      maintainVisibleContentPosition: { data: true, size: true, shouldRestorePosition: () => true },
      style: { height: "800px", minHeight: 0, overflowX: "hidden", overflowAnchor: "none" },
      ListHeaderComponent: h("div", { style: { height: "16px" } }),
      ListFooterComponent: footer,
    })));
    const s = sc();
    const gap = () => Math.round(s.scrollHeight - s.clientHeight - s.scrollTop);
    await frames(10);
    const openGap = await settled(gap, (g) => g === 0);
    const lastTop = () =>
      host.querySelector('[data-message-id="r' + (N - 1) + '"]').getBoundingClientRect().top;
    const before = lastTop();
    const inset = document.getElementById("composer-inset");
    inset.style.height = "292px";
    await frames(4);
    const grownGap = await settled(gap, () => true, 8);
    return {
      openGap,
      moved: Math.round(lastTop() - before),
      gap: grownGap,
      isAtEnd: ref.getState().isAtEnd,
    };
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
    let renders = 0;
    mount({
      count: 1000000, getItem: (i) => i, estimatedItemSize: 40, style: { height: "600px" },
      progressive: on,
      renderItem: (i) => { renders++; busy(1.5); return h("div", { style: { height: "40px" } }, "row " + i); },
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
    let maxRows = 0;
    let workStart = -1;
    let rendersAtStart = 0;
    const onScroll = () => {
      if (workStart < 0) { workStart = performance.now(); rendersAtStart = renders; }
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    let placeholders = 0;
    for (let f = 0; f < 60; f++) {
      s.scrollTop += 900;
      requestAnimationFrame(() => {
        if (workStart >= 0) {
          maxWork = Math.max(maxWork, performance.now() - workStart);
          maxRows = Math.max(maxRows, renders - rendersAtStart);
        }
        workStart = -1;
      });
      await frame();
      placeholders = Math.max(placeholders, host.querySelectorAll("[data-vl-placeholder]").length);
    }
    document.removeEventListener("scroll", onScroll, { capture: true });
    // Poll (bounded) for the slices to finish: no placeholder left, on two frames in a row.
    const left = await settled(() => host.querySelectorAll("[data-vl-placeholder]").length, (n) => n === 0, 600);
    gapOn = false;
    return { maxWork: Math.round(maxWork), maxRows, maxGap: Math.round(maxGap), placeholders, left };
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
    // `lists: "denext"`: the build's alias plugin, with its runtime module served from source
    // (an app's build loads the prebuilt `lists-legend-list.js` instead).
    plugins: [domListsPlugin("browser"), {
      name: "legend-list-runtime-from-source",
      setup(build) {
        build.onResolve(
          { filter: /^denext\/lists\/legend-list$/ },
          () => ({ path: join(FW, "src/lists/legend-list.ts") }),
        );
      },
    }],
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

    await t.step(
      'lists: "denext" (@legendapp/list/react aliased) LegendList chat: starts at the end, follows appends and a growing message',
      async () => {
        const r = await run<Record<string, Record<string, number | boolean | string> | number>>(
          "window.scenarios.legendChat()",
        );
        report.legendChat = r;
        const at = r.atStart as Record<string, number | boolean | string>;
        const app = r.afterAppend as Record<string, number | boolean>;
        const grow = r.afterGrow as Record<string, number | boolean>;
        const top = r.afterTop as Record<string, number | boolean>;
        assertEquals(at.gap, 0, "initialScrollAtEnd: at the end");
        assertEquals(at.isAtEnd, true);
        assertEquals(at.cls, "chat-list", "className on the scroll element");
        assertEquals(app.gap, 0, "maintainScrollAtEnd follows the appends");
        assert(app.last, "the newest message is rendered");
        assertEquals(grow.gap, 0, "and a last message that grows");
        assertEquals(grow.contentLength, grow.scrollHeight, "contentLength is the scroll content");
        assertEquals(top.top, 0, "scrollToIndex(0) reaches the start");
        assert(top.first, "the first message is rendered there");
        assert((r.totals as number) > 0, "listen('totalSize') called back");
        assertEquals(r.grew, 360, "listen('totalSize') heard the last message grow by 360px");
      },
    );

    for (const grow of [false, true]) {
      await t.step(
        `lists: "denext" LegendList as T3's timeline opens at the very end, footer included${
          grow ? " (rows grow after mount)" : ""
        }`,
        async () => {
          type Facts = Record<string, number | boolean | null>;
          const r = await run<{ open: Facts; scrolledUp: Facts; back: number }>(
            `window.scenarios.legendTimeline(${grow})`,
          );
          report[`legendTimeline_${grow}`] = r;
          // Before the fix the view stopped 188 px short: the last message sat on the bottom
          // edge and the footer (the composer's inset) was below it, out of view.
          assertEquals(r.open.gap, 0, "initialScrollAtEnd: at the very end, not at the last row");
          assertEquals(r.open.lastAboveFooter, 188, "the whole footer in view below the last row");
          assertEquals(r.open.isAtEnd, true);
          // LegendList's drawDistance (250 px), not a viewport of overscan (18 rows here).
          assert((r.open.rows as number) <= 12, `rows rendered at the end: ${r.open.rows}`);
          assert((r.scrolledUp.gap as number) > 0 && r.scrolledUp.isAtEnd === false, "scrolled up");
          assertEquals(r.back, 0, "scrollToEnd re-pins to the very end");
        },
      );
    }

    for (const atEnd of ["undefined", "false"]) {
      await t.step(
        `lists: "denext" LegendList maintainScrollAtEnd ${atEnd}: opens at the end, appends are not followed`,
        async () => {
          const r = await run<Record<string, number>>(`window.scenarios.legendNoPin(${atEnd})`);
          report[`legendNoPin_${atEnd}`] = r;
          assertEquals(r.open, 0, "opens at the very end");
          assertEquals(r.height, 12400, "the appended rows are laid out");
          assertEquals(r.gap, 400, "the 10 appended rows sit below the view: no pin");
        },
      );
    }

    for (const footerLayout of [false, true]) {
      await t.step(
        `lists: "denext" LegendList maintainScrollAtEnd.on.footerLayout: ${footerLayout} — the composer grows at the end`,
        async () => {
          const r = await run<Record<string, number | boolean>>(
            `window.scenarios.legendFooter(${footerLayout})`,
          );
          report[`legendFooter_${footerLayout}`] = r;
          assertEquals(r.openGap, 0, "opens at the very end, footer included");
          if (footerLayout) {
            // Pinned: the view follows the footer down, so the messages move up by its growth.
            assertEquals(r.moved, -120, "the messages move up with the pinned end");
            assertEquals(r.gap, 0, "still at the very end");
          } else {
            // T3's setting: the composer's growth must not move the visible messages.
            assertEquals(r.moved, 0, "the visible messages stay where they were");
            assertEquals(r.gap, 120, "the grown footer extends below the view");
          }
        },
      );
    }

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
        // Rows rendered inside a scroll frame are the work's deterministic measure.
        assert(
          on.maxRows < off.maxRows,
          `progressive frames render fewer rows (${on.maxRows} < ${off.maxRows})`,
        );
        // Milliseconds are wall-clock: asserted only on an idle machine.
        const [load1] = Deno.loadavg();
        if (load1 < 4) {
          assert(
            on.maxWork < off.maxWork,
            `progressive frames are lighter (${on.maxWork} < ${off.maxWork} ms)`,
          );
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
