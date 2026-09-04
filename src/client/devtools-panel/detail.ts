// DevTools panel: the component detail pane (badges, why-did-this-render diff, source link,
// owner stack, editable props/hooks, contexts).

import type { InspectHook, InspectNode } from "../devtools-inspect.ts";
import { findNode, h4, type PanelCtx } from "./ctx.ts";
import { el } from "./styles.ts";
import { editorUrl, hookEditor, prettySource, propEditor, renderValue } from "./values.ts";

type RenderReason = ReturnType<PanelCtx["api"]["getRenderReason"]>;

function renderHeader(ctx: PanelCtx, sel: InspectNode, reason: RenderReason): void {
  const { doc, S, S_BADGE, detailPane } = ctx;
  detailPane.append(h4(ctx, true, "Component"));
  const nameRow = el(doc, "div", S.kv, el(doc, "span", S.v + ";" + S.comp, sel.name));
  for (const b of sel.badges ?? []) nameRow.append(el(doc, "span", S_BADGE, b));
  if (reason && reason.count > 0) {
    nameRow.append(el(doc, "span", S.count, `rendered ×${reason.count}`));
  }
  detailPane.append(nameRow);
}

function renderSourceAndOwners(ctx: PanelCtx, sel: InspectNode): void {
  const { doc, S, api, detailPane } = ctx;
  if (sel.source) {
    detailPane.append(h4(ctx, false, "Source"));
    const link = el(doc, "a", S.v, prettySource(sel.source)) as unknown as HTMLAnchorElement;
    const url = editorUrl(sel.source);
    if (url) link.href = url;
    link.title = sel.source;
    detailPane.append(el(doc, "div", S.kv, link as unknown as Element));
  }
  const owners = api.getOwnerStack(sel.id);
  if (owners.length > 0) {
    detailPane.append(h4(ctx, false, "Owner stack"));
    detailPane.append(
      el(doc, "div", S.kv, el(doc, "span", S.v, owners.map((o) => o.name).join(" ← "))),
    );
  }
}

function renderProps(ctx: PanelCtx, sel: InspectNode, reason: RenderReason): void {
  const { doc, S, api, detailPane } = ctx;
  detailPane.append(h4(ctx, false, "Props"));
  const entries = sel.propEntries ?? [];
  if (entries.length === 0) {
    detailPane.append(el(doc, "div", S.kv, el(doc, "span", S.v, sel.props.preview)));
    return;
  }
  for (const p of entries) {
    const kStyle = reason?.props.includes(p.key) === true ? S.kChanged : S.k;
    if (p.editable) {
      detailPane.append(
        el(doc, "div", S.kv, el(doc, "span", kStyle, p.key), propEditor(ctx, sel, p)),
      );
    } else {
      renderValue(ctx, { kind: "prop", key: p.key }, [], p.value, p.key, kStyle, 0);
    }
  }
  const reset = el(doc, "button", S.tab, "reset props");
  reset.addEventListener("click", () => {
    api.clearPropOverrides(sel.id);
    ctx.render();
  });
  detailPane.append(reset);
}

/** Deps / cleanup annotations (effect/memo/callback/deferred). */
function renderHookAnnotations(ctx: PanelCtx, hk: InspectHook): void {
  const { doc, S, detailPane } = ctx;
  if (hk.deps) {
    const depsText = hk.deps.length === 0
      ? "[] (once)"
      : "[" + hk.deps.map((d) => d.preview).join(", ") + "]";
    detailPane.append(
      el(doc, "div", S.kv, el(doc, "span", S.dim, "deps"), el(doc, "span", S.dim, depsText)),
    );
  }
  if (hk.hasCleanup) {
    detailPane.append(
      el(doc, "div", S.kv, el(doc, "span", S.dim, "cleanup"), el(doc, "span", S.dim, "ƒ")),
    );
  }
}

function renderHooks(ctx: PanelCtx, sel: InspectNode, reason: RenderReason): void {
  const { doc, S, detailPane } = ctx;
  detailPane.append(h4(ctx, false, "Hooks"));
  if (sel.hooks.length === 0) {
    detailPane.append(el(doc, "div", S.empty, "none"));
    return;
  }
  for (const hk of sel.hooks) {
    const kStyle = reason?.hooks.includes(hk.index) === true ? S.kChanged : S.kHook;
    const label = `${hk.index} ${hk.kind}`;
    if (hk.editable) {
      detailPane.append(
        el(doc, "div", S.kv, el(doc, "span", kStyle, label), hookEditor(ctx, sel, hk)),
      );
    } else {
      renderValue(ctx, { kind: "hook", index: hk.index }, [], hk.value, label, kStyle, 0);
    }
    renderHookAnnotations(ctx, hk);
  }
}

function renderContexts(ctx: PanelCtx, sel: InspectNode, reason: RenderReason): void {
  if (sel.contexts.length === 0) return;
  ctx.detailPane.append(h4(ctx, false, "Context"));
  for (const c of sel.contexts) {
    const changed = reason?.contexts.includes(c.name) === true;
    renderValue(
      ctx,
      { kind: "context", key: c.name },
      [],
      c.value,
      c.name,
      changed ? ctx.S.kChanged : ctx.S.k,
      0,
    );
  }
}

export function renderDetail(ctx: PanelCtx, tree: InspectNode[]): void {
  const { doc, S, api, state, detailPane } = ctx;
  const sel = state.selected == null ? null : findNode(tree, state.selected);
  if (!sel) {
    detailPane.append(el(doc, "div", S.empty, "Select a component (or use 🎯 to pick one)."));
    return;
  }
  const reason = api.getRenderReason(sel.id);
  renderHeader(ctx, sel, reason);
  renderSourceAndOwners(ctx, sel);
  renderProps(ctx, sel, reason);
  renderHooks(ctx, sel, reason);
  renderContexts(ctx, sel, reason);
}
