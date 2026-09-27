/**
 * React Native's `ActionSheetIOS` for React Native mode: `@capacitor/action-sheet`'s system
 * sheet in the shell when that plugin is installed, else denext's in-page dialog (the one
 * `Alert` uses) or, when some options are disabled, `denext/mobile`'s context menu.
 * react-native-web has no `ActionSheetIOS`, so an import of it was a build error.
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { showContextMenu } from "../mobile/context-menu.ts";
import { type DialogButton, showDialog } from "../mobile/dialog.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { Share } from "./device-apis.ts";

/** `ActionSheetIOS.showActionSheetWithOptions`'s options. */
export interface ActionSheetIOSOptions {
  /** A title above the options. */
  readonly title?: string;
  /** A message under the title. */
  readonly message?: string;
  /** The option labels, in order; the callback receives the chosen one's index. */
  readonly options: readonly string[];
  /** The index (or indices) of destructive options, drawn in red. */
  readonly destructiveButtonIndex?: number | readonly number[];
  /** The index of the cancel option; a dismissal reports it. */
  readonly cancelButtonIndex?: number;
  /** The indices of options shown but not selectable. */
  readonly disabledButtonIndices?: readonly number[];
  /** iPad: the node the popover points at (accepted; the in-page sheet is centred). */
  readonly anchor?: number;
  /** The options' tint (accepted; not applied). */
  readonly tintColor?: unknown;
  /** The cancel option's tint (accepted; not applied). */
  readonly cancelButtonTintColor?: unknown;
  /** Disabled options' tint (accepted; not applied). */
  readonly disabledButtonTintColor?: unknown;
  /** The sheet's appearance (accepted; the in-page sheet follows the page). */
  readonly userInterfaceStyle?: string;
}

/** `ActionSheetIOS.showShareActionSheetWithOptions`'s options. */
export interface ShareActionSheetIOSOptions {
  /** The text to share. */
  readonly message?: string;
  /** The URL to share. */
  readonly url?: string;
  /** A subject, for mail. */
  readonly subject?: string;
  /** iPad: the node the popover points at (accepted). */
  readonly anchor?: number;
  /** The buttons' tint (accepted). */
  readonly tintColor?: number;
  /** The cancel button's tint (accepted). */
  readonly cancelButtonTintColor?: number;
  /** Disabled buttons' tint (accepted). */
  readonly disabledButtonTintColor?: number;
  /** Activities to leave out (accepted; the share sheet takes none). */
  readonly excludedActivityTypes?: readonly string[];
  /** The sheet's appearance (accepted). */
  readonly userInterfaceStyle?: string;
}

/** What `showShareActionSheetWithOptions`'s failure callback receives. */
export interface ShareActionSheetError {
  /** The error domain. */
  readonly domain: string;
  /** The error code. */
  readonly code: string;
  /** Extra details, when any. */
  readonly userInfo?: object;
  /** What went wrong. */
  readonly message: string;
}

/** React Native's `ActionSheetIOS` module. */
export interface ActionSheetIOSStatic {
  /** Show an action sheet; `callback` receives the chosen option's index. */
  showActionSheetWithOptions(
    options: ActionSheetIOSOptions,
    callback: (buttonIndex: number) => void,
  ): void;
  /** Show the share sheet; `successCallback(completed, method)` or `failureCallback(error)`. */
  showShareActionSheetWithOptions(
    options: ShareActionSheetIOSOptions,
    failureCallback: (error: ShareActionSheetError) => void,
    successCallback: (success: boolean, method: string | null | undefined) => void,
  ): void;
  /** Accepted and does nothing: an open sheet cannot be closed from the page here. */
  dismissActionSheet(): void;
}

/** The JS side of `@capacitor/action-sheet`. */
interface ActionSheetPlugin {
  showActions(options: {
    title?: string;
    message?: string;
    options: Array<{ title: string; style?: "DEFAULT" | "DESTRUCTIVE" | "CANCEL" }>;
    cancelable?: boolean;
  }): Promise<{ index: number; canceled?: boolean }>;
}

/** The destructive indices, as a set. */
function destructiveSet(options: ActionSheetIOSOptions): ReadonlySet<number> {
  const d = options.destructiveButtonIndex;
  return new Set(d === undefined ? [] : typeof d === "number" ? [d] : d);
}

/** What a dismissal reports: the cancel option's index, or -1 without one (as React Native). */
function dismissedIndex(options: ActionSheetIOSOptions): number {
  return options.cancelButtonIndex ?? -1;
}

/** The sheet through `@capacitor/action-sheet`. */
async function showNative(
  plugin: ActionSheetPlugin,
  options: ActionSheetIOSOptions,
): Promise<number> {
  const destructive = destructiveSet(options);
  const result = await plugin.showActions({
    ...(options.title ? { title: options.title } : {}),
    ...(options.message ? { message: options.message } : {}),
    options: options.options.map((title, i) => ({
      title,
      style: i === options.cancelButtonIndex
        ? "CANCEL"
        : destructive.has(i)
        ? "DESTRUCTIVE"
        : "DEFAULT",
    })),
    cancelable: true,
  });
  return result?.canceled || typeof result?.index !== "number" || result.index < 0
    ? dismissedIndex(options)
    : result.index;
}

