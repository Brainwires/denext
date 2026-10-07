/**
 * `expo-checkbox` for denext: `Checkbox` as a real `<input type="checkbox">` (keyboard and
 * screen-reader accessible, form-submittable) under a drawn box in Expo's look — 16 × 16 by
 * default, `color` for the checked fill and the border, greyed when `disabled`. It is
 * controlled, as Expo's: render it with `value` and update that from `onValueChange`.
 *
 * @example
 * ```ts
 * import Checkbox from "denext/expo/checkbox";
 * import { h, useState } from "denext";
 *
 * function Agree() {
 *   const [on, setOn] = useState(false);
 *   return h(Checkbox, { value: on, onValueChange: setOn, color: on ? "#4630EB" : undefined });
 * }
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { hostView, viewStyle } from "./internal/common.ts";

/** What `onChange` receives in `nativeEvent`. */
export interface CheckboxEvent {
  /** The input element. */
  // deno-lint-ignore no-explicit-any
  target: any;
  /** The new value. */
  value: boolean;
}

/** `Checkbox` props (plus any view prop). */
export interface CheckboxProps {
  /** Whether it is checked (default `false`). */
  value?: boolean;
  /** Whether it ignores input (default `false`). */
  disabled?: boolean;
  /** The checked fill and the border colour. */
  color?: string;
  /** Called with the change event (`event.nativeEvent.value` is the new value). */
  onChange?: (event: { nativeEvent: CheckboxEvent }) => void;
  /** Called with the new value. */
  onValueChange?: (value: boolean) => void;
  /** The style (its size is the box's). */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** Expo's check mark: a white tick, drawn over the checked fill. */
const CHECK_MARK = 'url("data:image/svg+xml,' +
  "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Cpath d='M.04.63.15.52.43.8" +
  ".32.91zM.22.8.85.17.96.27.32.91z' fill='%23fff'/%3E%3C/svg%3E\")";

/** Expo's default checked colour. */
const CHECKED = "#009688";

/** The drawn box's style for the state. */
function boxStyle(value: boolean, disabled: boolean, color?: string): Record<string, unknown> {
  let border = color ?? (value ? CHECKED : "#657786");
  let fill = value ? color ?? CHECKED : "#fff";
  if (disabled) {
    border = value ? "#AAB8C2" : "#CCD6DD";
    if (value) fill = "#AAB8C2";
  }
  return {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    boxSizing: "border-box",
    borderRadius: "2px",
    border: `2px solid ${border}`,
    backgroundColor: fill,
    ...(value
      ? { backgroundImage: CHECK_MARK, backgroundRepeat: "no-repeat", backgroundSize: "100% 100%" }
      : {}),
  };
}

/**
 * A checkbox.
 *
 * @param props The value, colour, handlers and view props.
 * @returns The checkbox.
 */
export function Checkbox(props: CheckboxProps): VNode {
  const { value = false, disabled = false, color, onChange, onValueChange, style, ...rest } = props;
  const handle = (event: { target?: { checked?: boolean } }) => {
    const target = event?.target;
    const next = Boolean(target?.checked);
    onChange?.({ ...event, nativeEvent: { target, value: next } });
    onValueChange?.(next);
  };
  const input = h("input", {
    type: "checkbox",
    checked: value,
    disabled,
    "aria-checked": value,
    "aria-disabled": disabled,
    onChange: handle,
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      margin: 0,
      padding: 0,
      opacity: 0,
      cursor: "inherit",
    },
  } as never);
  const box = h(
    "span",
    { "aria-hidden": "true", style: boxStyle(value, disabled, color) } as never,
  );
  return h(
    hostView(),
    {
      ...rest,
      style: viewStyle(style, {
        width: 16,
        height: 16,
        cursor: disabled ? "default" : "pointer",
        userSelect: "none",
      }),
    } as never,
    input,
    box,
  );
}

export default Checkbox;
