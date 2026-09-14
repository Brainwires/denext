// DevTools panel: the page highlight overlay + tooltip, and the element picker that
// resolves a hovered/clicked DOM node back to its component.

import type { DenextDevtoolsApi } from "../devtools-inspect.ts";
import { findNode, type PanelState } from "./ctx.ts";
import { el, type PanelStyles } from "./styles.ts";

export interface Highlighter {
  overlay: HTMLElement;
  tip: HTMLElement;
  highlight(node: Element | null, label?: string): void;
  hideHighlight(): void;
  /**
   * Briefly outline `node` in `color` — the highlight-updates flash (see
   * `./highlight.ts`). Reuses the one overlay element, so a new flash supersedes the
   * one in flight, and {@link Highlighter.hideHighlight} cancels a pending restore.
   *
   * @param node The host element to outline (a null node is ignored).
   * @param color The outline colour (the blue → yellow → red update ramp).
   * @param ms How long the outline stays up.
   */
  flash(node: Element | null, color: string, ms: number): void;
}

/** The highlight overlay + tooltip (for the picker and tree-row hover), on the page itself. */
export function createHighlighter(doc: Document, S: PanelStyles["S"]): Highlighter {
  const overlay = el(doc, "div", S.overlay);
  const tip = el(doc, "div", S.tip);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const clearFlash = (): void => {
    if (flashTimer === null) return;
    clearTimeout(flashTimer);
    flashTimer = null;
  };
  // Put the overlay back to its resting colours: a flash tints border+fill, and the
  // hover highlight only moves the box, so without this the next hover would keep the
  // flash's colour.
  const restoreColors = (): void => {
    overlay.style.background = S.overlayBg;
    overlay.style.borderColor = S.overlayBorder;
  };
  const hideHighlight = (): void => {
    clearFlash();
    restoreColors();
    overlay.style.display = "none";
    tip.style.display = "none";
  };
  const place = (node: Element): void => {
    const r = node.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.top = r.top + "px";
    overlay.style.left = r.left + "px";
    overlay.style.width = Math.max(0, r.width) + "px";
    overlay.style.height = Math.max(0, r.height) + "px";
  };
  const flash = (node: Element | null, color: string, ms: number): void => {
    if (!node || typeof node.getBoundingClientRect !== "function") return;
    clearFlash();
    place(node);
    overlay.style.background = "transparent";
    overlay.style.borderColor = color;
    tip.style.display = "none";
    flashTimer = setTimeout(() => {
      flashTimer = null;
      restoreColors();
      overlay.style.display = "none";
    }, ms);
  };
  const highlight = (node: Element | null, label?: string): void => {
    if (!node || typeof node.getBoundingClientRect !== "function") return hideHighlight();
    clearFlash();
    restoreColors();
    place(node);
    const r = node.getBoundingClientRect();
    if (!label) {
      tip.style.display = "none";
      return;
    }
    tip.replaceChildren(doc.createTextNode(label));
    tip.style.display = "block";
    tip.style.top = Math.max(0, r.top - 18) + "px";
    tip.style.left = r.left + "px";
  };
  return { overlay, tip, highlight, hideHighlight, flash };
}

export interface Picker {
  start(): void;
  stop(): void;
}

/** The element picker: pointer over the page highlights the owning component, click selects it. */
export function createPicker(
  doc: Document,
  api: DenextDevtoolsApi,
  S: PanelStyles["S"],
  state: PanelState,
  pickBtn: HTMLElement,
  hl: Highlighter,
  selectNode: (id: number) => void,
): Picker {
  const nameForId = (id: number): string => findNode(api.getInspectorTree(), id)?.name ?? "?";
  const targetId = (e: Event) =>
    api.getFiberIdForDom((e as { target?: Node | null }).target ?? null);
  const onPickMove = (e: Event): void => {
    const id = targetId(e);
    if (id == null) return hl.hideHighlight();
    hl.highlight(api.getHostNode(id), nameForId(id));
  };
  const onPickClick = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    const id = targetId(e);
    stop();
    if (id != null) selectNode(id);
  };
  const onPickKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") stop();
  };
  const start = (): void => {
    if (state.picking) return;
    state.picking = true;
    pickBtn.style.cssText = S.iconOn;
    doc.addEventListener("pointermove", onPickMove, true);
    doc.addEventListener("click", onPickClick, true);
    doc.addEventListener("keydown", onPickKey, true);
  };
  function stop(): void {
    if (!state.picking) return;
    state.picking = false;
    pickBtn.style.cssText = S.icon;
    doc.removeEventListener("pointermove", onPickMove, true);
    doc.removeEventListener("click", onPickClick, true);
    doc.removeEventListener("keydown", onPickKey, true);
    hl.hideHighlight();
  }
  return { start, stop };
}
