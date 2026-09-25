/**
 * The React Native primitives the `denext/expo/*` component shims render with, when there
 * are any.
 *
 * This file is the fallback: every export is `undefined`, so a shim renders plain DOM
 * elements (a `<div>` for a view, an `<img>` for an image). In React Native mode
 * (`reactNative` in `denext.config.ts`) the build points this module at the app's own
 * react-native-web, so the same shims render real `View` / `Image` components and inherit
 * React Native's style handling (style arrays, `paddingHorizontal`, flex defaults).
 *
 * Internal to the shims: not a `denext/expo/*` entrypoint.
 *
 * @module
 */

import type { VNodeType } from "../../jsx/types.ts";

/** The slice of React Native's `AppRegistry` that `registerRootComponent` uses. */
export interface AppRegistryLike {
  /** Register `component` under `appKey`. */
  registerComponent(appKey: string, getComponent: () => unknown): string;
  /** Mount the registered component into `rootTag`. */
  runApplication(appKey: string, parameters: { rootTag: unknown; initialProps?: unknown }): void;
}

/** The slice of React Native's `StyleSheet` the shims use. */
export interface StyleSheetLike {
  /** Merge a (possibly nested) style array into one object. */
  flatten(style: unknown): Record<string, unknown> | undefined;
}

/** react-native-web's `View` in React Native mode; `undefined` here. */
export const View: VNodeType | undefined = undefined;
/** react-native-web's `Image` in React Native mode; `undefined` here. */
export const Image: VNodeType | undefined = undefined;
/** react-native-web's `AppRegistry` in React Native mode; `undefined` here. */
export const AppRegistry: AppRegistryLike | undefined = undefined;
/** react-native-web's `StyleSheet` in React Native mode; `undefined` here. */
export const StyleSheet: StyleSheetLike | undefined = undefined;
