/**
 * The clicks of the desktop runtime's `app` capability (application menu, Dock menu, tray icons
 * and their menus), shared by `denext/desktop/app` and `denext/mobile`'s `onQuickAction`: one
 * subscription to the runtime's queue for the whole page.
 *
 * Client-only: web APIs, nothing runs at import beyond creating the subscriber.
 *
 * @module
 */

import { pullQueue } from "./pull.ts";
import { parseTrayMouseDetail, type TrayMouseDetail } from "./tray-events.ts";

/**
 * A tray event as the runtime queues it: `click` / `doubleClick`, and the DOM names of the events
 * runtime 3.0.0-denext.6 added.
 */
export type TrayActionEvent =
  | "click"
  | "doubleClick"
  | "contextmenu"
  | "auxclick"
  | "mouseenter"
  | "mouseleave";

const TRAY_EVENTS = new Set<string>([
  "click",
  "doubleClick",
  "contextmenu",
  "auxclick",
  "mouseenter",
  "mouseleave",
]);

/** The key window a menu click reports (`null` with no app window open). */
export type AppMenuKeyWindow = { readonly id: string; readonly key?: string } | null;

/** What an application-menu click carries besides the item's id. */
export interface AppMenuClickInfo {
  /** The page's own item (`setAppMenu`), a custom menu's (`setMenu`), or a window's own Window-menu item. */
  readonly kind: "appMenu" | "menu" | "windowMenu";
  /** The key window when the item was chosen. */
  readonly keyWindow: AppMenuKeyWindow;
  /** A custom item's top-level menu id. */
  readonly menu?: string;
  /** A checkbox's or radio item's state after the click. */
  readonly checked?: boolean;
  /** The window a Window-menu item belongs to. */
  readonly windowId?: string;
}

/** One click, as the runtime queues it. */
export type AppActionEvent =
  | ({ readonly source: "menu"; readonly id: string } & AppMenuClickInfo)
  | { readonly source: "dock"; readonly id: string }
  | {
    readonly source: "tray";
    readonly tray: string;
    readonly event: TrayActionEvent;
    /** The runtime's detail (runtime 3.0.0-denext.6+), else `null`. */
    readonly detail: TrayMouseDetail | null;
  }
  | { readonly source: "trayMenu"; readonly tray: string; readonly id: string }
  | { readonly source: "dockReopen"; readonly hasVisibleWindows: boolean };

/** A queued tray event, checked. */
function parseTray(a: Record<string, unknown>, tray: string): AppActionEvent {
  return {
    source: "tray",
    tray,
    event: TRAY_EVENTS.has(a.event as string) ? a.event as TrayActionEvent : "click",
    detail: parseTrayMouseDetail(a.detail),
  };
}

/** One queued click, checked. */
function parse(raw: unknown): AppActionEvent | undefined {
  const a = (raw ?? {}) as Record<string, unknown>;
  const id = typeof a.id === "string" ? a.id : undefined;
  const tray = typeof a.tray === "string" ? a.tray : undefined;
  switch (a.source) {
    case "menu":
      return id === undefined ? undefined : { source: "menu", id, ...menuClickInfo(a) };
    case "dock":
      return id === undefined ? undefined : { source: "dock", id };
    case "tray":
      return tray === undefined ? undefined : parseTray(a, tray);
    case "trayMenu":
      return tray === undefined || id === undefined ? undefined : { source: "trayMenu", tray, id };
    case "dockReopen":
      return { source: "dockReopen", hasVisibleWindows: a.hasVisibleWindows === true };
    default:
      return undefined;
  }
}

/** The context of a menu click, checked (an older runtime's click: a page item, no key window). */
function menuClickInfo(a: Record<string, unknown>): AppMenuClickInfo {
  const kind = a.kind === "menu" || a.kind === "windowMenu" ? a.kind : "appMenu";
  const k = a.keyWindow as Record<string, unknown> | null | undefined;
  const keyWindow = k && typeof k.id === "string"
    ? { id: k.id, ...(typeof k.key === "string" ? { key: k.key } : {}) }
    : null;
  return {
    kind,
    keyWindow,
    ...(typeof a.menu === "string" ? { menu: a.menu } : {}),
    ...(typeof a.checked === "boolean" ? { checked: a.checked } : {}),
    ...(typeof a.windowId === "string" ? { windowId: a.windowId } : {}),
  };
}

/** Call `listener` with each click of the app's menus and tray icons. Returns the unsubscribe. */
export const onAppAction: (listener: (action: AppActionEvent) => void) => () => void = pullQueue(
  "app",
  "action",
  parse,
);
