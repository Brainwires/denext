// DevTools panel: the header's full-screen / half-screen toggle. The choice is remembered
// per tab in localStorage (best-effort: a private window or blocked storage just forgets).

import type { PanelCtx, TabId } from "./ctx.ts";
import type { Shell } from "./shell.ts";

/** The panel's two sizes: docked at half the viewport's height, or the whole viewport. */
type PanelSize = "half" | "full";

/** The localStorage key holding `{ [tab]: size }`. */
const SIZE_STORAGE_KEY = "denext:devtools:size";

type SizeMap = Partial<Record<TabId, PanelSize>>;

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** The remembered sizes (an empty map when storage is unavailable or holds junk). */
function readSizes(): SizeMap {
  try {
    const raw = storage()?.getItem(SIZE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed as SizeMap : {};
  } catch {
    return {};
  }
}

function writeSizes(sizes: SizeMap): void {
  try {
    storage()?.setItem(SIZE_STORAGE_KEY, JSON.stringify(sizes));
  } catch { /* storage blocked — the toggle still works for this page */ }
}

/** The size the given tab is shown at. */
function sizeFor(tab: TabId): PanelSize {
  return readSizes()[tab] === "full" ? "full" : "half";
}

/** Flip the active tab's size and remember it. */
export function toggleSize(ctx: PanelCtx): void {
  const sizes = readSizes();
  sizes[ctx.state.tab] = sizeFor(ctx.state.tab) === "full" ? "half" : "full";
  writeSizes(sizes);
  ctx.render();
}

/**
 * Restyle the panel frame for the active tab's size (keeping its open/closed display) and
 * label the toggle with what a tap will do.
 *
 * @param ctx The mounted panel context.
 * @param shell The panel's DOM shell.
 */
export function syncSize(ctx: PanelCtx, shell: Shell): void {
  const { S, state } = ctx;
  const full = sizeFor(state.tab) === "full";
  shell.panel.style.cssText = `${S.panel};${full ? S.panelFull : S.panelHalf}`;
  shell.panel.style.display = state.open ? "flex" : "none";
  const label = full ? "Half screen" : "Full screen";
  shell.sizeBtn.textContent = full ? "⤡" : "⤢";
  shell.sizeBtn.title = label;
  shell.sizeBtn.setAttribute("aria-label", label);
}
