// DevTools panel: live value rows (lazy deep-expand + copy/log/$d actions) and the
// inline hook/prop editors.

import type {
  InspectHook,
  InspectNode,
  InspectProp,
  SerializedValue,
  ValueRef,
} from "../devtools-inspect.ts";
import type { PanelCtx } from "./ctx.ts";
import { el } from "./styles.ts";

function refKey(ref: ValueRef, path: Array<string | number>): string {
  const base = ref.kind === "hook" ? `hook:${ref.index}` : `${ref.kind}:${ref.key}`;
  return `${base}|${path.join(".")}`;
}

/** Small copy/log/$d action buttons for a live value at `ref`+`path`. */
function valueActions(
  ctx: PanelCtx,
  ref: ValueRef,
  path: Array<string | number>,
  preview: string,
): HTMLElement {
  const { doc, S, api, state } = ctx;
  const wrap = el(doc, "span", "");
  const copy = el(doc, "button", S.act, "copy");
  copy.title = "Copy preview";
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    try {
      (navigator as { clipboard?: { writeText(s: string): unknown } }).clipboard?.writeText(
        preview,
      );
    } catch {
      // Clipboard may be unavailable; ignore.
    }
  });
  const log = el(doc, "button", S.act, "log");
  log.title = "console.log the live value";
  log.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.selected != null) api.logValueAt(state.selected, ref, path);
  });
  const store = el(doc, "button", S.act, "$d");
  store.title = "Store live value as $d";
  store.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.selected == null) return;
    const name = api.storeAsGlobal(state.selected, ref, path);
    if (name) store.textContent = "✓$d";
  });
  wrap.append(copy, log, store);
  return wrap;
}

/** Render one value row (a prop/hook/context value or a nested entry), lazily expandable. */
export function renderValue(
  ctx: PanelCtx,
  ref: ValueRef,
  path: Array<string | number>,
  sv: SerializedValue,
  label: string,
  labelStyle: string,
  depth: number,
): void {
  const { doc, S, api, state, detailPane } = ctx;
  const kv = el(doc, "div", S.kv);
  kv.style.paddingLeft = depth * 12 + "px";
  const expandable = (sv.type === "object" || sv.type === "array") && (sv.size ?? 0) > 0;
  const key = refKey(ref, path);
  const isOpen = state.expanded.has(key);
  if (expandable) {
    const prev = el(doc, "span", S.vExpand, `${isOpen ? "▼" : "▶"} ${sv.preview}`);
    prev.addEventListener("click", () => {
      if (isOpen) state.expanded.delete(key);
      else state.expanded.add(key);
      ctx.render();
    });
    kv.append(el(doc, "span", labelStyle, label), prev, valueActions(ctx, ref, path, sv.preview));
  } else {
    kv.append(
      el(doc, "span", labelStyle, label),
      el(doc, "span", S.v, sv.preview),
      valueActions(ctx, ref, path, sv.preview),
    );
  }
  detailPane.append(kv);
  if (expandable && isOpen && state.selected != null) {
    const deep = api.getValueAt(state.selected, ref, path);
    for (const entry of deep?.entries ?? []) {
      renderValue(ctx, ref, [...path, entry.key], entry.value, entry.key, S.k, depth + 1);
    }
  }
}

/**
 * A boolean checkbox or a text/number input bound to a serialized value; `commit` pushes the
 * edited value back (a hook state or a prop override). Shared by the hook and prop editors —
 * they differ only in value source and commit target.
 */
function valueEditor(
  ctx: PanelCtx,
  v: SerializedValue,
  commit: (next: unknown) => void,
): HTMLElement {
  const { doc, S } = ctx;
  if (v.type === "boolean") {
    const box = el(doc, "input", "") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = v.raw === true;
    box.addEventListener("change", () => commit(box.checked));
    return box;
  }
  const input = el(doc, "input", S.input) as HTMLInputElement;
  input.type = v.type === "number" ? "number" : "text";
  input.value = v.raw == null ? "" : String(v.raw);
  input.addEventListener("change", () => {
    const next = v.type === "number" ? Number(input.value) : input.value;
    if (v.type === "number" && Number.isNaN(next)) return;
    commit(next);
  });
  return input;
}

export function hookEditor(ctx: PanelCtx, sel: InspectNode, hk: InspectHook): HTMLElement {
  return valueEditor(ctx, hk.value, (next) => ctx.api.setHookState(sel.id, hk.index, next));
}

export function propEditor(ctx: PanelCtx, sel: InspectNode, p: InspectProp): HTMLElement {
  return valueEditor(ctx, p.value, (next) => ctx.api.setPropOverride(sel.id, p.key, next));
}

/** `file:///…/app/page.tsx#Export` → `app/page.tsx#Export` (last two path segments). */
export function prettySource(source: string): string {
  const hash = source.lastIndexOf("#");
  const file = hash >= 0 ? source.slice(0, hash) : source;
  const exp = hash >= 0 ? source.slice(hash) : "";
  return file.split("/").slice(-2).join("/") + exp;
}

/** An editor-open URL (`vscode://file/<path>`) for a `file://` source, else "". */
export function editorUrl(source: string): string {
  const hash = source.lastIndexOf("#");
  const file = hash >= 0 ? source.slice(0, hash) : source;
  if (!file.startsWith("file://")) return "";
  try {
    return "vscode://file" + new URL(file).pathname;
  } catch {
    return "";
  }
}
