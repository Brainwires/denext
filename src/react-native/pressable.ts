/**
 * React Native's `android_ripple` on `Pressable` for React Native mode: in the Android shell a
 * press draws Material's ripple from the touch point (react-native-web ignores the prop). The
 * ripple is a circle in `color` (the theme's light highlight, `rgba(0, 0, 0, 0.12)`, by default)
 * that grows to `radius` (by default the distance to the farthest corner) while pressed and
 * fades on release, clipped to the pressable's box and corners unless `borderless`. It is drawn
 * in a layer inside the pressable, under nothing the app renders. As in React Native, iOS and a
 * browser draw no ripple. `foreground` is accepted (the layer is always on top, pointer-events
 * off).
 *
 * React Native mode's build wraps react-native-web's `Pressable` with
 * {@linkcode withPressableRipple}.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType, VProps } from "../jsx/types.ts";
import { useRef } from "../runtime/hooks.ts";
import { nativePlatform } from "../mobile/bridge.ts";

/** React Native's `android_ripple` config. */
export interface RippleConfig {
  /** The ripple colour (a CSS colour string). */
  readonly color?: unknown;
  /** Draw past the pressable's box. */
  readonly borderless?: boolean;
  /** The ripple's radius, px. */
  readonly radius?: number;
  /** Draw over the content (the layer always is). */
  readonly foreground?: boolean;
}

/** Material's light-theme highlight, React Native's default ripple colour. */
const DEFAULT_COLOR = "rgba(0, 0, 0, 0.12)";

/** The ripple's grow and fade durations, ms (Material's). */
const GROW_MS = 225;
const FADE_MS = 150;

/** A layer's box, as `getBoundingClientRect` gives it. */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A press event's DOM event: a pointer / mouse event, a touch event, or a key event. */
interface PressNativeEvent {
  readonly clientX?: number;
  readonly clientY?: number;
  readonly changedTouches?: ArrayLike<{ clientX: number; clientY: number }>;
}

/** Where a ripple starts and how far it grows, in the layer's coordinates. */
export interface RippleGeometry {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * The ripple's centre (the touch or pointer, else the box's centre, as a key press) and its
 * radius (`radius`, else the distance to the farthest corner).
 *
 * @param box The layer's box.
 * @param event The press's DOM event.
 * @param radius The configured radius.
 * @returns The geometry.
 */
export function rippleGeometry(
  box: Box,
  event: PressNativeEvent | undefined,
  radius?: number,
): RippleGeometry {
  const touch = event?.changedTouches?.[0];
  const cx = touch?.clientX ?? event?.clientX;
  const cy = touch?.clientY ?? event?.clientY;
  const x = typeof cx === "number" ? cx - box.left : box.width / 2;
  const y = typeof cy === "number" ? cy - box.top : box.height / 2;
  const far = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y));
  return { x, y, radius: typeof radius === "number" && radius > 0 ? radius : far };
}

/** The slice of a DOM element the ripple uses. */
interface RippleHost {
  readonly ownerDocument: { createElement(tag: string): RippleNode };
  getBoundingClientRect(): Box;
  appendChild(node: RippleNode): unknown;
}

/** The ripple circle's element. */
interface RippleNode {
  readonly style: Record<string, string>;
  remove(): void;
  animate?(
    keyframes: Record<string, string>[],
    options: Record<string, unknown>,
  ): { finished?: Promise<unknown> };
}

/**
 * Draw a ripple in `layer`: a circle growing from the press point.
 *
 * @param layer The ripple layer.
 * @param event The press's DOM event.
 * @param config The `android_ripple` config.
 * @returns The circle, for {@linkcode endRipple}.
 */
export function startRipple(
  layer: RippleHost,
  event: PressNativeEvent | undefined,
  config: RippleConfig,
): RippleNode {
  const { x, y, radius } = rippleGeometry(layer.getBoundingClientRect(), event, config.radius);
  const circle = layer.ownerDocument.createElement("span");
  Object.assign(circle.style, {
    position: "absolute",
    left: `${x - radius}px`,
    top: `${y - radius}px`,
    width: `${radius * 2}px`,
    height: `${radius * 2}px`,
    borderRadius: "50%",
    backgroundColor: typeof config.color === "string" ? config.color : DEFAULT_COLOR,
    pointerEvents: "none",
    transform: "scale(1)",
  });
  layer.appendChild(circle);
  circle.animate?.([{ transform: "scale(0)" }, { transform: "scale(1)" }], {
    duration: GROW_MS,
    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
  });
  return circle;
}

/**
 * Fade a ripple out and remove it (at once where the page cannot animate).
 *
 * @param circle The circle {@linkcode startRipple} drew.
 */
export function endRipple(circle: RippleNode): void {
  const fade = circle.animate?.([{ opacity: "1" }, { opacity: "0" }], {
    duration: FADE_MS,
    fill: "forwards",
  });
  if (fade?.finished) fade.finished.then(() => circle.remove(), () => circle.remove());
  else circle.remove();
}

/** The layer's style: the pressable's box and corners, clipped unless borderless. */
export function rippleLayerStyle(config: RippleConfig): Record<string, unknown> {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: config.borderless ? "visible" : "hidden",
    borderRadius: "inherit",
    pointerEvents: "none",
  };
}

/** The props the wrapper reads (the rest go on to react-native-web's `Pressable`). */
interface PressableProps {
  readonly android_ripple?: RippleConfig | null;
  readonly children?: unknown;
  readonly onPressIn?: (e: { nativeEvent?: PressNativeEvent }) => void;
  readonly onPressOut?: (e: unknown) => void;
  readonly [prop: string]: unknown;
}

/**
 * react-native-web's `Pressable` with `android_ripple` (see the module docs). Without it, or
 * outside the Android shell, it renders exactly as before.
 *
 * @param Pressable react-native-web's `Pressable`.
 * @returns The wrapped `Pressable`.
 */
export function withPressableRipple(Pressable: VNodeType): VNodeType {
  function RNPressable(props: PressableProps): VNode {
    const layer = useRef<RippleHost | null>(null);
    const circle = useRef<RippleNode | null>(null);
    const { android_ripple: ripple, ...rest } = props;
    if (!ripple || nativePlatform() !== "android") return h(Pressable, rest as VProps);
    const { children, onPressIn, onPressOut } = props;
    const wrapped: Record<string, unknown> = {
      ...rest,
      onPressIn(e: { nativeEvent?: PressNativeEvent }) {
        if (circle.current) endRipple(circle.current);
        circle.current = layer.current ? startRipple(layer.current, e?.nativeEvent, ripple) : null;
        onPressIn?.(e);
      },
      onPressOut(e: unknown) {
        if (circle.current) endRipple(circle.current);
        circle.current = null;
        onPressOut?.(e);
      },
      children: (state: unknown) => [
        (typeof children === "function" ? children(state) : children) as VNodeChild,
        h("span", { ref: layer, "aria-hidden": "true", style: rippleLayerStyle(ripple) }),
      ],
    };
    return h(Pressable, wrapped as VProps);
  }
  return Object.assign(RNPressable, { displayName: "Pressable" }) as unknown as VNodeType;
}
