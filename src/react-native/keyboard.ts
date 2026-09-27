/**
 * React Native's `Keyboard` and `KeyboardAvoidingView` for React Native mode, over
 * `denext/mobile`'s keyboard state (`@capacitor/keyboard`'s will-show / will-hide in the
 * Capacitor shell, the visual viewport or VirtualKeyboard API in a browser). react-native-web
 * ships both as mocks.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import { useRef, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { hideKeyboard, type KeyboardState, onKeyboardChange } from "../mobile/keyboard-state.ts";
import { useOverlap } from "../mobile/keyboard-views.ts";
import { type EmitterSubscription, type Listeners, listeners } from "./internal.ts";

/** The events React Native's `Keyboard` emits. */
export type KeyboardEventName =
  | "keyboardWillShow"
  | "keyboardDidShow"
  | "keyboardWillHide"
  | "keyboardDidHide"
  | "keyboardWillChangeFrame"
  | "keyboardDidChangeFrame";

/** The keyboard's frame, in CSS px of the layout viewport. */
export interface KeyboardMetrics {
  readonly screenX: number;
  readonly screenY: number;
  readonly width: number;
  readonly height: number;
}

/** React Native's keyboard animation curves. */
export type KeyboardEventEasing = "easeIn" | "easeInEaseOut" | "easeOut" | "linear" | "keyboard";

/** What a `Keyboard` listener receives. */
export interface KeyboardEvent {
  /** The show / hide animation's length in ms (0 when unknown). */
  readonly duration: number;
  /** The animation's curve (`"keyboard"` in the iOS shell, else `"linear"`). */
  readonly easing: KeyboardEventEasing;
  /** Where the keyboard ends up (height 0 when hiding). */
  readonly endCoordinates: KeyboardMetrics;
  /** Where it was before. */
  readonly startCoordinates?: KeyboardMetrics;
  /** Always `true` (a web view sees only its own keyboard). */
  readonly isEventFromThisApp: boolean;
}

/** React Native's `Keyboard` module. */
export interface KeyboardStatic {
  /**
   * Listen to a keyboard event. Every event is emitted on every platform: a show emits
   * `keyboardWillShow` + `keyboardWillChangeFrame` at once and the `Did` pair once the
   * animation's duration has passed (at once where it is unknown).
   */
  addListener(
    eventName: KeyboardEventName,
    listener: (event: KeyboardEvent) => void,
    context?: unknown,
  ): EmitterSubscription;
  /** Remove every listener of `eventName` (or of every event). */
  removeAllListeners(eventName?: KeyboardEventName | null): void;
  /** Remove one listener (deprecated in React Native; use the subscription's `remove()`). */
  removeListener(eventName: KeyboardEventName, listener: (event: KeyboardEvent) => void): void;
  /** Hide the keyboard. */
  dismiss(): void;
  /** Whether the keyboard is up, as last reported. */
  isVisible(): boolean;
  /** The keyboard's frame while it is up, else `undefined`. */
  metrics(): KeyboardMetrics | undefined;
  /** React Native animates layout with the keyboard here; a web view does nothing. */
  scheduleLayoutAnimation(event: KeyboardEvent): void;
}

/** The keyboard hub: listeners, the last state, and the watcher while it runs. */
interface KeyboardHub {
  readonly listeners: Listeners<KeyboardEventName, KeyboardEvent>;
  state: KeyboardState;
  metrics: KeyboardMetrics | undefined;
  stop?: () => void;
  timers: Set<ReturnType<typeof setTimeout>>;
}

let hub: KeyboardHub | undefined;

/** The layout viewport's size (0 × 0 during SSR). */
function viewport(): { width: number; height: number } {
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  return { width: g.innerWidth ?? 0, height: g.innerHeight ?? 0 };
}

/** The keyboard's frame for `state`: along the viewport's bottom edge. */
function metricsOf(state: KeyboardState): KeyboardMetrics {
  const { width, height } = viewport();
  return { screenX: 0, screenY: height - state.height, width, height: state.height };
}

