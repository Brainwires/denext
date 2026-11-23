/**
 * React Native's `StyleSheet` for `denext/gpui`, where no react-native-web is loaded: `create`
 * returns the styles as given (React Native 0.66 and later), `flatten` merges a style array, and
 * `compose`, `hairlineWidth`, `absoluteFill` and `absoluteFillObject` are React Native's.
 *
 * @module
 */

import { flattenStyle, registerStyle, type StyleProp } from "./style.ts";

/** `position: absolute` over the whole parent. */
const ABSOLUTE_FILL: Readonly<Record<string, unknown>> = Object.freeze({
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
});

/** The `StyleSheet` statics `denext/gpui` provides. */
export interface GpuiStyleSheet {
  /** Return `styles` unchanged (frozen), as React Native 0.66+ does. */
  create<T extends Record<string, Record<string, unknown>>>(styles: T): Readonly<T>;
  /** Merge a style array into one object (later entries win). */
  flatten(style: StyleProp): Record<string, unknown> | undefined;
  /** `[a, b]`, or the one that is set. */
  compose(a: StyleProp, b: StyleProp): StyleProp;
  /** Register a style under a numeric id `flatten` resolves (React Native's prop registry). */
  registerStyle(style: Readonly<Record<string, unknown>>): number;
  /** The thinnest line: 1 logical pixel here. */
  readonly hairlineWidth: number;
  /** `position: absolute` with every edge at 0. */
  readonly absoluteFill: Readonly<Record<string, unknown>>;
  /** The same as an object to spread. */
  readonly absoluteFillObject: Readonly<Record<string, unknown>>;
}

/**
 * React Native's `StyleSheet` (see the module docs).
 *
 * @example
 * ```ts
 * import { StyleSheet } from "denext/gpui";
 *
 * const styles = StyleSheet.create({ box: { padding: 8, backgroundColor: "tomato" } });
 * StyleSheet.flatten([styles.box, { padding: 4 }]); // { padding: 4, backgroundColor: "tomato" }
 * ```
 */
export const StyleSheet: GpuiStyleSheet = {
  create<T extends Record<string, Record<string, unknown>>>(styles: T): Readonly<T> {
    for (const key of Object.keys(styles)) Object.freeze(styles[key]);
    return Object.freeze(styles);
  },
  flatten: (style) => flattenStyle(style),
  compose: (a, b) => (a && b ? [a, b] : a || b),
  registerStyle,
  hairlineWidth: 1,
  absoluteFill: ABSOLUTE_FILL,
  absoluteFillObject: ABSOLUTE_FILL,
};
