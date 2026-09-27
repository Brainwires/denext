/**
 * `@expo/ui/community/datetime-picker` for denext: the same `DateTimePicker` React Native mode
 * gives `@react-native-community/datetimepicker` (the two are API-compatible): an
 * `<input type="date" | "time" | "datetime-local">` with `onChange` / `onValueChange` /
 * `onDismiss`, `minimumDate` / `maximumDate` and `disabled`. `@expo/ui`'s own web build renders
 * nothing.
 *
 * @example
 * ```ts
 * import DateTimePicker from "denext/expo/ui/community/datetime-picker";
 * import { h } from "denext/jsx-runtime";
 *
 * h(DateTimePicker, { value: new Date(), mode: "date", onValueChange: (_e, d) => console.log(d) });
 * ```
 *
 * @module
 */

import DateTimePicker from "../react-native-compat/datetimepicker.ts";

export {
  type ButtonType,
  type DateTimePickerChangeEvent,
  type DateTimePickerEvent,
  type DateTimePickerMode,
  type DateTimePickerProps,
  type EvtTypes,
} from "../react-native-compat/datetimepicker.ts";
export { DateTimePicker };
export default DateTimePicker;