/** Emit the Will events now and the Did events after the animation. */
function emitChange(h: KeyboardHub, state: KeyboardState): void {
  const before = h.metrics;
  const end = metricsOf(state);
  h.state = state;
  h.metrics = state.visible ? end : undefined;
  const duration = state.animationDuration ?? 0;
  const event: KeyboardEvent = {
    duration,
    easing: duration > 0 && nativePlatform() === "ios" ? "keyboard" : "linear",
    endCoordinates: end,
    ...(before ? { startCoordinates: before } : {}),
    isEventFromThisApp: true,
  };
  const phase = state.visible ? "Show" : "Hide";
  h.listeners.emit(`keyboardWill${phase}`, event);
  h.listeners.emit("keyboardWillChangeFrame", event);
  const did = () => {
    h.listeners.emit(`keyboardDid${phase}`, event);
    h.listeners.emit("keyboardDidChangeFrame", event);
  };
  if (duration <= 0) return did();
  const timer = setTimeout(() => {
    h.timers.delete(timer);
    did();
  }, duration);
  h.timers.add(timer);
}

/** The hub, created on first use; its watcher starts with it and keeps running. */
function keyboardHub(): KeyboardHub {
  if (hub) return hub;
  const created: KeyboardHub = {
    listeners: listeners(),
    state: { visible: false, height: 0 },
    metrics: undefined,
    timers: new Set(),
  };
  hub = created;
  if (typeof document !== "undefined") {
    created.stop = onKeyboardChange((state) => emitChange(created, state));
  }
  return created;
}

/** Test hook: stop the watcher and forget every listener. */
export function resetKeyboardForTesting(): void {
  const h = hub;
  hub = undefined;
  if (!h) return;
  h.stop?.();
  for (const timer of h.timers) clearTimeout(timer);
  h.listeners.clear();
}

/**
 * React Native's `Keyboard`, backed by `denext/mobile`'s keyboard state: in the Capacitor shell
 * with `@capacitor/keyboard` (`denext mobile add keyboard`) the native will-show / will-hide
 * events (with the iOS animation duration), in a browser the VirtualKeyboard API or the visual
 * viewport. `endCoordinates` is measured against the layout viewport (`screenY` is its height
 * minus the keyboard's). The watcher starts on the first call and keeps running.
 *
 * @example
 * ```ts
 * import { Keyboard } from "react-native";
 *
 * const sub = Keyboard.addListener("keyboardWillShow", (e) => setInset(e.endCoordinates.height));
 * sub.remove();
 * ```
 */
export const Keyboard: KeyboardStatic = {
  addListener(eventName, listener, context) {
    const fn = context === undefined ? listener : listener.bind(context);
    return keyboardHub().listeners.add(eventName, fn);
  },
  removeAllListeners(eventName) {
    hub?.listeners.clear(eventName ?? undefined);
  },
  removeListener(eventName, listener) {
    hub?.listeners.remove(eventName, listener);
  },
  dismiss() {
    hideKeyboard().catch(() => {});
  },
  isVisible() {
    return keyboardHub().state.visible;
  },
  metrics() {
    return keyboardHub().metrics;
  },
  scheduleLayoutAnimation(_event) {},
};

/** React Native's `KeyboardAvoidingView` behaviors. */
export type RNKeyboardAvoidingBehavior = "height" | "position" | "padding";

/** Props of React Native's `KeyboardAvoidingView` (any other prop goes to the `View`). */
export interface RNKeyboardAvoidingViewProps {
  /** How to make room: none by default, as in React Native. */
  readonly behavior?: RNKeyboardAvoidingBehavior;
  /** The inner view's style with `behavior="position"`. */
  readonly contentContainerStyle?: unknown;
  /** Added to the keyboard's height (the distance from the screen's top to this view). */
  readonly keyboardVerticalOffset?: number;
  /** `false` turns the avoidance off (default `true`). */
  readonly enabled?: boolean;
  readonly style?: unknown;
  readonly onLayout?: (event: LayoutEvent) => void;
  readonly children?: VNodeChildren;
  readonly [prop: string]: unknown;
}

