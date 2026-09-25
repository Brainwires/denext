/**
 * Home-screen quick actions (the long-press shortcuts on the app icon) for `denext/mobile`,
 * over the `AppShortcuts` plugin (`@capawesome/capacitor-app-shortcuts`) in the shell. On the
 * web there are none: setting them is a no-op and no action ever arrives.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { createFanout, type Fanout } from "./link-routing.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

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
}

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

/** A {@linkcode QuickAction} as the plugin's `Shortcut`, checked. */
function toShortcut(action: QuickAction) {
  if (typeof action?.id !== "string" || action.id === "") {
    throw new TypeError("setQuickActions: every action needs a non-empty id");
  }
  if (typeof action.title !== "string" || action.title === "") {
    throw new TypeError(`setQuickActions: action "${action.id}" needs a non-empty title`);
  }
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
 * removes them all. Outside the shell it does nothing. iOS shows at most four; Android's
 * launcher shows about four.
 *
 * @param actions The actions, in display order.
 * @returns A promise that settles once the OS has them. It rejects with a `TypeError` for an
 * action without an id or title (before anything changes).
 * @example
 * ```ts
 * import { setQuickActions } from "denext/mobile";
 *
 * await setQuickActions([
 *   { id: "new-chat", title: "New chat", subtitle: "Start a thread", icon: "square.and.pencil" },
 *   { id: "search", title: "Search" },
 * ]);
 * ```
 */
export async function setQuickActions(actions: readonly QuickAction[]): Promise<void> {
  const shortcuts = actions.map(toShortcut);
  const ids = new Set(shortcuts.map((s) => s.id));
  if (ids.size !== shortcuts.length) throw new TypeError("setQuickActions: ids must be unique");
  const plugin = shortcutsPlugin();
  if (!plugin) return;
  await (shortcuts.length === 0 ? plugin.clear() : plugin.set({ shortcuts }));
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
 * in an app without scenes), which `denext mobile add quick-actions` wires.
 *
 * @param callback Called with the chosen action's id.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onQuickAction } from "denext/mobile";
 *
 * const stop = onQuickAction((id) => {
 *   if (id === "new-chat") location.assign("/chat/new");
 * });
 * ```
 */
export function onQuickAction(callback: (id: string) => void): () => void {
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
 *   useQuickAction((id) => router.push(id === "search" ? "/search" : "/chat/new"));
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
