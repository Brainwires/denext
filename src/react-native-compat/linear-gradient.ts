/**
 * `react-native-linear-gradient` for denext (React Native mode): `LinearGradient` as a view
 * with a CSS `linear-gradient()` background (react-native-web's `View` in React Native mode,
 * a `<div>` elsewhere). The package's native view has no web build, so React Native mode
 * resolves the package here.
 *
 * `start` / `end` are honoured exactly: the view measures itself (`onLayout`) and places each
 * colour stop where the native gradient puts it along the start → end line, which CSS draws
 * through the box's centre. Until the first layout the box is taken as square. `useAngle` +
 * `angle` is a CSS angle (0 = towards the top, 90 = towards the right); `angleCenter` is
 * honoured only at the centre (the default).
 *
 * @example
 * ```ts
 * import LinearGradient from "react-native-linear-gradient"; // → this module
 * import { h } from "denext/jsx-runtime";
 *
 * h(LinearGradient, { colors: ["#4c669f", "#3b5998"], style: { flex: 1 } });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useState } from "../runtime/hooks.ts";
import { hasReactNative, hostView, viewStyle } from "../expo/internal/common.ts";

/** A point in the view's unit square (`{ x: 0, y: 0 }` is the top left corner). */
export interface GradientPoint {
  /** 0 (left) to 1 (right). */
  x: number;
  /** 0 (top) to 1 (bottom). */
  y: number;
}

/** `LinearGradient` props (plus any view prop). */
export interface LinearGradientProps {
  /** The colours: CSS colour strings, or `processColor` numbers (`0xAARRGGBB`). */
  colors: readonly (string | number)[];
  /** Where the gradient starts (default `{ x: 0.5, y: 0 }`). */
  start?: GradientPoint | readonly [number, number];
  /** Where the gradient ends (default `{ x: 0.5, y: 1 }`). */
  end?: GradientPoint | readonly [number, number];
  /** Each colour's position on the start → end line, 0–1 (default: evenly spaced). */
  locations?: readonly number[];
  /** Use `angle` instead of `start` / `end`. */
  useAngle?: boolean;
  /** The angle in degrees (0 = towards the top, 90 = towards the right; default 0). */
  angle?: number;
  /** The angle's centre (only the default `{ x: 0.5, y: 0.5 }` is honoured). */
  angleCenter?: GradientPoint;
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: unknown;
  /** Called with the view's layout (also used to measure it). */
  onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  /** Other view props. */
  [prop: string]: unknown;
}

/** A `processColor` number (`0xAARRGGBB`) or a CSS colour, as CSS. */
export function gradientColor(color: string | number): string {
  if (typeof color === "string") return color;
  const n = color >>> 0;
  const a = ((n >>> 24) & 0xff) / 255;
  return `rgba(${(n >>> 16) & 0xff},${(n >>> 8) & 0xff},${n & 0xff},${Number(a.toFixed(3))})`;
}

/** A point prop (an object, or the deprecated `[x, y]` array), or `fallback`. */
function point(value: LinearGradientProps["start"], fallback: GradientPoint): GradientPoint {
  if (Array.isArray(value)) return { x: Number(value[0]), y: Number(value[1]) };
  return value ? value as GradientPoint : fallback;
}

/** A number rounded for CSS output. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The CSS `linear-gradient()` that draws the native gradient from `start` to `end` over a box
 * of `width` × `height`: CSS's gradient line runs through the centre at an angle and spans the
 * box's corners, so the angle comes from the start → end vector in px and each stop is
 * re-positioned to where the start and end points project onto that line.
 *
 * @param colors The colours.
 * @param locations Their positions on the start → end line (evenly spaced when absent).
 * @param start The start point (unit square).
 * @param end The end point (unit square).
 * @param width The box width in px (any positive number; only the aspect matters).
 * @param height The box height in px.
 * @returns The CSS image.
 */
export function linearGradientCss(
  colors: readonly (string | number)[],
  locations: readonly number[] | undefined,
  start: GradientPoint,
  end: GradientPoint,
  width = 1,
  height = 1,
): string {
  const w = width > 0 ? width : 1;
  const hgt = height > 0 ? height : 1;
  const dx = (end.x - start.x) * w;
  const dy = (end.y - start.y) * hgt;
  // CSS angles: 0deg points up, 90deg right; the unit direction is (sin θ, -cos θ).
  const theta = dx === 0 && dy === 0 ? Math.PI : Math.atan2(dx, -dy);
  const dirX = Math.sin(theta);
  const dirY = -Math.cos(theta);
  const length = Math.abs(w * dirX) + Math.abs(hgt * dirY);
  const along = (p: GradientPoint) =>
    ((p.x * w - w / 2) * dirX + (p.y * hgt - hgt / 2) * dirY) / length + 0.5;
  const t0 = along(start);
  const t1 = along(end);
  const stops = colors.map((color, i) => {
    const loc = locations?.[i] ?? (colors.length > 1 ? i / (colors.length - 1) : 0);
    return `${gradientColor(color)} ${round((t0 + loc * (t1 - t0)) * 100)}%`;
  });
  return `linear-gradient(${round((theta * 180) / Math.PI)}deg, ${stops.join(", ")})`;
}

/** The CSS `linear-gradient()` for `useAngle`: a CSS angle, the stops as given. */
function angleGradientCss(
  colors: readonly (string | number)[],
  locations: readonly number[] | undefined,
  angle: number,
): string {
  const stops = colors.map((color, i) => {
    const loc = locations?.[i] ?? (colors.length > 1 ? i / (colors.length - 1) : 0);
    return `${gradientColor(color)} ${round(loc * 100)}%`;
  });
  return `linear-gradient(${round(angle)}deg, ${stops.join(", ")})`;
}

/**
 * A view whose background is a linear gradient.
 *
 * @param props The colours, geometry, style and children.
 * @returns The view.
 */
export function LinearGradient(props: LinearGradientProps): VNode {
  const {
    colors,
    start,
    end,
    locations,
    useAngle,
    angle = 0,
    angleCenter: _center,
    style,
    children,
    onLayout,
    ...rest
  } = props;
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 1, height: 1 });
  const image = useAngle ? angleGradientCss(colors ?? [], locations, angle) : linearGradientCss(
    colors ?? [],
    locations,
    point(start, { x: 0.5, y: 0 }),
    point(end, { x: 0.5, y: 1 }),
    size.width,
    size.height,
  );
  return h(
    hostView(),
    {
      ...rest,
      // Only react-native-web's View reports its layout; a plain <div> keeps the square guess.
      ...(hasReactNative()
        ? {
          onLayout: (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
            const layout = event?.nativeEvent?.layout;
            if (layout && (layout.width !== size.width || layout.height !== size.height)) {
              setSize({ width: layout.width, height: layout.height });
            }
            onLayout?.(event);
          },
        }
        : {}),
      style: viewStyle(style, { backgroundImage: image }),
    },
    children as never,
  );
}

export default LinearGradient;