/** react-native-web's `onLayout` event. */
interface LayoutEvent {
  nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
}

/** The view's frame while it is not lifted: its `y` and its unlifted height. */
interface RestFrame {
  readonly y: number;
  readonly height: number;
}

/**
 * How far the keyboard overlaps a view resting at `frame`: React Native's
 * `frame.y + frame.height - (keyboardY - keyboardVerticalOffset)`, where the keyboard's top is
 * the layout viewport's height minus the covered height.
 */
function bottomHeight(frame: RestFrame | null, overlapPx: number, offset: number): number {
  if (!frame || overlapPx <= 0) return 0;
  const keyboardY = viewport().height - overlapPx - offset;
  return Math.max(0, Math.round(frame.y + frame.height - keyboardY));
}

/** The transition to add while the keyboard's duration is known. */
function keyboardTransition(property: string, duration: number | undefined): object {
  return duration === undefined
    ? {}
    : { transitionProperty: property, transitionDuration: `${duration}ms` };
}

/**
 * React Native's `KeyboardAvoidingView` over react-native-web's `View`: with a `behavior` it
 * adds bottom padding (`"padding"`), shrinks to its resting height minus the overlap
 * (`"height"`), or moves its content up (`"position"`, through an inner view styled with
 * `contentContainerStyle`); without one it is a plain `View`, as in React Native. The overlap
 * is React Native's own formula over the view's `onLayout` frame, with the keyboard's top at
 * the layout viewport's height minus the part of the keyboard that covers the page, which is 0
 * where the web view resizes around the keyboard (Android, the iOS shell's default `resize`),
 * so nothing is lifted twice.
 *
 * @param View react-native-web's `View` (React Native mode passes it in).
 * @returns The component.
 */
export function createKeyboardAvoidingView(
  View: VNodeType,
): (props: RNKeyboardAvoidingViewProps) => VNode {
  function KeyboardAvoidingView(props: RNKeyboardAvoidingViewProps): VNode {
    const {
      behavior,
      contentContainerStyle,
      keyboardVerticalOffset = 0,
      enabled = true,
      style,
      onLayout,
      children,
      ...rest
    } = props;
    const [frame, setFrame] = useState<RestFrame | null>(null);
    const lifted = useRef(false);
    const overlap = useOverlap(enabled && behavior !== undefined);
    const bottom = bottomHeight(frame, overlap.px, keyboardVerticalOffset);
    lifted.current = bottom > 0;
    const layout = (event: LayoutEvent) => {
      const { y, height } = event.nativeEvent.layout;
      // The resting frame: a lifted "height" view reports its shrunk height, which must not
      // become the height it shrinks from.
      setFrame((prev) =>
        prev && lifted.current && behavior === "height"
          ? (prev.y === y ? prev : { y, height: prev.height })
          : (prev?.y === y && prev.height === height ? prev : { y, height })
      );
      onLayout?.(event);
    };
    const own = { ...rest, onLayout: layout };
    switch (behavior) {
      case "height":
        return h(View, {
          ...own,
          style: [
            style,
            bottom > 0 && frame ? { height: frame.height - bottom, flex: 0 } : null,
            keyboardTransition("height", overlap.duration),
          ],
        }, children);
      case "position":
        return h(
          View,
          { ...own, style },
          h(View, {
            style: [
              contentContainerStyle,
              { bottom },
              keyboardTransition("bottom", overlap.duration),
            ],
          }, children),
        );
      case "padding":
        return h(View, {
          ...own,
          style: [
            style,
            { paddingBottom: bottom },
            keyboardTransition("padding-bottom", overlap.duration),
          ],
        }, children);
      default:
        return h(View, { ...own, style }, children);
    }
  }
  return KeyboardAvoidingView;
}
