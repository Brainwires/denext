/**
 * A native-or-web context menu for `denext/mobile`: the native `DenextContextMenu` Capacitor
 * plugin in the shell when it is installed (`denext mobile add context-menu`: a `UIMenu` on iOS,
 * a `PopupMenu` on Android), else an accessible in-DOM popover that lists every item. The web
 * fallback never drops an item: a submenu's items are listed as a labelled group.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";
import { onDesktop, viaDesktop } from "./desktop-branch.ts";
import { isNativeShell } from "./bridge.ts";
import { haptic } from "./haptics.ts";

/** One entry in a {@linkcode showContextMenu} menu. */
export interface ContextMenuItem {
  /** The value {@linkcode showContextMenu} resolves with when this item is chosen. */
  readonly id: string;
  /** The visible label. */
  readonly label: string;
  /** Shown but not selectable when `true`. */
  readonly disabled?: boolean;
  /** Styled as a destructive action (`data-destructive` on the web). */
  readonly destructive?: boolean;
  /** An optional leading glyph/emoji rendered before the label (the web popover). */
  readonly icon?: string;
  /**
   * An SF Symbol name (`"trash"`, `"square.and.arrow.up"`) drawn by the native iOS menu. The
   * web popover shows `icon` instead; Android's menu shows none.
   */
  readonly systemIcon?: string;
  /** A second line under the label (iOS 15+; appended to the label elsewhere as `—`). */
  readonly subtitle?: string;
  /**
   * A submenu: its items open from this one on iOS; Android and the web popover list them as a
   * labelled group under this item's label. This item's own `id` is never resolved.
   */
  readonly children?: readonly ContextMenuItem[];
}

/** Where and how {@linkcode showContextMenu} opens. */
export interface ContextMenuOptions {
  /** Viewport x for the top-left of the menu (defaults to `anchor.left`, else `0`). */
  readonly x?: number;
  /** Viewport y for the top-left of the menu (defaults to `anchor.bottom`, else `0`). */
  readonly y?: number;
  /** A rect to anchor the menu under when `x`/`y` are omitted (e.g. `el.getBoundingClientRect()`). */
  readonly anchor?: DOMRect;
  /** An accessible title/header for the menu. */
  readonly title?: string;
  /**
   * A long-press haptic as the menu opens, inside the native shell only (default `false`;
   * {@linkcode useContextMenu} turns it on for a long press).
   */
  readonly haptic?: boolean;
}

/** One item as the native plugin receives it (the JSON the bridge carries). */
export interface NativeMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  icon?: string;
  systemIcon?: string;
  subtitle?: string;
  children?: NativeMenuItem[];
}

/** The JS side of the `DenextContextMenu` Capacitor plugin (`denext mobile add context-menu`). */
interface ContextMenuPlugin {
  show(options: {
    items: NativeMenuItem[];
    title?: string;
    x?: number;
    y?: number;
    haptic?: boolean;
  }): Promise<{ selectedId?: string | null } | null>;
}

/**
 * `items` as the native plugin takes them: only the fields that are set, submenus nested.
 * Exported for {@linkcode useContextMenu}'s armed iOS menus.
 */
export function nativeMenuItems(items: readonly ContextMenuItem[]): NativeMenuItem[] {
  return items.map((it) => ({
    id: it.id,
    label: it.label,
    ...(it.disabled ? { disabled: true } : {}),
    ...(it.destructive ? { destructive: true } : {}),
    ...(it.icon !== undefined ? { icon: it.icon } : {}),
    ...(it.systemIcon !== undefined ? { systemIcon: it.systemIcon } : {}),
    ...(it.subtitle !== undefined ? { subtitle: it.subtitle } : {}),
    ...(it.children ? { children: nativeMenuItems(it.children) } : {}),
  }));
}

/** The slice of an element the web popover uses (real DOM and the test DOM both satisfy it). */
interface MenuEl {
  setAttribute(name: string, value: string): void;
  readonly style: { setProperty(name: string, value: string): void };
  addEventListener(type: string, fn: (e: MenuEvent) => void, options?: unknown): void;
  removeEventListener(type: string, fn: (e: MenuEvent) => void, options?: unknown): void;
  appendChild(node: unknown): unknown;
  remove(): void;
  focus?(): void;
  textContent: string;
  readonly parentNode: MenuEl | null;
}

/** The slice of `document` the web popover uses. */
interface MenuDocument {
  createElement(tag: string): MenuEl;
  body?: { appendChild(node: unknown): unknown } | null;
  addEventListener(type: string, fn: (e: MenuEvent) => void, options?: unknown): void;
  removeEventListener(type: string, fn: (e: MenuEvent) => void, options?: unknown): void;
}

/** A DOM event as this module reads it (keydown / pointerdown). */
interface MenuEvent {
  target?: MenuEl | null;
  key?: string;
  preventDefault?: () => void;
}

/** Whether `node` is `root` or a descendant of it. */
function contains(root: MenuEl, node: MenuEl | null | undefined): boolean {
  for (let n: MenuEl | null | undefined = node; n; n = n.parentNode) {
    if (n === root) return true;
  }
  return false;
}

