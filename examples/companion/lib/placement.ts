// Where Loopy's window goes: the bottom-right corner of the primary display's work area (the
// display minus the menu bar, Dock, taskbar and panels). Pure, so it is unit-tested.
//
// Linux Wayland: only a layer-shell overlay window can be placed there (KDE Plasma, wlroots;
// `setPosition` in the window capabilities), and its position is the layer surface's margins:
// an offset from the top-left of its display's area outside the panels. GDK reports the whole
// display as the work area, so the corner is kept clear of a panel the session can't report
// (WAYLAND_PANEL_INSET), until the runtime anchors a layer surface to the edges nearest its
// position (`layerShellEdgeAnchor`), where the compositor keeps it clear of the panels itself.

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
  readonly bounds: Rect;
  readonly workArea: Rect;
  readonly isPrimary: boolean;
}

/**
 * How far in from the display's edges the corner stays on Wayland when the work area is the whole
 * display: clear of a panel of up to this size (KDE Plasma's default is 44 px plus a gap).
 */
export const WAYLAND_PANEL_INSET = 64;

/** What the window capabilities say about placing on this session (the keys read here). */
export interface PlacementSession {
  /** Linux Wayland (`sessionType === "wayland"`). */
  readonly wayland: boolean;
  /** The runtime anchors a layer surface to the edges nearest its position. */
  readonly edgeAnchored: boolean;
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

/** Whether two rectangles are the same. */
function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** `rect` with `by` taken off each edge (never below zero size). */
function shrink(rect: Rect, by: number): Rect {
  return {
    x: rect.x + by,
    y: rect.y + by,
    width: Math.max(0, rect.width - 2 * by),
    height: Math.max(0, rect.height - 2 * by),
  };
}

/**
 * Where the window goes on `screen`: the bottom-right corner of its work area. On Wayland (a
 * layer-shell overlay, the only window placed there) the work area is shrunk by
 * {@linkcode WAYLAND_PANEL_INSET} when the session reported none (it equals the display), and the
 * position is made relative to the display's top-left (the layer surface's margins) — both unless
 * the runtime anchors to the nearest edges, which takes screen coordinates and avoids the panels
 * itself.
 */
export function cornerOnScreen(
  screen: ScreenLike,
  size: { readonly width: number; readonly height: number },
  session: PlacementSession,
): { x: number; y: number } {
  if (!session.wayland || session.edgeAnchored) return cornerPosition(screen.workArea, size);
  const origin = screen.bounds;
  const reported = !sameRect(screen.workArea, origin);
  const corner = cornerPosition(
    reported ? screen.workArea : shrink(origin, WAYLAND_PANEL_INSET),
    size,
  );
  return { x: corner.x - origin.x, y: corner.y - origin.y };
}
