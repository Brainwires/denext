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
// The panes live under `./devtools-panel/` (styles, tree, detail, render-modes, profiler,
// picker) and render against a shared `PanelCtx`; this module builds the shell and wires it.
//
// Dev-only and DCE-friendly: `installDevtools` is imported ONLY by the dev route/Flight
// entries, so production bundles never pull it in; it also no-ops unless `__denextDev`.

import { type DenextDevtoolsApi, installInspector } from "./devtools-inspect.ts";
import { DINO_ICON } from "./devtools-dino.ts";
import type { PanelCtx, PanelState } from "./devtools-panel/ctx.ts";
import { renderDetail } from "./devtools-panel/detail.ts";
import { createHighlighter, createPicker } from "./devtools-panel/picker.ts";
import { renderProfilerTab } from "./devtools-panel/profiler.ts";
import { renderRenderModes } from "./devtools-panel/render-modes.ts";
import { buildStyles, el, type PanelStyles } from "./devtools-panel/styles.ts";
import { computeVisible, renderTree } from "./devtools-panel/tree.ts";

function isDev(): boolean {
  try {
    return (globalThis as { __denextDev?: boolean }).__denextDev === true;
  } catch {
    return false;
  }
}

/** The panel's DOM shell: launcher, header tabs, toolbar, panes. */
interface Shell {
  launch: HTMLElement;
  panel: HTMLElement;
  tabComponents: HTMLElement;
  tabRender: HTMLElement;
  tabProfiler: HTMLElement;
  closeBtn: HTMLElement;
  pickBtn: HTMLElement;
  searchBox: HTMLInputElement;
  hostBtn: HTMLElement;
  leftPane: HTMLElement;
  treePane: HTMLElement;
  detailPane: HTMLElement;
}

function buildShell(doc: Document, S: PanelStyles["S"]): Shell {
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
  panel.append(head, el(doc, "div", S.body, leftPane, detailPane));
  return {
    launch,
    panel,
    tabComponents,
    tabRender,
    tabProfiler,
    closeBtn,
    pickBtn,
    searchBox,
    hostBtn,
    leftPane,
    treePane,
    detailPane,
  };
}

function initialState(): PanelState {
  return {
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
}

/** Re-render the whole panel from the current state (the panes' own tiny update loop). */
function renderPanel(ctx: PanelCtx, shell: Shell): void {
  const { S, state, api, doc, treePane, detailPane } = ctx;
  shell.tabComponents.style.cssText = state.tab === "components" ? S.tabOn : S.tab;
  shell.tabRender.style.cssText = state.tab === "render" ? S.tabOn : S.tab;
  shell.tabProfiler.style.cssText = state.tab === "profiler" ? S.tabOn : S.tab;
  shell.leftPane.style.display = state.tab === "components" ? "" : "none";
  treePane.replaceChildren();
  detailPane.replaceChildren();
  if (state.tab === "render") return renderRenderModes(ctx);
  if (state.tab === "profiler") return renderProfilerTab(ctx);
  const tree = api.getInspectorTree();
  if (tree.length === 0) treePane.append(el(doc, "div", S.empty, "nothing mounted"));
  else renderTree(ctx, tree, 0, computeVisible(state.search, tree));
  renderDetail(ctx, tree);
}

/** Header tabs, toolbar buttons, the Ctrl+Shift+D shortcut, and open/close. */
function wireInteractions(
  ctx: PanelCtx,
  shell: Shell,
  picker: { start(): void; stop(): void },
  setOpen: (open: boolean) => void,
): void {
  const { S, state, doc } = ctx;
  const showTab = (tab: PanelState["tab"]) => () => {
    state.tab = tab;
    ctx.render();
  };
  shell.launch.addEventListener("click", () => setOpen(true));
  shell.closeBtn.addEventListener("click", () => setOpen(false));
  shell.tabComponents.addEventListener("click", showTab("components"));
  shell.tabRender.addEventListener("click", showTab("render"));
  shell.tabProfiler.addEventListener("click", showTab("profiler"));
  shell.pickBtn.addEventListener("click", () => (state.picking ? picker.stop() : picker.start()));
  shell.searchBox.addEventListener("input", () => {
    state.search = shell.searchBox.value.trim().toLowerCase();
    ctx.render();
    shell.searchBox.focus();
  });
  shell.hostBtn.addEventListener("click", () => {
    state.showHost = !state.showHost;
    shell.hostBtn.style.cssText = state.showHost ? S.iconOn : S.icon;
    ctx.render();
  });
  // Ctrl+Shift+D toggles the panel — chosen to avoid Chrome's Alt/Cmd bookmark
  // shortcuts (Cmd+D / Alt+D) on macOS.
  doc.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      setOpen(!state.open);
    }
  });
}

/** Re-render while open, coalesced to a frame: on every commit, and on streamed-hole reveals. */
function wireLiveUpdates(ctx: PanelCtx): void {
  const { api, state } = ctx;
  let queued = false;
  const queueRender = (): void => {
    if (!state.open || queued) return;
    queued = true;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16);
    raf(() => {
      queued = false;
      if (state.open) ctx.render();
    });
  };
  api.subscribe(queueRender);
  // A reveal doesn't cause a commit, so the commit subscription wouldn't catch it.
  api.subscribeBoundaries(() => {
    if (state.tab === "render") queueRender();
  });
}

function mount(api: DenextDevtoolsApi, doc: Document): void {
  const { S, S_BADGE } = buildStyles();
  const state = initialState();
  const shell = buildShell(doc, S);
  const hl = createHighlighter(doc, S);
  const ctx: PanelCtx = {
    doc,
    api,
    S,
    S_BADGE,
    state,
    treePane: shell.treePane,
    detailPane: shell.detailPane,
    render: () => renderPanel(ctx, shell),
    selectNode: (id) => {
      if (state.selected !== id) state.expanded.clear();
      state.selected = id;
      ctx.render();
    },
    highlight: hl.highlight,
    hideHighlight: hl.hideHighlight,
  };
  const picker = createPicker(doc, api, S, state, shell.pickBtn, hl, ctx.selectNode);
  const setOpen = (open: boolean): void => {
    state.open = open;
    shell.panel.style.display = open ? "flex" : "none";
    shell.launch.style.display = open ? "none" : "";
    if (open) {
      api.enableRenderReasons(); // start accruing "why did this render" while inspecting
      ctx.render();
    } else {
      picker.stop();
      hl.hideHighlight();
      api.disableRenderReasons();
    }
  };
  wireInteractions(ctx, shell, picker, setOpen);
  wireLiveUpdates(ctx);
  const attach = () =>
    (doc.body ?? doc.documentElement).append(shell.launch, shell.panel, hl.overlay, hl.tip);
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
  if (installed || !devtoolsAvailable()) return;
  const api = installInspector();
  if (!api) return;
  installed = true;
  mount(api, document);
  announceReady();
}

/** Dev only, and only where there is a document to mount into. */
function devtoolsAvailable(): boolean {
  return isDev() && typeof document !== "undefined";
}

function announceReady(): void {
  if (typeof console === "undefined") return;
  console.info(
    "%c[denext] devtools ready",
    "color:#8aa2ff;font-weight:bold",
    "— launcher at bottom-left, or Ctrl+Shift+D",
  );
}