/** A process-wide counter so each menu's ids are unique. */
let menuSeq = 0;

/** Build, mount and drive the accessible in-DOM popover; resolves the chosen id, or null. */
function showWebContextMenu(
  items: readonly ContextMenuItem[],
  options: ContextMenuOptions,
): Promise<string | null> {
  const doc = (globalThis as { document?: MenuDocument }).document;
  // Non-DOM (server) context, or nothing to show: render nothing, resolve null.
  if (typeof doc?.createElement !== "function" || !doc.body || items.length === 0) {
    return Promise.resolve(null);
  }

  return new Promise<string | null>((resolve) => {
    const seq = ++menuSeq;
    const menu = doc.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("tabindex", "-1");

    if (options.title !== undefined) {
      const titleId = `denext-context-menu-${seq}-title`;
      const title = doc.createElement("div");
      title.setAttribute("id", titleId);
      title.setAttribute("data-menu-title", "true");
      title.textContent = options.title;
      menu.appendChild(title);
      menu.setAttribute("aria-labelledby", titleId);
    }

    const x = options.x ?? options.anchor?.left ?? 0;
    const y = options.y ?? options.anchor?.bottom ?? 0;
    menu.style.setProperty("position", "fixed");
    menu.style.setProperty("left", `${x}px`);
    menu.style.setProperty("top", `${y}px`);
    menu.style.setProperty("margin", "0");

    const entries: Array<{ item: ContextMenuItem; el: MenuEl; enabled: boolean }> = [];
    let settled = false;
    let active = -1;

    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      menu.removeEventListener("keydown", onKey);
      doc.removeEventListener("pointerdown", onOutside);
      doc.removeEventListener("keydown", onOutside);
      menu.remove();
      resolve(result);
    };

    const setActive = (index: number) => {
      active = index;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        e.el.setAttribute("tabindex", i === index && e.enabled ? "0" : "-1");
      }
      const el = entries[index]?.el;
      if (typeof el?.focus === "function") el.focus();
    };

    /** Move focus to the next/previous enabled item, wrapping. */
    const move = (delta: number) => {
      const enabled = entries.filter((e) => e.enabled);
      if (enabled.length === 0) return;
      const start = active < 0 ? (delta > 0 ? -1 : 0) : active;
      for (let step = 1; step <= entries.length; step++) {
        const next = (start + delta * step + entries.length * step) % entries.length;
        if (entries[next]?.enabled) return setActive(next);
      }
    };

    function onKey(e: MenuEvent): void {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault?.();
          return move(1);
        case "ArrowUp":
          e.preventDefault?.();
          return move(-1);
        case "Enter":
        case " ":
        case "Spacebar": {
          e.preventDefault?.();
          const entry = entries[active];
          if (entry?.enabled) finish(entry.item.id);
          return;
        }
        case "Escape":
        case "Esc":
          e.preventDefault?.();
          return finish(null);
      }
    }

    /** Dismiss on Escape reaching the document, or a pointer press outside the menu. */
    function onOutside(e: MenuEvent): void {
      if (e.key !== undefined) {
        if (e.key === "Escape" || e.key === "Esc") finish(null);
        return;
      }
      if (!contains(menu, e.target)) finish(null);
    }

    let groupSeq = 0;
    /** A text span with `attr` set (the icon, the label, the subtitle). */
    const span = (text: string, attr?: string) => {
      const el = doc.createElement("span");
      if (attr) {
        el.setAttribute("aria-hidden", "true");
        el.setAttribute(attr, "true");
      }
      el.textContent = text;
      return el;
    };

    /** One selectable item, appended to `parent`. */
    const addItem = (parent: MenuEl, item: ContextMenuItem, parentDisabled: boolean) => {
      const el = doc.createElement("div");
      el.setAttribute("role", "menuitem");
      el.setAttribute("tabindex", "-1");
      const enabled = item.disabled !== true && !parentDisabled;
      if (!enabled) el.setAttribute("aria-disabled", "true");
      if (item.destructive) el.setAttribute("data-destructive", "true");
      if (item.icon !== undefined) el.appendChild(span(item.icon, "data-menu-icon"));
      el.appendChild(span(item.label));
      if (item.subtitle !== undefined) {
        const sub = span(item.subtitle);
        sub.setAttribute("data-menu-subtitle", "true");
        el.appendChild(sub);
      }
      if (enabled) el.addEventListener("click", () => finish(item.id));
      parent.appendChild(el);
      entries.push({ item, el, enabled });
    };

    /** `items` into `parent`; a submenu becomes a `role="group"` labelled by its item. */
    const addItems = (parent: MenuEl, list: readonly ContextMenuItem[], disabled: boolean) => {
      for (const item of list) {
        if (!item.children) {
          addItem(parent, item, disabled);
          continue;
        }
        const group = doc.createElement("div");
        const labelId = `denext-context-menu-${seq}-group-${++groupSeq}`;
        group.setAttribute("role", "group");
        group.setAttribute("aria-labelledby", labelId);
        const label = span(item.label);
        label.setAttribute("id", labelId);
        label.setAttribute("data-menu-group-label", "true");
        group.appendChild(label);
        addItems(group, item.children, disabled || item.disabled === true);
        parent.appendChild(group);
      }
    };
    addItems(menu, items, false);

    menu.addEventListener("keydown", onKey);
    doc.body!.appendChild(menu);

    const first = entries.findIndex((e) => e.enabled);
    if (first >= 0) setActive(first);
    else if (typeof menu.focus === "function") menu.focus();

    // Attach the outside-dismiss listeners after the current task so the click/keypress
    // that opened the menu does not immediately close it.
    queueMicrotask(() => {
      if (settled) return;
      doc.addEventListener("pointerdown", onOutside);
      doc.addEventListener("keydown", onOutside);
    });
  });
}

