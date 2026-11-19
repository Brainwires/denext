/**
 * Home-screen quick actions (the long-press shortcuts on the app icon) for `denext/mobile`,
 * over the `AppShortcuts` plugin (`@capawesome/capacitor-app-shortcuts`) in the shell. In a Deno
 * Desktop window on macOS they are the Dock icon's menu (Windows and Linux have none), where they
 * may also be separators, submenus and checked or disabled items. On the web there are none:
 * setting them is a no-op and no action ever arrives.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { createFanout, type Fanout } from "./link-routing.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";
import { onDesktop, viaDesktop } from "./desktop-branch.ts";
import type { DesktopDockEntry } from "../desktop/native.ts";

/** One home-screen quick action. */
export interface QuickAction {
  /** What {@linkcode onQuickAction} reports when it is chosen. Unique among the actions. */
  readonly id: string;
  /** The label. */
  readonly title: string;
  /** A second line (iOS) / the long label Android shows when there is room. */
  readonly subtitle?: string;
  /**
   * The icon: an SF Symbol or asset-catalogue image name on iOS, a drawable resource name on
   * Android. A string is used on both platforms; `{ ios, android }` names each. On iOS an
   * icon shows only together with a `subtitle`.
   */
  readonly icon?: string | { readonly ios?: string; readonly android?: string };
  /** Selectable (default `true`): the Dock menu only (ignored on iOS / Android). */
  readonly enabled?: boolean;
  /** A checkmark next to the title: the Dock menu only (ignored on iOS / Android). */
  readonly checked?: boolean;
}

/** A separator line between quick actions: the Dock menu only (left out on iOS / Android). */
export interface QuickActionSeparator {
  /** Always `"separator"`. */
  readonly type: "separator";
}

/**
 * A submenu of quick actions: the Dock menu only (iOS and Android have none, so
 * `setQuickActions` rejects one there with a `TypeError`).
 */
export interface QuickActionSubmenu {
  /** The submenu's label. */
  readonly title: string;
  /** Its entries. */
  readonly submenu: readonly QuickActionEntry[];
}

/** One entry of {@linkcode setQuickActions}: an action, a separator or a submenu. */
export type QuickActionEntry = QuickAction | QuickActionSeparator | QuickActionSubmenu;

