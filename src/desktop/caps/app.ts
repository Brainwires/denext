/**
 * The `app` capability: the application menu, tray icons, the dock / taskbar badge and attention
 * request, and the dock menu — what `denext/desktop/app` (and, for the dock menu,
 * `setQuickActions` in `denext/mobile`) drives from the page. `runDesktop` registers it for every
 * app (no `denext desktop add`): it needs no Deno permission, and the page only changes the app's
 * own chrome.
 *
 * Runtime APIs: `BrowserWindow.setApplicationMenu`, `Deno.Tray`, `Deno.dock`. They exist under the
 * stock runtime too; denext's pinned runtime adds keyboard accelerators on every OS
 * (`Deno.desktop.menuCapabilities()`), menu icons and tooltips. The dock menu is macOS-only (the
 * OS has no other). A badge is the Dock icon's on macOS, a prefix of the window titles on Windows,
 * and on Linux a count on the app's launcher where a dock reads launcher badges (runtime
 * 2.9.7-denext.11), else the same title prefix.
 *
 * Tray icons follow the runtime's probe of the session (`Deno.desktop.platformFeatures()`, runtime
 * 2.9.7-denext.10 and later): where no tray host runs (stock GNOME without the AppIndicator
 * extension), `capabilities` reports `tray: false` with the runtime's reason and `createTray`
 * rejects `unsupported` with it, never a dead icon. A tray-only app (its window hidden) gets its
 * window shown instead, so it is never unreachable. Without the probe the facts read `"unknown"`.
 *
 * Clicks are PULLED (an `action` signal, then `take`), so each is delivered once, never again after
 * a reload. A new page load removes the trays the previous page created (their click handlers went
 * with it); the application menu and the dock menu stay until the new page sets its own.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import { base64ToBytes } from "../../mobile/base64.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import type { DesktopAppApi, DesktopMenuItem } from "../launch-events.ts";
import { clickedId, nativeMenu } from "./menu.ts";
import { platformFacts, reasonText } from "./platform.ts";
import { createPullQueue } from "./queue.ts";

/** The most tray icons the page may hold. */
const MAX_TRAYS = 8;
/** The largest base64 icon accepted. */
const MAX_ICON_CHARS = 1024 * 1024;
/** The longest tooltip / badge accepted. */
const MAX_TEXT = 256;

/** `Deno.Tray`, as far as this module uses it. */
export interface TrayLike extends EventTarget {
  setIcon(png: Uint8Array): void;
  setIconDark?(png: Uint8Array | null): void;
  setTooltip(text: string | null): void;
  setMenu(menu: DesktopMenuItem[] | null): void;
  getBounds?(): { x: number; y: number; width: number; height: number } | null;
  destroy(): void;
}

/** `Deno.dock`, as far as this module uses it. */
export interface DockLike extends EventTarget {
  setBadge(text: string | null): void;
  bounce(critical?: boolean): void;
  setMenu?(menu: DesktopMenuItem[] | null): void;
}

/** One click the page takes. */
type AppAction =
  | { readonly source: "menu" | "dock"; readonly id: string }
  | { readonly source: "tray"; readonly tray: string; readonly event: "click" | "doubleClick" }
  | { readonly source: "trayMenu"; readonly tray: string; readonly id: string };

/** Options for {@linkcode createAppController}. */
export interface AppControllerOptions {
  /** The adopted `Deno.BrowserWindow`. */
  readonly window: unknown;
  /** The runtime's app API (`Deno.desktop`), when it has one. */
  readonly api?: DesktopAppApi;
  /** Push an event to the page (the bridge's `emit`). */
  readonly emit: (cap: string, event: string, data: unknown) => void;
  /** The `Deno.Tray` constructor (default the runtime's); tests pass a fake. */
  readonly Tray?: new () => TrayLike;
  /** `Deno.dock` (default the runtime's); tests pass a fake. */
  readonly dock?: DockLike;
  /** The running OS (default `Deno.build.os`). */
  readonly os?: string;
}

/** What {@linkcode createAppController} returns. */
export interface AppController {
  /** The `app` bridge capability. */
  readonly capability: DesktopCapability;
  /** Listen for the window's and the dock's menu clicks (once). */
  install(): void;
}

/** A `validation` error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** Why a feature is missing when the runtime does not say: it has no API for it. */
const NO_API = "this Deno Desktop runtime has no API for it";

/** Why the badge / attention request is missing. */
const NO_DOCK = "this Deno Desktop runtime has no Deno.dock";

/**
 * `unsupported` (501), with the reason in the message and as `data.reason` for the page.
 *
 * @param what The feature ("a tray icon").
 * @param reason Why it is missing here (default: the runtime has no API for it).
 * @param extra More detail for the page (`data`).
 */
function unsupported(
  what: string,
  reason: string = NO_API,
  extra: Record<string, unknown> = {},
): DesktopCapError {
  return new DesktopCapError("unsupported", `${what} is not available here: ${reason}`, {
    status: 501,
    data: { reason, ...extra },
  });
}