/**
 * Open a context menu and resolve the chosen item's `id`, or `null` if it was dismissed.
 *
 * - Inside the native shell with the `DenextContextMenu` plugin (`denext mobile add
 *   context-menu`), the OS menu: on iOS a `UIMenu` at `(x, y)` (the edit-menu presentation,
 *   iOS 16+; an action sheet on iOS 15) with SF Symbol `systemIcon`s, subtitles, destructive
 *   and disabled items and submenus; on Android a Material `PopupMenu` anchored at `(x, y)`
 *   (submenus as labelled groups, destructive items in the error color). For the long-press
 *   menu that lifts the pressed element (`UIContextMenuInteraction` with its preview), bind the
 *   element with {@linkcode useContextMenu} instead.
 * - Inside a Deno Desktop window with the `contextMenu` capability (`denext desktop add
 *   context-menu`) and denext's pinned runtime, the OS's own menu at `(x, y)`: submenus,
 *   disabled items, subtitles appended to the label, and `null` when the user dismisses it
 *   (`destructive`, `icon` and `systemIcon` are not drawn there; a `title` is a disabled first
 *   item). Without the capability, or under the stock runtime, the in-page popover below.
 * - Otherwise (the web, and SSR-safe) an accessible in-DOM popover: `role="menu"`
 *   with a `role="menuitem"` per item (a submenu is a `role="group"` labelled by its item),
 *   opened at `(x, y)` or under `anchor`. It is keyboard navigable (Up/Down to move,
 *   Enter/Space to choose, Escape to dismiss), dismisses on an outside pointer press, respects
 *   `disabled` (shown, not selectable) and `destructive`, and removes every node and listener it
 *   added when it resolves.
 *
 * Every path renders **every** item, so no menu action is silently dropped.
 *
 * @param items The menu entries (every one is rendered).
 * @param options `x`/`y` or `anchor` for placement, an optional `title`, and `haptic`.
 * @returns The chosen item's `id`, or `null` when dismissed (or in a non-DOM context, or when
 * `items` is empty).
 * @example
 * ```tsx
 * "use client";
 * import { showContextMenu } from "denext/mobile";
 *
 * export function Row({ id }: { id: string }) {
 *   return (
 *     <button
 *       type="button"
 *       onContextMenu={async (e) => {
 *         e.preventDefault();
 *         const choice = await showContextMenu(
 *           [
 *             { id: "open", label: "Open", systemIcon: "arrow.up.right.square" },
 *             {
 *               id: "move",
 *               label: "Move to",
 *               children: [
 *                 { id: "inbox", label: "Inbox" },
 *                 { id: "archive", label: "Archive" },
 *               ],
 *             },
 *             { id: "delete", label: "Delete", destructive: true, systemIcon: "trash" },
 *           ],
 *           { x: e.clientX, y: e.clientY },
 *         );
 *         if (choice === "delete") await remove(id);
 *       }}
 *     >
 *       Actions
 *     </button>
 *   );
 * }
 * ```
 */
export async function showContextMenu(
  items: readonly ContextMenuItem[],
  options: ContextMenuOptions = {},
): Promise<string | null> {
  const list = [...items];
  // Deno Desktop: the OS menu through the bridge (lazy, so web/mobile bundles never load it); an
  // `unavailable` answer (capability off, or the stock runtime) runs the popover instead.
  const x = options.x ?? options.anchor?.left ?? 0;
  const y = options.y ?? options.anchor?.bottom ?? 0;
  const desktop = list.length > 0 && onDesktop()
    ? await viaDesktop(
      "contextMenu",
      (d) => d.showNativeContextMenu(list, x, y, options.title),
    )
    : undefined;
  if (desktop) return desktop.value;
  const plugin = nativePlugin<ContextMenuPlugin>("DenextContextMenu", ["show"]);
  if (plugin && list.length > 0) {
    const result = await plugin.show({
      items: nativeMenuItems(list),
      ...(options.title !== undefined ? { title: options.title } : {}),
      x,
      y,
      ...(options.haptic ? { haptic: true } : {}),
    });
    const id = result?.selectedId;
    return typeof id === "string" ? id : null;
  }
  if (options.haptic && list.length > 0 && isNativeShell()) haptic("medium").catch(() => {});
  return await showWebContextMenu(list, options);
}