/** The JS side of `@capawesome/capacitor-app-shortcuts`. */
interface AppShortcutsPlugin {
  set(options: {
    shortcuts: Array<{
      id: string;
      title: string;
      description?: string;
      iosIcon?: string;
      androidIcon?: string;
    }>;
  }): Promise<unknown>;
  clear(): Promise<unknown>;
  addListener(
    eventName: "click",
    listener: (event: { shortcutId?: unknown }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The native plugin, when the shell has it. */
function shortcutsPlugin(): AppShortcutsPlugin | undefined {
  return nativePlugin<AppShortcutsPlugin>("AppShortcuts", ["set", "clear", "addListener"]);
}

/** Whether `entry` is a separator. */
function isSeparator(entry: QuickActionEntry): entry is QuickActionSeparator {
  return (entry as { type?: unknown })?.type === "separator";
}

/** Whether `entry` is a submenu. */
function isSubmenu(entry: QuickActionEntry): entry is QuickActionSubmenu {
  return Array.isArray((entry as { submenu?: unknown })?.submenu);
}

/** Check `entries` (every level): actions need an id and a title, ids are unique. */
function checkEntries(entries: readonly QuickActionEntry[], ids: Set<string>): void {
  for (const entry of entries) {
    if (isSeparator(entry)) continue;
    if (isSubmenu(entry)) {
      if (typeof entry.title !== "string" || entry.title === "") {
        throw new TypeError("setQuickActions: every submenu needs a non-empty title");
      }
      checkEntries(entry.submenu, ids);
      continue;
    }
    checkAction(entry);
    if (ids.has(entry.id)) throw new TypeError("setQuickActions: ids must be unique");
    ids.add(entry.id);
  }
}

/** An action needs a non-empty id and title. */
function checkAction(action: QuickAction): void {
  if (typeof action?.id !== "string" || action.id === "") {
    throw new TypeError("setQuickActions: every action needs a non-empty id");
  }
  if (typeof action.title !== "string" || action.title === "") {
    throw new TypeError(`setQuickActions: action "${action.id}" needs a non-empty title`);
  }
}

/** The Dock menu entries `entries` set (subtitles and icons are the phone's only). */
function dockEntries(entries: readonly QuickActionEntry[]): DesktopDockEntry[] {
  return entries.map((entry): DesktopDockEntry => {
    if (isSeparator(entry)) return { type: "separator" };
    if (isSubmenu(entry)) return { title: entry.title, submenu: dockEntries(entry.submenu) };
    return {
      id: entry.id,
      title: entry.title,
      ...(entry.enabled === false ? { enabled: false } : {}),
      ...(entry.checked === true ? { checked: true } : {}),
    };
  });
}

/** A {@linkcode QuickAction} as the plugin's `Shortcut` (checked already). */
function toShortcut(action: QuickAction) {
  const icon = typeof action.icon === "string"
    ? { ios: action.icon, android: action.icon }
    : action.icon ?? {};
  return {
    id: action.id,
    title: action.title,
    ...(action.subtitle ? { description: action.subtitle } : {}),
    ...(icon.ios ? { iosIcon: icon.ios } : {}),
    ...(icon.android ? { androidIcon: icon.android } : {}),
  };
}

/**
 * Replace the app's home-screen quick actions (long-press on the icon).
 *
 * Inside the native shell with `@capawesome/capacitor-app-shortcuts` installed (`denext mobile
 * add quick-actions`), the iOS Home Screen quick actions / Android app shortcuts; an empty list
 * removes them all. iOS shows at most four; Android's launcher shows about four. There a
 * separator is left out, `enabled` and `checked` are ignored, and a submenu is refused.
 *
 * In a Deno Desktop window, the Dock icon's menu on macOS: titles (no subtitles or icons),
 * separators (`{ type: "separator" }`), submenus (`{ title, submenu }`), and `enabled` /
 * `checked`; nothing on Windows and Linux. The page's entries follow the app's own Dock items
 * (`setDockMenu` / `runDesktop({ dockMenu })` in `desktop.ts`) after a separator, and an id one of
 * those uses is refused (`validation`). A choice reaches one page's {@linkcode onQuickAction} (the
 * key window's if it listens, else the one focused most recently that does) and the backend's
 * `onDockMenuItem`. Elsewhere it does nothing.
 *
 * @param actions The entries, in display order.
 * @returns A promise that settles once the OS has them. It rejects with a `TypeError` for an
 * action without an id or title, a submenu without a title, or a repeated id (before anything
 * changes), and on iOS / Android for a submenu.
 * @example
 * ```ts
 * import { setQuickActions } from "denext/mobile";
 *
 * await setQuickActions([
 *   { id: "new-note", title: "New note", subtitle: "Start a draft", icon: "square.and.pencil" },
 *   { id: "search", title: "Search" },
 * ]);
 * ```
 */
export async function setQuickActions(actions: readonly QuickActionEntry[]): Promise<void> {
  checkEntries(actions, new Set());
  if (onDesktop() && await viaDesktop("app", (d) => d.setDesktopDockMenu(dockEntries(actions)))) {
    return;
  }
  const plugin = shortcutsPlugin();
  if (!plugin) return;
  if (actions.some(isSubmenu)) {
    throw new TypeError("setQuickActions: submenus are the macOS Dock menu's only");
  }
  const shortcuts = actions.filter((a): a is QuickAction => !isSeparator(a)).map(toShortcut);
  await (shortcuts.length === 0 ? plugin.clear() : plugin.set({ shortcuts }));
}

/** Dock-menu choices in a Deno Desktop window (the desktop module loads lazily). */
function onDesktopDock(callback: (id: string) => void): () => void {
  let stop: (() => void) | undefined;
  let active = true;
  import("../desktop/native.ts").then((d) => {
    if (active) stop = d.onDesktopDockMenu(callback);
  }, () => {});
  return () => {
    active = false;
    stop?.();
  };
}

/** The one native `click` listener every subscriber shares. */
let fanout: Fanout<string> | undefined;

/**
 * Call `callback` with the `id` of each quick action the user chooses, including the one that
 * cold-started the app: the shell keeps that until the first listener, so subscribe early (a
 * root layout or the app shell); only the subscribers present when it is handed over see it.
 * Outside the native shell it does nothing.
 *
 * On iOS the action reaches the plugin through `SceneDelegate.swift` (or `AppDelegate.swift`
 * in an app without scenes), which `denext mobile add quick-actions` wires. In a Deno Desktop
 * window it reports the page's Dock-menu items chosen (macOS): each choice reaches one page only,
 * the key window's if it subscribed, else the page of the window focused most recently that did.
 *
 * @param callback Called with the chosen action's id.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onQuickAction } from "denext/mobile";
 *
 * const stop = onQuickAction((id) => {
 *   if (id === "new-note") location.assign("/notes/new");
 * });
 * ```
 */
export function onQuickAction(callback: (id: string) => void): () => void {
  if (onDesktop()) return onDesktopDock(callback);
  if (!shortcutsPlugin()) return () => {};
  fanout ??= createFanout<string>((emit) =>
    listenerDisposer(
      shortcutsPlugin()?.addListener("click", (event) => {
        if (typeof event?.shortcutId === "string") emit(event.shortcutId);
      }),
    )
  );
  return fanout.subscribe((id) => callback(id));
}

/**
 * Hook form of {@linkcode onQuickAction}: subscribes on mount, unsubscribes on unmount, and
 * always calls the latest `callback`.
 *
 * @param callback Called with the chosen action's id.
 * @example
 * ```tsx
 * "use client";
 * import { useRouter } from "denext";
 * import { useQuickAction } from "denext/mobile";
 *
 * export function QuickActions() {
 *   const router = useRouter();
 *   useQuickAction((id) => router.push(id === "search" ? "/search" : "/notes/new"));
 *   return null;
 * }
 * ```
 */
export function useQuickAction(callback: (id: string) => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  useEffect(() => onQuickAction((id) => cbRef.current(id)), []);
}

/** Forget the shared listener (tests only). */
export function resetQuickActionsForTesting(): void {
  fanout = undefined;
}
