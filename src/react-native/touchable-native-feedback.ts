/**
 * React Native's `TouchableNativeFeedback` for React Native mode: react-native-web ships it as
 * an unimplemented view (a red box in development), so React Native mode replaces its module
 * with {@linkcode createTouchableNativeFeedback} over react-native-web's own press handling.
 * Like React Native's, it renders its single child with the press handlers (no wrapper view).
 * In the Android shell a press draws `background`'s ripple from the touch point, as
 * `Pressable`'s `android_ripple` does, in a layer appended to the child:
 * `TouchableNativeFeedback.Ripple(color, borderless, rippleRadius)` in its colour, and
 * `SelectableBackground()` / `SelectableBackgroundBorderless()` (the default background is
 * `SelectableBackground()`, as in React Native) in the theme's light highlight. iOS and a
 * browser draw none, as React Native's is Android's. `useForeground` is accepted (the layer is
 * always over the child's content, pointer-events off).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { useMemo, useRef } from "../runtime/hooks.ts";
import { Children, cloneElement } from "../runtime/react-core.ts";
import { setRef } from "./internal.ts";
import { endRipple, type RippleConfig, rippleLayerStyle, startRipple } from "./pressable.ts";

/** react-native-web's `usePressEvents(hostRef, config)`, which returns the press handlers. */
export type UsePressEvents = (
  hostRef: { current: unknown },
  config: Record<string, unknown>,
) => Record<string, unknown>;

/** A ripple description (`background`), drawn in the Android shell. */
export interface RippleBackground {
  /** The kind. */
  readonly type: "RippleAndroid" | "ThemeAttrAndroid";
  /** The colour. */
  readonly color?: unknown;
  /** Whether it extends past the view. */
  readonly borderless?: boolean;
  /** The ripple radius. */
  readonly rippleRadius?: number;
  /** The theme attribute. */
  readonly attribute?: string;
}

/** `TouchableNativeFeedback` props. */
export interface TouchableNativeFeedbackProps {
  /** The one child (a `View`) that gets the press handlers. */
  children?: unknown;
  /** Pressed. */
  onPress?: (e: unknown) => void;
  /** Press started. */
  onPressIn?: (e: unknown) => void;
  /** Press ended. */
  onPressOut?: (e: unknown) => void;
  /** Long-pressed. */
  onLongPress?: (e: unknown) => void;
  /** Disabled. */
  disabled?: boolean;
  /** Focusable (default true unless disabled). */
  focusable?: boolean;
  /** Delay before `onPressIn`, ms. */
  delayPressIn?: number;
  /** Delay before `onPressOut`, ms. */
  delayPressOut?: number;
  /** Delay before `onLongPress`, ms. */
  delayLongPress?: number;
  /** The ripple (Android shell; `SelectableBackground()` by default). */
  background?: RippleBackground;
  /** Draw the ripple over the content (the layer always is). */
  useForeground?: boolean;
  /** The ref (the child's host node). */
  ref?: unknown;
  /** Other props passed to the child (`testID`, `accessibilityLabel`, …). */
  [prop: string]: unknown;
}

/** The props forwarded to the child, as React Native's own forwards them. */
const FORWARDED = [
  "accessibilityLabel",
  "accessibilityRole",
  "accessibilityState",
  "accessibilityHint",
  "accessibilityLiveRegion",
  "accessibilityValue",
  "nativeID",
  "onBlur",
  "onFocus",
  "onLayout",
  "testID",
] as const;

/** The `TouchableNativeFeedback` component, with its statics. */
export interface TouchableNativeFeedbackComponent {
  /** Render the child with the press handlers. */
  (props: TouchableNativeFeedbackProps): VNode | null;
  /** The theme's selectable background. */
  SelectableBackground(rippleRadius?: number): RippleBackground;
  /** The theme's borderless selectable background. */
  SelectableBackgroundBorderless(rippleRadius?: number): RippleBackground;
  /** A ripple of `color`. */
  Ripple(color: unknown, borderless: boolean, rippleRadius?: number): RippleBackground;
  /** Whether `useForeground` works: false. */
  canUseNativeForeground(): boolean;
  /** The display name. */
  displayName: string;
}

/**
 * `background` as `Pressable`'s ripple config: a `Ripple`'s colour, the theme's highlight for
 * `SelectableBackground` (the default), unbounded for the borderless kinds.
 *
 * @param background The `background` prop.
 * @returns The config.
 */