/** The reason in a runtime's `NotSupported` from `new Deno.Tray()`, or `undefined` for another error. */
function trayNotSupported(err: unknown): string | undefined {
  const name = (err as { name?: unknown } | null)?.name;
  if (name !== "NotSupported") return undefined;
  const message = err instanceof Error ? err.message : "";
  // The runtime words it "Tray icons are not available here: <reason>".
  return reasonText(message.replace(/^.*?not available here:\s*/i, "")) ?? "no tray host";
}

/** The arguments object (or `{}`). */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
}

/** A base64 PNG as bytes. */
function png(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || value === "" || value.length > MAX_ICON_CHARS) {
    throw invalid(`${name} must be a base64 PNG up to 1 MiB`);
  }
  try {
    return base64ToBytes(value);
  } catch {
    throw invalid(`${name} must be base64 PNG bytes`);
  }
}

/** A short optional text (`null` clears). */
function shortText(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_TEXT) {
    throw invalid(`${name} must be a string up to ${MAX_TEXT} characters`);
  }
  return value;
}

/** The runtime's `Deno.Tray` / `Deno.dock`, when present. */
function runtimeChrome(): { Tray?: new () => TrayLike; dock?: DockLike } {
  const d = Deno as unknown as { Tray?: unknown; dock?: unknown };
  return {
    ...(typeof d.Tray === "function" ? { Tray: d.Tray as new () => TrayLike } : {}),
    ...(typeof d.dock === "object" && d.dock !== null ? { dock: d.dock as DockLike } : {}),
  };
}

/** One live tray the page created. */
interface LiveTray {
  readonly tray: TrayLike;
  ids: Set<string>;
}

/**
 * Create the `app` capability over the adopted window, `Deno.Tray` and `Deno.dock`.
 *
 * @param options The window, runtime APIs and the bridge's emitter.
 * @returns The capability and its installer.
 */
