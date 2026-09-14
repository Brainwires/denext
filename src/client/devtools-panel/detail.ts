// DevTools panel: the component detail pane (badges, why-did-this-render diff, source link,
// owner stack, editable props/hooks, contexts).

import type { InspectHook, InspectNode, SerializedValue } from "../devtools-inspect.ts";
import { findNode, h4, type PanelCtx } from "./ctx.ts";
import { el } from "./styles.ts";
import { hookEditor, propEditor, renderValue, sourceLink } from "./values.ts";

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
    detailPane.append(el(doc, "div", S.kv, sourceLink(ctx, sel.source)));
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

/** A `useDebugValue` label as text: its preview, or `[a, b]` when several were recorded. */
function debugText(debug: SerializedValue): string {
  return debug.entries
    ? `[${debug.entries.map((e) => e.value.preview).join(", ")}]`
    : debug.preview;
}

/** Deps / cleanup / debug-value annotations (effect/memo/callback/deferred, `useDebugValue`). */
function renderHookAnnotations(ctx: PanelCtx, hk: InspectHook): void {
  const { doc, S, detailPane } = ctx;
  if (hk.debug) {
    detailPane.append(
      el(
        doc,
        "div",
        S.kv,
        el(doc, "span", S.dim, "debug"),
        el(doc, "span", S.v, debugText(hk.debug)),
      ),
    );
  }
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

/**
 * A hook row's two-part label: the variable it was bound to (or its kind, when the dev
 * metadata didn't resolve), plus the dim hook name — `0 count` + `· useState`.
 */
function hookLabel(hk: InspectHook): { label: string; note?: string } {
  return {
    label: `${hk.index} ${hk.name ?? hk.kind}`,
    note: hk.hook === undefined ? undefined : `· ${hk.hook}`,
  };
}

function renderHooks(ctx: PanelCtx, sel: InspectNode, reason: RenderReason): void {
  const { doc, S, detailPane } = ctx;
  detailPane.append(h4(ctx, false, "Hooks"));
  if (sel.hooks.length === 0) {
    detailPane.append(el(doc, "div", S.empty, "none"));
    return;
  }
  if (sel.hooksNamed === false) {
    detailPane.append(el(doc, "div", S.empty, "names unavailable (conditional hooks?)"));
  }
  for (const hk of sel.hooks) {
    const kStyle = reason?.hooks.includes(hk.index) === true ? S.kChanged : S.kHook;
    const { label, note } = hookLabel(hk);
    if (hk.editable) {
      const row = el(doc, "div", S.kv, el(doc, "span", kStyle, label));
      if (note) row.append(el(doc, "span", S.dim, note));
      row.append(hookEditor(ctx, sel, hk));
      detailPane.append(row);
    } else {
      renderValue(ctx, { kind: "hook", index: hk.index }, [], hk.value, label, kStyle, 0, note);
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
