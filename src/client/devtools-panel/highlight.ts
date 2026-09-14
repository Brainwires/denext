// DevTools panel: highlight-updates (B9) — flash every component that re-rendered, on the
// page itself, as React DevTools' "Highlight updates when components render" does.
//
// It reads the inspector's render-reason counter rather than hooking the reconciler: the
// panel already turns render reasons on while it is open, so a per-commit walk comparing
// each node's `count` to the previous commit's is enough to know who actually re-rendered
// — and costs nothing when the toggle is off.

import type { DenextDevtoolsApi, InspectNode } from "../devtools-inspect.ts";
import type { Highlighter } from "./picker.ts";

/** How long one update flash stays on screen. */
const FLASH_MS = 350;

/**
 * The flash colour ramp by consecutive-update streak: a component that renders once is
 * calm blue, one that keeps re-rendering commit after commit goes yellow then red.
 */
const FLASH_COLORS = ["#5b8cff", "#8aa2ff", "#f0d45b", "#ffb35c", "#ff5c5c"];

/** The ramp colour for a streak of `n` consecutive updating commits (1-based). */
function flashColor(n: number): string {
  const i = Math.min(Math.max(n, 1), FLASH_COLORS.length) - 1;
  return FLASH_COLORS[i];
}

/** The highlight-updates toggle's handle. */
export interface HighlightUpdates {
  /**
   * Turn flashing on or off. Turning it off clears the remembered per-component render
   * counts, so re-enabling it re-baselines instead of flashing the whole tree at once.
   */
  setEnabled(on: boolean): void;
}

/**
 * Install the per-commit update flash against a mounted inspector + highlighter.
 *
 * Subscribes to commits immediately but does nothing until {@link
 * HighlightUpdates.setEnabled} turns it on.
 *
 * @param api The inspector API the panel is mounted against.
 * @param hl The panel's page highlighter (its overlay draws the flash).
 * @returns The toggle handle.
 */
export function installHighlightUpdates(
  api: DenextDevtoolsApi,
  hl: Highlighter,
): HighlightUpdates {
  /** Each component's render count as of the previous commit. */
  const counts = new Map<number, number>();
  /** How many consecutive commits each component has updated in (the colour ramp). */
  const streaks = new Map<number, number>();
  let enabled = false;

  const visit = (node: InspectNode, seen: Set<number>): void => {
    seen.add(node.id);
    const count = api.getRenderReason(node.id)?.count ?? 0;
    const prev = counts.get(node.id);
    counts.set(node.id, count);
    if (prev === undefined) return; // first sighting — baseline only, never a flash
    if (count <= prev) {
      streaks.delete(node.id);
      return;
    }
    const streak = (streaks.get(node.id) ?? 0) + 1;
    streaks.set(node.id, streak);
    hl.flash(api.getHostNode(node.id), flashColor(streak), FLASH_MS);
  };

  const walk = (nodes: InspectNode[], seen: Set<number>): void => {
    for (const node of nodes) {
      visit(node, seen);
      walk(node.children, seen);
    }
  };

  const onCommit = (): void => {
    if (!enabled) return;
    const seen = new Set<number>();
    walk(api.getInspectorTree(), seen);
    for (const id of [...counts.keys()]) {
      if (seen.has(id)) continue; // unmounted — forget it so a remount re-baselines
      counts.delete(id);
      streaks.delete(id);
    }
  };

  api.subscribe(onCommit);
  return {
    setEnabled(on: boolean): void {
      enabled = on;
      if (on) onCommit(); // baseline the current tree without flashing it
      else {
        counts.clear();
        streaks.clear();
      }
    },
  };
}
