// DevTools panel: the Profiler tab — record/clear, a commit-bar strip to step through, a
// flamegraph per commit, and a ranked-by-self-time list with why-each-rendered; a component
// filter, Export / Import of a recording as JSON, and a comparison with a pinned commit or an
// imported recording (./profiler-data.ts holds the pure half).

import type { CommitSummary, FlameNode } from "../devtools-inspect.ts";
import { h4, type PanelCtx } from "./ctx.ts";
import { el } from "./styles.ts";
import {
  commitMatches,
  compareTotals,
  exportRecording,
  matchesFilter,
  parseRecording,
  totalsOf,
} from "./profiler-data.ts";

/** What a component the filter rejects is drawn at (dimmed, kept for the layout). */
const FILTERED_OUT = "0.3";

/** A short "props: a,b · hooks: 0" description of what changed, or "". */
function reasonText(changed: FlameNode["changed"]): string {
  if (!changed) return "";
  const parts: string[] = [];
  if (changed.props.length) parts.push("props: " + changed.props.join(","));
  if (changed.hooks.length) parts.push("hooks: " + changed.hooks.join(","));
  if (changed.contexts.length) parts.push("ctx: " + changed.contexts.join(","));
  return parts.join(" · ");
}

/** Warm-scale fill for a flame bar (dim when the component didn't render). */
function flameColor(node: FlameNode): string {
  if (!node.didRender) return "#2a3140";
  const t = Math.min(1, node.selfMs / 8); // 0ms → yellow-green, ≥8ms → red-orange
  return `hsl(${Math.round(50 - 42 * t)},85%,62%)`;
}

/** One flamegraph node — a bar plus a proportional row of child bars beneath it. */
function flameEl(ctx: PanelCtx, node: FlameNode): HTMLElement {
  const { doc, S, state } = ctx;
  const wrap = el(doc, "div", S.flameWrap);
  const bar = el(doc, "div", S.flameBar, `${node.name} ${node.selfMs.toFixed(1)}`);
  bar.style.background = flameColor(node);
  if (!matchesFilter(node.name, state.profilerFilter)) bar.style.opacity = FILTERED_OUT;
  bar.title = `${node.name} · self ${node.selfMs.toFixed(2)}ms · total ${
    node.totalMs.toFixed(2)
  }ms${node.didRender ? "" : " · did not render"}`;
  bar.addEventListener("click", () => {
    state.tab = "components";
    ctx.selectNode(node.id); // jump to the component in the tree
  });
  wrap.append(bar);
  if (node.children.length) {
    const row = el(doc, "div", S.flameRow);
    for (const c of node.children) {
      const cw = flameEl(ctx, c);
      cw.style.width = (node.totalMs > 0 ? (c.totalMs / node.totalMs) * 100 : 0) + "%";
      row.append(cw);
    }
    wrap.append(row);
  }
  return wrap;
}

function flattenFlame(node: FlameNode, out: FlameNode[]): void {
  for (const c of node.children) {
    out.push(c);
    flattenFlame(c, out);
  }
}

/** Save the recording as a JSON file (the browser's download). */
function exportProfile(ctx: PanelCtx): void {
  const { doc, api } = ctx;
  const data = exportRecording(api.getCommits(), (i) => api.getCommitTree(i));
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const a = doc.createElement("a") as HTMLAnchorElement;
  a.href = url;
  a.download = "denext-profile.json";
  a.click?.();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Make an exported recording the comparison baseline: its per-component totals over every
 * commit, compared with every commit of the current recording.
 *
 * @param ctx The mounted panel.
 * @param name The file's name (the baseline's label).
 * @param text The file's text.
 * @returns Whether it was a recording.
 * @internal Exposed for tests; the Import button calls it.
 */
export function loadProfileBaseline(ctx: PanelCtx, name: string, text: string): boolean {
  const rec = parseRecording(text);
  const { state } = ctx;
  if (!rec) {
    state.profilerNote = `${name} is not an exported denext profile`;
  } else {
    state.profilerNote = "";
    state.profilerBaseline = {
      label: `${name} (${rec.commits.length} commit${rec.commits.length === 1 ? "" : "s"})`,
      totals: totalsOf(rec.commits.map((c) => c.tree)),
      scope: "recording",
    };
  }
  ctx.render();
  return rec !== null;
}

