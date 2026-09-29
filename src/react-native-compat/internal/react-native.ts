/**
 * The React Native primitives the community-package stand-ins (`src/react-native-compat/*`)
 * render with, when there are any.
 *
 * This file is the fallback: every export is `undefined`, so a stand-in renders plain DOM
 * elements (a `<div>` for a view, a `<span>` for text). In React Native mode the build leaves
 * this import external (as the `denext/expo/*` shims' bridge) and points it at the app's own
 * react-native-web, so the same stand-ins render real `View` / `Text` / `ScrollView`
 * components and inherit React Native's style handling (style arrays, `paddingHorizontal`,
 * flex defaults).
 *
 * Import it as a namespace (`import * as RN from "./internal/react-native.ts"`): outside React
 * Native mode the bridge is an empty module, and only a namespace import reads a missing name
 * as `undefined` instead of failing the build.
 *
 * Internal to the stand-ins: not an entrypoint.
 *
 * @module
 */

import type { VNodeType } from "../../jsx/types.ts";

/** The slice of React Native's `StyleSheet` the stand-ins use. */
export interface StyleSheetLike {
  /** Merge a (possibly nested) style array into one object. */
  flatten(style: unknown): Record<string, unknown> | undefined;
  /** `StyleSheet.absoluteFill`. */
  readonly absoluteFill?: unknown;
}

/** An `Animated.Value` of React Native's `Animated`, as the stand-ins drive it. */
export interface AnimatedValueLike {
  /** Jump to `value`. */
  setValue(value: number): void;
}

/** The slice of React Native's `Animated` the stand-ins use. */
export interface AnimatedLike {
  /** `new Animated.Value(initial)`. */
  readonly Value: new (initial: number) => AnimatedValueLike;
  /** `Animated.View`. */
  readonly View?: VNodeType;
}

/** The slice of React Native's `Platform` the stand-ins use. */
export interface PlatformLike {
  /** `"web"` in React Native mode (see `denext/react-native`'s Platform). */
  readonly OS: string;
}

/** react-native-web's `View` in React Native mode; `undefined` here. */
export const View: VNodeType | undefined = undefined;
/** react-native-web's `Text` in React Native mode; `undefined` here. */
export const Text: VNodeType | undefined = undefined;
/** react-native-web's `ScrollView` in React Native mode; `undefined` here. */
export const ScrollView: VNodeType | undefined = undefined;
/** react-native-web's `Pressable` in React Native mode; `undefined` here. */
export const Pressable: VNodeType | undefined = undefined;
/** react-native-web's `Image` in React Native mode; `undefined` here. */
export const Image: VNodeType | undefined = undefined;
/** react-native-web's `StyleSheet` in React Native mode; `undefined` here. */
export const StyleSheet: StyleSheetLike | undefined = undefined;
/** react-native-web's `Animated` in React Native mode; `undefined` here. */
export const Animated: AnimatedLike | undefined = undefined;
/** React Native mode's `Platform`; `undefined` here. */
export const Platform: PlatformLike | undefined = undefined;
