/**
 * `denext/navigation` — native-feeling navigation for App Router apps (and, through adapters,
 * React Navigation / Expo Router in React Native mode):
 *
 * - {@linkcode StackLayout}: the routes under a layout as a stack. A push keeps the screens
 *   below mounted (state and scroll kept, via `<Activity>`), a pop shows them again at once;
 *   platform push/pop animations (View Transitions where supported), the iOS edge swipe that
 *   follows the finger, Android predictive back and the back button, a native-style header, and
 *   `modal` / `formSheet` / `transparentModal` presentations. The URL history is the stack:
 *   browser back, deep links and reloads keep it consistent. Per-route options come from a
 *   page's `export const screenOptions = { … }` or {@linkcode useStackNavigation}'s
 *   `setOptions`.
 * - {@linkcode TabsLayout}: a tab bar whose tabs keep their state and stacks; re-tapping the
 *   active tab pops to its root, then scrolls to the top.
 * - {@linkcode Sheet}: a bottom sheet with detents, drag, dismissal, a focus trap and keyboard
 *   avoidance.
 * - {@linkcode createNativeStackNavigatorFactory} / {@linkcode createBottomTabNavigatorFactory}:
 *   React Navigation navigators drawn by the same views (React Native mode).
 *
 * Client components: render them from a `"use client"` file. Importing this module runs
 * nothing, and an app that does not import it ships none of it.
 *
 * @module
 */

export {
  StackLayout,
  type StackLayoutProps,
  type StackNavigation,
  useStackNavigation,
} from "./stack-layout.ts";
export {
  StackView,
  type StackViewAnimate,
  type StackViewHandle,
  type StackViewProps,
  useScreenInfo,
} from "./stack-view.ts";
export { StackHeader, type StackHeaderProps } from "./header.ts";
export {
  type TabDefinition,
  TabsLayout,
  type TabsLayoutProps,
  TabsView,
  type TabsViewProps,
} from "./tabs.ts";
export { Sheet, type SheetProps } from "./sheet.ts";
export {
  createBottomTabNavigatorFactory,
  createNativeStackNavigatorFactory,
  type ReactNavigationCore,
  type ReactNavigationDescriptor,
  type ReactNavigationObject,
  type ReactNavigationRoute,
  type ReactNavigationState,
} from "./react-navigation.ts";
export type { TabScope, TabStackHandle } from "./context.ts";
// The element types the components above take and return (so this entry's docs are
// self-contained); `Fragment` is the value `VNodeType` names.
export { Fragment } from "../jsx/jsx-runtime.ts";
export type {
  Component,
  Key,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "../jsx/types.ts";
export type {
  NavigationPlatform,
  ScreenOptions,
  SheetDetent,
  StackAnimation,
  StackPresentation,
  StackViewEntry,
} from "./types.ts";
