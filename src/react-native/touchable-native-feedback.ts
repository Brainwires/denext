/**
 * React Native's `TouchableNativeFeedback` for React Native mode: react-native-web ships it as
 * an unimplemented view (a red box in development), so React Native mode replaces its module
 * with {@linkcode createTouchableNativeFeedback} over react-native-web's own press handling.
 * Like React Native's, it renders its single child with the press handlers (no wrapper view);
 * the Android ripple is not drawn, and `background` / `useForeground` are accepted and ignored.
 *
 * @module
 */

import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useMemo, useRef } from "../runtime/hooks.ts";
import { Children, cloneElement } from "../runtime/react-core.ts";

/** react-native-web's `usePressEvents(hostRef, config)`, which returns the press handlers. */
export type UsePressEvents = (
  hostRef: { current: unknown },
  config: Record<string, unknown>,
) => Record<string, unknown>;

/** A ripple description (inert here). */
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
  /** The ripple (ignored). */
  background?: RippleBackground;
  /** Draw the ripple over the content (ignored). */
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

/** Set a ref (a callback or an object). */
function setRef(ref: unknown, value: unknown): void {
  if (typeof ref === "function") ref(value);
  else if (ref && typeof ref === "object") (ref as { current: unknown }).current = value;
}

/** The `TouchableNativeFeedback` component, with its statics. */
export interface TouchableNativeFeedbackComponent {
  /** Render the child with the press handlers. */
  (props: TouchableNativeFeedbackProps): VNode | null;
  /** The theme's selectable background (inert). */
  SelectableBackground(rippleRadius?: number): RippleBackground;
  /** The theme's borderless selectable background (inert). */
  SelectableBackgroundBorderless(rippleRadius?: number): RippleBackground;
  /** A ripple of `color` (inert). */
  Ripple(color: unknown, borderless: boolean, rippleRadius?: number): RippleBackground;
  /** Whether `useForeground` works: false. */
  canUseNativeForeground(): boolean;
  /** The display name. */
  displayName: string;
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
    const config = useMemo(() => ({
      cancelable: true,
      disabled: props.disabled,
      delayLongPress: props.delayLongPress,
      delayPressStart: props.delayPressIn,
      delayPressEnd: props.delayPressOut,
      onLongPress: props.onLongPress,
      onPress: props.onPress,
      onPressStart: props.onPressIn,
      onPressEnd: props.onPressOut,
    }), [
      props.disabled,
      props.delayLongPress,
      props.delayPressIn,
      props.delayPressOut,
      props.onLongPress,
      props.onPress,
      props.onPressIn,
      props.onPressOut,
    ]);
    const handlers = usePressEvents(host, config);
    const child = Children.only(props.children as VNodeChildren) as VNode;
    const childRef = (child.props as { ref?: unknown }).ref;
    const forwarded: Record<string, unknown> = {};
    for (const name of FORWARDED) if (props[name] !== undefined) forwarded[name] = props[name];
    return cloneElement(child, {
      ...forwarded,
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
