/**
 * `@react-native-menu/menu` for denext (and `@expo/ui/community/menu`, which is
 * API-compatible): `MenuView` wraps a trigger; a tap (or, with `shouldOpenOnLongPress`, a long
 * press or right click) opens the actions as `denext/mobile`'s {@linkcode showContextMenu}:
 * the app's native `DenextContextMenu` plugin in the Capacitor shell when it registers one,
 * the OS menu in a Deno Desktop window, else an in-page menu.
 *
 * The menu is one level deep: `displayInline` sections are spliced in place, and a submenu's
 * actions are listed after their parent's title (`Sort › By name`). `hidden` actions are left
 * out, `disabled` and `destructive` are honoured, and `state: "on"` shows a check mark.
 * `image` icons are not drawn.
 *
 * @example
 * ```ts
 * import { MenuView } from "@react-native-menu/menu";
 * import { h } from "denext/jsx-runtime";
 *
 * h(MenuView, {
 *   actions: [{ id: "share", title: "Share" }, {
 *     id: "delete",
 *     title: "Delete",
 *     attributes: { destructive: true },
 *   }],
 *   onPressAction: ({ nativeEvent }) => console.log(nativeEvent.event),
 * }, "•••");
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useImperativeHandle, useRef } from "../runtime/hooks.ts";
import {
  type ContextMenuItem,
  type ContextMenuOptions,
  showContextMenu,
} from "../mobile/context-menu.ts";
import { hasReactNative, hostView, viewStyle } from "../expo/internal/common.ts";

/** An action's flags. */
export interface MenuAttributes {
  /** Drawn as destructive. */
  destructive?: boolean;
  /** Shown but not selectable. */
  disabled?: boolean;
  /** Left out. */
  hidden?: boolean;
}

/** One menu action. */
export interface MenuAction {
  /** What `onPressAction` reports (default: the title). */
  id?: string;
  /** The label. */
  title: string;
  /** A subtitle (not drawn). */
  subtitle?: string;
  /** The title colour (ignored). */
  titleColor?: unknown;
  /** An icon (not drawn). */
  image?: unknown;
  /** The icon colour (ignored). */
  imageColor?: unknown;
  /** `"on"` shows a check mark. */
  state?: "on" | "off" | "mixed";
  /** Flags. */
  attributes?: MenuAttributes;
  /** A submenu, or with `displayInline` an inline section. */
  subactions?: MenuAction[];
  /** Splice `subactions` in place instead of a submenu. */
  displayInline?: boolean;
}

/** What `onPressAction` receives. */
export interface NativeActionEvent {
  /** The event. */
  nativeEvent: {
    /** The chosen action's id (or title). */
    event: string;
  };
}

/** The ref handle of a {@linkcode MenuView}. */
export interface MenuComponentRef {
  /** Open the menu. */
  show(): void;
}

/** `MenuView` props (plus any view prop). */
export interface MenuComponentProps {
  /** The actions. */
  actions: MenuAction[];
  /** The menu's title. */
  title?: string;
  /** Called with the chosen action. */
  onPressAction?: (event: NativeActionEvent) => void;
  /** Called when the menu opens. */
  onOpenMenu?: () => void;
  /** Called when the menu closes (after a choice or a dismissal). */
  onCloseMenu?: () => void;
  /** Open on a long press (or right click) instead of a tap. Default `false`. */
  shouldOpenOnLongPress?: boolean;
  /** The Android colour scheme (ignored). */
  colorScheme?: string;
  /** The Android theme variant (ignored). */
  themeVariant?: string;
  /** iOS's preferred action order (ignored). */
  isAnchoredToRight?: boolean;
  /** The trigger's style. */
  style?: unknown;
  /** The test id. */
  testID?: string;
  /** The ref handle ({@linkcode MenuComponentRef}). */
  ref?: unknown;
  /** The trigger. */
  children?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/**
 * The actions as one flat list of {@linkcode ContextMenuItem}s.
 *
 * @param actions The actions.
 * @param prefix The parent submenu's path (`"Sort › "`), empty at the top.
 * @returns The items, in order.
 */
export function menuItems(actions: readonly MenuAction[], prefix = ""): ContextMenuItem[] {
  return actions.flatMap((action) => {
    if (action.attributes?.hidden) return [];
    if (!action.subactions?.length) return [menuItem(action, prefix)];
    const nested = action.displayInline ? prefix : `${prefix}${action.title} › `;
    return menuItems(action.subactions, nested);
  });
}

/** One leaf action as a {@linkcode ContextMenuItem}. */
function menuItem(action: MenuAction, prefix: string): ContextMenuItem {
  const attributes = action.attributes ?? {};
  return {
    id: action.id ?? action.title,
    label: `${prefix}${action.title}`,
    disabled: attributes.disabled,
    destructive: attributes.destructive,
    icon: action.state === "on" ? "✓" : undefined,
  };
}

/**
 * Open the menu: `onOpenMenu`, the choice to `onPressAction`, then `onCloseMenu`.
 *
 * @param actions The actions.
 * @param options Where, and the title.
 * @param callbacks The view's callbacks.
 */
async function openMenu(
  actions: readonly MenuAction[],
  options: ContextMenuOptions,
  callbacks: Pick<MenuComponentProps, "onOpenMenu" | "onPressAction" | "onCloseMenu">,
): Promise<void> {
  callbacks.onOpenMenu?.();
  const choice = await showContextMenu(menuItems(actions), options);
  if (choice !== null) callbacks.onPressAction?.({ nativeEvent: { event: choice } });
  callbacks.onCloseMenu?.();
}

/** How long a press must be held to count as a long press, in ms. */
const LONG_PRESS_MS = 500;

/**
 * A trigger that opens a menu of actions.
 *
 * @param props The actions, the callbacks and the trigger.
 * @returns The trigger view.
 */
export function MenuView(props: MenuComponentProps): VNode {
  const {
    actions,
    title,
    onPressAction: _press,
    onOpenMenu: _open,
    onCloseMenu: _close,
    shouldOpenOnLongPress = false,
    colorScheme: _c,
    themeVariant: _t,
    isAnchoredToRight: _r,
    style,
    testID,
    ref,
    children,
    ...rest
  } = props;
  const host = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = (at?: { x: number; y: number }) =>
    openMenu(actions, { ...at, anchor: host.current?.getBoundingClientRect?.(), title }, props);
  useImperativeHandle(ref as never, (): MenuComponentRef => ({ show: () => void open() }));
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const handlers = shouldOpenOnLongPress
    ? {
      onPointerDown: (e: PointerEvent) => {
        cancel();
        const at = { x: e.clientX, y: e.clientY };
        timer.current = setTimeout(() => {
          timer.current = null;
          void open(at);
        }, LONG_PRESS_MS);
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        cancel();
        void open({ x: e.clientX, y: e.clientY });
      },
    }
    : { onClick: (e: MouseEvent) => void open({ x: e.clientX, y: e.clientY }) };
  return h(
    hostView(),
    {
      ...rest,
      ...handlers,
      ref: host,
      ...(hasReactNative() ? { testID } : { "data-testid": testID }),
      style: viewStyle(style),
    },
    children as never,
  );
}

export default MenuView;