/** Export + Import (a hidden file input behind a button). */
function fileButtons(ctx: PanelCtx): HTMLElement[] {
  const { doc, S, api } = ctx;
  const out: HTMLElement[] = [];
  if (api.getCommits().length > 0) {
    const exp = el(doc, "button", S.tab, "Export");
    exp.addEventListener("click", () => exportProfile(ctx));
    out.push(exp);
  }
  const input = doc.createElement("input") as HTMLInputElement;
  input.setAttribute("type", "file");
  input.setAttribute("accept", "application/json,.json");
  input.style.display = "none";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file) loadProfileBaseline(ctx, file.name, await file.text());
  });
  const imp = el(doc, "button", S.tab, "Import…");
  imp.title = "Compare with an exported recording";
  imp.addEventListener("click", () => input.click?.());
  out.push(imp, input);
  return out;
}

/** The component filter box: made once, so typing survives the re-render each keystroke causes. */
function filterBox(ctx: PanelCtx): HTMLInputElement {
  const { doc, S, state } = ctx;
  if (state.profilerUi) return state.profilerUi.box;
  const box = doc.createElement("input") as HTMLInputElement;
  box.style.cssText = S.search;
  box.setAttribute("type", "text");
  box.setAttribute("placeholder", "filter components");
  const ui = { box, focused: false };
  box.addEventListener("input", () => {
    state.profilerFilter = box.value.trim();
    ctx.render();
  });
  box.addEventListener("focus", () => (ui.focused = true));
  box.addEventListener("blur", () => {
    if (box.isConnected) ui.focused = false;
  });
  state.profilerUi = ui;
  return box;
}

/** Record/Stop + Clear buttons, Export / Import and the component filter. */
function renderControls(ctx: PanelCtx, recording: boolean): void {
  const { doc, S, api, state, detailPane } = ctx;
  const rec = el(doc, "button", S.tab, recording ? "■ Stop" : "● Record");
  rec.addEventListener("click", () => {
    if (api.isProfiling()) {
      api.stopProfiling();
    } else {
      api.resetProfile();
      state.profilerCommit = null;
      api.startProfiling();
    }
    ctx.render();
  });
  const clear = el(doc, "button", S.tab, "Clear");
  clear.addEventListener("click", () => {
    api.resetProfile();
    state.profilerCommit = null;
    ctx.render();
  });
  const box = filterBox(ctx);
  detailPane.append(el(doc, "div", S.kv, rec, clear, ...fileButtons(ctx), box));
  if (state.profilerUi?.focused) box.focus();
  if (state.profilerNote) detailPane.append(el(doc, "div", S.empty, state.profilerNote));
}

/** Commit-bar strip — one bar per commit (height ∝ duration), click to step through. */
function renderCommitStrip(ctx: PanelCtx, commits: CommitSummary[], selectedIndex: number): void {
  const { doc, S, state, api, detailPane } = ctx;
  const filter = state.profilerFilter;
  let maxDur = 0;
  for (const c of commits) if (c.duration > maxDur) maxDur = c.duration;
  maxDur = maxDur || 0.0001;
  const strip = el(doc, "div", S.commitStrip);
  for (const c of commits) {
    const bar = el(doc, "div", c.index === selectedIndex ? S.commitBarSel : S.commitBar);
    bar.style.height = Math.max(2, Math.round((c.duration / maxDur) * 48)) + "px";
    bar.title = `commit #${c.index} · ${c.phase} · ${
      c.duration.toFixed(1)
    }ms · ${c.renderCount} rendered`;
    if (filter && !commitMatches(api.getCommitTree(c.index), filter)) {
      bar.style.opacity = FILTERED_OUT; // the filtered components did not render here
    }
    bar.addEventListener("click", () => {
      state.profilerCommit = c.index;
      ctx.render();
    });
    strip.append(bar);
  }
  detailPane.append(strip);
}

/** Ranked-by-self chart + why-each-rendered (top 25). */
function renderRanked(ctx: PanelCtx, ranked: FlameNode[]): void {
  const { doc, S, detailPane } = ctx;
  detailPane.append(h4(ctx, false, "Ranked (self time · why)"));
  const maxSelf = ranked[0].selfMs || 0.0001;
  for (const n of ranked.slice(0, 25)) {
    const bar = el(doc, "div", S.rankBar);
    bar.style.width = Math.max(3, Math.round((n.selfMs / maxSelf) * 70)) + "px";
    const row = el(
      doc,
      "div",
      S.rank,
      el(doc, "span", S.comp, n.name),
      bar,
      el(doc, "span", S.dim, `${n.selfMs.toFixed(1)}ms`),
    );
    const why = reasonText(n.changed);
    if (why) row.append(el(doc, "span", S.at, why));
    detailPane.append(row);
  }
}

/** A signed millisecond change (`+1.2ms`). */
function signedMs(n: number): string {
  if (Math.abs(n) < 0.05) return "±0.0ms";
  return `${n > 0 ? "+" : "-"}${Math.abs(n).toFixed(1)}ms`;
}

