/**
 * `@react-native-community/datetimepicker` for denext (React Native mode). The package ships
 * Flow source with no web build (its `main` does not parse), so React Native mode resolves it
 * here.
 *
 * - `DateTimePicker` (the default export) renders an `<input type="date" | "time" |
 *   "datetime-local">` for `mode` `date` / `time` / `datetime` (`countdown` edits hours and
 *   minutes as a time), inline, as iOS draws it; every edit calls `onChange({ type: "set" },
 *   date)` and `onValueChange`. In the Android shell it behaves as on Android instead: mounting
 *   it opens a dialog, and OK / Cancel / the neutral button call `onChange` with `set` /
 *   `dismissed` / `neutralButtonPressed` (plus `onDismiss` / `onNeutralButtonPress`).
 * - `DateTimePickerAndroid.open(options)` opens that dialog imperatively (on every platform);
 *   `dismiss()` closes it as dismissed.
 * - `minimumDate` / `maximumDate` become the input's `min` / `max`, `minuteInterval` its
 *   `step`; `timeZoneOffsetInMinutes` edits in that fixed offset; `accentColor`, `textColor`
 *   and `themeVariant` style it. `display`, `locale`, `timeZoneName`, `is24Hour` and the
 *   Material options are accepted and ignored (the browser's picker follows the device).
 *
 * @example
 * ```ts
 * import DateTimePicker from "@react-native-community/datetimepicker"; // → this module
 * import { h } from "denext/jsx-runtime";
 *
 * h(DateTimePicker, { value: new Date(), mode: "date", onChange: (_e, d) => console.log(d) });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useRef } from "../runtime/hooks.ts";
import { runtimePlatform } from "../mobile/bridge.ts";
import { hostView, viewStyle } from "../expo/internal/common.ts";
import {
  clampDate,
  type DateInputMode,
  fromInputValue,
  inputLimits,
  inputType,
  openDateDialog,
  toInputValue,
} from "./internal/date-input.ts";

/** What happened: a date was picked, the dialog was dismissed, or the neutral button pressed. */
export type EvtTypes = "set" | "neutralButtonPressed" | "dismissed";

/** The event `onChange` receives. */
export interface DateTimePickerEvent {
  /** What happened. */
  type: EvtTypes;
  /** The picked date's timestamp and UTC offset (minutes). */
  nativeEvent: { timestamp: number; utcOffset: number };
}

/** The event `onValueChange` receives. */
export interface DateTimePickerChangeEvent {
  /** The picked date's timestamp and UTC offset (minutes). */
  nativeEvent: { timestamp: number; utcOffset: number };
}

/** A dialog button's label and colour (Android). */
export interface ButtonType {
  /** The label. */
  label?: string;
  /** The text colour (ignored). */
  textColor?: unknown;
}

/** The picker's mode. */
export type DateTimePickerMode = "date" | "time" | "datetime" | "countdown";

/** `DateTimePicker` props (the iOS and Android props together, plus any view prop). */
export interface DateTimePickerProps {
  /** The date shown. */
  value: Date;
  /** What the picker edits (default `date`). */
  mode?: DateTimePickerMode;
  /** Called when a date is picked, or the dialog is dismissed. */
  onChange?: (event: DateTimePickerEvent, date?: Date) => void;
  /** Called when a date is picked. */
  onValueChange?: (event: DateTimePickerChangeEvent, date: Date) => void;
  /** Called when the dialog is dismissed (Android). */
  onDismiss?: () => void;
  /** Called on the neutral button (Android). */
  onNeutralButtonPress?: () => void;
  /** The earliest date. */
  minimumDate?: Date;
  /** The latest date. */
  maximumDate?: Date;
  /** The minute step. */
  minuteInterval?: number;
  /** Edit in this fixed UTC offset instead of local time. */
  timeZoneOffsetInMinutes?: number;
  /** An IANA zone (ignored; local time is used). */
  timeZoneName?: string;
  /** Disable the input. */
  disabled?: boolean;
  /** The test id (`data-testid` on the input). */
  testID?: string;
  /** The input's accent colour. */
  accentColor?: string;
  /** The input's text colour. */
  textColor?: string;
  /** Light or dark. */
  themeVariant?: "dark" | "light";
  /** The Android dialog's title. */
  title?: string;
  /** The Android dialog's confirm button. */
  positiveButton?: ButtonType;
  /** The Android dialog's cancel button. */
  negativeButton?: ButtonType;
  /** The Android dialog's neutral button. */
  neutralButton?: ButtonType;
  /** The style of the view around the input. */
  style?: unknown;
  /** Other props (`display`, `locale`, `is24Hour`, … are accepted and ignored). */
  [prop: string]: unknown;
}

/** The input mode for a picker mode (`countdown` edits a time). */
function modeOf(mode: DateTimePickerMode | undefined): DateInputMode {
  if (mode === "time" || mode === "countdown") return "time";
  return mode === "datetime" ? "datetime" : "date";
}

/** The UTC offset (minutes) reported for `date`. */
function utcOffsetOf(date: Date, fixed?: number): number {
  return fixed ?? -date.getTimezoneOffset();
}

/**
 * The `onChange` arguments for a picked date.
 *
 * @param date The date.
 * @param utcOffset Its UTC offset in minutes.
 * @returns `[event, date]`.
 */
