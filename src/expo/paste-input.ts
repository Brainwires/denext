/**
 * `expo-paste-input` (the community package) for denext: `TextInputWrapper` wraps a text
 * input and reports pastes through `onPaste`, from the DOM `paste` event: text as
 * `{ type: "text", value }`, pasted images as `{ type: "images", uris }` (`blob:` URLs).
 * The paste itself still reaches the input.
 *
 * @example
 * ```ts
 * import { TextInputWrapper } from "denext/expo/paste-input";
 * import { h } from "denext/jsx-runtime";
 *
 * h(TextInputWrapper, { onPaste: (p) => p.type === "images" && attach(p.uris) }, input);
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { hostView, viewStyle } from "./internal/common.ts";

/** What `onPaste` receives. */
export type PasteEventPayload =
  | { type: "text"; value: string }
  | { type: "images"; uris: string[] }
  | { type: "unsupported" };

/** `TextInputWrapper` props. */
export interface TextInputWrapperViewProps {
  /** Called on each paste inside the wrapper. */
  onPaste?: (payload: PasteEventPayload) => void;
  /** The wrapped input. */
  children?: unknown;
  /** The style. */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** A DOM paste event as a payload. */
function payloadOf(event: ClipboardEvent): PasteEventPayload {
  const data = event.clipboardData;
  if (!data) return { type: "unsupported" };
  const images = [...data.files ?? []].filter((f) => f.type.startsWith("image/"));
  if (images.length > 0) {
    return { type: "images", uris: images.map((f) => URL.createObjectURL(f)) };
  }
  const text = data.getData("text/plain");
  return text ? { type: "text", value: text } : { type: "unsupported" };
}

/**
 * A wrapper that reports pastes in the input inside it.
 *
 * @param props `onPaste`, the style and the input.
 * @returns The wrapper view.
 */
export function TextInputWrapperView(props: TextInputWrapperViewProps): VNode {
  const { onPaste, children, style, ...rest } = props;
  // The listener sits on a layout-neutral `<div>`: react-native-web's View does not forward
  // `onPaste`, and the event bubbles up from the input either way.
  return h(
    "div",
    {
      style: { display: "contents" },
      onPaste: onPaste ? (event: ClipboardEvent) => onPaste(payloadOf(event)) : undefined,
    },
    h(hostView(), { ...rest, style: viewStyle(style) }, children as never),
  );
}

/** The same component as {@linkcode TextInputWrapperView}. */
export const TextInputWrapper: typeof TextInputWrapperView = TextInputWrapperView;