/** Pin the selected commit as the baseline, or drop the baseline. */
function baselineButton(ctx: PanelCtx, sel: CommitSummary, tree: FlameNode | null): HTMLElement {
  const { doc, S, state } = ctx;
  if (state.profilerBaseline) {
    const clear = el(doc, "button", S.tab, "Clear baseline");
    clear.addEventListener("click", () => {
      state.profilerBaseline = null;
      ctx.render();
    });
    return clear;
  }
  const pin = el(doc, "button", S.tab, "Pin as baseline");
  pin.title = "Compare later commits with this one";
  pin.addEventListener("click", () => {
    state.profilerBaseline = {
      label: `commit #${sel.index}`,
      totals: totalsOf([tree]),
      scope: "commit",
    };
    ctx.render();
  });
  return pin;
}

/**
 * The comparison with the baseline: the selected commit against a pinned one, or the whole
 * recording against an imported one — per component, largest change first (filtered).
 */
function renderCompare(ctx: PanelCtx, sel: CommitSummary, tree: FlameNode | null): void {
  const { doc, S, api, state, detailPane } = ctx;
  const base = state.profilerBaseline;
  if (!base) return;
  const commits = api.getCommits();
  const now = base.scope === "commit"
    ? { label: `commit #${sel.index}`, totals: totalsOf([tree]) }
    : {
      label: `this recording (${commits.length} commits)`,
      totals: totalsOf(commits.map((c) => api.getCommitTree(c.index))),
    };
  detailPane.append(h4(ctx, false, `Compare · ${now.label} vs ${base.label}`));
  const rows = compareTotals(base.totals, now.totals, state.profilerFilter);
  if (rows.length === 0) {
    detailPane.append(el(doc, "div", S.empty, "No component rendered in either."));
    return;
  }
  for (const r of rows.slice(0, 25)) {
    const delta = el(doc, "span", S.at, signedMs(r.deltaMs));
    if (Math.abs(r.deltaMs) >= 0.05) delta.style.color = r.deltaMs > 0 ? "#ff8a7a" : "#7ee08a";
    detailPane.append(el(
      doc,
      "div",
      S.rank,
      el(doc, "span", S.comp, r.name),
      el(
        doc,
        "span",
        S.dim,
        `${r.baseMs.toFixed(1)} → ${
          r.nowMs.toFixed(1)
        }ms · renders ${r.baseRenders} → ${r.nowRenders}`,
      ),
      delta,
    ));
  }
}

/** The selected commit: its flamegraph (top-level components laid out proportionally) + ranking. */
function renderCommit(ctx: PanelCtx, sel: CommitSummary): void {
  const { doc, S, api, state, detailPane } = ctx;
  const tree = api.getCommitTree(sel.index);
  detailPane.append(
    h4(ctx, false, `Commit #${sel.index} · ${sel.phase} · ${sel.duration.toFixed(1)}ms`),
    el(doc, "div", S.kv, baselineButton(ctx, sel, tree)),
  );
  renderCompare(ctx, sel, tree);
  if (!tree || tree.children.length === 0) {
    detailPane.append(el(doc, "div", S.empty, "Nothing rendered in this commit."));
    return;
  }
  const total = tree.totalMs || 0.0001;
  const fgRow = el(doc, "div", S.flameRow);
  for (const child of tree.children) {
    const cw = flameEl(ctx, child);
    cw.style.width = ((child.totalMs / total) * 100) + "%";
    fgRow.append(cw);
  }
  detailPane.append(fgRow);
  const flat: FlameNode[] = [];
  flattenFlame(tree, flat);
  const ranked = flat.filter((n) => n.didRender && matchesFilter(n.name, state.profilerFilter))
    .sort((a, b) => b.selfMs - a.selfMs);
  if (ranked.length === 0) {
    const why = state.profilerFilter
      ? `No component matching "${state.profilerFilter}" rendered in this commit.`
      : "No components rendered (a host-only commit).";
    detailPane.append(el(doc, "div", S.empty, why));
    return;
  }
  renderRanked(ctx, ranked);
}

export function renderProfilerTab(ctx: PanelCtx): void {
  const { doc, S, api, state, detailPane } = ctx;
  const recording = api.isProfiling();
  renderControls(ctx, recording);
  const commits = api.getCommits();
  if (commits.length === 0) {
    const text = recording
      ? "Recording… interact with the app."
      : "No commits recorded. Click Record, then interact.";
    detailPane.append(el(doc, "div", S.empty, text));
    return;
  }
  const selectedIndex = state.profilerCommit ?? commits[commits.length - 1].index;
  renderCommitStrip(ctx, commits, selectedIndex);
  renderCommit(ctx, commits.find((c) => c.index === selectedIndex) as CommitSummary);
}