export function rippleConfigOf(background: RippleBackground | undefined): RippleConfig {
  const bg = background ?? { type: "ThemeAttrAndroid", attribute: "selectableItemBackground" };
  const borderless = bg.type === "RippleAndroid"
    ? bg.borderless === true
    : bg.attribute === "selectableItemBackgroundBorderless";
  return {
    color: bg.type === "RippleAndroid" ? bg.color : undefined,
    borderless,
    radius: bg.rippleRadius,
  };
}

/** The slice of a press event the ripple reads. */
interface PressEvent {
  readonly nativeEvent?: Parameters<typeof startRipple>[1];
}

/**
 * The press handlers wrapped to draw the ripple in `layer` (Android shell only), and the layer
 * to append to the child, or `null` where no ripple is drawn.
 */
function useRipple(
  props: TouchableNativeFeedbackProps,
): { layer: VNode | null; onPressIn?: (e: PressEvent) => void; onPressOut?: (e: unknown) => void } {
  const layer = useRef<Parameters<typeof startRipple>[0] | null>(null);
  const circle = useRef<ReturnType<typeof startRipple> | null>(null);
  if (nativePlatform() !== "android" || props.disabled) return { layer: null };
  const config = rippleConfigOf(props.background);
  return {
    layer: h("span", { ref: layer, "aria-hidden": "true", style: rippleLayerStyle(config) }),
    onPressIn(e) {
      if (circle.current) endRipple(circle.current);
      circle.current = layer.current ? startRipple(layer.current, e?.nativeEvent, config) : null;
      props.onPressIn?.(e);
    },
    onPressOut(e) {
      if (circle.current) endRipple(circle.current);
      circle.current = null;
      props.onPressOut?.(e);
    },
  };
}

/**
 * `TouchableNativeFeedback` over react-native-web's press handling.
 *
 * @param usePressEvents react-native-web's `usePressEvents`.
 * @returns The component.
 */
export function createTouchableNativeFeedback(
  usePressEvents: UsePressEvents,
): TouchableNativeFeedbackComponent {
  function TouchableNativeFeedback(props: TouchableNativeFeedbackProps): VNode | null {
    const host = useRef<unknown>(null);
    const ripple = useRipple(props);
    const onPressIn = ripple.onPressIn ?? props.onPressIn;
    const onPressOut = ripple.onPressOut ?? props.onPressOut;
    const config = useMemo(() => ({
      cancelable: true,
      disabled: props.disabled,
      delayLongPress: props.delayLongPress,
      delayPressStart: props.delayPressIn,
      delayPressEnd: props.delayPressOut,
      onLongPress: props.onLongPress,
      onPress: props.onPress,
      onPressStart: onPressIn,
      onPressEnd: onPressOut,
    }), [
      props.disabled,
      props.delayLongPress,
      props.delayPressIn,
      props.delayPressOut,
      props.onLongPress,
      props.onPress,
      onPressIn,
      onPressOut,
    ]);
    const handlers = usePressEvents(host, config);
    const child = Children.only(props.children as VNodeChildren) as VNode;
    const childRef = (child.props as { ref?: unknown }).ref;
    const forwarded: Record<string, unknown> = {};
    for (const name of FORWARDED) if (props[name] !== undefined) forwarded[name] = props[name];
    const kids = (child.props as { children?: VNodeChildren }).children;
    const withLayer = ripple.layer
      ? { children: [kids as VNodeChild, ripple.layer] as VNodeChildren }
      : {};
    return cloneElement(child, {
      ...forwarded,
      ...withLayer,
      ...handlers,
      accessibilityDisabled: props.disabled,
      focusable: !props.disabled && props.focusable !== false,
      ref(node: unknown) {
        host.current = node;
        setRef(props.ref, node);
        setRef(childRef, node);
      },
    });
  }
  const ripple = (type: RippleBackground["type"], extra: Partial<RippleBackground>) => ({
    type,
    ...extra,
  });
  return Object.assign(TouchableNativeFeedback, {
    SelectableBackground: (rippleRadius?: number) =>
      ripple("ThemeAttrAndroid", { attribute: "selectableItemBackground", rippleRadius }),
    SelectableBackgroundBorderless: (rippleRadius?: number) =>
      ripple("ThemeAttrAndroid", { attribute: "selectableItemBackgroundBorderless", rippleRadius }),
    Ripple: (color: unknown, borderless: boolean, rippleRadius?: number) =>
      ripple("RippleAndroid", { color, borderless, rippleRadius }),
    canUseNativeForeground: () => false,
    displayName: "TouchableNativeFeedback",
  });
}
