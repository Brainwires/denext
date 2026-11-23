/**
 * `denext/gpui`: render React Native primitives into a Deno Desktop window's **native tree**
 * (laufey's `gpui` backend) instead of a web view's DOM.
 *
 * The app keeps writing React: `View`, `Text`, `Image`, `ScrollView`, `TextInput` and
 * `Pressable`, styled with React Native's `StyleSheet`. A `react-reconciler` renderer, which the
 * app passes in and which loads against denext's own React core, turns each commit into one
 * binary batch (NTB1) for the window's `nativeTree.commit`, and the host's events come back to
 * the components' handlers. denext imports no npm package for it.
 *
 * It needs denext's Deno Desktop runtime on the `gpui` backend (`desktop.backend: "gpui"`).
 * Elsewhere {@linkcode render} throws a {@linkcode GpuiUnsupportedError} (`code: "unsupported"`)
 * and {@linkcode gpuiSupport} says why. While a root is mounted,
 * `Platform.constants.denextShell` is `"gpui"`.
 *
 * Version 1 has no `VirtualList`, navigation, animation, transforms or shadows.
 *
 * @example
 * ```ts ignore
 * import createReconciler from "react-reconciler";
 * import { h, useState } from "denext/react";
 * import { Pressable, render, StyleSheet, Text, View } from "denext/gpui";
 *
 * function Counter() {
 *   const [n, setN] = useState(0);
 *   return h(
 *     View,
 *     { style: styles.box },
 *     h(Pressable, { onPress: () => setN(n + 1) }, h(Text, null, `Pressed ${n} times`)),
 *   );
 * }
 * const styles = StyleSheet.create({ box: { flex: 1, padding: 16, backgroundColor: "#fafafa" } });
 *
 * render(h(Counter, null), {
 *   window: new Deno.BrowserWindow({ title: "Counter" }),
 *   reconciler: createReconciler,
 * });
 * ```
 *
 * @module
 */

export {
  AppRegistry,
  type GpuiAppParameters,
  type GpuiAppRegistry,
  type GpuiComponentProvider,
  type GpuiDesktopApi,
  type GpuiRenderOptions,
  type GpuiRoot,
  type GpuiSupport,
  gpuiSupport,
  GpuiUnsupportedError,
  type ReactReconcilerFactory,
  type ReactReconcilerInstance,
  render,
} from "./mount.ts";
export {
  type ContainerOptions,
  type NativeTreeApi,
  NativeTreeBatchError,
  NativeTreeCommitError,
  type NativeTreeWindow,
} from "./container.ts";
export {
  type FocusEvent,
  type GpuiComponent,
  type GpuiImageProps,
  type GpuiPressableProps,
  type GpuiPressProps,
  type GpuiScrollViewProps,
  type GpuiStyle,
  type GpuiTextInputProps,
  type GpuiTextProps,
  type GpuiViewProps,
  Image,
  type KeyPressEvent,
  type LayoutEvent,
  Pressable,
  type PressableState,
  type ScrollEvent,
  ScrollView,
  Text,
  TextInput,
  View,
} from "./components.ts";
export { type GpuiStyleSheet, StyleSheet } from "./stylesheet.ts";
export type { StyleProp } from "./style.ts";
export { parseColor } from "./color.ts";
export { NATIVE_TREE_EVENT } from "./events.ts";
export type { PressabilityConfig, PressEvent } from "../react-native/pressability.ts";
export {
  type DesktopOS,
  Platform,
  type PlatformConstants,
  type PlatformSelectSpec,
  type PlatformStatic,
  type ReactNativeVersion,
} from "../react-native/platform.ts";
