// DevTools panel: the DOM shell — launcher, header with a scrollable six-tab strip, the
// tree toolbar, and the two panes. Pure construction: nothing here reads panel state or
// binds behaviour (see `./render.ts` and `./interactions.ts`).

import { DINO_ICON } from "../devtools-dino.ts";
import type { TabId } from "./ctx.ts";
import { el, type PanelStyles } from "./styles.ts";

/** One entry in the panel's tab strip. */
export interface TabSpec {
  readonly id: TabId;
  readonly label: string;
}

/** The panel's tabs, in `Alt+1…6` / `Ctrl+Shift+[`,`]` order. */
export const TABS: readonly TabSpec[] = [
  { id: "components", label: "Components" },
  { id: "render", label: "Render modes" },
  { id: "profiler", label: "Profiler" },
  { id: "network", label: "Network" },
  { id: "cache", label: "Cache" },
  { id: "routes", label: "Routes" },
];

/**
 * Below this panel width the `denext · glass-box` title is dropped so the tab strip keeps
 * the whole header row (a 380 px phone-width panel otherwise shows two tabs).
 */
const TITLE_MIN_WIDTH = 420;

/** The panel's DOM shell: launcher, header tabs, toolbar, panes. */
export interface Shell {
  launch: HTMLElement;
  panel: HTMLElement;
  title: HTMLElement;
  tabStrip: HTMLElement;
  /** The tab buttons by id (the render dispatch marks the active one). */
  tabs: Record<TabId, HTMLElement>;
  closeBtn: HTMLElement;
  pickBtn: HTMLElement;
  searchBox: HTMLInputElement;
  hostBtn: HTMLElement;
  /** The ✨ highlight-updates toggle. */
  hlBtn: HTMLElement;
  leftPane: HTMLElement;
  treePane: HTMLElement;
  detailPane: HTMLElement;
}

/**
 * The tab strip: a horizontally scrollable `role="tablist"` of `role="tab"` buttons.
 *
 * @param doc The document to build in.
 * @param S The panel's inline-style table.
 * @param tabs The tabs to render, in order.
 * @returns The strip element and its buttons keyed by tab id.
 */
export function buildTabStrip(
  doc: Document,
  S: PanelStyles["S"],
  tabs: readonly TabSpec[],
): { strip: HTMLElement; buttons: Record<TabId, HTMLElement> } {
  const strip = el(doc, "div", S.tabStrip);
  strip.setAttribute("role", "tablist");
  const buttons = {} as Record<TabId, HTMLElement>;
  for (const [i, tab] of tabs.entries()) {
    const btn = el(doc, "button", S.tabItem, tab.label);
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.setAttribute("tabindex", "-1");
    btn.title = `${tab.label} (Alt+${i + 1})`;
    buttons[tab.id] = btn;
    strip.append(btn);
  }
  return { strip, buttons };
}

/** The fixed launcher button (the mascot head-shot) that opens the panel. */
function buildLauncher(doc: Document, S: PanelStyles["S"]): HTMLElement {
  const icon = el(doc, "img", S.launchImg);
  (icon as unknown as HTMLImageElement).src = DINO_ICON;
  (icon as unknown as HTMLImageElement).alt = "denext devtools";
  const launch = el(doc, "button", S.launch, icon);
  launch.title = "denext devtools (Ctrl+Shift+D)";
  launch.addEventListener("mouseenter", () => (launch.style.boxShadow = S.launchShadowHover));
  launch.addEventListener("mouseleave", () => (launch.style.boxShadow = S.launchShadow));
  return launch;
}

/** Tree toolbar: element picker, name filter, host-node toggle, highlight-updates toggle. */
function buildToolbar(doc: Document, S: PanelStyles["S"]): {
  toolbar: HTMLElement;
  pickBtn: HTMLElement;
  searchBox: HTMLInputElement;
  hostBtn: HTMLElement;
  hlBtn: HTMLElement;
} {
  const pickBtn = el(doc, "button", S.icon, "🎯");
  pickBtn.title = "Pick an element on the page";
  const searchBox = el(doc, "input", S.search) as HTMLInputElement;
  searchBox.type = "text";
  searchBox.placeholder = "filter…";
  const hostBtn = el(doc, "button", S.icon, "{ }");
  hostBtn.title = "Show host (DOM) nodes";
  const hlBtn = el(doc, "button", S.icon, "✨");
  hlBtn.title = "Flash components as they re-render";
  return {
    toolbar: el(doc, "div", S.toolbar, pickBtn, searchBox, hostBtn, hlBtn),
    pickBtn,
    searchBox,
    hostBtn,
    hlBtn,
  };
}

/**
 * Build the whole panel shell (detached — {@link Shell.launch} and {@link Shell.panel}
 * are appended to the document by the caller).
 *
 * @param doc The document to build in.
 * @param S The panel's inline-style table.
 * @returns Every element the render pass and the interaction wiring need.
 */
export function buildShell(doc: Document, S: PanelStyles["S"]): Shell {
  const panel = el(doc, "div", S.panel);
  panel.setAttribute("role", "complementary");
  panel.setAttribute("aria-label", "denext devtools");
  panel.style.display = "none";

  const title = el(doc, "b", S.title, "denext · glass-box");
  const { strip, buttons } = buildTabStrip(doc, S, TABS);
  const closeBtn = el(doc, "button", S.close, "×");
  closeBtn.title = "close";
  const head = el(doc, "div", S.head, title, strip, closeBtn);

  const { toolbar, pickBtn, searchBox, hostBtn, hlBtn } = buildToolbar(doc, S);
  const treePane = el(doc, "div", S.tree);
  const leftPane = el(doc, "div", S.left, toolbar, treePane);
  const detailPane = el(doc, "div", S.detail);
  panel.append(head, el(doc, "div", S.body, leftPane, detailPane));
  return {
    launch: buildLauncher(doc, S),
    panel,
    title,
    tabStrip: strip,
    tabs: buttons,
    closeBtn,
    pickBtn,
    searchBox,
    hostBtn,
    hlBtn,
    leftPane,
    treePane,
    detailPane,
  };
}

/**
 * Show or hide the header title for the panel's CURRENT width — recomputed on every
 * render rather than through a media query, because the panel is styled with inline
 * CSSOM only (the dev CSP forbids a runtime `<style>` sheet).
 *
 * @param shell The mounted shell.
 */
export function syncTitle(shell: Shell): void {
  const rect = typeof shell.panel.getBoundingClientRect === "function"
    ? shell.panel.getBoundingClientRect()
    : null;
  // Width 0 means "not laid out yet" (the panel is hidden, or a test DOM) — keep the title.
  const narrow = !!rect && rect.width > 0 && rect.width < TITLE_MIN_WIDTH;
  shell.title.style.display = narrow ? "none" : "";
}
