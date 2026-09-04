// DevTools panel: the Profiler tab — record/clear, a commit-bar strip to step through, a
// flamegraph per commit, and a ranked-by-self-time list with why-each-rendered.

import type { CommitSummary, FlameNode } from "../devtools-inspect.ts";
import { h4, type PanelCtx } from "./ctx.ts";
import { el } from "./styles.ts";

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

/** Record/Stop + Clear buttons. */
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
  detailPane.append(el(doc, "div", S.kv, rec, clear));
}

/** Commit-bar strip — one bar per commit (height ∝ duration), click to step through. */
function renderCommitStrip(ctx: PanelCtx, commits: CommitSummary[], selectedIndex: number): void {
  const { doc, S, state, detailPane } = ctx;
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

/** The selected commit: its flamegraph (top-level components laid out proportionally) + ranking. */
function renderCommit(ctx: PanelCtx, sel: CommitSummary): void {
  const { doc, S, api, detailPane } = ctx;
  detailPane.append(
    h4(ctx, false, `Commit #${sel.index} · ${sel.phase} · ${sel.duration.toFixed(1)}ms`),
  );
  const tree = api.getCommitTree(sel.index);
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
  const ranked = flat.filter((n) => n.didRender).sort((a, b) => b.selfMs - a.selfMs);
  if (ranked.length === 0) {
    detailPane.append(el(doc, "div", S.empty, "No components rendered (a host-only commit)."));
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
