/**
 * The `contextMenu` capability: `denext/mobile`'s `showContextMenu` / `useContextMenu` as the OS's
 * own menu in a Deno Desktop window (`BrowserWindow.showContextMenu` of denext's pinned runtime),
 * with submenus, disabled items, checkmarks and a real dismissal (it resolves `null` when the
 * user closes the menu without choosing).
 *
 * The runtime must report the close (`Deno.desktop.menuCapabilities().contextClosed`): without it
 * a dismissed menu could not be told from one still open, so the capability answers `unavailable`
 * and the page shows its in-page menu instead — as it does under the stock runtime.
 *
 * Runtime-only (imported by the caps resolver, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import { type DesktopAppApi, desktopAppApi, type DesktopMenuItem } from "../launch-events.ts";
import { nativeMenu } from "./menu.ts";

/** The window's context-menu method (`Deno.BrowserWindow.showContextMenu`). */
interface ContextMenuWindow {
  showContextMenu(x: number, y: number, menu: DesktopMenuItem[]): Promise<string | null> | void;
}

/** Options for {@linkcode contextMenuCapability}. */
export interface ContextMenuCapabilityOptions {
  /** The runtime's app API (default `Deno.desktop`); tests pass a fake. */
  readonly api?: DesktopAppApi;
}

/** The furthest a menu may open from the window's origin, in CSS pixels. */
const MAX_COORD = 100_000;

/** The window, when this runtime can show a native menu and report its close; else `unavailable`. */
function menuWindow(api: DesktopAppApi | undefined, window: unknown): ContextMenuWindow {
  const win = window as Partial<ContextMenuWindow> | undefined;
  const caps = typeof api?.menuCapabilities === "function" ? api.menuCapabilities() : undefined;
  if (typeof win?.showContextMenu !== "function" || caps?.contextClosed !== true) {
    throw new DesktopCapError(
      "unavailable",
      "this Deno Desktop runtime cannot report a dismissed context menu (denext's pinned runtime can)",
    );
  }
  return win as ContextMenuWindow;
}

/** A coordinate argument, rounded. */
function coord(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_COORD) {
    throw new DesktopCapError("validation", `${name} must be a number`);
  }
  return Math.round(value);
}

/**
 * Build the `contextMenu` capability.
 *
 * @param options The runtime API (tests).
 * @returns The capability.
 */
export function contextMenuCapability(
  options: ContextMenuCapabilityOptions = {},
): DesktopCapability {
  const api = () => options.api ?? desktopAppApi();
  return {
    name: "contextMenu",
    methods: {
      capabilities: {
        handler: () => {
          const caps = api()?.menuCapabilities?.();
          return { native: caps?.contextClosed === true, ...(caps ?? {}) };
        },
      },
      show: {
        // The user is reading the menu: no deadline.
        timeoutMs: false,
        handler: async (args, ctx) => {
          const win = menuWindow(api(), ctx.window);
          const a = (args ?? {}) as { items?: unknown; x?: unknown; y?: unknown; title?: unknown };
          const { items, ids } = nativeMenu(a.items);
          const title = typeof a.title === "string" && a.title !== ""
            ? [{ item: { label: a.title.slice(0, 256), enabled: false } }, "separator" as const]
            : [];
          const chosen = await win.showContextMenu(coord(a.x, "x"), coord(a.y, "y"), [
            ...title,
            ...items,
          ]);
          return { id: typeof chosen === "string" && ids.has(chosen) ? chosen : null };
        },
      },
    },
  };
}
