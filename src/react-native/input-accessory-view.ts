/**
 * React Native's `InputAccessoryView` for React Native mode: a bar that rides on top of the
 * keyboard, drawn with `denext/mobile`'s `KeyboardStickyView`. react-native-web ships it as an
 * `UnimplementedView` and leaves it out of its entry.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import { useEffect, useState } from "../runtime/hooks.ts";
import { KeyboardStickyView } from "../mobile/keyboard-views.ts";

/** Props of React Native's `InputAccessoryView`. */
export interface InputAccessoryViewProps {
  /** The bar's content. */
  readonly children?: VNodeChildren;
  /**
   * The id text inputs name in `inputAccessoryViewID`. With one, the bar shows only while a
   * text field is being edited; without one, it is always shown (a sticky composer).
   */
  readonly nativeID?: string;
  /** The bar's style. */
  readonly style?: unknown;
  /** The bar's background colour. */
  readonly backgroundColor?: string;
}

/** The slice of an element the focus check reads. */
interface Focusable {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  readonly type?: string;
}

/** `<input>` types that bring up a text keyboard. */
const NON_TEXT_INPUTS = /^(?:button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i;

/** Whether `el` is a text field (a keyboard is up while it has focus). */
function isTextField(el: unknown): boolean {
  const node = el as Focusable | null | undefined;
  if (!node) return false;
  if (node.isContentEditable === true) return true;
  const tag = node.tagName?.toUpperCase();
  if (tag === "TEXTAREA") return true;
  return tag === "INPUT" && !NON_TEXT_INPUTS.test(node.type ?? "text");
}

/** Whether a text field has focus, followed live while `enabled`. */
function useEditing(enabled: boolean): boolean {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const doc = (globalThis as {
      document?: EventTarget & { activeElement?: unknown };
    }).document;
    if (typeof doc?.addEventListener !== "function") return;
    setEditing(isTextField(doc.activeElement));
    const onIn = (e: Event) => setEditing(isTextField(e.target));
    const onOut = (e: Event) =>
      setEditing(isTextField((e as Event & { relatedTarget?: unknown }).relatedTarget));
    doc.addEventListener("focusin", onIn);
    doc.addEventListener("focusout", onOut);
    return () => {
      doc.removeEventListener("focusin", onIn);
      doc.removeEventListener("focusout", onOut);
    };
  }, [enabled]);
  return editing;
}

/** The fixed strip along the bottom of the screen the bar rides in. */
const DOCK = { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 1000 } as const;

/**
 * React Native's `InputAccessoryView` over react-native-web's `View`: its children in a
 * `View` (with `backgroundColor` and `style`) docked to the bottom of the screen and lifted on
 * top of the keyboard while it is up, through `denext/mobile`'s `KeyboardStickyView` (it moves
 * by the part of the keyboard that covers the page, so a web view that resizes around the
 * keyboard does not lift it twice).
 *
 * With a `nativeID` the bar is shown only while a text field is being edited, as React Native
 * shows it only for the inputs whose `inputAccessoryViewID` names it (a web view cannot tell
 * which input names which bar, so any text field shows it); without one it is always shown,
 * React Native's sticky-composer use.
 *
 * @param View react-native-web's `View` (React Native mode passes it in).
 * @returns The component.
 */
export function createInputAccessoryView(
  View: VNodeType,
): (props: InputAccessoryViewProps) => VNode | null {
  function InputAccessoryView(props: InputAccessoryViewProps): VNode | null {
    const { children, nativeID, style, backgroundColor } = props;
    const editing = useEditing(nativeID !== undefined);
    if (nativeID !== undefined && !editing) return null;
    return h(
      KeyboardStickyView,
      { style: DOCK, "data-denext-input-accessory": nativeID ?? "" },
      h(View, {
        ...(nativeID !== undefined ? { nativeID } : {}),
        style: [backgroundColor ? { backgroundColor } : null, style],
      }, children),
    );
  }
  return InputAccessoryView;
}
