// First-party denext DevTools — the in-page panel (dev-only).
//
// A self-contained, vanilla-DOM glass-box: a component tree with per-node props,
// hooks/state (live-editable), and contexts, plus a render-mode view of the page's
// client islands. It reads everything through the inspector API
// (`./devtools-inspect.ts`) and renders with plain DOM (its OWN tiny update loop, not
// the reconciler — so inspecting never re-enters the tree it inspects). Built from DOM
// APIs (no innerHTML), so values are shown as text and never interpreted as markup.
//
// The interaction surface targets React-DevTools parity: an element picker with a
// hover-highlight overlay, a searchable/collapsible tree with an optional host-node
// view, and a detail pane with capability badges, a "why did this render" diff, deep
// (lazy) value expansion, and per-value log/store/copy actions.
//
// Styling is applied INLINE via CSSOM (`element.style`), never a `<style>` sheet: denext
// serves a strict `style-src 'self'` CSP (no `'unsafe-inline'`/hash for a runtime-injected
// stylesheet), which would silently drop a `<style>` — leaving the panel unstyled and its
// fixed launcher scrolling with the page. Per-element inline styles are CSP-safe.
//
// Dev-only and DCE-friendly: `installDevtools` is imported ONLY by the dev route/Flight
// entries, so production bundles never pull it in; it also no-ops unless `__denextDev`.

import {
  type CommitSummary,
  type DenextDevtoolsApi,
  type FlameNode,
  type InspectHook,
  type InspectNode,
  type InspectProp,
  installInspector,
  type SerializedValue,
  type ValueRef,
} from "./devtools-inspect.ts";
import { DINO_ICON } from "./devtools-dino.ts";

function isDev(): boolean {
  try {
    return (globalThis as { __denextDev?: boolean }).__denextDev === true;
  } catch {
    return false;
  }
}

