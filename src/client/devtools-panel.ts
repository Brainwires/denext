// First-party denext DevTools — the in-page panel (dev-only).
//
// A self-contained, vanilla-DOM glass-box: a component tree with per-node props,
// hooks/state (live-editable), and contexts, plus a render-mode view of the page's
// client islands. It reads everything through the inspector API
// (`./devtools-inspect.ts`) and renders with plain DOM (its OWN tiny update loop, not
// the reconciler — so inspecting never re-enters the tree it inspects). Built from DOM
// APIs (no innerHTML), so values are shown as text and never interpreted as markup.
//
// Dev-only and DCE-friendly: `installDevtools` is imported ONLY by the dev route/Flight
// entries, so production bundles never pull it in; it also no-ops unless `__denextDev`.

import {
  type DenextDevtoolsApi,
  type InspectHook,
  type InspectNode,
  installInspector,
} from "./devtools-inspect.ts";

function isDev(): boolean {
  try {
    return (globalThis as { __denextDev?: boolean }).__denextDev === true;
  } catch {
    return false;
  }
}

const STYLE_ID = "dnx-devtools-style";
const CSS = `.dnx-dt-launch{position:fixed;left:12px;bottom:12px;z-index:2147483001;
font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6e9ef;background:#12151c;
border:1px solid #2a3140;border-radius:8px;padding:6px 9px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.dnx-dt-launch:hover{border-color:#3a4560}
.dnx-dt{position:fixed;left:12px;bottom:12px;z-index:2147483002;width:min(560px,92vw);height:min(420px,70vh);
display:flex;flex-direction:column;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6e9ef;
background:#12151c;border:1px solid #2a3140;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden}
.dnx-dt-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#0c0e14;border-bottom:1px solid #2a3140}
.dnx-dt-head b{color:#8aa2ff;font-weight:600;letter-spacing:.02em}
.dnx-dt-tab{background:none;border:0;color:#8b94a7;cursor:pointer;padding:3px 7px;border-radius:6px;font:inherit}
.dnx-dt-tab.on{background:#1d2330;color:#e6e9ef}
.dnx-dt-x{margin-left:auto;background:none;border:0;color:#8b94a7;cursor:pointer;font-size:15px;line-height:1}
.dnx-dt-body{flex:1;display:flex;min-height:0}
.dnx-dt-tree{width:44%;overflow:auto;border-right:1px solid #1d2330;padding:6px 0}
.dnx-dt-detail{flex:1;overflow:auto;padding:8px 10px}
.dnx-dt-row{padding:2px 10px;cursor:pointer;white-space:nowrap;border-radius:4px}
.dnx-dt-row:hover{background:#1a202c}
.dnx-dt-row.sel{background:#233152}
.dnx-dt-comp{color:#8aa2ff}
.dnx-dt-host{color:#7ad6a0}
.dnx-dt-dim{color:#5b647a}
.dnx-dt-key{color:#f0b45b}
.dnx-dt h4{margin:10px 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b94a7}
.dnx-dt h4:first-child{margin-top:0}
.dnx-dt-kv{display:flex;gap:6px;padding:1px 0;align-items:baseline}
.dnx-dt-kv .k{color:#c7a4ff;flex:0 0 auto}
.dnx-dt-kv .v{color:#e6e9ef;word-break:break-all}
.dnx-dt-hk{color:#f0b45b}
.dnx-dt input,.dnx-dt select{font:inherit;background:#0c0e14;color:#e6e9ef;border:1px solid #2a3140;
border-radius:4px;padding:1px 4px;max-width:180px}
.dnx-dt-empty{color:#5b647a;padding:8px 10px}
.dnx-dt-wf{padding:4px 0}
.dnx-dt-wf li{list-style:none;display:flex;gap:8px;padding:2px 10px;border-top:1px solid #1a202c}
.dnx-dt-wf .at{color:#8b94a7;margin-left:auto}`;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(s);
}

