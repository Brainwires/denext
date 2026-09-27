/**
 * React Native's `Alert` for React Native mode: `Alert.alert` and `Alert.prompt` as the
 * system dialog through `@capacitor/dialog` in the Capacitor shell when the dialog fits it,
 * else an accessible in-page modal. react-native-web's `Alert.alert` does nothing.
 *
 * @module
 */

import {
  type DialogButton,
  type DialogInput,
  type DialogResult,
  showDialog,
} from "../mobile/dialog.ts";

/** A button's role. */
export type AlertButtonStyle = "default" | "cancel" | "destructive";

/** One `Alert` button. */
export interface AlertButton {
  text?: string;
  onPress?: (value?: string | { login: string; password: string }) => void;
  isPreferred?: boolean;
  style?: AlertButtonStyle;
}

/** `Alert.alert` / `Alert.prompt` options. */
export interface AlertOptions {
  /** Android: a tap outside (or the back button) dismisses the dialog. */
  cancelable?: boolean;
  /** iOS: the dialog's appearance (the in-page modal follows the page's color scheme). */
  userInterfaceStyle?: "unspecified" | "light" | "dark";
  /** Called when the dialog is dismissed without a button. */
  onDismiss?: () => void;
}

/** The prompt's field(s). */
export type AlertType = "default" | "plain-text" | "secure-text" | "login-password";

/** React Native's `keyboardType`, as far as the prompt's `inputmode` goes. */
const INPUT_MODES: Readonly<Record<string, string>> = {
  "number-pad": "numeric",
  "decimal-pad": "decimal",
  numeric: "decimal",
  "phone-pad": "tel",
  "email-address": "email",
  url: "url",
  "web-search": "search",
};

/** React Native's default single button. */
const OK: AlertButton = { text: "OK" };

/** The dialog buttons for `buttons` (their text; React Native's `OK` when there are none). */
function dialogButtons(buttons: readonly AlertButton[]): DialogButton[] {
  return buttons.map((b) => ({
    text: b.text ?? "",
    ...(b.style ? { style: b.style } : {}),
    ...(b.isPreferred ? { preferred: true } : {}),
  }));
}

/** Run the pressed button's `onPress` (or `onDismiss`) once the dialog closes. */
function settle(
  result: DialogResult,
  buttons: readonly AlertButton[],
  options: AlertOptions | undefined,
  value?: string | { login: string; password: string },
): void {
  if (result.index === null) return options?.onDismiss?.();
  const button = buttons[result.index];
  if (value === undefined) button?.onPress?.();
  else button?.onPress?.(value);
}

/** The value a prompt's `onPress` receives for `type`. */
function promptValue(
  result: DialogResult,
  type: AlertType,
): string | { login: string; password: string } {
  if (type === "login-password") {
    return { login: result.value ?? "", password: result.password ?? "" };
  }
  return result.value ?? "";
}

/** The field(s) a prompt of `type` shows. */
function dialogInput(type: AlertType): DialogInput {
  return type === "default" ? "plain-text" : type;
}

/**
 * React Native's `Alert`:
 *
 * - `Alert.alert(title, message?, buttons?, options?)` shows a dialog with the buttons
 *   (React Native's `OK` when none) and calls the pressed one's `onPress`.
 * - `Alert.prompt(title, message?, callbackOrButtons?, type?, defaultValue?, keyboardType?,
 *   options?)` adds a text field (`"secure-text"`: a password field; `"login-password"`: both,
 *   and `onPress` receives `{ login, password }`); a callback becomes React Native's
 *   `Cancel` / `OK` pair.
 *
 * Inside the Capacitor shell with `@capacitor/dialog` (`denext mobile add dialog`) a dialog
 * with one or two buttons, or a plain-text prompt, is the system dialog; anything else, and
 * everything in a browser, is an in-page `role="alertdialog"` modal that keeps focus inside,
 * shows `destructive` buttons in red, presses the `cancel`-style button on Escape and, when
 * `cancelable`, is dismissed by a tap outside (calling `onDismiss`). Dialogs queue.
 *
 * @example
 * ```ts
 * import { Alert } from "react-native";
 *
 * Alert.alert("Delete thread?", "This cannot be undone.", [
 *   { text: "Cancel", style: "cancel" },
 *   { text: "Delete", style: "destructive", onPress: () => remove(id) },
 * ]);
 * ```
 */
export class Alert {
  /**
   * Show an alert.
   *
   * @param title The title.
   * @param message The message under it.
   * @param buttons The buttons (default: one `OK`).
   * @param options `cancelable` and `onDismiss`.
   */
  static alert(
    title: string,
    message?: string | null,
    buttons?: AlertButton[] | null,
    options?: AlertOptions,
  ): void {
    const list = buttons && buttons.length > 0 ? buttons : [OK];
    showDialog({
      title: String(title ?? ""),
      ...(message ? { message: String(message) } : {}),
      buttons: dialogButtons(list),
      ...(options?.cancelable ? { cancelable: true } : {}),
    }).then((result) => settle(result, list, options), () => {});
  }

  /**
   * Show a prompt.
   *
   * @param title The title.
   * @param message The message under it.
   * @param callbackOrButtons Called with the text on OK, or the buttons (each `onPress`
   *   receives the text).
   * @param type The field(s): `"plain-text"` (default), `"secure-text"`, `"login-password"`.
   * @param defaultValue The field's initial text.
   * @param keyboardType The field's keyboard (as its `inputmode`).
   * @param options `cancelable` and `onDismiss`.
   */
  static prompt(
    title: string,
    message?: string | null,
    callbackOrButtons?: ((text: string) => void) | AlertButton[] | null,
    type: AlertType = "plain-text",
    defaultValue?: string,
    keyboardType?: string,
    options?: AlertOptions,
  ): void {
    const list: AlertButton[] = typeof callbackOrButtons === "function"
      ? [
        { text: "Cancel", style: "cancel" },
        { text: "OK", onPress: (value) => callbackOrButtons(value as string) },
      ]
      : callbackOrButtons && callbackOrButtons.length > 0
      ? callbackOrButtons
      : [{ text: "Cancel", style: "cancel" }, OK];
    const mode = keyboardType ? INPUT_MODES[keyboardType] : undefined;
    showDialog({
      title: String(title ?? ""),
      ...(message ? { message: String(message) } : {}),
      buttons: dialogButtons(list),
      input: dialogInput(type),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(mode ? { inputMode: mode } : {}),
      ...(options?.cancelable ? { cancelable: true } : {}),
    }).then((result) => settle(result, list, options, promptValue(result, type)), () => {});
  }
}
