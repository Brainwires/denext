/**
 * A tray icon's mouse events as denext hands them on: the event names (the DOM's), the detail of
 * the runtime's `TrayMouseEvent` (which button, the modifier keys, where the cursor was, whether it
 * was a double click) and what the runtime's `Deno.Tray.capabilities()` says this OS delivers.
 *
 * Deno Desktop runtime `3.0.0-denext.6` (`FIRST_OVERLAY_TRAY_RUNTIME`) fires every button's click
 * as a `"click"` whose `button` says which, a right click also as `"contextmenu"`, a middle click as
 * `"auxclick"`, a double click also as `"dblclick"`, and hover as `"mouseenter"` / `"mouseleave"`
 * (macOS, Windows). denext's `click` is the primary button's, as in the DOM: a right click reaches
 * `contextmenu` handlers, a middle click `auxclick` ones. An older runtime fires plain `click` /
 * `dblclick` events with no detail (the primary button).
 *
 * Pure and client-safe: the runtime side (`caps/app.ts`, `backend-tray.ts`) and the page side
 * (`denext/desktop/app`) share it.
 *
 * @module
 */

/** A tray icon event, by its DOM name. */
export type TrayEventType =
  | "click"
  | "dblclick"
  | "contextmenu"
  | "auxclick"
  | "mouseenter"
  | "mouseleave";

/** Every tray event type, in the order the runtime documents them. */
export const TRAY_EVENT_TYPES: readonly TrayEventType[] = [
  "click",
  "dblclick",
  "contextmenu",
  "auxclick",
  "mouseenter",
  "mouseleave",
];

/** The modifier keys held during a tray event. */
export interface TrayModifiers {
  /** Shift. */
  readonly shift: boolean;
  /** Control. */
  readonly ctrl: boolean;
  /** Option / Alt. */
  readonly alt: boolean;
  /** Command (macOS) / the Windows key. */
  readonly meta: boolean;
}

/** What a tray mouse event carries (the runtime's `TrayMouseEvent`, runtime `3.0.0-denext.6`+). */
export interface TrayMouseDetail {
  /** The button. */
  readonly button: "left" | "right" | "middle";
  /** The modifier keys held. */
  readonly modifiers: TrayModifiers;
  /** The cursor's screen x, or `null` where the OS doesn't say (some Linux tray hosts). */
  readonly x: number | null;
  /** The cursor's screen y, or `null`. */
  readonly y: number | null;
  /** The second click of a double click. */
  readonly double: boolean;
}

/** What the tray delivers on this OS and session (`Deno.Tray.capabilities()`). */
export interface TrayCapabilities {
  /** `click` fires. */
  readonly click: boolean;
  /** `dblclick` fires. */
  readonly doubleClick: boolean;
  /** `contextmenu` fires on a right click. */
  readonly rightClick: boolean;
  /** `auxclick` fires on a middle click. */
  readonly middleClick: boolean;
  /** `mouseenter` / `mouseleave` fire (macOS, Windows). */
  readonly hover: boolean;
  /** The detail's `modifiers` are filled in. */
  readonly modifiers: boolean;
  /** The detail's `x` / `y` are filled in. */
  readonly position: boolean;
  /** `popUpMenu()` opens the tray's menu (not on Linux, where the tray host opens it). */
  readonly popUpMenu: boolean;
}

const BUTTONS = new Set(["left", "right", "middle"]);

/** A finite number, else `null`. */
function coord(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The modifiers of a runtime event: its `modifiers` object, else the DOM-style `*Key` flags. */
function modifiersOf(e: Record<string, unknown>): TrayModifiers {
  const m = typeof e.modifiers === "object" && e.modifiers !== null
    ? e.modifiers as Record<string, unknown>
    : {};
  const flag = (key: string, dom: string) => m[key] === true || e[dom] === true;
  return {
    shift: flag("shift", "shiftKey"),
    ctrl: flag("ctrl", "ctrlKey"),
    alt: flag("alt", "altKey"),
    meta: flag("meta", "metaKey"),
  };
}

/**
 * The detail of a runtime tray event, or `null` when it has none (a runtime before
 * `3.0.0-denext.6`, whose events carry no `button`).
 *
 * @param event The event the runtime's `Deno.Tray` dispatched.
 * @returns The detail, or `null`.
 */
export function trayMouseDetail(event: Event): TrayMouseDetail | null {
  const e = event as unknown as Record<string, unknown>;
  if (typeof e.button !== "string" || !BUTTONS.has(e.button)) return null;
  return {
    button: e.button as TrayMouseDetail["button"],
    modifiers: modifiersOf(e),
    x: coord(e.x ?? e.screenX),
    y: coord(e.y ?? e.screenY),
    double: e.double === true,
  };
}

/**
 * Whether a runtime `click` is denext's `click`: the primary button's (a runtime with no detail
 * only reports primary clicks).
 *
 * @param detail The event's detail, or `null`.
 * @returns Whether `click` handlers hear it.
 */
export function isPrimaryClick(detail: TrayMouseDetail | null): boolean {
  return detail === null || detail.button === "left";
}

/**
 * A wire / page detail checked back into a {@linkcode TrayMouseDetail} (or `null`).
 *
 * @param value The detail as it came over the bridge.
 * @returns The detail, or `null` when it is not one.
 */
export function parseTrayMouseDetail(value: unknown): TrayMouseDetail | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.button !== "string" || !BUTTONS.has(v.button)) return null;
  const m = typeof v.modifiers === "object" && v.modifiers !== null
    ? v.modifiers as Record<string, unknown>
    : {};
  return {
    button: v.button as TrayMouseDetail["button"],
    modifiers: {
      shift: m.shift === true,
      ctrl: m.ctrl === true,
      alt: m.alt === true,
      meta: m.meta === true,
    },
    x: coord(v.x),
    y: coord(v.y),
    double: v.double === true,
  };
}

/**
 * What the tray delivers here: the runtime's `Deno.Tray.capabilities()` when it has one, else
 * what a runtime before `3.0.0-denext.6` delivers (clicks and double clicks wherever a tray icon can
 * be shown, nothing else).
 *
 * @param Tray The runtime's `Deno.Tray` (or `undefined`).
 * @param available Whether a tray icon can be shown here.
 * @returns The capabilities.
 */
export function trayCapabilitiesOf(Tray: unknown, available: boolean): TrayCapabilities {
  const probe = (Tray as { capabilities?: () => unknown } | undefined)?.capabilities;
  let raw: Record<string, unknown> | undefined;
  if (typeof probe === "function") {
    try {
      const out = probe.call(Tray);
      raw = typeof out === "object" && out !== null ? out as Record<string, unknown> : undefined;
    } catch {
      raw = undefined;
    }
  }
  const flag = (key: keyof TrayCapabilities, fallback: boolean) =>
    available && (raw ? raw[key] === true : fallback);
  return {
    click: flag("click", true),
    doubleClick: flag("doubleClick", true),
    rightClick: flag("rightClick", false),
    middleClick: flag("middleClick", false),
    hover: flag("hover", false),
    modifiers: flag("modifiers", false),
    position: flag("position", false),
    popUpMenu: flag("popUpMenu", false),
  };
}