// All panel inline styles + colors live inside a function (not at module scope) so
// esbuild tree-shakes the whole set out of production together with mount(): a bare
// top-level `const S = {…}` object literal is retained by esbuild even when every
// function using it is DCE'd, silently shipping ~2 KB of dead style strings in every
// production bundle. Nothing at module scope references these, so mount()'s removal in
// prod takes them with it.
function buildStyles() {
  const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
  const ACCENT = "#8aa2ff";
  const CHANGED = "#ff9d5c"; // "why did this render" highlight
  // Inline style strings (see the module header for why a <style> sheet can't be used).
  const S = {
    // Circular launcher showing the denext mascot's head-shot (a transparent-corner PNG).
    launch: `position:fixed;left:12px;bottom:12px;z-index:2147483001;width:52px;height:52px;` +
      `padding:0;border:0;border-radius:50%;cursor:pointer;background:#12151c;overflow:hidden;` +
      `box-shadow:0 4px 18px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center`,
    launchImg: `width:100%;height:100%;display:block;border-radius:50%`,
    launchShadow: "0 4px 18px rgba(0,0,0,.5)",
    launchShadowHover: `0 0 0 2px ${ACCENT},0 4px 20px rgba(0,0,0,.55)`,
    panel: `position:fixed;left:12px;bottom:12px;z-index:2147483002;width:min(620px,94vw);` +
      `height:min(460px,74vh);display:flex;flex-direction:column;font:12px/1.45 ${MONO};` +
      `color:#e6e9ef;background:#12151c;border:1px solid #2a3140;border-radius:10px;` +
      `box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden`,
    head: `display:flex;align-items:center;gap:8px;padding:7px 10px;background:#0c0e14;` +
      `border-bottom:1px solid #2a3140`,
    title: `color:${ACCENT};font-weight:600;letter-spacing:.02em`,
    tab:
      `background:none;border:0;color:#8b94a7;cursor:pointer;padding:3px 7px;border-radius:6px;font:inherit`,
    tabOn:
      `background:#1d2330;color:#e6e9ef;border-radius:6px;padding:3px 7px;border:0;cursor:pointer;font:inherit`,
    close:
      `margin-left:auto;background:none;border:0;color:#8b94a7;cursor:pointer;font-size:15px;line-height:1`,
    body: `flex:1;display:flex;min-height:0`,
    left:
      `width:46%;display:flex;flex-direction:column;border-right:1px solid #1d2330;min-height:0`,
    toolbar:
      `display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid #1a202c`,
    search: `flex:1;min-width:0;font:inherit;background:#0c0e14;color:#e6e9ef;` +
      `border:1px solid #2a3140;border-radius:5px;padding:2px 6px`,
    icon:
      `background:none;border:1px solid #2a3140;color:#8b94a7;cursor:pointer;border-radius:5px;padding:2px 6px;font:inherit`,
    iconOn: `background:${ACCENT};border:1px solid ${ACCENT};color:#0c0e14;cursor:pointer;` +
      `border-radius:5px;padding:2px 6px;font:inherit`,
    tree: `flex:1;overflow:auto;padding:6px 0`,
    detail: `flex:1;overflow:auto;padding:8px 10px`,
    row: `padding:2px 10px;cursor:pointer;white-space:nowrap;border-radius:4px;display:flex;` +
      `align-items:center;gap:3px`,
    rowSel: `padding:2px 10px;cursor:pointer;white-space:nowrap;border-radius:4px;` +
      `display:flex;align-items:center;gap:3px;background:#233152`,
    twist: `width:11px;flex:0 0 auto;color:#5b647a;text-align:center`,
    comp: `color:${ACCENT}`,
    hostName: `color:#7f8ba3`,
    key: `color:#f0b45b`,
    dim: `color:#5b647a`,
    h4:
      `margin:10px 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b94a7`,
    h4First:
      `margin:0 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b94a7`,
    kv: `display:flex;gap:6px;padding:1px 0;align-items:baseline`,
    k: `color:#c7a4ff;flex:0 0 auto`,
    kChanged: `color:${CHANGED};flex:0 0 auto;font-weight:600`,
    kHook: `color:#f0b45b;flex:0 0 auto`,
    v: `color:#e6e9ef;word-break:break-all`,
    vExpand: `color:#e6e9ef;word-break:break-all;cursor:pointer`,
    input: `font:inherit;background:#0c0e14;color:#e6e9ef;border:1px solid #2a3140;` +
      `border-radius:4px;padding:1px 4px;max-width:180px`,
    act:
      `background:none;border:0;color:#5b647a;cursor:pointer;font:inherit;padding:0 2px;margin-left:4px`,
    count: `color:${CHANGED};margin-left:6px;font-size:10px`,
    empty: `color:#5b647a;padding:8px 10px`,
    wf: `padding:4px 0;margin:0;list-style:none`,
    wfLi: `display:flex;gap:8px;padding:2px 10px;border-top:1px solid #1a202c;list-style:none`,
    at: `color:#8b94a7;margin-left:auto`,
    // Profiler: commit-bar strip, flamegraph rows/bars, ranked list.
    commitStrip: `display:flex;align-items:flex-end;gap:2px;height:56px;padding:6px 2px;` +
      `overflow-x:auto;border-bottom:1px solid #1a202c;margin-bottom:6px`,
    commitBar: `flex:0 0 auto;width:10px;min-height:2px;background:#3a4356;` +
      `border-radius:2px 2px 0 0;cursor:pointer`,
    commitBarSel: `flex:0 0 auto;width:10px;min-height:2px;background:${ACCENT};` +
      `border-radius:2px 2px 0 0;cursor:pointer`,
    flameWrap: `min-width:0`,
    flameBar: `box-sizing:border-box;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;` +
      `font-size:10px;color:#0c0e14;border-radius:2px;padding:1px 3px;margin:1px 0;cursor:pointer`,
    flameRow: `display:flex;width:100%;gap:1px`,
    rank: `display:flex;gap:6px;padding:1px 0;align-items:baseline`,
    rankBar: `height:9px;border-radius:2px;background:${ACCENT};flex:0 0 auto`,
    overlay:
      `position:fixed;z-index:2147483000;pointer-events:none;background:rgba(138,162,255,.22);` +
      `border:1px solid ${ACCENT};border-radius:2px;display:none`,
    tip: `position:fixed;z-index:2147483000;pointer-events:none;font:11px/1.3 ${MONO};` +
      `color:#0c0e14;background:${ACCENT};border-radius:4px;padding:1px 5px;display:none`,
  };
  // A capability badge (kept out of the literal above because it references ACCENT).
  const S_BADGE =
    `font-size:9px;color:#0c0e14;background:${ACCENT};border-radius:4px;padding:0 4px;margin-left:4px`;
  return { S, S_BADGE };
}