export function createAppController(options: AppControllerOptions): AppController {
  const chrome = runtimeChrome();
  const Tray = options.Tray ?? chrome.Tray;
  const dock = options.dock ?? chrome.dock;
  const os = options.os ?? Deno.build.os;
  const win = options.window as
    | (EventTarget & {
      setApplicationMenu?(menu: DesktopMenuItem[]): void;
      isVisible?(): boolean;
      show?(): void;
    })
    | undefined;
  const queue = createPullQueue<AppAction>(() => options.emit("app", "action", null));
  const trays = new Map<string, LiveTray>();
  let appMenuIds = new Set<string>();
  let dockMenuIds = new Set<string>();
  let nextTray = 1;
  let installed = false;

  const menuMissing = () =>
    win ? "this Deno Desktop runtime has no BrowserWindow.setApplicationMenu" : "no app window";
  const menuCaps = () => options.api?.menuCapabilities?.() ?? {};
  const dockMenuWorks = () => os === "darwin" && typeof dock?.setMenu === "function";

  const trayOf = (args: unknown): LiveTray => {
    const id = argsOf(args).id;
    const live = typeof id === "string" ? trays.get(id) : undefined;
    if (!live) throw invalid("no such tray");
    return live;
  };

  /** Apply the optional `icon` / `iconDark` / `tooltip` / `menu` of `a` to a tray. */
  const applyTray = (live: LiveTray, a: Record<string, unknown>) => {
    if (a.icon !== undefined) live.tray.setIcon(png(a.icon, "icon"));
    if (a.iconDark !== undefined) {
      live.tray.setIconDark?.(a.iconDark === null ? null : png(a.iconDark, "iconDark"));
    }
    if (a.tooltip !== undefined) live.tray.setTooltip(shortText(a.tooltip, "tooltip"));
    if (a.menu !== undefined) {
      const menu = a.menu === null ? null : nativeMenu(a.menu);
      live.ids = menu?.ids ?? new Set();
      live.tray.setMenu(menu?.items ?? null);
    }
  };

  /**
   * Why no tray icon can be shown here (`undefined` when one can): no `Deno.Tray`, or the probe
   * found no tray host.
   */
  const trayMissing = async (): Promise<string | undefined> => {
    if (!Tray) return NO_API;
    const facts = await platformFacts(options.api);
    return facts.trayHost === false
      ? facts.trayReason ?? "no tray host in this session"
      : undefined;
  };

  /**
   * `unsupported` for a tray icon, after showing a hidden window: a tray-only app would otherwise
   * be left with no way in. `data.windowShown` says whether it did.
   */
  const noTray = (reason: string): DesktopCapError => {
    let windowShown = false;
    try {
      if (win?.isVisible?.() === false && typeof win.show === "function") {
        win.show();
        windowShown = true;
      }
    } catch { /* the window is gone; nothing to show */ }
    return unsupported("a tray icon", reason, { windowShown });
  };

  /** A new `Deno.Tray`, or `unsupported` with the runtime's reason when it has no tray host. */
  const newTray = (T: new () => TrayLike): TrayLike => {
    try {
      return new T();
    } catch (err) {
      const reason = trayNotSupported(err);
      if (reason !== undefined) throw noTray(reason);
      throw err;
    }
  };

  const createTray = async (args: unknown) => {
    const missing = await trayMissing();
    if (missing !== undefined) throw noTray(missing);
    if (trays.size >= MAX_TRAYS) throw invalid(`at most ${MAX_TRAYS} tray icons`);
    const a = argsOf(args);
    const icon = png(a.icon, "icon");
    const live: LiveTray = { tray: newTray(Tray!), ids: new Set() };
    const id = String(nextTray++);
    live.tray.setIcon(icon);
    applyTray(live, { ...a, icon: undefined });
    live.tray.addEventListener(
      "click",
      () => queue.push({ source: "tray", tray: id, event: "click" }),
    );
    live.tray.addEventListener(
      "dblclick",
      () => queue.push({ source: "tray", tray: id, event: "doubleClick" }),
    );
    live.tray.addEventListener("menuclick", (e) => {
      const item = clickedId(e);
      if (item !== undefined && live.ids.has(item)) {
        queue.push({ source: "trayMenu", tray: id, id: item });
      }
    });
    trays.set(id, live);
    return { id };
  };

  const destroyTrays = () => {
    for (const live of trays.values()) {
      try {
        live.tray.destroy();
      } catch { /* already gone */ }
    }
    trays.clear();
  };

  const capability: DesktopCapability = {
    name: "app",
    methods: {
      capabilities: {
        handler: async () => {
          const caps = menuCaps();
          const facts = await platformFacts(options.api);
          const trayReason = (await trayMissing()) ?? null;
          return {
            appMenu: caps.appMenu ?? typeof win?.setApplicationMenu === "function",
            accelerators: caps.accelerators === true,
            icons: caps.icons === true,
            tooltips: caps.tooltips === true,
            tray: trayReason === null,
            trayReason,
            trayHost: facts.trayHost,
            secretService: facts.secretService,
            sessionType: facts.sessionType,
            cookieEncryption: facts.cookieEncryption,
            badge: typeof dock?.setBadge === "function",
            badgeShows: facts.badge,
            badgeReason: facts.badgeReason,
            sandbox: facts.sandbox,
            sandboxReason: facts.sandboxReason,
            fileChooser: facts.fileChooser,
            fileChooserReason: facts.fileChooserReason,
            bounce: typeof dock?.bounce === "function",
            dockMenu: dockMenuWorks(),
          };
        },
      },
      setAppMenu: {
        handler: (args) => {
          if (typeof win?.setApplicationMenu !== "function") {
            throw unsupported("an app menu", menuMissing());
          }
          const { items, ids } = nativeMenu(argsOf(args).menu);
          win.setApplicationMenu(items);
          appMenuIds = ids;
          return null;
        },
      },
      setDockMenu: {
        handler: (args) => {
          if (!dockMenuWorks()) return { applied: false };
          const raw = argsOf(args).menu;
          const menu = raw === null || (Array.isArray(raw) && raw.length === 0)
            ? null
            : nativeMenu(raw);
          dock!.setMenu!(menu?.items ?? null);
          dockMenuIds = menu?.ids ?? new Set();
          return { applied: true };
        },
      },
      setBadge: {
        handler: (args) => {
          if (typeof dock?.setBadge !== "function") throw unsupported("a badge", NO_DOCK);
          // The runtime takes a string: `null` would show as the text "null"; "" clears the badge.
          dock.setBadge(shortText(argsOf(args).text, "text") ?? "");
          return null;
        },
      },
      bounce: {
        handler: (args) => {
          if (typeof dock?.bounce !== "function") {
            throw unsupported("an attention request", NO_DOCK);
          }
          dock.bounce(argsOf(args).critical === true);
          return null;
        },
      },
      createTray: { handler: createTray },
      updateTray: {
        handler: (args) => {
          applyTray(trayOf(args), argsOf(args));
          return null;
        },
      },
      destroyTray: {
        handler: (args) => {
          const live = trayOf(args);
          trays.delete(String(argsOf(args).id));
          live.tray.destroy();
          return null;
        },
      },
      trayBounds: {
        handler: (args) => trayOf(args).tray.getBounds?.() ?? null,
      },
      take: { handler: () => queue.take() },
    },
    events: ["action"],
    onPageLoad: () => {
      destroyTrays();
      queue.clear();
    },
  };

  return {
    capability,
    install: () => {
      if (installed) return;
      installed = true;
      win?.addEventListener("menuclick", (e) => {
        const id = clickedId(e);
        if (id !== undefined && appMenuIds.has(id)) queue.push({ source: "menu", id });
      });
      dock?.addEventListener("menuclick", (e) => {
        const id = clickedId(e);
        if (id !== undefined && dockMenuIds.has(id)) queue.push({ source: "dock", id });
      });
      // The session probe's answer may have changed (a tray host came or went): the page re-reads
      // the capabilities (`onAppCapabilitiesChanged`).
      options.api?.addEventListener?.(
        "platformfeatureschanged",
        () => options.emit("app", "capabilities", null),
      );
    },
  };
}
