/**
 * `expo-quick-actions` (the community package) for denext: home-screen quick actions over
 * `denext/mobile`'s {@linkcode setQuickActions} / {@linkcode onQuickAction}
 * (`@capawesome/capacitor-app-shortcuts` in the Capacitor shell; nothing on the web).
 *
 * `initial` is always undefined: the action that cold-started the app reaches the first
 * {@linkcode addListener} subscriber instead, so subscribe early.
 *
 * @example
 * ```ts
 * import * as QuickActions from "denext/expo/quick-actions";
 *
 * await QuickActions.setItems([{ id: "new", title: "New chat", icon: "symbol:square.and.pencil" }]);
 * QuickActions.addListener((action) => navigate(action.params?.href));
 * ```
 *
 * @module
 */

import { nativePlugin } from "../mobile/plugin.ts";
import { onQuickAction, setQuickActions } from "../mobile/quick-actions.ts";

/** One quick action. */
export interface Action {
  /** Its id (unique). */
  id: string;
  /** Its label. */
  title: string;
  /**
   * Its icon: an SF Symbol as `symbol:<name>`, an asset as `asset:<name>`, or a platform
   * icon name. Expo's built-in iOS icon names (`compose`, `search`, …) are passed through.
   */
  icon?: string | null;
  /** A second line. */
  subtitle?: string | null;
  /** Data carried to the listener. */
  params?: Record<string, number | string | boolean | null | undefined> | null;
}

/** The action that cold-started the app: always undefined here (see the module docs). */
export const initial: Action | undefined = undefined;

/** The most actions the platform shows (not reported here). */
export const maxCount: number | undefined = undefined;

/** The actions last set, by id, so the listener can hand back `title` and `params`. */
let current: ReadonlyMap<string, Action> | undefined;

/** An Expo icon as the name the Capacitor plugin takes. */
function iconName(icon: string | null | undefined): string | undefined {
  if (!icon) return undefined;
  return icon.replace(/^(symbol|asset):/, "");
}

/**
 * Replace the app's quick actions (an empty or missing list removes them).
 *
 * @param data The actions, in display order.
 * @returns A promise that settles once the OS has them.
 */
export async function setItems<TAction extends Action = Action>(
  data: TAction[] = [],
): Promise<void> {
  current = new Map(data.map((action) => [action.id, action]));
  await setQuickActions(data.map((action) => ({
    id: action.id,
    title: action.title,
    ...(action.subtitle ? { subtitle: action.subtitle } : {}),
    ...(iconName(action.icon) ? { icon: iconName(action.icon) } : {}),
  })));
}

/**
 * Whether quick actions are supported: inside the shell with the plugin installed.
 *
 * @returns `true` when they can be set.
 */
export function isSupported(): Promise<boolean> {
  return Promise.resolve(nativePlugin("AppShortcuts", ["set"]) !== undefined);
}

/**
 * Call `listener` with each quick action the user chooses (the cold-start one included).
 *
 * @param listener Called with the action (with the `title` and `params` last set).
 * @returns A handle whose `remove` stops listening.
 */
export function addListener<TAction extends Action = Action>(
  listener: (action: TAction) => void,
): { remove: () => void } {
  const stop = onQuickAction((id) => {
    listener((current?.get(id) ?? { id, title: id }) as TAction);
  });
  return { remove: stop };
}
