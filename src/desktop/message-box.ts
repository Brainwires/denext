/**
 * Native message boxes for desktop extensions: {@linkcode DesktopExtensionHost.confirm} over the
 * runtime's `Deno.desktop.dialog.showMessageBox` (NSAlert, TaskDialogIndirect, GtkMessageDialog).
 * The box is app-modal, so it works with no window open: an `onBeforeQuit` guard asking "Quit
 * anyway?" after the last window closed, or a tray app.
 *
 * RUNTIME-ONLY, like {@link ./extension.ts}'s host: never imported by a client bundle.
 *
 * @module
 */

import { DesktopCapError, type DesktopConfirmOptions } from "./extension.ts";
import { supportsMessageDialog } from "../build/deno-version.ts";

/** What `Deno.desktop.dialog.showMessageBox` resolves with. */
interface MessageBoxResult {
  readonly response: number;
  readonly cancelled: boolean;
}

/** The slice of the runtime's `Deno.desktop` a confirm uses. */
interface MessageBoxApi {
  readonly dialog?: {
    readonly showMessageBox?: (options: Record<string, unknown>) => Promise<MessageBoxResult>;
  };
}

/** Where {@linkcode desktopConfirm} finds the runtime (tests pass fakes). */
export interface DesktopConfirmDeps {
  /** The runtime's `Deno.desktop` (default the global one). */
  readonly desktop?: unknown;
  /** The Deno Desktop runtime's version (default `Deno.version.deno`). */
  readonly runtimeVersion?: string;
}

const KINDS = new Set(["info", "warning", "error"]);
const MAX_BUTTONS = 16;

function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** A button index the options name, or `undefined`; anything else is a `validation` error. */
function buttonIndex(value: unknown, key: string, count: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= count) {
    throw invalid(`confirm: ${key} must be the index of a button (0 to ${count - 1})`);
  }
  return value;
}

/** The message and the optional texts, checked. */
function checkTexts(options: DesktopConfirmOptions): void {
  if (typeof options.message !== "string" || options.message === "") {
    throw invalid("confirm: message must be a non-empty string");
  }
  for (const key of ["detail", "title"] as const) {
    const v = options[key];
    if (v !== undefined && typeof v !== "string") throw invalid(`confirm: ${key} must be a string`);
  }
  if (options.kind !== undefined && !KINDS.has(options.kind)) {
    throw invalid("confirm: kind must be info, warning or error");
  }
}

/** A copy of the labels, checked. */
function checkButtons(buttons: unknown): string[] {
  if (buttons === undefined) return [];
  if (!Array.isArray(buttons) || !buttons.every((b) => typeof b === "string")) {
    throw invalid("confirm: buttons must be an array of strings");
  }
  if (buttons.length > MAX_BUTTONS) throw invalid(`confirm: at most ${MAX_BUTTONS} buttons`);
  return [...buttons];
}

/** Check `options` and build `showMessageBox`'s (Electron's names). */
function messageBoxOptions(options: DesktopConfirmOptions): Record<string, unknown> {
  if (options === null || typeof options !== "object") {
    throw invalid("confirm: options must be an object");
  }
  checkTexts(options);
  const buttons = checkButtons(options.buttons);
  const count = Math.max(buttons.length, 1);
  const ids = {
    defaultId: buttonIndex(options.defaultId, "defaultId", count),
    cancelId: buttonIndex(options.cancelId, "cancelId", count),
  };
  const optional = { detail: options.detail, title: options.title, ...ids };
  const out: Record<string, unknown> = {
    message: options.message,
    type: options.kind ?? "info",
    buttons,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Ask the user with the OS's own message box, app-modal (no window needed). Resolves the pressed
 * button's index; a box dismissed without a button (Escape or the close button with no cancel
 * button, the app quitting) resolves `cancelId`, or `null` without one. Rejects with a
 * `validation` {@linkcode DesktopCapError} for bad options, and with an `unsupported` one (status
 * 501) on a runtime without native message boxes (before
 * `FIRST_MESSAGE_DIALOG_RUNTIME`, or one whose `Deno.desktop.dialog` has no `showMessageBox`).
 *
 * @param options The message, the buttons and which one Return / Escape press.
 * @param deps Where the runtime is (tests).
 * @returns The pressed button's index, or `cancelId` / `null` when dismissed.
 */
export async function desktopConfirm(
  options: DesktopConfirmOptions,
  deps: DesktopConfirmDeps = {},
): Promise<number | null> {
  const request = messageBoxOptions(options);
  const api = (deps.desktop ?? (Deno as unknown as { desktop?: unknown }).desktop) as
    | MessageBoxApi
    | undefined;
  const show = api?.dialog?.showMessageBox;
  const version = deps.runtimeVersion ?? Deno.version.deno;
  if (typeof show !== "function" || !supportsMessageDialog(version)) {
    throw new DesktopCapError(
      "unsupported",
      "host.confirm needs a Deno Desktop runtime with native message boxes " +
        "(Deno.desktop.dialog.showMessageBox)",
      { status: 501 },
    );
  }
  let result: MessageBoxResult;
  try {
    result = await show.call(api!.dialog, request);
  } catch (err) {
    if (err instanceof TypeError || err instanceof RangeError) {
      throw invalid(`confirm: ${err.message}`);
    }
    throw new DesktopCapError("dialog_failed", "the native message box could not be shown", {
      status: 500,
    });
  }
  if (result.cancelled) return (request.cancelId as number | undefined) ?? null;
  return result.response;
}
