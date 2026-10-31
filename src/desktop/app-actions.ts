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

/** One click, as the runtime queues it. */
export type AppActionEvent =
  | { readonly source: "menu" | "dock"; readonly id: string }
  | {
    readonly source: "tray";
    readonly tray: string;
    readonly event: TrayActionEvent;
    /** The runtime's detail (runtime 3.0.0-denext.6+), else `null`. */
    readonly detail: TrayMouseDetail | null;
  }
  | { readonly source: "trayMenu"; readonly tray: string; readonly id: string }
  | { readonly source: "dockReopen"; readonly hasVisibleWindows: boolean };

/** One queued click, checked. */
function parse(raw: unknown): AppActionEvent | undefined {
  const a = (raw ?? {}) as Record<string, unknown>;
  const id = typeof a.id === "string" ? a.id : undefined;
  const tray = typeof a.tray === "string" ? a.tray : undefined;
  switch (a.source) {
    case "menu":
    case "dock":
      return id === undefined ? undefined : { source: a.source, id };
    case "tray":
      return tray === undefined ? undefined : {
        source: "tray",
        tray,
        event: TRAY_EVENTS.has(a.event as string) ? a.event as TrayActionEvent : "click",
        detail: parseTrayMouseDetail(a.detail),
      };
    case "trayMenu":
      return tray === undefined || id === undefined ? undefined : { source: "trayMenu", tray, id };
    case "dockReopen":
      return { source: "dockReopen", hasVisibleWindows: a.hasVisibleWindows === true };
    default:
      return undefined;
  }
}

/** Call `listener` with each click of the app's menus and tray icons. Returns the unsubscribe. */
export const onAppAction: (listener: (action: AppActionEvent) => void) => () => void = pullQueue(
  "app",
  "action",
  parse,
);
