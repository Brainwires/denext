/**
 * `react-native-date-picker` for denext (React Native mode). The package's native pickers
 * have no web build (it renders "not supported" text, and its Flow source breaks the build),
 * so React Native mode resolves it here.
 *
 * - Inline (the default), `DatePicker` renders an `<input type="date" | "time" |
 *   "datetime-local">` for `mode` (default `datetime`); each edit calls `onDateChange(date)`.
 * - With `modal`, it renders nothing and shows a dialog while `open` is true: the confirm
 *   button calls `onConfirm(date)`, cancel (or Escape, or the backdrop) `onCancel()`.
 *   `title` (`null` hides it), `confirmText` and `cancelText` label it; `theme="dark"` darkens
 *   it.
 * - `minimumDate` / `maximumDate` bound the input, `minuteInterval` sets its step and
 *   `timeZoneOffsetInMinutes` edits in that fixed offset. `locale`, `is24hourSource`,
 *   `dividerColor`, `buttonColor` and `onStateChange` are accepted and ignored (the browser's
 *   picker follows the device).
 *
 * @example
 * ```ts
 * import DatePicker from "react-native-date-picker"; // → this module
 * import { h } from "denext/jsx-runtime";
 *
 * h(DatePicker, { modal: true, open: true, date: new Date(), onConfirm: (d) => console.log(d) });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useRef } from "../runtime/hooks.ts";
import { hostView, viewStyle } from "../expo/internal/common.ts";
import {
  clampDate,
  fromInputValue,
  inputLimits,
  inputType,
  openDateDialog,
  toInputValue,
} from "./internal/date-input.ts";

/** `DatePicker` props (plus any view prop). */
export interface DatePickerProps {
  /** The date shown. */
  date: Date;
  /** What the picker edits (default `datetime`). */
  mode?: "date" | "time" | "datetime";
  /** Called on every inline edit. */
  onDateChange?: (date: Date) => void;
  /** The earliest date. */
  minimumDate?: Date;
  /** The latest date. */
  maximumDate?: Date;
  /** The minute step (default 1). */
  minuteInterval?: number;
  /** Edit in this fixed UTC offset instead of local time. */
  timeZoneOffsetInMinutes?: number;
  /** Show as a dialog instead of inline. */
  modal?: boolean;
  /** Whether the dialog shows (with `modal`). */
  open?: boolean;
  /** The confirmed date (with `modal`). */
  onConfirm?: (date: Date) => void;
  /** The dialog was cancelled (with `modal`). */
  onCancel?: () => void;
  /** The confirm button's label (default `Confirm`). */
  confirmText?: string;
  /** The cancel button's label (default `Cancel`). */
  cancelText?: string;
  /** The dialog's title (default `Select date` / `Select time`; `null` hides it). */
  title?: string | null;
  /** `light`, `dark` or `auto` (default `auto`). */
  theme?: "light" | "dark" | "auto";
  /** The locale (ignored). */
  locale?: string;
  /** Where the 12 / 24 hour choice comes from (ignored). */
  is24hourSource?: "locale" | "device";
  /** The spinning state (never reported). */
  onStateChange?: (state: "spinning" | "idle") => void;
  /** The style of the view around the inline input. */
  style?: unknown;
  /** The test id (`data-testid` on the inline input). */
  testID?: string;
  /** Other props. */
  [prop: string]: unknown;
}

/** The dialog's default title for `mode`. */
function defaultTitle(mode: string): string {
  return mode === "time" ? "Select time" : "Select date";
}

/** The dialog theme for `theme` (`auto` follows the page's colour scheme). */
function dialogTheme(theme: DatePickerProps["theme"]): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  const media = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof media === "function" && media("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * A date / time picker: an inline input, or a dialog with `modal`.
 *
 * @param props The date, mode, limits and callbacks.
 * @returns The inline input, or nothing in `modal` mode.
 */
export default function DatePicker(props: DatePickerProps): VNode {
  const mode = props.mode ?? "datetime";
  const latest = useRef(props);
  latest.current = props;
  const showDialog = props.modal === true && props.open === true;
  useEffect(() => {
    if (!showDialog) return;
    const p = latest.current;
    const close = openDateDialog({
      mode,
      value: p.date instanceof Date ? p.date : new Date(),
      minimumDate: p.minimumDate,
      maximumDate: p.maximumDate,
      minuteInterval: p.minuteInterval,
      offsetMinutes: p.timeZoneOffsetInMinutes,
      title: p.title === undefined ? defaultTitle(mode) : p.title,
      confirmText: p.confirmText ?? "Confirm",
      cancelText: p.cancelText ?? "Cancel",
      theme: dialogTheme(p.theme),
      onConfirm: (date) => latest.current.onConfirm?.(date),
      onCancel: () => latest.current.onCancel?.(),
    });
    return () => close(true);
  }, [showDialog, mode]);
  if (props.modal) return null as unknown as VNode;
  const { date, minimumDate, maximumDate, minuteInterval, timeZoneOffsetInMinutes: fixed } = props;
  const base = date instanceof Date ? date : new Date();
  const theme = props.theme === "light" || props.theme === "dark" ? props.theme : undefined;
  return h(
    hostView(),
    { style: viewStyle(props.style) },
    h("input", {
      type: inputType(mode),
      value: toInputValue(base, mode, fixed),
      ...inputLimits(mode, minimumDate, maximumDate, minuteInterval, fixed),
      "data-testid": props.testID,
      style: theme ? { font: "inherit", colorScheme: theme } : { font: "inherit" },
      onChange: (event: { target?: { value?: string } }) => {
        const next = fromInputValue(event?.target?.value ?? "", mode, base, fixed);
        if (next) latest.current.onDateChange?.(clampDate(next, minimumDate, maximumDate));
      },
    }),
  );
}
