// When a geometry check cannot pass because the window manager, not the app, decides the window's
// size: the pure decision behind `checks.ts`'s `unlessTiled` (no window calls here, so it is
// unit-tested in tests/desktop-kitchen-sink.test.ts).

/** A rectangle as `getWindowState()` / `getScreens()` report it. */
export interface Box {
  readonly width: number;
  readonly height: number;
}

/** The parts of `getWindowState()` the decision reads. */
export interface GeometryState {
  readonly maximized: boolean;
  readonly fullscreen: boolean;
  readonly bounds?: Box | null;
  readonly contentBounds?: Box | null;
}

/** The parts of a screen the decision reads. */
export interface GeometryScreen {
  readonly bounds: Box;
  readonly workArea: Box;
}

/** What the check learnt by asking the window manager (see `compositorOwnsGeometry`). */
export interface GeometryProbe {
  /**
   * The window read maximized, `unmaximizeWindow()` was asked, and it still reads maximized: a
   * tiling window manager (i3) reports its tiled windows as maximized and ignores the request.
   */
  readonly unmaximizeIgnored?: boolean;
}

/**
 * Why the compositor owns this window's geometry (a tiling window manager), or `null` when the
 * window's state says nothing of the kind and a failed geometry check is a real failure. A tiled
 * window fills its screen's work area (90% in both dimensions: it loses only the gaps and the bar)
 * and either reads unmaximized (Sway) or reads maximized and ignores an unmaximize (i3).
 *
 * @param asked What the check asked for (`900x700`, `maximized`), for the reason.
 * @param state The window's state after the failed check.
 * @param screen The window's screen.
 * @param probe What asking the window manager showed.
 */
export function tiledReason(
  asked: string,
  state: GeometryState,
  screen: GeometryScreen,
  probe: GeometryProbe = {},
): string | null {
  const frame = state.bounds ?? state.contentBounds;
  if (!frame || state.fullscreen) return null;
  if (state.maximized && probe.unmaximizeIgnored !== true) return null;
  const fills = (r: Box) => frame.width >= r.width * 0.9 && frame.height >= r.height * 0.9;
  if (!fills(screen.workArea) && !fills(screen.bounds)) return null;
  const how = state.maximized ? "reads maximized and ignores unmaximize" : "stays unmaximized";
  return `the compositor controls this window's geometry (a tiling window manager): asked ` +
    `${asked}, the window ${how}, ${frame.width}x${frame.height}, filling the ` +
    `${screen.workArea.width}x${screen.workArea.height} work area`;
}
