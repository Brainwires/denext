/**
 * The backend-owned tray of `denext.config.ts` (`desktop.tray`): its validation (shared by the
 * config validator and `resolveDesktopCapabilities`, which fails fast at launch since the desktop
 * entry imports the config's JSON slice unvalidated), and where its panel goes next to the icon.
 *
 * Runtime-only (imported by the caps resolver, `runDesktop` and the config validator; never a
 * client bundle).
 *
 * @module
 */

/** The panel at the tray icon, resolved (`desktop.tray.panel`). */
export interface DesktopTrayPanelSettings {
  /** The page it shows: a path of the app. */
  readonly url: string;
  /** Width in CSS pixels. */
  readonly width: number;
  /** Height in CSS pixels. */
  readonly height: number;
  /** Hide it when it loses focus. */
  readonly hideOnBlur: boolean;
}

/** The backend-owned tray, resolved (`desktop.tray`). */
export interface DesktopTraySettings {
  /** The icon: a PNG path in the export (`"/tray.png"`). */
  readonly icon: string;
  /** The dark-mode icon (a path in the export). */
  readonly iconDark?: string;
  /** The tooltip. */
  readonly tooltip?: string;
  /** The menu, as `denext/desktop/app` menus are written (checked when it is set). */
  readonly menu?: readonly unknown[];
  /** The panel at the icon. */
  readonly panel?: DesktopTrayPanelSettings;
}

/** The panel's default size. */
export const DEFAULT_PANEL_SIZE = { width: 360, height: 480 } as const;
/** The gap between the tray icon and its panel. */
const PANEL_GAP = 6;
/** The longest app path accepted. */
const MAX_PATH = 2048;
/** The longest tooltip accepted. */
const MAX_TOOLTIP = 256;

/**
 * Whether `url` is a path of the app (`/panel`, `/vm?id=1`): absolute, not protocol-relative, with
 * no backslash or control character — never another origin.
 *
 * @param url The candidate.
 * @returns Whether it is an app path.
 */
export function isAppPath(url: unknown): url is string {
  if (typeof url !== "string" || url.length > MAX_PATH) return false;
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return false; // a control character or `\`
  }
  return true;
}

/** A size key (≥ 1, ≤ 10000), or a problem. */
function sizeProblem(value: unknown, key: string): [string, string] | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 10000) {
    return [key, "must be a number of pixels from 1 to 10000"];
  }
  return null;
}

/** The first problem with `desktop.tray.panel`, or `null`. */
function panelProblem(panel: unknown): [string, string] | null {
  if (panel === undefined) return null;
  if (typeof panel !== "object" || panel === null || Array.isArray(panel)) {
    return ["tray.panel", "must be { url, width?, height?, hideOnBlur? }"];
  }
  const p = panel as Record<string, unknown>;
  if (!isAppPath(p.url)) return ["tray.panel.url", 'must be a path of the app, like "/panel"'];
  if (p.hideOnBlur !== undefined && typeof p.hideOnBlur !== "boolean") {
    return ["tray.panel.hideOnBlur", "must be a boolean"];
  }
  return sizeProblem(p.width, "tray.panel.width") ?? sizeProblem(p.height, "tray.panel.height");
}

/**
 * The first problem with a `desktop.tray` value as `[key, message]` (the key relative to
 * `desktop.`), or `null` when it is valid.
 *
 * @param tray The `desktop.tray` value.
 * @returns The problem, or `null`.
 */
export function desktopTrayProblem(tray: unknown): [string, string] | null {
  if (typeof tray !== "object" || tray === null || Array.isArray(tray)) {
    return ["tray", "must be { icon, iconDark?, tooltip?, menu?, panel? }"];
  }
  const t = tray as Record<string, unknown>;
  if (!isAppPath(t.icon)) {
    return ["tray.icon", 'must be a PNG path in the export, like "/tray.png"'];
  }
  if (t.iconDark !== undefined && !isAppPath(t.iconDark)) {
    return ["tray.iconDark", "must be a PNG path in the export"];
  }
  if (
    t.tooltip !== undefined && (typeof t.tooltip !== "string" || t.tooltip.length > MAX_TOOLTIP)
  ) {
    return ["tray.tooltip", `must be a string up to ${MAX_TOOLTIP} characters`];
  }
  if (t.menu !== undefined && !Array.isArray(t.menu)) {
    return ["tray.menu", "must be an array of menu items"];
  }
  return panelProblem(t.panel);
}

/**
 * Resolve `desktop.tray`, throwing on an invalid value.
 *
 * @param desktop The config's `desktop` block (or `undefined`).
 * @returns The tray, or `undefined` when none is configured.
 */