/** The sheet as `denext/mobile`'s context menu, which can show disabled options. */
async function showMenu(options: ActionSheetIOSOptions): Promise<number> {
  const destructive = destructiveSet(options);
  const disabled = new Set(options.disabledButtonIndices ?? []);
  const view = globalThis as { innerWidth?: number; innerHeight?: number };
  const chosen = await showContextMenu(
    options.options.map((label, i) => ({
      id: String(i),
      label,
      ...(disabled.has(i) ? { disabled: true } : {}),
      ...(destructive.has(i) ? { destructive: true } : {}),
    })),
    {
      ...(options.title ? { title: options.title } : {}),
      x: Math.max(0, Math.round((view.innerWidth ?? 0) / 2 - 120)),
      y: Math.max(0, Math.round((view.innerHeight ?? 0) / 3)),
    },
  );
  return chosen === null ? dismissedIndex(options) : Number(chosen);
}

/** The sheet as denext's in-page dialog (the system dialog for two options or fewer). */
async function showAsDialog(options: ActionSheetIOSOptions): Promise<number> {
  const destructive = destructiveSet(options);
  const buttons: DialogButton[] = options.options.map((text, i) => ({
    text,
    ...(i === options.cancelButtonIndex
      ? { style: "cancel" as const }
      : destructive.has(i)
      ? { style: "destructive" as const }
      : {}),
  }));
  const result = await showDialog({
    title: options.title ?? "",
    ...(options.message ? { message: options.message } : {}),
    buttons,
    cancelable: true,
  });
  return result.index ?? dismissedIndex(options);
}

/** Show `options` the best way available here; resolves the chosen index. */
function showSheet(options: ActionSheetIOSOptions): Promise<number> {
  const plugin = nativePlatform() === "web"
    ? undefined
    : nativePlugin<ActionSheetPlugin>("ActionSheet", ["showActions"]);
  if ((options.disabledButtonIndices?.length ?? 0) > 0) return showMenu(options);
  return plugin ? showNative(plugin, options) : showAsDialog(options);
}

/**
 * React Native's `ActionSheetIOS`, on every platform React Native mode runs on:
 *
 * - `showActionSheetWithOptions(options, callback)`: inside the iOS / Android shell with
 *   `@capacitor/action-sheet` installed, the system action sheet (`cancelButtonIndex` is its
 *   cancel button, `destructiveButtonIndex` its red ones); otherwise denext's in-page dialog,
 *   the accessible modal `Alert` uses (each option a button, destructive ones in red, Escape or
 *   a tap outside picking the cancel option). With `disabledButtonIndices`, which neither can
 *   draw, the options open in `denext/mobile`'s context menu instead (disabled ones shown, not
 *   selectable). `callback` receives the chosen index; a dismissal reports
 *   `cancelButtonIndex` (or -1 without one), as on an iPad.
 * - `showShareActionSheetWithOptions(options, failure, success)`: React Native mode's
 *   `Share.share` (the system share sheet in the shell, `navigator.share` or a copy in a
 *   browser); `success(true, activityType)` once shared, `success(false, null)` when
 *   dismissed, `failure(error)` when it cannot share.
 * - `dismissActionSheet()`: accepted; a sheet the page opened cannot be closed from JS here.
 *
 * The tint colours and `userInterfaceStyle` are accepted and not applied.
 *
 * @example
 * ```ts
 * import { ActionSheetIOS } from "react-native";
 *
 * ActionSheetIOS.showActionSheetWithOptions(
 *   { options: ["Cancel", "Delete"], cancelButtonIndex: 0, destructiveButtonIndex: 1 },
 *   (index) => index === 1 && remove(id),
 * );
 * ```
 */
export const ActionSheetIOS: ActionSheetIOSStatic = {
  showActionSheetWithOptions(options, callback) {
    if (!options || !Array.isArray(options.options)) {
      throw new TypeError("ActionSheetIOS.showActionSheetWithOptions: options.options is required");
    }
    if (typeof callback !== "function") {
      throw new TypeError("ActionSheetIOS.showActionSheetWithOptions: a callback is required");
    }
    showSheet(options).then(callback, () => callback(dismissedIndex(options)));
  },
  showShareActionSheetWithOptions(options, failureCallback, successCallback) {
    Share.share({
      ...(options.message !== undefined ? { message: options.message } : {}),
      ...(options.url !== undefined ? { url: options.url } : {}),
      ...(options.subject !== undefined ? { title: options.subject } : {}),
    }).then(
      (result) =>
        result.action === "sharedAction"
          ? successCallback(true, result.activityType ?? null)
          : successCallback(false, null),
      (err: unknown) =>
        failureCallback({
          domain: "denext.share",
          code: "share_failed",
          message: (err as Error)?.message ?? String(err),
        }),
    );
  },
  dismissActionSheet() {},
};
