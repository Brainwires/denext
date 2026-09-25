/**
 * A native-or-web context menu for `denext/mobile`: a native `DenextContextMenu` Capacitor
 * plugin in the shell when one is registered, else an accessible in-DOM popover that lists every
 * item. The web fallback is the primary supported path and never drops an item.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";

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
  /** An optional leading glyph/emoji rendered before the label. */
  readonly icon?: string;
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
}

/** The JS side of an app-provided `DenextContextMenu` Capacitor plugin. */
interface ContextMenuPlugin {
  show(options: {
    items: Array<
      { id: string; label: string; disabled?: boolean; destructive?: boolean; icon?: string }
    >;
    title?: string;
    x?: number;
    y?: number;
  }): Promise<{ selectedId?: string | null } | null>;
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

    for (const item of items) {
      const el = doc.createElement("div");
      el.setAttribute("role", "menuitem");
      el.setAttribute("tabindex", "-1");
      if (item.disabled) el.setAttribute("aria-disabled", "true");
      if (item.destructive) el.setAttribute("data-destructive", "true");
      if (item.icon !== undefined) {
        const icon = doc.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        icon.setAttribute("data-menu-icon", "true");
        icon.textContent = item.icon;
        el.appendChild(icon);
      }
      const label = doc.createElement("span");
      label.textContent = item.label;
      el.appendChild(label);
      const enabled = item.disabled !== true;
      if (enabled) el.addEventListener("click", () => finish(item.id));
      menu.appendChild(el);
      entries.push({ item, el, enabled });
    }

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
 * - Inside the native shell with an app-registered `DenextContextMenu` plugin (see below), the OS
 *   menu — every item, including `disabled` and `destructive` ones, is handed to it.
 * - Otherwise (the web, desktop, and SSR-safe) an accessible in-DOM popover: `role="menu"`
 *   with a `role="menuitem"` per item, opened at `(x, y)` or under `anchor`. It is keyboard
 *   navigable (Up/Down to move, Enter/Space to choose, Escape to dismiss), dismisses on an
 *   outside pointer press, respects `disabled` (shown, not selectable) and `destructive`, and
 *   removes every node and listener it added when it resolves.
 *
 * The web fallback always renders **every** item, so no menu action is silently dropped.
 *
 * There is no first-party Capacitor context-menu plugin; the native path is feature-detected
 * by the plugin name `DenextContextMenu` with a `show({ items, title?, x?, y? })` method resolving
 * `{ selectedId?: string | null }`. Register such a plugin natively to take the OS path;
 * without it, the web popover is used inside the shell too.
 *
 * @param items The menu entries (every one is rendered).
 * @param options `x`/`y` or `anchor` for placement, and an optional `title`.
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
 *             { id: "open", label: "Open" },
 *             { id: "delete", label: "Delete", destructive: true },
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
  const plugin = nativePlugin<ContextMenuPlugin>("DenextContextMenu", ["show"]);
  if (plugin) {
    const result = await plugin.show({
      items: list.map((it) => ({
        id: it.id,
        label: it.label,
        ...(it.disabled ? { disabled: true } : {}),
        ...(it.destructive ? { destructive: true } : {}),
        ...(it.icon !== undefined ? { icon: it.icon } : {}),
      })),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.x !== undefined ? { x: options.x } : {}),
      ...(options.y !== undefined ? { y: options.y } : {}),
    });
    const id = result?.selectedId;
    return typeof id === "string" ? id : null;
  }
  return await showWebContextMenu(list, options);
}