export function resolveDesktopTraySettings(desktop: unknown): DesktopTraySettings | undefined {
  const tray = (desktop as { tray?: unknown } | null | undefined)?.tray;
  if (tray === undefined) return undefined;
  const problem = desktopTrayProblem(tray);
  if (problem) throw new Error(`desktop: invalid desktop.${problem[0]}: ${problem[1]}`);
  const t = tray as {
    icon: string;
    iconDark?: string;
    tooltip?: string;
    menu?: unknown[];
    panel?: { url: string; width?: number; height?: number; hideOnBlur?: boolean };
  };
  const p = t.panel;
  return {
    icon: t.icon,
    ...(t.iconDark !== undefined ? { iconDark: t.iconDark } : {}),
    ...(t.tooltip !== undefined ? { tooltip: t.tooltip } : {}),
    ...(t.menu !== undefined ? { menu: t.menu } : {}),
    ...(p
      ? {
        panel: {
          url: p.url,
          width: Math.round(p.width ?? DEFAULT_PANEL_SIZE.width),
          height: Math.round(p.height ?? DEFAULT_PANEL_SIZE.height),
          hideOnBlur: p.hideOnBlur !== false,
        },
      }
      : {}),
  };
}

/** A rectangle in screen coordinates. */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A display as far as panel placement needs it. */
export interface PlacementScreen {
  /** The whole display. */
  readonly bounds: ScreenRect;
  /** The display minus the menu bar, Dock, taskbar and panels. */
  readonly workArea: ScreenRect;
}

/** The display whose bounds contain the point, else the first. */
function screenAt(
  screens: readonly PlacementScreen[],
  x: number,
  y: number,
): PlacementScreen | undefined {
  return screens.find((s) =>
    x >= s.bounds.x && x < s.bounds.x + s.bounds.width && y >= s.bounds.y &&
    y < s.bounds.y + s.bounds.height
  ) ?? screens[0];
}

/**
 * Where a tray panel's top-left corner goes: centred on the icon, under it when the icon is in
 * the top half of its display (macOS' menu bar, most Linux panels) and above it otherwise (a
 * bottom taskbar), moved left / right / up / down to stay inside the display's work area. With no
 * display known it goes under the icon (the runtime's own default).
 *
 * @param icon The tray icon's bounds.
 * @param size The panel's size.
 * @param screens The displays (`Deno.desktop.screens()`), possibly empty.
 * @returns The panel's position.
 */
export function placeTrayPanel(
  icon: ScreenRect,
  size: { readonly width: number; readonly height: number },
  screens: readonly PlacementScreen[],
): { x: number; y: number } {
  const cx = icon.x + icon.width / 2;
  const cy = icon.y + icon.height / 2;
  const screen = screenAt(screens, cx, cy);
  const x = cx - size.width / 2;
  if (!screen) return { x: Math.round(x), y: Math.round(icon.y + icon.height) };
  const area = screen.workArea;
  const top = cy < screen.bounds.y + screen.bounds.height / 2;
  const y = top ? icon.y + icon.height + PANEL_GAP : icon.y - size.height - PANEL_GAP;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi)));
  return {
    x: clamp(x, area.x, area.x + area.width - size.width),
    y: clamp(y, area.y, area.y + area.height - size.height),
  };
}

/**
 * How far in from a display's edges a tray panel stays on Linux Wayland when the display's work
 * area is unknown: GDK reports the whole display as the work area there, so a panel placed at a
 * click in a bottom taskbar would reach into it (KDE Plasma's default panel is 44 px, plus its
 * floating gap). Kept clear of a panel of up to this size on any edge.
 */
export const WAYLAND_PANEL_INSET = 64;

/** Whether the work area is the whole display (nothing known about the panels on it). */
function wholeDisplay(screen: PlacementScreen): boolean {
  const b = screen.bounds;
  const a = screen.workArea;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The displays a tray panel is placed in. Where `guessPanels` (Linux Wayland, unless the runtime
 * anchors a layer surface to the edge nearest its position, `layerShellEdgeAnchor`) a display
 * whose work area is the whole display gets {@linkcode WAYLAND_PANEL_INSET} taken off each edge
 * (at most a quarter of its size), so the panel keeps clear of a taskbar the session can't report.
 * A work area the session does report is kept as it is.
 *
 * @param screens The displays (`Deno.desktop.screens()`).
 * @param guessPanels Whether to keep clear of panels the session can't report.
 * @returns The displays to place in.
 */
export function panelPlacementScreens(
  screens: readonly PlacementScreen[],
  guessPanels: boolean,
): PlacementScreen[] {
  if (!guessPanels) return [...screens];
  return screens.map((s) => {
    if (!wholeDisplay(s)) return s;
    const b = s.bounds;
    const dx = Math.min(WAYLAND_PANEL_INSET, Math.floor(b.width / 4));
    const dy = Math.min(WAYLAND_PANEL_INSET, Math.floor(b.height / 4));
    return {
      ...s,
      workArea: { x: b.x + dx, y: b.y + dy, width: b.width - 2 * dx, height: b.height - 2 * dy },
    };
  });
}
