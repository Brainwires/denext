/**
 * The LISTEN mask: the event bits for the handlers a node actually has, so the host sends nothing
 * nobody listens for.
 *
 * @module
 */

import { KIND, LISTEN } from "./props.generated.ts";

/** The press handlers: any of them makes a Pressable or Text listen for presses. */
export const PRESS_HANDLERS = ["onPress", "onPressIn", "onPressOut", "onLongPress"] as const;

/** Whether `props` has a function under any of `names`. */
function hasAny(props: Record<string, unknown>, names: readonly string[]): boolean {
  return names.some((name) => typeof props[name] === "function");
}

/**
 * The LISTEN mask for a node of `kind` with `props`: a bit only for the handlers present (a
 * controlled TextInput listens for text even without one, to keep its event count).
 *
 * @param kind The node's kind.
 * @param props Its props.
 * @returns The mask.
 */
export function listenMask(kind: number, props: Record<string, unknown>): number {
  let mask = 0;
  const pressable = kind === KIND.Pressable || kind === KIND.Text;
  if (pressable && hasAny(props, PRESS_HANDLERS)) mask |= LISTEN.press;
  if (hasAny(props, ["onLayout"])) mask |= LISTEN.layout;
  if (kind === KIND.ScrollView && hasAny(props, ["onScroll"])) mask |= LISTEN.scroll;
  if (hasAny(props, ["onFocus", "onBlur"])) mask |= LISTEN.focus;
  if (
    kind === KIND.TextInput &&
    (hasAny(props, ["onChangeText", "onChange", "onSubmitEditing", "onSelectionChange"]) ||
      typeof props.value === "string")
  ) mask |= LISTEN.text;
  if (hasAny(props, ["onKeyPress"])) mask |= LISTEN.key;
  if (kind === KIND.Image && hasAny(props, ["onLoad", "onError", "onLoadEnd"])) {
    mask |= LISTEN.image;
  }
  return mask;
}
