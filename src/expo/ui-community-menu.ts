/**
 * `@expo/ui/community/menu` for denext: the same `MenuView` React Native mode gives
 * `@react-native-menu/menu` (the two are API-compatible). A tap on the trigger (or a long
 * press, with `shouldOpenOnLongPress`) opens the actions through `denext/mobile`'s
 * `showContextMenu`, and the chosen one reaches `onPressAction`. `@expo/ui`'s own web build
 * renders the trigger but never fires an action.
 *
 * @example
 * ```ts
 * import { MenuView } from "denext/expo/ui/community/menu";
 * import { h } from "denext/jsx-runtime";
 *
 * h(MenuView, {
 *   actions: [{ id: "copy", title: "Copy" }],
 *   onPressAction: ({ nativeEvent }) => console.log(nativeEvent.event),
 * }, "Open");
 * ```
 *
 * @module
 */

export {
  type MenuAction,
  type MenuAttributes,
  type MenuComponentProps,
  type MenuComponentRef,
  MenuView,
  MenuView as default,
  type NativeActionEvent,
} from "../react-native-compat/menu.ts";

/** A menu action's selection state. */
export type MenuState = "on" | "off";
