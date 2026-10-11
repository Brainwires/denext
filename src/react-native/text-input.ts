/**
 * React Native's `TextInput` look for React Native mode: react-native-web's `<input>` /
 * `<textarea>` keep two browser defaults a React Native text input does not have.
 *
 * - The focus ring: React Native draws no outline (`outlineWidth` 0, `outlineStyle` solid), so
 *   the input gets those as its base style; an app's own `outline*` style or Tailwind class
 *   still applies on top.
 * - A wrapping placeholder: React Native lays the placeholder out on one line, so a long one in
 *   a `multiline` input that is a line tall (a chat composer) does not wrap onto a clipped second
 *   line; it is cut with an ellipsis (`white-space: nowrap; text-overflow: ellipsis`).
 *
 * React Native mode's build wraps react-native-web's `TextInput` with
 * {@linkcode withTextInputDefaults}.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../jsx/types.ts";

/** The class the placeholder rule targets. */
export const TEXT_INPUT_CLASS = "denext-rn-textinput";

/** React Native's outline: none drawn, but an app's `outlineWidth` alone shows a solid one. */
const BASE_STYLE = { outlineWidth: 0, outlineStyle: "solid" };

/** The class as react-native-web's compiled-style object (`$$css`), merged into `className`. */
const CLASS_STYLE = { $$css: true, denextTextInput: TEXT_INPUT_CLASS };

/** The stylesheet the class needs (the placeholder is a pseudo-element: no inline style). */
const RULE = `.${TEXT_INPUT_CLASS}::placeholder{white-space:nowrap;overflow:hidden;` +
  `text-overflow:ellipsis}`;

/** The documents that have the rule. */
const styled = new WeakSet<object>();

/** Add the placeholder rule to the document once. */
function ensureRule(): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.head || typeof doc.createElement !== "function" || styled.has(doc)) return;
  styled.add(doc);
  const id = "denext-rn-textinput-style";
  if (doc.getElementById?.(id)) return;
  const el = doc.createElement("style");
  el.id = id;
  el.textContent = RULE;
  doc.head.appendChild(el);
}

/**
 * react-native-web's `TextInput` with React Native's look (see the module comment). Its statics
 * (`State`, …) are kept.
 *
 * @param TextInput react-native-web's `TextInput`.
 * @returns The wrapped component.
 */
export function withTextInputDefaults(TextInput: VNodeType): VNodeType {
  function RNTextInput(props: { style?: unknown }): VNode {
    ensureRule();
    return h(TextInput, { ...props, style: [BASE_STYLE, CLASS_STYLE, props.style] });
  }
  const statics = Object.fromEntries(
    Object.entries(TextInput as unknown as Record<string, unknown>)
      .filter(([k]) => k !== "$$typeof" && k !== "render"),
  );
  return Object.assign(RNTextInput, statics, { displayName: "TextInput" }) as unknown as VNodeType;
}
