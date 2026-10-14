/**
 * React Native's `Modal` back action for React Native mode: on Android a visible modal takes the
 * back button and the back gesture, calling `onRequestClose` (and nothing under it runs: not
 * the screen's `BackHandler` handlers, not the router). react-native-web's `Modal` closes only
 * on Escape, so in the Android shell a back press while a modal is open went to the screen
 * behind it. React Native mode's build wraps react-native-web's `Modal` with
 * {@linkcode withModalBackHandler}; outside the Android shell it renders exactly as before
 * (react-native-web keeps Escape on every platform).
 *
 * The same wrapper draws two more of React Native's `Modal` props:
 *
 * - `backdropColor` (React Native 0.79+): the background of an opaque modal (react-native-web's
 *   is always white).
 * - `presentationStyle="pageSheet"` / `"formSheet"` in the iOS shell: a sheet with rounded top
 *   corners below the status bar over the dimmed screen, as iOS presents one. Dragging it down
 *   (from anywhere on it, or from a scroll view's top) and letting go past half its height, or
 *   flicking it, slides it away and calls `onRequestClose`, as React Native's iOS sheet does;
 *   `onDismiss` follows once the app hides the modal. A sheet the app keeps visible slides back.
 *   The drag is `Sheet`'s (`denext/navigation`). `"fullScreen"` / `"overFullScreen"`, and every
 *   style on Android and in a browser, are react-native-web's full-screen modal, as React Native
 *   ignores the prop off iOS.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType, VProps } from "../jsx/types.ts";
import { useCallback, useEffect, useRef } from "../runtime/hooks.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { attachSheetDrag } from "../navigation/sheet.ts";
import type { ListenerTarget } from "../navigation/listen.ts";
import { BackHandler } from "./back-handler.ts";

/** The props the wrapper reads (all go on to react-native-web's `Modal`). */
interface ModalProps {
  readonly visible?: boolean;
  readonly onRequestClose?: () => void;
  readonly transparent?: boolean;
  readonly backdropColor?: string;
  readonly presentationStyle?: "fullScreen" | "pageSheet" | "formSheet" | "overFullScreen";
  readonly children?: unknown;
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

/** The dimmed screen behind an iOS sheet. */
const SHEET_DIM = "rgba(0, 0, 0, 0.4)";

/**
 * The views a modal's children are drawn in for `backdropColor` and an iOS sheet, as
 * `[outer style, inner style]` (`inner` only for a sheet), or `null` to draw them as
 * react-native-web does.
 *
 * @param props The modal's props.
 * @param platform The shell's platform (`nativePlatform()`).
 * @returns The styles, or `null`.
 */
export function modalFrame(
  props: ModalProps,
  platform: string,
): [Record<string, unknown>, Record<string, unknown> | null] | null {
  if (props.transparent) return null;
  const sheet = platform === "ios" &&
    (props.presentationStyle === "pageSheet" || props.presentationStyle === "formSheet");
  const background = props.backdropColor ?? "white";
  if (sheet) {
    return [{ flex: 1, backgroundColor: SHEET_DIM }, {
      flex: 1,
      marginTop: "calc(env(safe-area-inset-top, 0px) + 10px)",
      borderTopLeftRadius: 10,
      borderTopRightRadius: 10,
      overflow: "hidden",
      backgroundColor: background,
    }];
  }
  return props.backdropColor ? [{ flex: 1, backgroundColor: background }, null] : null;
}

/** The iOS sheet's element, as its swipe-down uses it. */
export interface SwipeSheetElement extends ListenerTarget {
  readonly style: { transform: string; transition: string };
  getBoundingClientRect(): { height: number };
  contains?(node: unknown): boolean;
}

/** A scroll view's element, as the swipe reads it. */
interface ScrollerLike {
  readonly scrollTop?: number;
  readonly scrollHeight?: number;
  readonly clientHeight?: number;
  readonly parentNode?: unknown;
}

/** The nearest vertically scrollable element from `node` up to (not including) `sheet`. */
function scrollerAt(node: unknown, sheet: unknown): ScrollerLike | null {
  const style = (globalThis as { getComputedStyle?: (el: unknown) => { overflowY?: string } })
    .getComputedStyle;
  for (
    let el = node as ScrollerLike | null;
    el && el !== sheet;
    el = el.parentNode as ScrollerLike
  ) {
    if ((el.scrollHeight ?? 0) <= (el.clientHeight ?? 0) + 1) continue;
    const overflow = style ? style(el).overflowY : "auto";
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  return null;
}

/** How the swiped-away sheet slides, and how it settles back. */
const SHEET_SLIDE = "transform 250ms cubic-bezier(0.2, 0.9, 0.3, 1)";

/**
 * The iOS sheet's swipe-down to dismiss, on `sheet`: a drag down moves it (from a scroll view
 * inside it only once that is at its top), and a release past half its height or a flick slides
 * it away and calls `onRequestClose`; any other release settles it back. If the modal is still
 * open (`isOpen`) once the slide ends, it slides back.
 *
 * @param sheet The sheet's element.
 * @param onRequestClose Called when the swipe dismisses the sheet.
 * @param isOpen Whether the app still shows the modal.
 * @returns The detach function.
 */
export function attachSheetSwipe(
  sheet: SwipeSheetElement,
  onRequestClose: () => void,
  isOpen: () => boolean,
): () => void {
  let scroller: ScrollerLike | null = null;
  let dismissed = false;
  const full = () => sheet.getBoundingClientRect().height;
  const place = (offset: number, animate: boolean) => {
    sheet.style.transition = animate ? SHEET_SLIDE : "none";
    sheet.style.transform = `translateY(${Math.max(0, offset)}px)`;
  };
  const onEnd = () => {
    if (dismissed && isOpen()) place(0, true);
    dismissed = false;
  };
  sheet.addEventListener("transitionend", onEnd);
  const detachDrag = attachSheetDrag(sheet, {
    addEventListener: (t, f, o) => sheet.addEventListener(t, f, o),
    removeEventListener: (t, f, o) => sheet.removeEventListener(t, f, o),
    // A press over a scroll view is the content's until a downward drag from its top.
    contains(target: unknown) {
      scroller = scrollerAt(target, sheet);
      return scroller !== null;
    },
  }, {
    metrics: () => ({ heights: [full()], height: full(), dismissible: true }),
    scrollerAtTop: () => (scroller?.scrollTop ?? 0) <= 0,
    atLargest: () => true,
    follow: (height) => place(full() - height, false),
    release(result) {
      if (result !== "dismiss") return place(0, true);
      dismissed = true;
      place(full() + 40, true);
      onRequestClose();
    },
  });
  return () => {
    detachDrag();
    sheet.removeEventListener("transitionend", onEnd);
  };
}

/**
 * The callback ref that wires {@linkcode attachSheetSwipe} to an iOS sheet's element while the
 * modal is shown, calling the latest `onRequestClose`.
 */
function useSheetSwipe(props: ModalProps): (node: SwipeSheetElement | null) => void {
  const latest = useRef(props);
  latest.current = props;
  const detach = useRef<(() => void) | null>(null);
  useEffect(() => () => detach.current?.(), []);
  return useCallback((node: SwipeSheetElement | null) => {
    detach.current?.();
    detach.current = node
      ? attachSheetSwipe(
        node,
        () => latest.current.onRequestClose?.(),
        () => latest.current.visible !== false,
      )
      : null;
  }, []);
}

/**
 * react-native-web's `Modal` with Android's back action (see the module docs).
 *
 * @param Modal react-native-web's `Modal` (React Native mode passes it in).
 * @param View react-native-web's `View`, for `backdropColor` and the iOS sheet.
 * @returns The wrapped `Modal`.
 */
export function withModalBackHandler(Modal: VNodeType, View: VNodeType = "div"): VNodeType {
  function RNModal(props: ModalProps): VNode {
    useModalBackHandler(props.visible !== false, props.onRequestClose);
    const swipeRef = useSheetSwipe(props);
    const { backdropColor: _color, presentationStyle: _style, ...rest } = props;
    const frame = modalFrame(props, nativePlatform());
    if (!frame) return h(Modal, rest as VProps);
    const [outer, inner] = frame;
    const content = inner
      ? h(View, { style: inner, ref: swipeRef }, props.children as VNodeChild)
      : props.children;
    return h(Modal, {
      ...rest,
      transparent: true,
      children: h(View, { style: outer }, content as VNodeChild),
    } as VProps);
  }
  return Object.assign(RNModal, { displayName: "Modal" }) as unknown as VNodeType;
}
