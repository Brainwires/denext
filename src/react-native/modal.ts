/**
 * React Native's `Modal` back action for React Native mode: on Android a visible modal takes the
 * back button and the back gesture, calling `onRequestClose` (and nothing under it runs: not
 * the screen's `BackHandler` handlers, not the router). react-native-web's `Modal` closes only
 * on Escape, so in the Android shell a back press while a modal is open went to the screen
 * behind it. React Native mode's build wraps react-native-web's `Modal` with
 * {@linkcode withModalBackHandler}; outside the Android shell it renders exactly as before
 * (react-native-web keeps Escape on every platform).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../jsx/types.ts";
import { useEffect, useRef } from "../runtime/hooks.ts";
import { BackHandler } from "./back-handler.ts";

/** The props the wrapper reads (all go on to react-native-web's `Modal`). */
interface ModalProps {
  readonly visible?: boolean;
  readonly onRequestClose?: () => void;
  readonly [prop: string]: unknown;
}

/**
 * While a modal is visible, consume the back action and call its latest `onRequestClose`. The
 * handler is registered when the modal opens, so a modal opened later (on top) gets the back
 * action first, and one inside the modal's content (whose effects run before the modal's own)
 * sits under it, as React Native's dialog keeps `BackHandler` handlers from running.
 *
 * @param visible Whether the modal is shown.
 * @param onRequestClose The app's close request.
 */
function useModalBackHandler(visible: boolean, onRequestClose?: () => void): void {
  const latest = useRef(onRequestClose);
  latest.current = onRequestClose;
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      latest.current?.();
      return true;
    });
    return () => sub.remove();
  }, [visible]);
}

/**
 * react-native-web's `Modal` with Android's back action (see the module docs).
 *
 * @param Modal react-native-web's `Modal` (React Native mode passes it in).
 * @returns The wrapped `Modal`.
 */
export function withModalBackHandler(Modal: VNodeType): VNodeType {
  function RNModal(props: ModalProps): VNode {
    useModalBackHandler(props.visible !== false, props.onRequestClose);
    return h(Modal, props);
  }
  return Object.assign(RNModal, { displayName: "Modal" }) as unknown as VNodeType;
}
