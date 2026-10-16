// The DevTools Profiler tab's export / compare / filter: the pure half
// (src/client/devtools-panel/profiler-data.ts) and the tab drawing it over a fake recording.

import { assert, assertEquals } from "@std/assert";
import { FakeDocument, type FakeElement, type FakeNode } from "./helpers/dom.ts";
import { initialState } from "../src/client/devtools-panel.ts";
import type { PanelCtx } from "../src/client/devtools-panel/ctx.ts";
import { buildStyles } from "../src/client/devtools-panel/styles.ts";
import { loadProfileBaseline, renderProfilerTab } from "../src/client/devtools-panel/profiler.ts";
import {
  commitMatches,
  compareTotals,
  exportRecording,
  matchesFilter,
  parseRecording,
  totalsOf,
} from "../src/client/devtools-panel/profiler-data.ts";
import type { CommitSummary, FlameNode } from "../src/client/devtools-inspect.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

let nextId = 1;
/** A flamegraph node (a rendered component unless `didRender` is false). */
function node(
  name: string,
  selfMs: number,
  children: FlameNode[] = [],
  didRender = true,
): FlameNode {
  const totalMs = selfMs + children.reduce((s, c) => s + c.totalMs, 0);
  return { id: nextId++, name, selfMs, totalMs, didRender, changed: null, children };
}

/** A synthetic commit root over `children`. */
function root(children: FlameNode[]): FlameNode {
  return node("(root)", 0, children);
}

/** Two commits: a mount of App > List > Item×2, then an update of List > Item only. */
function recording(): { commits: CommitSummary[]; trees: Map<number, FlameNode> } {
  const trees = new Map<number, FlameNode>([
    [1, root([node("App", 1, [node("List", 2, [node("Item", 0.5), node("Item", 0.5)])])])],
    [2, root([node("App", 0, [node("List", 4, [node("Item", 1.5)])], false)])],
  ]);
  const commits: CommitSummary[] = [
    { index: 1, commitTime: 10, duration: 4, phase: "mount", renderCount: 4 },
    { index: 2, commitTime: 20, duration: 5.5, phase: "update", renderCount: 2 },
  ];
  return { commits, trees };
}

Deno.test("profiler data: an exported recording reads back; anything else does not", () => {
  const { commits, trees } = recording();
  const exported = exportRecording(commits, (i) => trees.get(i) ?? null);
  assertEquals(exported.format, "denext-profile");
  assertEquals(exported.commits.map((c) => [c.index, c.tree?.children[0].name]), [
    [1, "App"],
    [2, "App"],
  ]);
  assertEquals(parseRecording(JSON.stringify(exported)), exported);
  assertEquals(parseRecording("not json"), null);
  assertEquals(parseRecording(JSON.stringify({ format: "other", commits: [] })), null);
});

Deno.test("profiler data: per-component totals count only rendered components", () => {
  const { trees } = recording();
  const totals = totalsOf([trees.get(1)!, trees.get(2)!, null]);
  assertEquals(totals.get("App"), { selfMs: 1, renders: 1 }); // did not render in commit 2
  assertEquals(totals.get("List"), { selfMs: 6, renders: 2 });
  assertEquals(totals.get("Item"), { selfMs: 2.5, renders: 3 });
  assertEquals(totals.has("(root)"), false);
});

Deno.test("profiler data: a comparison is largest change first, and filterable", () => {
  const { trees } = recording();
  const rows = compareTotals(totalsOf([trees.get(1)!]), totalsOf([trees.get(2)!]));
  assertEquals(rows.map((r) => [r.name, r.deltaMs, r.baseRenders, r.nowRenders]), [
    ["List", 2, 1, 1],
    ["App", -1, 1, 0],
    ["Item", 0.5, 2, 1],
  ]);
  assertEquals(
    compareTotals(totalsOf([trees.get(1)!]), totalsOf([trees.get(2)!]), "item").map((r) => r.name),
    ["Item"],
  );
});