export function createDateTimeSetEvtParams(
  date: Date,
  utcOffset: number,
): [DateTimePickerEvent, Date] {
  return [{ type: "set", nativeEvent: { timestamp: date.getTime(), utcOffset } }, date];
}

/**
 * The `onChange` arguments for a dismissed dialog.
 *
 * @param date The date the picker held.
 * @param utcOffset Its UTC offset in minutes.
 * @returns `[event, date]`.
 */
export function createDismissEvtParams(
  date: Date,
  utcOffset: number,
): [DateTimePickerEvent, Date] {
  return [{ type: "dismissed", nativeEvent: { timestamp: date.getTime(), utcOffset } }, date];
}

/**
 * The `onChange` arguments for the neutral button.
 *
 * @param date The date the picker held.
 * @param utcOffset Its UTC offset in minutes.
 * @returns `[event, date]`.
 */
export function createNeutralEvtParams(
  date: Date,
  utcOffset: number,
): [DateTimePickerEvent, Date] {
  return [
    { type: "neutralButtonPressed", nativeEvent: { timestamp: date.getTime(), utcOffset } },
    date,
  ];
}

/** Open the Android-style dialog for `props`; returns its closer. */
function openFor(props: DateTimePickerProps): (silent?: boolean) => void {
  const value = props.value instanceof Date ? props.value : new Date();
  const fixed = props.timeZoneOffsetInMinutes;
  return openDateDialog({
    mode: modeOf(props.mode),
    value,
    minimumDate: props.minimumDate,
    maximumDate: props.maximumDate,
    minuteInterval: props.minuteInterval,
    offsetMinutes: fixed,
    title: props.title,
    confirmText: props.positiveButton?.label,
    cancelText: props.negativeButton?.label,
    neutralText: props.neutralButton?.label,
    theme: props.themeVariant,
    onConfirm(date) {
      const [event] = createDateTimeSetEvtParams(date, utcOffsetOf(date, fixed));
      props.onChange?.(event, date);
      props.onValueChange?.({ nativeEvent: event.nativeEvent }, date);
    },
    onCancel() {
      props.onChange?.(...createDismissEvtParams(value, utcOffsetOf(value, fixed)));
      props.onDismiss?.();
    },
    onNeutral() {
      props.onChange?.(...createNeutralEvtParams(value, utcOffsetOf(value, fixed)));
      props.onNeutralButtonPress?.();
    },
  });
}

/** The dialog {@linkcode DateTimePickerAndroid.open} showed last, while it is open. */
let openDialog: ((silent?: boolean) => void) | null = null;

/** Android's imperative picker API. */
export const DateTimePickerAndroid: {
  /** Open a picker dialog for `options` (the component's props). */
  open(options: DateTimePickerProps): void;
  /** Close the open dialog as dismissed. */
  dismiss(mode?: string): Promise<boolean>;
} = {
  open(options) {
    openDialog?.(true);
    const close = openFor({
      ...options,
      onChange: (event, date) => {
        openDialog = null;
        options.onChange?.(event, date);
      },
    });
    openDialog = close;
  },
  dismiss() {
    const close = openDialog;
    openDialog = null;
    close?.();
    return Promise.resolve(close !== null);
  },
};

/**
 * A date / time picker: an inline input, or (in the Android shell) a dialog opened on mount.
 *
 * @param props The value, mode, limits and callbacks.
 * @returns The input, or nothing while the dialog shows.
 */
export default function DateTimePicker(props: DateTimePickerProps): VNode {
  const dialog = runtimePlatform() === "android";
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    if (!dialog) return;
    const close = openFor({
      ...latest.current,
      onChange: (e, d) => latest.current.onChange?.(e, d),
      onValueChange: (e, d) => latest.current.onValueChange?.(e, d),
      onDismiss: () => latest.current.onDismiss?.(),
      onNeutralButtonPress: () => latest.current.onNeutralButtonPress?.(),
    });
    return () => close(true);
  }, [dialog]);
  if (dialog) return null as unknown as VNode;
  const {
    value,
    mode: pickerMode,
    minimumDate,
    maximumDate,
    minuteInterval,
    timeZoneOffsetInMinutes: fixed,
    disabled,
    testID,
    accentColor,
    textColor,
    themeVariant,
    style,
  } = props;
  const mode = modeOf(pickerMode);
  const base = value instanceof Date ? value : new Date();
  const onInput = (event: { target?: { value?: string } }) => {
    const next = fromInputValue(event?.target?.value ?? "", mode, base, fixed);
    if (!next) return;
    const date = clampDate(next, minimumDate, maximumDate);
    const [e] = createDateTimeSetEvtParams(date, utcOffsetOf(date, fixed));
    latest.current.onChange?.(e, date);
    latest.current.onValueChange?.({ nativeEvent: e.nativeEvent }, date);
  };
  const inputStyle: Record<string, string> = { font: "inherit" };
  if (accentColor) inputStyle.accentColor = accentColor;
  if (textColor) inputStyle.color = textColor;
  if (themeVariant) inputStyle.colorScheme = themeVariant;
  return h(
    hostView(),
    { style: viewStyle(style) },
    h("input", {
      type: inputType(mode),
      value: toInputValue(base, mode, fixed),
      ...inputLimits(mode, minimumDate, maximumDate, minuteInterval, fixed),
      disabled: disabled === true,
      "data-testid": testID,
      style: inputStyle,
      onChange: onInput,
    }),
  );
}
