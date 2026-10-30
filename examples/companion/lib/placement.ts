// Where Loopy's window goes: the bottom-right corner of the primary display's work area (the
// display minus the menu bar, Dock, taskbar and panels). Pure, so it is unit-tested.

/** Loopy's window size (kept equal to `desktop.window` in denext.config.ts). */
export const WINDOW_SIZE = { width: 260, height: 300 } as const;

/** The gap between the window and the work area's edges. */
const CORNER_MARGIN = 16;

/** A rectangle in screen coordinates. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A display as `getScreens()` reports it (the fields used here). */
export interface ScreenLike {
  readonly workArea: Rect;
  readonly isPrimary: boolean;
}

/**
 * The top-left corner that puts a `size` window in the bottom-right of `workArea`, `margin` in
 * from its edges — clamped so a work area smaller than the window still shows its top-left.
 */
export function cornerPosition(
  workArea: Rect,
  size: { readonly width: number; readonly height: number },
  margin: number = CORNER_MARGIN,
): { x: number; y: number } {
  return {
    x: Math.round(Math.max(workArea.x, workArea.x + workArea.width - size.width - margin)),
    y: Math.round(Math.max(workArea.y, workArea.y + workArea.height - size.height - margin)),
  };
}

/** The primary display (the first one when none says so), or `undefined` with none. */
export function primaryScreen<S extends ScreenLike>(screens: readonly S[]): S | undefined {
  return screens.find((s) => s.isPrimary) ?? screens[0];
}