Deno.test("profiler data: the filter is a case-insensitive substring of a rendered component", () => {
  const { trees } = recording();
  assert(matchesFilter("TodoList", "list"));
  assert(matchesFilter("Anything", ""));
  assert(!matchesFilter("App", "list"));
  assert(commitMatches(trees.get(2)!, "item"));
  assert(!commitMatches(trees.get(2)!, "app"), "App did not render in commit 2");
  assert(commitMatches(null, ""));
  assert(!commitMatches(null, "item"));
});

function queryAll(root: FakeNode, pred: (e: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => {
    if ((n as FakeElement).tagName !== undefined && pred(n as FakeElement)) {
      out.push(n as FakeElement);
    }
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

/** The Profiler tab over the fake recording, with a render pass that redraws it. */
function profilerPane() {
  const { commits, trees } = recording();
  const doc = new FakeDocument();
  const detailPane = doc.createElement("div");
  const { S, S_BADGE } = buildStyles();
  const api = {
    isProfiling: () => false,
    getCommits: () => commits,
    getCommitTree: (i: number) => trees.get(i) ?? null,
  };
  const ctx: PanelCtx = {
    doc: asAny(doc),
    api: asAny(api),
    S,
    S_BADGE,
    state: initialState(),
    treePane: asAny(doc.createElement("div")),
    detailPane: asAny(detailPane),
    render: () => {
      detailPane.replaceChildren();
      renderProfilerTab(ctx);
    },
    selectNode: () => {},
    highlight: () => {},
    hideHighlight: () => {},
  };
  ctx.render();
  const button = (label: string) =>
    queryAll(detailPane, (e) => e.tagName === "BUTTON" && e.textContent === label)[0];
  return { ctx, detailPane, button, commits, trees };
}

Deno.test("profiler tab: the component filter narrows the ranking and dims other commits", () => {
  const { ctx, detailPane } = profilerPane();
  const box =
    queryAll(detailPane, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "text")[0];
  asAny(box).value = " app ";
  box.dispatch("input");
  assertEquals(ctx.state.profilerFilter, "app");
  // Commit 2 (selected: the latest) did not render App: the ranking says so.
  assert(
    detailPane.textContent.includes(`No component matching "app" rendered`),
    detailPane.textContent,
  );
  const bars = queryAll(detailPane, (e) => String(asAny(e).title ?? "").startsWith("commit #"));
  assertEquals(bars.map((b) => asAny(b.style).opacity ?? ""), ["", "0.3"]);
  // The box is the same element after the re-render (typing is not lost).
  assert(queryAll(detailPane, (e) => e === box).length === 1);
});

Deno.test("profiler tab: pin a commit as the baseline, then compare another with it", () => {
  const { ctx, detailPane, button } = profilerPane();
  ctx.state.profilerCommit = 1;
  ctx.render();
  button("Pin as baseline").dispatch("click");
  assertEquals(ctx.state.profilerBaseline?.label, "commit #1");
  ctx.state.profilerCommit = 2;
  ctx.render();
  const text = detailPane.textContent;
  assert(text.includes("Compare · commit #2 vs commit #1"), text);
  assert(text.includes("2.0 → 4.0ms"), text); // List
  assert(text.includes("+2.0ms"), text);
  assert(text.includes("-1.0ms"), text); // App stopped rendering
  button("Clear baseline").dispatch("click");
  assertEquals(ctx.state.profilerBaseline, null);
  assert(!detailPane.textContent.includes("Compare ·"));
});

Deno.test("profiler tab: an imported recording is compared with the whole current one", () => {
  const { ctx, detailPane, commits, trees } = profilerPane();
  assert(
    queryAll(detailPane, (e) => e.tagName === "BUTTON" && e.textContent === "Export").length === 1,
  );
  const saved = exportRecording(commits.slice(0, 1), (i) => trees.get(i) ?? null);
  assert(loadProfileBaseline(ctx, "before.json", JSON.stringify(saved)));
  const text = detailPane.textContent;
  assert(text.includes("Compare · this recording (2 commits) vs before.json (1 commit)"), text);
  assert(text.includes("renders 2 → 3"), text); // Item: 2 renders before, 3 across both now
  assert(!loadProfileBaseline(ctx, "notes.txt", "hello"));
  assert(detailPane.textContent.includes("notes.txt is not an exported denext profile"));
});