// Minimal DOM helper — inline style via CSSOM (CSP-safe), text children only (no HTML
// parsing). `attrs` sets real attributes (type/title/id); its `style` key is applied as
// cssText, never as a class.
function el(
  doc: Document,
  tag: string,
  style: string,
  ...kids: (Node | string)[]
): HTMLElement {
  const node = doc.createElement(tag);
  if (style) node.style.cssText = style;
  for (const kid of kids) node.append(typeof kid === "string" ? doc.createTextNode(kid) : kid);
  return node;
}

interface PanelState {
  open: boolean;
  tab: "components" | "render" | "profiler";
  selected: number | null;
  /** Element-picker mode: pointer over the page highlights + selects a component. */
  picking: boolean;
  /** Component-name filter (lowercased); empty shows everything. */
  search: string;
  /** Collapsed node ids (their subtree is hidden in the tree). */
  collapsed: Set<number>;
  /** Whether host/text nodes get their own tree rows (off by default). */
  showHost: boolean;
  /** Expanded deep-value path keys in the detail pane (reset when the selection changes). */
  expanded: Set<string>;
  /** The commit index selected in the Profiler tab's step-through, or null for the latest. */
  profilerCommit: number | null;
}

function mount(api: DenextDevtoolsApi, doc: Document): void {
  const { S, S_BADGE } = buildStyles();
  const state: PanelState = {
    open: false,
    tab: "components",
    selected: null,
    picking: false,
    search: "",
    collapsed: new Set(),
    showHost: false,
    expanded: new Set(),
    profilerCommit: null,
  };

  const launchIcon = el(doc, "img", S.launchImg);
  (launchIcon as unknown as HTMLImageElement).src = DINO_ICON;
  (launchIcon as unknown as HTMLImageElement).alt = "denext devtools";
  const launch = el(doc, "button", S.launch, launchIcon);
  launch.title = "denext devtools (Ctrl+Shift+D)";
  launch.addEventListener("mouseenter", () => (launch.style.boxShadow = S.launchShadowHover));
  launch.addEventListener("mouseleave", () => (launch.style.boxShadow = S.launchShadow));

  const panel = el(doc, "div", S.panel);
  panel.setAttribute("role", "complementary");
  panel.setAttribute("aria-label", "denext devtools");
  panel.style.display = "none";

  const tabComponents = el(doc, "button", S.tabOn, "Components");
  const tabRender = el(doc, "button", S.tab, "Render modes");
  const tabProfiler = el(doc, "button", S.tab, "Profiler");
  const closeBtn = el(doc, "button", S.close, "×");
  closeBtn.title = "close";
  const head = el(
    doc,
    "div",
    S.head,
    el(doc, "b", S.title, "denext · glass-box"),
    tabComponents,
    tabRender,
    tabProfiler,
    closeBtn,
  );

  // Tree toolbar: element picker, name filter, host-node toggle.
  const pickBtn = el(doc, "button", S.icon, "🎯");
  pickBtn.title = "Pick an element on the page";
  const searchBox = el(doc, "input", S.search) as HTMLInputElement;
  searchBox.type = "text";
  searchBox.placeholder = "filter…";
  const hostBtn = el(doc, "button", S.icon, "{ }");
  hostBtn.title = "Show host (DOM) nodes";
  const toolbar = el(doc, "div", S.toolbar, pickBtn, searchBox, hostBtn);

  const treePane = el(doc, "div", S.tree);
  const leftPane = el(doc, "div", S.left, toolbar, treePane);
  const detailPane = el(doc, "div", S.detail);
  const body = el(doc, "div", S.body, leftPane, detailPane);
  panel.append(head, body);

  // Highlight overlay + tooltip (for the picker and tree-row hover), on the page itself.
  const overlay = el(doc, "div", S.overlay);
  const tip = el(doc, "div", S.tip);

  function highlight(node: Element | null, label?: string): void {
    if (!node || typeof (node as Element).getBoundingClientRect !== "function") {
      hideHighlight();
      return;
    }
    const r = (node as Element).getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.top = r.top + "px";
    overlay.style.left = r.left + "px";
    overlay.style.width = Math.max(0, r.width) + "px";
    overlay.style.height = Math.max(0, r.height) + "px";
    if (label) {
      tip.replaceChildren(doc.createTextNode(label));
      tip.style.display = "block";
      tip.style.top = Math.max(0, r.top - 18) + "px";
      tip.style.left = r.left + "px";
    } else {
      tip.style.display = "none";
    }
  }
  function hideHighlight(): void {
    overlay.style.display = "none";
    tip.style.display = "none";
  }

  // ---- element picker ----
  function nameForId(id: number): string {
    const n = findNode(api.getInspectorTree(), id);
    return n ? n.name : "?";
  }
  function onPickMove(e: Event): void {
    const id = api.getFiberIdForDom((e as { target?: Node | null }).target ?? null);
    if (id == null) {
      hideHighlight();
      return;
    }
    highlight(api.getHostNode(id), nameForId(id));
  }
  function onPickClick(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    const id = api.getFiberIdForDom((e as { target?: Node | null }).target ?? null);
    stopPicking();
    if (id != null) {
      selectNode(id);
    }
  }
  function onPickKey(e: KeyboardEvent): void {
    if (e.key === "Escape") stopPicking();
  }
  function startPicking(): void {
    if (state.picking) return;
    state.picking = true;
    pickBtn.style.cssText = S.iconOn;
    doc.addEventListener("pointermove", onPickMove, true);
    doc.addEventListener("click", onPickClick, true);
    doc.addEventListener("keydown", onPickKey, true);
  }
  function stopPicking(): void {
    if (!state.picking) return;
    state.picking = false;
    pickBtn.style.cssText = S.icon;
    doc.removeEventListener("pointermove", onPickMove, true);
    doc.removeEventListener("click", onPickClick, true);
    doc.removeEventListener("keydown", onPickKey, true);
    hideHighlight();
  }

  function selectNode(id: number): void {
    if (state.selected !== id) state.expanded.clear();
    state.selected = id;
    render();
  }

  // ---- tree ----
  function findNode(nodes: InspectNode[], id: number): InspectNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * The ids to show for the current search: a node is visible if it (or a descendant)
   * matches. Returns null when there is no filter (show everything).
   */
  function computeVisible(nodes: InspectNode[]): Set<number> | null {
    if (!state.search) return null;
    const out = new Set<number>();
    const walk = (list: InspectNode[]): boolean => {
      let any = false;
      for (const n of list) {
        const childHit = walk(n.children);
        const selfHit = n.name.toLowerCase().includes(state.search);
        if (childHit || selfHit) {
          out.add(n.id);
          any = true;
        }
      }
      return any;
    };
    walk(nodes);
    return out;
  }

  function renderTree(nodes: InspectNode[], depth: number, visible: Set<number> | null): void {
    for (const n of nodes) {
      if (visible && !visible.has(n.id)) continue;
      const isComponentRow = n.kind === "component" || state.showHost;
      if (!isComponentRow) {
        renderTree(n.children, depth, visible);
        continue;
      }
      const row = el(doc, "div", n.id === state.selected ? S.rowSel : S.row);
      row.style.paddingLeft = 6 + depth * 12 + "px";

      // Collapse/expand twisty — only when there are (visible) children.
      const hasKids = n.children.length > 0;
      const collapsed = state.collapsed.has(n.id);
      const twist = el(doc, "span", S.twist, hasKids ? (collapsed ? "▶" : "▼") : "");
      if (hasKids) {
        twist.addEventListener("click", (e) => {
          e.stopPropagation();
          if (collapsed) state.collapsed.delete(n.id);
          else state.collapsed.add(n.id);
          render();
        });
      }
      row.append(twist);

      const nameStyle = n.kind === "component" ? S.comp : S.hostName;
      row.append(el(doc, "span", nameStyle, n.name));
      if (n.key !== null) row.append(el(doc, "span", S.key, ` key=${n.key}`));
      for (const b of n.badges ?? []) row.append(el(doc, "span", S_BADGE, b));

      row.addEventListener("click", () => selectNode(n.id));
      row.addEventListener("mouseenter", () => {
        if (!state.picking) highlight(api.getHostNode(n.id), n.name);
      });
      row.addEventListener("mouseleave", () => {
        if (!state.picking) hideHighlight();
      });
      treePane.append(row);
      if (!collapsed) renderTree(n.children, depth + 1, visible);
    }
  }

  // ---- detail: value rendering (lazy deep-expand + actions) ----
  function refKey(ref: ValueRef, path: Array<string | number>): string {
    const base = ref.kind === "hook" ? `hook:${ref.index}` : `${ref.kind}:${ref.key}`;
    return `${base}|${path.join(".")}`;
  }

  /** Small copy/log/$d action buttons for a live value at `ref`+`path`. */
  function valueActions(ref: ValueRef, path: Array<string | number>, preview: string): HTMLElement {
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
      if (state.selected != null) {
        const name = api.storeAsGlobal(state.selected, ref, path);
        if (name) store.textContent = "✓$d";
      }
    });
    wrap.append(copy, log, store);
    return wrap;
  }

  /** Render one value row (a prop/hook/context value or a nested entry), lazily expandable. */
  function renderValue(
    ref: ValueRef,
    path: Array<string | number>,
    sv: SerializedValue,
    label: string,
    labelStyle: string,
    depth: number,
  ): void {
    const kv = el(doc, "div", S.kv);
    kv.style.paddingLeft = depth * 12 + "px";
    const expandable = (sv.type === "object" || sv.type === "array") && (sv.size ?? 0) > 0;
    const key = refKey(ref, path);
    const isOpen = state.expanded.has(key);
    if (expandable) {
      const label2 = el(doc, "span", labelStyle, label);
      const prev = el(doc, "span", S.vExpand, `${isOpen ? "▼" : "▶"} ${sv.preview}`);
      prev.addEventListener("click", () => {
        if (isOpen) state.expanded.delete(key);
        else state.expanded.add(key);
        render();
      });
      kv.append(label2, prev, valueActions(ref, path, sv.preview));
    } else {
      kv.append(
        el(doc, "span", labelStyle, label),
        el(doc, "span", S.v, sv.preview),
        valueActions(ref, path, sv.preview),
      );
    }
    detailPane.append(kv);

    if (expandable && isOpen && state.selected != null) {
      const deep = api.getValueAt(state.selected, ref, path);
      for (const entry of deep?.entries ?? []) {
        renderValue(ref, [...path, entry.key], entry.value, entry.key, S.k, depth + 1);
      }
    }
  }

  function hookEditor(sel: InspectNode, hk: InspectHook): HTMLElement {
    const v = hk.value;
    if (v.type === "boolean") {
      const box = el(doc, "input", "") as HTMLInputElement;
      box.type = "checkbox";
      box.checked = v.raw === true;
      box.addEventListener("change", () => api.setHookState(sel.id, hk.index, box.checked));
      return box;
    }
    const input = el(doc, "input", S.input) as HTMLInputElement;
    input.type = v.type === "number" ? "number" : "text";
    input.value = v.raw == null ? "" : String(v.raw);
    input.addEventListener("change", () => {
      const next = v.type === "number" ? Number(input.value) : input.value;
      if (v.type === "number" && Number.isNaN(next)) return;
      api.setHookState(sel.id, hk.index, next);
    });
    return input;
  }

  function propEditor(sel: InspectNode, p: InspectProp): HTMLElement {
    const v = p.value;
    if (v.type === "boolean") {
      const box = el(doc, "input", "") as HTMLInputElement;
      box.type = "checkbox";
      box.checked = v.raw === true;
      box.addEventListener("change", () => api.setPropOverride(sel.id, p.key, box.checked));
      return box;
    }
    const input = el(doc, "input", S.input) as HTMLInputElement;
    input.type = v.type === "number" ? "number" : "text";
    input.value = v.raw == null ? "" : String(v.raw);
    input.addEventListener("change", () => {
      const next = v.type === "number" ? Number(input.value) : input.value;
      if (v.type === "number" && Number.isNaN(next)) return;
      api.setPropOverride(sel.id, p.key, next);
    });
    return input;
  }

  function h4(first: boolean, text: string): HTMLElement {
    return el(doc, "h4", first ? S.h4First : S.h4, text);
  }

  /** `file:///…/app/page.tsx#Export` → `app/page.tsx#Export` (last two path segments). */
  function prettySource(source: string): string {
    const hash = source.lastIndexOf("#");
    const file = hash >= 0 ? source.slice(0, hash) : source;
    const exp = hash >= 0 ? source.slice(hash) : "";
    return file.split("/").slice(-2).join("/") + exp;
  }

  /** An editor-open URL (`vscode://file/<path>`) for a `file://` source, else "". */
  function editorUrl(source: string): string {
    const hash = source.lastIndexOf("#");
    const file = hash >= 0 ? source.slice(0, hash) : source;
    if (!file.startsWith("file://")) return "";
    try {
      return "vscode://file" + new URL(file).pathname;
    } catch {
      return "";
    }
  }

  function renderDetail(tree: InspectNode[]): void {
    const sel = state.selected == null ? null : findNode(tree, state.selected);
    if (!sel) {
      detailPane.append(el(doc, "div", S.empty, "Select a component (or use 🎯 to pick one)."));
      return;
    }
    const reason = api.getRenderReason(sel.id);

    detailPane.append(h4(true, "Component"));
    const nameRow = el(doc, "div", S.kv, el(doc, "span", S.v + ";" + S.comp, sel.name));
    for (const b of sel.badges ?? []) nameRow.append(el(doc, "span", S_BADGE, b));
    if (reason && reason.count > 0) {
      nameRow.append(el(doc, "span", S.count, `rendered ×${reason.count}`));
    }
    detailPane.append(nameRow);

    if (sel.source) {
      detailPane.append(h4(false, "Source"));
      const link = el(doc, "a", S.v, prettySource(sel.source)) as unknown as HTMLAnchorElement;
      const url = editorUrl(sel.source);
      if (url) link.href = url;
      link.title = sel.source;
      detailPane.append(el(doc, "div", S.kv, link as unknown as Element));
    }

    const owners = api.getOwnerStack(sel.id);
    if (owners.length > 0) {
      detailPane.append(h4(false, "Owner stack"));
      detailPane.append(
        el(doc, "div", S.kv, el(doc, "span", S.v, owners.map((o) => o.name).join(" ← "))),
      );
    }

    detailPane.append(h4(false, "Props"));
    const entries = sel.propEntries ?? [];
    if (entries.length === 0) {
      detailPane.append(el(doc, "div", S.kv, el(doc, "span", S.v, sel.props.preview)));
    } else {
      for (const p of entries) {
        const changed = reason?.props.includes(p.key) === true;
        const kStyle = changed ? S.kChanged : S.k;
        if (p.editable) {
          detailPane.append(
            el(doc, "div", S.kv, el(doc, "span", kStyle, p.key), propEditor(sel, p)),
          );
        } else {
          renderValue({ kind: "prop", key: p.key }, [], p.value, p.key, kStyle, 0);
        }
      }
      const reset = el(doc, "button", S.tab, "reset props");
      reset.addEventListener("click", () => {
        api.clearPropOverrides(sel.id);
        render();
      });
      detailPane.append(reset);
    }

    detailPane.append(h4(false, "Hooks"));
    if (sel.hooks.length === 0) {
      detailPane.append(el(doc, "div", S.empty, "none"));
    } else {
      for (const hk of sel.hooks) {
        const changed = reason?.hooks.includes(hk.index) === true;
        const kStyle = changed ? S.kChanged : S.kHook;
        const label = `${hk.index} ${hk.kind}`;
        if (hk.editable) {
          detailPane.append(
            el(doc, "div", S.kv, el(doc, "span", kStyle, label), hookEditor(sel, hk)),
          );
        } else {
          renderValue({ kind: "hook", index: hk.index }, [], hk.value, label, kStyle, 0);
        }
        // Deps / cleanup annotations (effect/memo/callback/deferred).
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
    }

    if (sel.contexts.length > 0) {
      detailPane.append(h4(false, "Context"));
      for (const c of sel.contexts) {
        const changed = reason?.contexts.includes(c.name) === true;
        renderValue(
          { kind: "context", key: c.name },
          [],
          c.value,
          c.name,
          changed ? S.kChanged : S.k,
          0,
        );
      }
    }
  }

  function renderRenderModes(): void {
    // Server-emitted page verdict (static/dynamic/streamed + cache), when present.
    const page = api.getPageRenderMode();
    if (page) {
      detailPane.append(h4(true, "Page"));
      const row = el(
        doc,
        "div",
        S.kv,
        el(doc, "span", S.k, "mode"),
        el(doc, "span", S.v + ";" + S.comp, page.mode),
      );
      if (page.cache) row.append(el(doc, "span", S.dim, ` · cache ${page.cache}`));
      detailPane.append(row);
    }

    // Per-Suspense-boundary server timeline (streamed pages), when present.
    const boundaries = api.getBoundaryTimings();
    if (boundaries.length > 0) {
      detailPane.append(h4(!page, "Suspense boundaries (live waterfall)"));
      let maxMs = 0;
      for (const b of boundaries) if (b.ms > maxMs) maxMs = b.ms;
      maxMs = maxMs || 0.0001;
      const bul = el(doc, "ul", S.wf);
      for (const b of boundaries) {
        const bar = el(doc, "div", S.rankBar);
        bar.style.width = Math.max(3, Math.round((b.ms / maxMs) * 70)) + "px";
        const li = el(
          doc,
          "li",
          S.wfLi,
          el(doc, "span", S.comp, b.id),
          bar,
          el(doc, "span", S.dim, `${b.ms}ms server`),
        );
        // The client reveal time lands in real time, before the server-resolve island.
        if (b.revealAt != null) {
          li.append(el(doc, "span", S.at, `revealed @${Math.round(b.revealAt)}ms`));
        }
        bul.append(li);
      }
      detailPane.append(bul);
    }

    const modes = api.getRenderModes();
    if (modes.length === 0) {
      if (boundaries.length === 0) {
        detailPane.append(
          el(
            doc,
            "div",
            S.empty,
            page
              ? "No client islands on this page."
              : "No client islands — this page is server-rendered HTML.",
          ),
        );
      }
      return;
    }
    detailPane.append(h4(!page && boundaries.length === 0, "Client islands (hydration waterfall)"));
    const ul = el(doc, "ul", S.wf);
    for (const m of modes) {
      ul.append(
        el(
          doc,
          "li",
          S.wfLi,
          el(doc, "span", S.comp, m.strategy + (m.param ? `(${m.param})` : "")),
          el(doc, "span", S.dim, m.id === "island" ? "" : `#${m.id}`),
          el(doc, "span", S.at, m.hydratedAt != null ? `${m.hydratedAt}ms` : ""),
        ),
      );
    }
    detailPane.append(ul);
  }

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
  function flameEl(node: FlameNode): HTMLElement {
    const wrap = el(doc, "div", S.flameWrap);
    const bar = el(doc, "div", S.flameBar, `${node.name} ${node.selfMs.toFixed(1)}`);
    bar.style.background = flameColor(node);
    bar.title = `${node.name} · self ${node.selfMs.toFixed(2)}ms · total ${
      node.totalMs.toFixed(2)
    }ms${node.didRender ? "" : " · did not render"}`;
    bar.addEventListener("click", () => {
      state.tab = "components";
      selectNode(node.id); // jump to the component in the tree
    });
    wrap.append(bar);
    if (node.children.length) {
      const row = el(doc, "div", S.flameRow);
      for (const c of node.children) {
        const cw = flameEl(c);
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

  function renderProfilerTab(): void {
    const recording = api.isProfiling();
    const rec = el(doc, "button", S.tab, recording ? "■ Stop" : "● Record");
    rec.addEventListener("click", () => {
      if (api.isProfiling()) {
        api.stopProfiling();
      } else {
        api.resetProfile();
        state.profilerCommit = null;
        api.startProfiling();
      }
      render();
    });
    const clear = el(doc, "button", S.tab, "Clear");
    clear.addEventListener("click", () => {
      api.resetProfile();
      state.profilerCommit = null;
      render();
    });
    detailPane.append(el(doc, "div", S.kv, rec, clear));

    const commits = api.getCommits();
    if (commits.length === 0) {
      detailPane.append(
        el(
          doc,
          "div",
          S.empty,
          recording
            ? "Recording… interact with the app."
            : "No commits recorded. Click Record, then interact.",
        ),
      );
      return;
    }

    // Commit-bar strip — one bar per commit (height ∝ duration), click to step through.
    const selectedIndex = state.profilerCommit ?? commits[commits.length - 1].index;
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
        render();
      });
      strip.append(bar);
    }
    detailPane.append(strip);

    const sel = commits.find((c) => c.index === selectedIndex) as CommitSummary;
    detailPane.append(
      h4(false, `Commit #${sel.index} · ${sel.phase} · ${sel.duration.toFixed(1)}ms`),
    );

    const tree = api.getCommitTree(selectedIndex);
    if (!tree || tree.children.length === 0) {
      detailPane.append(el(doc, "div", S.empty, "Nothing rendered in this commit."));
      return;
    }

    // Flamegraph: the commit root's top-level components laid out proportionally.
    const total = tree.totalMs || 0.0001;
    const fgRow = el(doc, "div", S.flameRow);
    for (const child of tree.children) {
      const cw = flameEl(child);
      cw.style.width = ((child.totalMs / total) * 100) + "%";
      fgRow.append(cw);
    }
    detailPane.append(fgRow);

    // Ranked-by-self chart + why-each-rendered.
    const flat: FlameNode[] = [];
    flattenFlame(tree, flat);
    const ranked = flat.filter((n) => n.didRender).sort((a, b) => b.selfMs - a.selfMs);
    if (ranked.length === 0) {
      detailPane.append(el(doc, "div", S.empty, "No components rendered (a host-only commit)."));
      return;
    }
    detailPane.append(h4(false, "Ranked (self time · why)"));
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

  function render(): void {
    tabComponents.style.cssText = state.tab === "components" ? S.tabOn : S.tab;
    tabRender.style.cssText = state.tab === "render" ? S.tabOn : S.tab;
    tabProfiler.style.cssText = state.tab === "profiler" ? S.tabOn : S.tab;
    leftPane.style.display = state.tab === "components" ? "" : "none";
    treePane.replaceChildren();
    detailPane.replaceChildren();
    if (state.tab === "components") {
      const tree = api.getInspectorTree();
      if (tree.length === 0) treePane.append(el(doc, "div", S.empty, "nothing mounted"));
      else renderTree(tree, 0, computeVisible(tree));
      renderDetail(tree);
    } else if (state.tab === "render") {
      renderRenderModes();
    } else {
      renderProfilerTab();
    }
  }

  // ---- interactions ----
  function setOpen(open: boolean): void {
    state.open = open;
    panel.style.display = open ? "flex" : "none";
    launch.style.display = open ? "none" : "";
    if (open) {
      api.enableRenderReasons(); // start accruing "why did this render" while inspecting
      render();
    } else {
      stopPicking();
      hideHighlight();
      api.disableRenderReasons();
    }
  }
  launch.addEventListener("click", () => setOpen(true));
  closeBtn.addEventListener("click", () => setOpen(false));
  tabComponents.addEventListener("click", () => {
    state.tab = "components";
    render();
  });
  tabRender.addEventListener("click", () => {
    state.tab = "render";
    render();
  });
  tabProfiler.addEventListener("click", () => {
    state.tab = "profiler";
    render();
  });
  pickBtn.addEventListener("click", () => {
    if (state.picking) stopPicking();
    else startPicking();
  });
  searchBox.addEventListener("input", () => {
    state.search = searchBox.value.trim().toLowerCase();
    render();
    searchBox.focus();
  });
  hostBtn.addEventListener("click", () => {
    state.showHost = !state.showHost;
    hostBtn.style.cssText = state.showHost ? S.iconOn : S.icon;
    render();
  });
  // Ctrl+Shift+D toggles the panel — chosen to avoid Chrome's Alt/Cmd bookmark
  // shortcuts (Cmd+D / Alt+D) on macOS.
  doc.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      setOpen(!state.open);
    }
  });

  // Re-render while open, coalesced to a frame.
  let queued = false;
  function queueRender(): void {
    if (!state.open || queued) return;
    queued = true;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16);
    raf(() => {
      queued = false;
      if (state.open) render();
    });
  }
  api.subscribe(queueRender); // on every commit
  // On each streamed-hole reveal, refresh the Render-modes waterfall in real time (a
  // reveal doesn't cause a commit, so the commit subscription wouldn't catch it).
  api.subscribeBoundaries(() => {
    if (state.tab === "render") queueRender();
  });

  const attach = () => (doc.body ?? doc.documentElement).append(launch, panel, overlay, tip);
  if (doc.body) attach();
  else doc.addEventListener("DOMContentLoaded", attach, { once: true });
}

let installed = false;

/**
 * Mount the panel against an explicit document — the {@link installDevtools} internals,
 * exposed for unit tests so a fake document can drive the DOM. Not part of the public API.
 * @internal
 */
export function mountPanel(api: DenextDevtoolsApi, doc: Document): void {
  mount(api, doc);
}

/**
 * Install denext's first-party DevTools (inspector API + in-page panel). Idempotent,
 * and a no-op in production / without a DOM / unless `__denextDev`. Imported ONLY by the
 * dev route/Flight entries, so it never enters a production bundle.
 */
export function installDevtools(): void {
  if (installed || !isDev() || typeof document === "undefined") return;
  const api = installInspector();
  if (!api) return;
  installed = true;
  mount(api, document);
  if (typeof console !== "undefined") {
    console.info(
      "%c[denext] devtools ready",
      "color:#8aa2ff;font-weight:bold",
      "— launcher at bottom-left, or Ctrl+Shift+D",
    );
  }
}
