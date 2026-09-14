// DevTools panel: live value rows (lazy deep-expand + copy/log/$d actions) and the
// inline hook/prop editors.

import type {
  InspectHook,
  InspectNode,
  InspectProp,
  SerializedValue,
  SourceLocation,
  ValueRef,
} from "../devtools-inspect.ts";
import type { PanelCtx } from "./ctx.ts";
import { openInEditor } from "./dev-api.ts";
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

/**
 * Render one value row (a prop/hook/context value or a nested entry), lazily expandable.
 * `note` is an optional dim annotation drawn after the label (a hook row's hook name).
 */
export function renderValue(
  ctx: PanelCtx,
  ref: ValueRef,
  path: Array<string | number>,
  sv: SerializedValue,
  label: string,
  labelStyle: string,
  depth: number,
  note?: string,
): void {
  const { doc, S, api, state, detailPane } = ctx;
  const kv = el(doc, "div", S.kv);
  kv.style.paddingLeft = depth * 12 + "px";
  const expandable = (sv.type === "object" || sv.type === "array") && (sv.size ?? 0) > 0;
  const key = refKey(ref, path);
  const isOpen = state.expanded.has(key);
  kv.append(el(doc, "span", labelStyle, label));
  if (note) kv.append(el(doc, "span", S.dim, note));
  if (expandable) {
    const prev = el(doc, "span", S.vExpand, `${isOpen ? "▼" : "▶"} ${sv.preview}`);
    prev.addEventListener("click", () => {
      if (isOpen) state.expanded.delete(key);
      else state.expanded.add(key);
      ctx.render();
    });
    kv.append(prev, valueActions(ctx, ref, path, sv.preview));
  } else {
    kv.append(
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

/**
 * A source location as the panel shows it: `app/page.tsx:42`.
 *
 * The path is repo-relative when the module is served from the app root (an unbundled
 * dev module URL is same-origin with the page), and otherwise the URL's last two
 * segments — the browser has no view of the project directory, so a `file://` module is
 * shown by its tail rather than by a path it cannot shorten honestly.
 *
 * @param src The component's source location.
 * @returns The display text (the line is appended when known).
 */
export function prettySource(src: SourceLocation): string {
  let path = src.file;
  try {
    const url = new URL(src.file);
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    path = url.protocol !== "file:" && url.origin === origin
      ? url.pathname.replace(/^\//, "")
      : url.pathname.split("/").slice(-2).join("/");
  } catch {
    path = src.file.split("/").slice(-2).join("/");
  }
  return src.line === undefined ? path : `${path}:${src.line}`;
}

/** `file:///a/b.tsx` → `/a/b.tsx`; a non-`file:` source keeps its text. */
function filePath(file: string): string {
  if (!file.startsWith("file://")) return file;
  try {
    return decodeURIComponent(new URL(file).pathname);
  } catch {
    return file;
  }
}

/** The full `path:line:column` a source link shows as its tooltip. */
function sourceTitle(src: SourceLocation): string {
  return `${filePath(src.file)}:${src.line ?? 1}:${src.column ?? 1}`;
}

/**
 * The hard-coded editor URL the link falls back to — `vscode://file/<path>:<line>:<col>`
 * — used only when the dev server's `/_denext/open-in-editor` endpoint answered
 * "unavailable" (SPA dev serves no dev endpoints). `""` for a non-`file://` source.
 *
 * @param src The component's source location.
 * @returns The `vscode://` URL, or `""`.
 */
export function editorFallbackUrl(src: SourceLocation): string {
  if (!src.file.startsWith("file://")) return "";
  return `vscode://file${sourceTitle(src)}`;
}

/**
 * The detail pane's source link: focusable, titled with the full `file:line:column`, and
 * routed through the dev server's editor endpoint (which honours `DENEXT_EDITOR`/
 * `VISUAL`/`EDITOR`) — unless a dev endpoint has already reported itself unavailable, in
 * which case it becomes a plain `vscode://` link the browser follows.
 *
 * @param ctx The mounted panel context.
 * @param src The selected component's source location.
 * @returns The anchor element.
 */
export function sourceLink(ctx: PanelCtx, src: SourceLocation): HTMLElement {
  const { doc, S, state } = ctx;
  const link = el(doc, "a", S.vExpand, prettySource(src)) as HTMLAnchorElement;
  link.title = sourceTitle(src);
  const fallback = state.dataUnavailable === true ? editorFallbackUrl(src) : "";
  link.href = fallback || "#";
  link.addEventListener("click", (e: Event) => {
    if (fallback) return; // let the browser follow the vscode:// URL
    e.preventDefault();
    openInEditor(filePath(src.file), src.line ?? 1, src.column ?? 1);
  });
  return link;
}
