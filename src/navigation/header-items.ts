/**
 * React Navigation native-stack's bar button items (`unstable_headerLeftItems` /
 * `unstable_headerRightItems`, React Navigation 7.1x, the iOS 26 toolbar API) as header slot
 * content: a `button` item is a button (its SF Symbol icon drawn by `SystemIcon`, else its
 * label), a `menu` item a button that opens its menu with `showContextMenu` (an in-page menu,
 * or the native one where the shell has it), `spacing` a gap and `custom` its own element.
 * Internal to `react-navigation.ts`.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { SystemIcon } from "../mobile/system-icon.ts";
import type { ContextMenuItem } from "../mobile/context-menu.ts";

/** An item's icon: an SF Symbol or an image. */
type ItemIcon =
  | { readonly type: "sfSymbol"; readonly name: string }
  | { readonly type: "image"; readonly source?: unknown };

/** What `button` and `menu` items share. */
interface SharedItem {
  readonly label?: string;
  readonly icon?: ItemIcon;
  readonly tintColor?: unknown;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly width?: number;
}

/** A menu entry: an action or a submenu. */
interface MenuEntry {
  readonly type: "action" | "submenu";
  readonly label: string;
  readonly description?: string;
  readonly icon?: ItemIcon;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly hidden?: boolean;
  readonly items?: readonly MenuEntry[];
}

/** One bar item. */
type HeaderItem =
  | SharedItem & { readonly type: "button"; readonly onPress?: () => void }
  | SharedItem & {
    readonly type: "menu";
    readonly menu?: { readonly title?: string; readonly items?: readonly MenuEntry[] };
  }
  | { readonly type: "spacing"; readonly spacing?: number }
  | { readonly type: "custom"; readonly element?: VNodeChildren };

/** An image icon's URL (a `{ uri }` source or a string). */
function imageUri(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  const uri = (source as { uri?: unknown } | null)?.uri;
  return typeof uri === "string" ? uri : undefined;
}

/** The icon drawn for an item, or null (the label is drawn instead). */
function iconOf(icon: ItemIcon | undefined): VNode | null {
  if (icon?.type === "sfSymbol") return h(SystemIcon, { name: icon.name, size: 22 });
  const uri = icon?.type === "image" ? imageUri(icon.source) : undefined;
  return uri ? h("img", { src: uri, alt: "", width: 22, height: 22 }) : null;
}

/** A bar button. */
function barButton(item: SharedItem, onClick: (event: MouseEvent) => void): VNode {
  const label = item.accessibilityLabel ?? item.label ?? "";
  const icon = iconOf(item.icon);
  return h("button", {
    type: "button",
    "data-dnx-header-item": "",
    "aria-label": label || undefined,
    disabled: item.disabled === true,
    onClick,
    style: buttonStyle(item, icon !== null),
  }, icon ?? item.label ?? "");
}

/** A bar button's style: a 36 px target, tinted like the header (or the item's own tint). */
function buttonStyle(item: SharedItem, hasIcon: boolean): Record<string, unknown> {
  const disabled = item.disabled === true;
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 36,
    height: 36,
    width: item.width,
    padding: hasIcon ? 0 : "0 8px",
    border: 0,
    borderRadius: 18,
    background: "none",
    font: "inherit",
    fontSize: 17,
    color: typeof item.tintColor === "string" ? item.tintColor : "var(--dnx-header-tint, LinkText)",
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? "default" : "pointer",
  };
}

/** A menu's entries as context-menu items, with each action's `onPress` by id. */
function menuItems(
  entries: readonly MenuEntry[],
  actions: Map<string, () => void>,
  prefix = "",
): ContextMenuItem[] {
  return entries.filter((e) => !e.hidden).map((entry, i) => {
    const id = `${prefix}${i}`;
    if (entry.type === "submenu") {
      return { id, label: entry.label, children: menuItems(entry.items ?? [], actions, `${id}.`) };
    }
    if (entry.onPress) actions.set(id, entry.onPress);
    return {
      id,
      label: entry.label,
      subtitle: entry.description,
      disabled: entry.disabled,
      destructive: entry.destructive,
      systemIcon: entry.icon?.type === "sfSymbol" ? entry.icon.name : undefined,
    };
  });
}

/** Open a `menu` item's menu under its button and run the chosen action. */
async function openMenu(
  menu: { readonly title?: string; readonly items?: readonly MenuEntry[] } | undefined,
  anchor: Element | null,
): Promise<void> {
  const actions = new Map<string, () => void>();
  const items = menuItems(menu?.items ?? [], actions);
  const { showContextMenu } = await import("../mobile/context-menu.ts");
  const choice = await showContextMenu(items, {
    anchor: anchor?.getBoundingClientRect(),
    title: menu?.title,
  });
  if (choice !== null) actions.get(choice)?.();
}

/** One item's node. */
function itemNode(item: HeaderItem): VNodeChildren {
  switch (item.type) {
    case "button":
      return barButton(item, () => item.onPress?.());
    case "menu":
      return barButton(item, (event) => {
        openMenu(item.menu, event.currentTarget as Element | null).catch(() => {});
      });
    case "spacing":
      return h("span", { style: { flex: "none", width: item.spacing ?? 8 } });
    case "custom":
      return item.element ?? null;
    default:
      return null;
  }
}

/**
 * A native-stack `unstable_header…Items` option as header slot content, or undefined when it
 * is not a function.
 *
 * @param value The option (`(props) => NativeStackHeaderItem[]`).
 * @param args What it is called with (`tintColor`, `canGoBack`).
 */
export function headerItems(
  value: unknown,
  args: Record<string, unknown>,
): VNodeChildren | undefined {
  if (typeof value !== "function") return undefined;
  const items = (value as (a: unknown) => unknown)(args);
  if (!Array.isArray(items) || items.length === 0) return undefined;
  // Each item in a keyed `display: contents` box (a custom element keeps its own key).
  return items.map((item, i) =>
    h("span", { key: i, style: { display: "contents" } }, itemNode(item as HeaderItem))
  );
}
