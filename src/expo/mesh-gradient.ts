/**
 * `expo-mesh-gradient` for denext: `MeshGradientView` drawn with CSS — each mesh point's
 * colour as a radial gradient centred on the point, reaching about one grid cell, layered over
 * the mesh's average colour (react-native-web's `View` in React Native mode, a `<div>`
 * elsewhere). It follows the points and colours (and their changes), on every platform; it is
 * an approximation of SwiftUI's `MeshGradient`, not the same interpolation. `smoothsColors`
 * widens the blend; `resolution` and `ignoresSafeArea` are ignored; with `mask` the children
 * are drawn over the gradient rather than masking it. The average colour under the layers is
 * computed here for hex, `rgb()` and `processColor` colours; with others (named, `hsl()`) it is
 * CSS `color-mix()`, which Safari 16.2+ (iOS 16.2+) needs.
 *
 * @example
 * ```ts
 * import { MeshGradientView } from "denext/expo/mesh-gradient";
 * import { h } from "denext/jsx-runtime";
 *
 * h(MeshGradientView, {
 *   style: { flex: 1 },
 *   columns: 2,
 *   rows: 2,
 *   colors: ["red", "purple", "indigo", "blue"],
 *   points: [[0, 0], [1, 0], [0, 1], [1, 1]],
 * });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { gradientColor } from "../react-native-compat/linear-gradient.ts";
import { hostView, viewStyle } from "./internal/common.ts";

/** `MeshGradientView` props (plus any view prop). */
export interface MeshGradientViewProps {
  /** The mesh's columns (default 0: nothing is drawn). */
  columns?: number;
  /** The mesh's rows (default 0). */
  rows?: number;
  /** Each point as `[x, y]` (0–1), row by row: `columns × rows` of them. */
  points?: number[][];
  /** Each point's colour (CSS colour or `processColor` number), in the points' order. */
  colors?: (string | number)[];
  /** Blend the colours over a wider area (default `true`). */
  smoothsColors?: boolean;
  /** Extend under the safe areas (ignored: the view is drawn where its style puts it). */
  ignoresSafeArea?: boolean;
  /** Mask the gradient with the children (not supported: the children draw over it). */
  mask?: boolean;
  /** Android's mesh resolution (ignored). */
  resolution?: { x?: number; y?: number };
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** A rounded percentage. */
function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

/** `#rgb[a]` / `#rrggbb[aa]` / `rgb[a](r, g, b[, a])` as channels (0–255, alpha 0–1), or null. */
function channels(color: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (hex) {
    const d = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const byte = (i: number) => parseInt(d.slice(i, i + 2), 16);
    return [byte(0), byte(2), byte(4), d.length === 8 ? byte(6) / 255 : 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i
    .exec(color.trim());
  if (!rgb) return null;
  return [
    Number(rgb[1]),
    Number(rgb[2]),
    Number(rgb[3]),
    rgb[4] === undefined ? 1 : Number(rgb[4]),
  ];
}

/**
 * The average of CSS colours (equal weights). Colours it can read (hex, `rgb()` / `rgba()`, which
 * `processColor` numbers become) are averaged here, as `rgba()`; any other (a named colour,
 * `hsl()`, …) is left to the browser as `color-mix()`, which Safari before 16.2 does not parse
 * (the background colour is then missing; the radial layers still draw).
 */
function average(colors: readonly string[]): string {
  const parsed = colors.map(channels);
  if (parsed.every((c) => c !== null)) {
    const mean = (i: number) => parsed.reduce((sum, c) => sum + c![i], 0) / parsed.length;
    const alpha = Math.round(mean(3) * 1000) / 1000;
    return `rgba(${Math.round(mean(0))},${Math.round(mean(1))},${Math.round(mean(2))},${alpha})`;
  }
  return colors.slice(1).reduce(
    (mix, color, i) => `color-mix(in srgb, ${mix}, ${color} ${pct(1 / (i + 2))})`,
    colors[0],
  );
}

/**
 * The CSS background the mesh draws: a radial gradient per point over the average colour, or
 * null when the mesh is empty.
 *
 * @param props The mesh.
 * @returns `{ backgroundColor, backgroundImage }`, or null.
 */
function meshBackground(
  props: Pick<MeshGradientViewProps, "columns" | "rows" | "points" | "colors" | "smoothsColors">,
): { backgroundColor: string; backgroundImage: string } | null {
  const columns = Math.max(0, Math.floor(props.columns ?? 0));
  const rows = Math.max(0, Math.floor(props.rows ?? 0));
  const count = Math.min(columns * rows, props.points?.length ?? 0, props.colors?.length ?? 0);
  if (count === 0) return null;
  const colors = props.colors!.slice(0, count).map(gradientColor);
  // One cell's reach (in the box's size), wider when smoothing.
  const cell = 1 / Math.max(1, Math.min(columns, rows) - 1);
  const reach = cell * (props.smoothsColors === false ? 0.75 : 1.1);
  const layers = props.points!.slice(0, count).map(([x, y], i) =>
    `radial-gradient(${pct(reach)} ${pct(reach)} at ${pct(x ?? 0)} ${pct(y ?? 0)}, ` +
    `${colors[i]} 0%, transparent 100%)`
  );
  return { backgroundColor: average(colors), backgroundImage: layers.join(", ") };
}

/**
 * A view filled with a mesh gradient.
 *
 * @param props The mesh, style and children.
 * @returns The view.
 */
export function MeshGradientView(props: MeshGradientViewProps): VNode {
  const {
    columns,
    rows,
    points,
    colors,
    smoothsColors,
    ignoresSafeArea: _safe,
    mask: _mask,
    resolution: _resolution,
    style,
    children,
    ...rest
  } = props;
  const background = meshBackground({ columns, rows, points, colors, smoothsColors });
  return h(
    hostView(),
    { ...rest, style: viewStyle(style, background ?? undefined) } as never,
    children as never,
  );
}
