// DevTools panel: the MVU tab. Drives the tab against a hand-built program registry through the
// in-memory DOM harness, asserting the rendered steps, the step on screen, and that clicking a
// step travels there (the program's `jump`) and redraws.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { FakeDocument, type FakeElement } from "./helpers/dom.ts";
import { initialState } from "../src/client/devtools-panel.ts";
import type { PanelCtx } from "../src/client/devtools-panel/ctx.ts";
import { buildStyles } from "../src/client/devtools-panel/styles.ts";
import { type MvuDevRecord, renderMvuTab, summarize } from "../src/client/devtools-panel/mvu.ts";
import { TABS } from "../src/client/devtools-panel/shell.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

function mvuCtx(registry: Map<number, MvuDevRecord>) {
  const doc = new FakeDocument();
  const { S, S_BADGE } = buildStyles();
  const detailPane = doc.createElement("div");
  let renders = 0;
  const ctx: PanelCtx = {
    doc: asAny(doc),
    api: asAny({}),
    S,
    S_BADGE,
    state: { ...initialState(), tab: "mvu" },
    treePane: asAny(doc.createElement("div")),
    detailPane: asAny(detailPane),
    render: () => {
      renders++;
      detailPane.replaceChildren();
      renderMvuTab(ctx, registry);
    },
    selectNode: () => {},
    highlight: () => {},
    hideHighlight: () => {},
  };
  return { ctx, detailPane, renders: () => renders };
}

function record(): MvuDevRecord & { jumps: number[] } {
  const rec = {
    id: 1,
    name: "Counter",
    steps: [
      { msg: "(init)", model: { n: 0 }, at: 0 },
      { msg: { type: "inc" }, model: { n: 1 }, at: 1 },
      { msg: { type: "inc" }, model: { n: 2 }, at: 2 },
    ],
    cursor: 2,
    jumps: [] as number[],
    jump(i: number) {
      rec.jumps.push(i);
      rec.cursor = i;
    },
  };
  return rec;
}

function items(pane: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement) => {
    for (const c of n.childNodes as FakeElement[]) {
      if (c.tagName === "LI") out.push(c);
      if (c.childNodes) walk(c);
    }
  };
  walk(pane);
  return out;
}

Deno.test("devtools MVU tab: is a tab of the panel", () => {
  assert(TABS.some((t) => t.id === "mvu" && t.label === "MVU"));
});

Deno.test("devtools MVU tab: lists each program's steps and the model on screen", () => {
  const rec = record();
  const { ctx, detailPane } = mvuCtx(new Map([[1, rec]]));
  ctx.render();
  const text = detailPane.textContent ?? "";
  assertStringIncludes(text, "Counter · 3 steps");
  assertStringIncludes(text, '{"type":"inc"}');
  assertStringIncludes(text, "model after step #2");
  assertStringIncludes(text, '"n": 2');
  assertEquals(items(detailPane).length, 3);
});

Deno.test("devtools MVU tab: clicking a step travels to it and redraws", () => {
  const rec = record();
  const { ctx, detailPane, renders } = mvuCtx(new Map([[1, rec]]));
  ctx.render();
  const before = renders();
  items(detailPane)[0].dispatch("click");
  assertEquals(rec.jumps, [0]);
  assert(renders() > before, "the panel redrew");
  assertStringIncludes(detailPane.textContent ?? "", "model after step #0");
});

Deno.test("devtools MVU tab: says so when nothing runs; summaries are cut", () => {
  const { ctx, detailPane } = mvuCtx(new Map());
  ctx.render();
  assertStringIncludes(detailPane.textContent ?? "", "No Model–View–Update program");
  assertEquals(summarize("x".repeat(100), 10), "xxxxxxxxx…");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assertEquals(summarize(cycle), "[object Object]");
  assertEquals(summarize(undefined), "undefined");
});
