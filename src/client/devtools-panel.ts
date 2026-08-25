// First-party denext DevTools — the in-page panel (dev-only).
//
// A self-contained, vanilla-DOM glass-box: a component tree with per-node props,
// hooks/state (live-editable), and contexts, plus a render-mode view of the page's
// client islands. It reads everything through the inspector API
// (`./devtools-inspect.ts`) and renders with plain DOM (its OWN tiny update loop, not
// the reconciler — so inspecting never re-enters the tree it inspects). Built from DOM
// APIs (no innerHTML), so values are shown as text and never interpreted as markup.
//
// Styling is applied INLINE via CSSOM (`element.style`), never a `<style>` sheet: denext
// serves a strict `style-src 'self'` CSP (no `'unsafe-inline'`/hash for a runtime-injected
// stylesheet), which would silently drop a `<style>` — leaving the panel unstyled and its
// fixed launcher scrolling with the page. Per-element inline styles are CSP-safe.
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

const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
const ACCENT = "#8aa2ff";
// Inline style strings (see the module header for why a <style> sheet can't be used).
const S = {
  launch: `position:fixed;left:12px;bottom:12px;z-index:2147483001;font:700 13px/1 ${MONO};` +
    `color:#0c0e14;background:${ACCENT};border:0;border-radius:9px;padding:10px 14px;` +
    `cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.5)`,
  panel: `position:fixed;left:12px;bottom:12px;z-index:2147483002;width:min(560px,92vw);` +
    `height:min(420px,70vh);display:flex;flex-direction:column;font:12px/1.45 ${MONO};` +
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
  tree: `width:44%;overflow:auto;border-right:1px solid #1d2330;padding:6px 0`,
  detail: `flex:1;overflow:auto;padding:8px 10px`,
  row: `padding:2px 10px;cursor:pointer;white-space:nowrap;border-radius:4px`,
  rowSel: `padding:2px 10px;cursor:pointer;white-space:nowrap;border-radius:4px;background:#233152`,
  comp: `color:${ACCENT}`,
  key: `color:#f0b45b`,
  dim: `color:#5b647a`,
  h4:
    `margin:10px 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b94a7`,
  h4First:
    `margin:0 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b94a7`,
  kv: `display:flex;gap:6px;padding:1px 0;align-items:baseline`,
  k: `color:#c7a4ff;flex:0 0 auto`,
  kHook: `color:#f0b45b;flex:0 0 auto`,
  v: `color:#e6e9ef;word-break:break-all`,
  input: `font:inherit;background:#0c0e14;color:#e6e9ef;border:1px solid #2a3140;` +
    `border-radius:4px;padding:1px 4px;max-width:180px`,
  empty: `color:#5b647a;padding:8px 10px`,
  wf: `padding:4px 0;margin:0;list-style:none`,
  wfLi: `display:flex;gap:8px;padding:2px 10px;border-top:1px solid #1a202c;list-style:none`,
  at: `color:#8b94a7;margin-left:auto`,
};

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
  tab: "components" | "render";
  selected: number | null;
}

function mount(api: DenextDevtoolsApi): void {
  const doc = document;
  const state: PanelState = { open: false, tab: "components", selected: null };

  const launch = el(doc, "button", S.launch, "⚛ denext devtools");
  launch.title = "denext devtools (Ctrl+Shift+D)";
  launch.addEventListener("mouseenter", () => (launch.style.background = "#a4b6ff"));
  launch.addEventListener("mouseleave", () => (launch.style.background = ACCENT));

  const panel = el(doc, "div", S.panel);
  panel.setAttribute("role", "complementary");
  panel.setAttribute("aria-label", "denext devtools");
  panel.style.display = "none";

  const tabComponents = el(doc, "button", S.tabOn, "Components");
  const tabRender = el(doc, "button", S.tab, "Render modes");
  const closeBtn = el(doc, "button", S.close, "×");
  closeBtn.title = "close";
  const head = el(
    doc,
    "div",
    S.head,
    el(doc, "b", S.title, "denext · glass-box"),
    tabComponents,
    tabRender,
    closeBtn,
  );
  const treePane = el(doc, "div", S.tree);
  const detailPane = el(doc, "div", S.detail);
  const body = el(doc, "div", S.body, treePane, detailPane);
  panel.append(head, body);

  // ---- rendering ----
  function renderTree(nodes: InspectNode[], depth: number): void {
    for (const n of nodes) {
      if (n.kind === "component") {
        const row = el(doc, "div", n.id === state.selected ? S.rowSel : S.row);
        row.style.paddingLeft = 10 + depth * 12 + "px";
        row.append(el(doc, "span", S.comp, n.name));
        if (n.key !== null) row.append(el(doc, "span", S.key, ` key=${n.key}`));
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
      detailPane.append(el(doc, "div", S.empty, "Select a component."));
      return;
    }
    detailPane.append(h4(true, "Component"));
    detailPane.append(el(doc, "div", S.kv, el(doc, "span", S.v + ";" + S.comp, sel.name)));

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
    detailPane.append(el(doc, "div", S.kv, el(doc, "span", S.v, sel.props.preview)));

    detailPane.append(h4(false, "Hooks"));
    if (sel.hooks.length === 0) {
      detailPane.append(el(doc, "div", S.empty, "none"));
    } else {
      for (const hk of sel.hooks) {
        const kv = el(doc, "div", S.kv, el(doc, "span", S.kHook, `${hk.index} ${hk.kind}`));
        if (hk.editable) kv.append(hookEditor(sel, hk));
        else kv.append(el(doc, "span", S.v, hk.value.preview));
        detailPane.append(kv);
      }
    }

    if (sel.contexts.length > 0) {
      detailPane.append(h4(false, "Context"));
      for (const c of sel.contexts) {
        detailPane.append(
          el(doc, "div", S.kv, el(doc, "span", S.k, c.name), el(doc, "span", S.v, c.value.preview)),
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

    const modes = api.getRenderModes();
    if (modes.length === 0) {
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
      return;
    }
    detailPane.append(h4(!page, "Client islands (hydration waterfall)"));
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

  function render(): void {
    tabComponents.style.cssText = state.tab === "components" ? S.tabOn : S.tab;
    tabRender.style.cssText = state.tab === "render" ? S.tabOn : S.tab;
    treePane.style.display = state.tab === "components" ? "" : "none";
    treePane.replaceChildren();
    detailPane.replaceChildren();
    if (state.tab === "components") {
      const tree = api.getInspectorTree();
      if (tree.length === 0) treePane.append(el(doc, "div", S.empty, "nothing mounted"));
      else renderTree(tree, 0);
      renderDetail(tree);
    } else {
      renderRenderModes();
    }
  }

  // ---- interactions ----
  function setOpen(open: boolean): void {
    state.open = open;
    panel.style.display = open ? "flex" : "none";
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
  // Ctrl+Shift+D toggles the panel — chosen to avoid Chrome's Alt/Cmd bookmark
  // shortcuts (Cmd+D / Alt+D) on macOS.
  doc.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "d" || e.key === "D")) {
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
  if (typeof console !== "undefined") {
    console.info(
      "%c[denext] devtools ready",
      `color:${ACCENT};font-weight:bold`,
      "— launcher at bottom-left, or Ctrl+Shift+D",
    );
  }
}