// Minimal DOM helper — text children only, so nothing is ever parsed as HTML.
function el(
  doc: Document,
  tag: string,
  attrs?: Record<string, string>,
  ...kids: (Node | string)[]
): HTMLElement {
  const node = doc.createElement(tag);
  if (attrs) { for (const k in attrs) node.setAttribute(k, attrs[k]); }
  for (const kid of kids) node.append(typeof kid === "string" ? doc.createTextNode(kid) : kid);
  return node;
}

interface PanelState {
  open: boolean;
  tab: "components" | "render";
  selected: number | null;
}

function mount(api: DenextDevtoolsApi): void {
  const doc = document;
  ensureStyles(doc);
  const state: PanelState = { open: false, tab: "components", selected: null };

  const launch = el(
    doc,
    "button",
    { class: "dnx-dt-launch", title: "denext devtools (Alt+D)" },
    "⚛ denext",
  );
  const panel = el(doc, "div", {
    class: "dnx-dt",
    role: "complementary",
    "aria-label": "denext devtools",
  });
  panel.style.display = "none";

  const tabComponents = el(doc, "button", { class: "dnx-dt-tab on" }, "Components");
  const tabRender = el(doc, "button", { class: "dnx-dt-tab" }, "Render modes");
  const closeBtn = el(doc, "button", { class: "dnx-dt-x", title: "close" }, "×");
  const head = el(
    doc,
    "div",
    { class: "dnx-dt-head" },
    el(doc, "b", {}, "denext · glass-box"),
    tabComponents,
    tabRender,
    closeBtn,
  );
  const treePane = el(doc, "div", { class: "dnx-dt-tree" });
  const detailPane = el(doc, "div", { class: "dnx-dt-detail" });
  const body = el(doc, "div", { class: "dnx-dt-body" }, treePane, detailPane);
  panel.append(head, body);

  // ---- rendering ----
  function renderTree(nodes: InspectNode[], depth: number): void {
    for (const n of nodes) {
      if (n.kind === "component") {
        const row = el(doc, "div", {
          class: "dnx-dt-row" + (n.id === state.selected ? " sel" : ""),
        });
        row.style.paddingLeft = 10 + depth * 12 + "px";
        row.append(el(doc, "span", { class: "dnx-dt-comp" }, n.name));
        if (n.key !== null) row.append(el(doc, "span", { class: "dnx-dt-key" }, ` key=${n.key}`));
        row.addEventListener("click", () => {
          state.selected = n.id;
          render();
        });
        treePane.append(row);
        renderTree(n.children, depth + 1);
      } else {
        // Host/fragment/text: descend but don't take a row (keeps the tree component-focused).
        renderTree(n.children, depth);
      }
    }
  }

  function findNode(nodes: InspectNode[], id: number): InspectNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
    return null;
  }

  function hookEditor(sel: InspectNode, hk: InspectHook): HTMLElement {
    const v = hk.value;
    if (v.type === "boolean") {
      const input = el(doc, "input", { type: "checkbox" }) as HTMLInputElement;
      input.checked = v.raw === true;
      input.addEventListener("change", () => api.setHookState(sel.id, hk.index, input.checked));
      return input;
    }
    const input = el(doc, "input", {
      type: v.type === "number" ? "number" : "text",
    }) as HTMLInputElement;
    input.value = v.raw == null ? "" : String(v.raw);
    input.addEventListener("change", () => {
      const next = v.type === "number" ? Number(input.value) : input.value;
      if (v.type === "number" && Number.isNaN(next)) return;
      api.setHookState(sel.id, hk.index, next);
    });
    return input;
  }

  function renderDetail(tree: InspectNode[]): void {
    const sel = state.selected == null ? null : findNode(tree, state.selected);
    if (!sel) {
      detailPane.append(el(doc, "div", { class: "dnx-dt-empty" }, "Select a component."));
      return;
    }
    detailPane.append(el(doc, "h4", {}, "Component"));
    detailPane.append(
      el(doc, "div", { class: "dnx-dt-kv" }, el(doc, "span", { class: "v dnx-dt-comp" }, sel.name)),
    );

    detailPane.append(el(doc, "h4", {}, "Props"));
    detailPane.append(
      el(doc, "div", { class: "dnx-dt-kv" }, el(doc, "span", { class: "v" }, sel.props.preview)),
    );

    detailPane.append(el(doc, "h4", {}, "Hooks"));
    if (sel.hooks.length === 0) {
      detailPane.append(el(doc, "div", { class: "dnx-dt-empty" }, "none"));
    } else {
      for (const hk of sel.hooks) {
        const kv = el(
          doc,
          "div",
          { class: "dnx-dt-kv" },
          el(doc, "span", { class: "k dnx-dt-hk" }, `${hk.index} ${hk.kind}`),
        );
        if (hk.editable) kv.append(hookEditor(sel, hk));
        else kv.append(el(doc, "span", { class: "v" }, hk.value.preview));
        detailPane.append(kv);
      }
    }

    if (sel.contexts.length > 0) {
      detailPane.append(el(doc, "h4", {}, "Context"));
      for (const c of sel.contexts) {
        detailPane.append(
          el(
            doc,
            "div",
            { class: "dnx-dt-kv" },
            el(doc, "span", { class: "k" }, c.name),
            el(doc, "span", { class: "v" }, c.value.preview),
          ),
        );
      }
    }
  }

  function renderRenderModes(): void {
    // Server-emitted page verdict (static/dynamic/streamed + cache), when present.
    const page = api.getPageRenderMode();
    if (page) {
      detailPane.append(el(doc, "h4", {}, "Page"));
      const row = el(
        doc,
        "div",
        { class: "dnx-dt-kv" },
        el(doc, "span", { class: "k" }, "mode"),
        el(doc, "span", { class: "v dnx-dt-comp" }, page.mode),
      );
      if (page.cache) {
        row.append(el(doc, "span", { class: "dnx-dt-dim" }, ` · cache ${page.cache}`));
      }
      detailPane.append(row);
    }

    const modes = api.getRenderModes();
    if (modes.length === 0) {
      detailPane.append(
        el(
          doc,
          "div",
          { class: "dnx-dt-empty" },
          page
            ? "No client islands on this page."
            : "No client islands — this page is server-rendered HTML.",
        ),
      );
      return;
    }
    detailPane.append(el(doc, "h4", {}, "Client islands (hydration waterfall)"));
    const ul = el(doc, "ul", { class: "dnx-dt-wf" });
    for (const m of modes) {
      ul.append(
        el(
          doc,
          "li",
          {},
          el(doc, "span", { class: "dnx-dt-comp" }, m.strategy + (m.param ? `(${m.param})` : "")),
          el(doc, "span", { class: "dnx-dt-dim" }, m.id === "island" ? "" : `#${m.id}`),
          el(doc, "span", { class: "at" }, m.hydratedAt != null ? `${m.hydratedAt}ms` : ""),
        ),
      );
    }
    detailPane.append(ul);
  }

  function render(): void {
    tabComponents.className = "dnx-dt-tab" + (state.tab === "components" ? " on" : "");
    tabRender.className = "dnx-dt-tab" + (state.tab === "render" ? " on" : "");
    treePane.style.display = state.tab === "components" ? "" : "none";
    treePane.replaceChildren();
    detailPane.replaceChildren();
    if (state.tab === "components") {
      const tree = api.getInspectorTree();
      if (tree.length === 0) {
        treePane.append(el(doc, "div", { class: "dnx-dt-empty" }, "nothing mounted"));
      } else renderTree(tree, 0);
      renderDetail(tree);
    } else {
      renderRenderModes();
    }
  }

  // ---- interactions ----
  function setOpen(open: boolean): void {
    state.open = open;
    panel.style.display = open ? "" : "none";
    launch.style.display = open ? "none" : "";
    if (open) render();
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
  doc.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      setOpen(!state.open);
    }
  });

  // Re-render on commits while open, coalesced to a frame.
  let queued = false;
  api.subscribe(() => {
    if (!state.open || queued) return;
    queued = true;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16);
    raf(() => {
      queued = false;
      if (state.open) render();
    });
  });

  const attach = () => (doc.body ?? doc.documentElement).append(launch, panel);
  if (doc.body) attach();
  else doc.addEventListener("DOMContentLoaded", attach, { once: true });
}

let installed = false;

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
  mount(api);
}
