/**
 * `expo-dev-client` for denext: a stub. The dev client is Expo's native development launcher
 * and menu; a denext app has `denext dev` instead. The dev-menu calls it re-exports
 * (`openMenu`, `registerDevMenuItems`, …) do nothing, so app code that registers menu items
 * keeps running.
 *
 * @example
 * ```ts
 * import { registerDevMenuItems } from "denext/expo/dev-client";
 *
 * await registerDevMenuItems([{ name: "Reset", callback: reset }]); // no-op
 * ```
 *
 * @module
 */

/** A dev-menu item. */
export interface ExpoDevMenuItem {
  /** The label. */
  name: string;
  /** What it does. */
  callback: () => void;
  /** Close the menu after running it. */
  shouldCollapse?: boolean;
}

/** Open the dev menu: there is none here. */
export function openMenu(): void {}

/** Hide the dev menu: there is none here. */
export function hideMenu(): void {}

/** Close the dev menu: there is none here. */
export function closeMenu(): void {}

/**
 * Show or hide the dev menu's floating tools button: there is none here.
 *
 * @param _visible Whether to show it (ignored).
 */
export function setToolsButtonVisible(_visible: boolean): void {}

/**
 * Add items to the dev menu: there is none here, so they are dropped.
 *
 * @param _items The items.
 * @returns A promise that settles at once.
 */
export function registerDevMenuItems(_items: ExpoDevMenuItem[]): Promise<void> {
  return Promise.resolve();
}
