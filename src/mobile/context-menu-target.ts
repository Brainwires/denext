/**
 * Long-press (and right-click) context menus bound to an element, for `denext/mobile`:
 * {@linkcode useContextMenu} / {@linkcode attachContextMenu}.
 *
 * - **iOS shell with `denext mobile add context-menu`:** the real `UIContextMenuInteraction`.
 *   A press on the element arms the native side with the element's rect and items; the
 *   system's own long press then lifts the element (a snapshot preview with its corner radius),
 *   plays the system haptic and shows the `UIMenu` (SF Symbols, subtitles, destructive and
 *   disabled items, submenus). A secondary click on iPad opens it too.
 * - **Everywhere else:** a 500 ms long press that stays within 10 px (touch or pen), or a
 *   `contextmenu` event (a right click; Android's WebView sends one for a long press), opens
 *   {@linkcode showContextMenu} at the pointer — the native `PopupMenu` in the Android shell
 *   with a long-press haptic, the in-page popover on the web.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";
import {
  type ContextMenuItem,
  type NativeMenuItem,
  nativeMenuItems,
  showContextMenu,
} from "./context-menu.ts";

/** The items of a bound menu, or a function that builds them when the menu opens. */
export type ContextMenuItems = readonly ContextMenuItem[] | (() => readonly ContextMenuItem[]);

/** Options for {@linkcode useContextMenu} and {@linkcode attachContextMenu}. */
export interface ContextMenuTargetOptions {
  /** The menu's title (the iOS menu header; the popover's label). */
  readonly title?: string;
  /** How long a press must be held, in ms, off iOS's native interaction (default `500`). */
  readonly longPressMs?: number;
  /** A long-press haptic in the native shell (default `true`; the web never vibrates). */
  readonly haptic?: boolean;
  /** Stop opening menus without unbinding (default `false`). */
  readonly disabled?: boolean;
}

/** The iOS plugin's arming half (the same `DenextContextMenu` plugin as `showContextMenu`). */
interface ArmablePlugin {
  arm(options: {
    token: string;
    items: NativeMenuItem[];
    title?: string;
    rect: { x: number; y: number; width: number; height: number };
    cornerRadius: number;
  }): Promise<unknown>;
  disarm(options: { token: string }): Promise<unknown>;
  addListener(
    event: "menuAction",
    fn: (event: { token?: string; id?: string }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The pointer / mouse event fields this module reads. */
/** The slice of a pointer / mouse event a bound menu reads. */
export interface PressEvent {
  /** The pointer's id (pointer events). */
  readonly pointerId?: number;
  /** `"touch"`, `"pen"` or `"mouse"`. */
  readonly pointerType?: string;
  /** The mouse button (2 = secondary). */
  readonly button?: number;
  /** Viewport x of the press. */
  readonly clientX: number;
  /** Viewport y of the press. */
  readonly clientY: number;
  /** Suppress the default action (the browser's own menu). */
  preventDefault?(): void;
  /** Stop the event reaching ancestors. */
  stopPropagation?(): void;
}

/** The slice of an element a bound menu uses (real DOM and the test DOM both satisfy it). */
export interface ContextMenuElement {
  /** Listen for press events on the element. */
  addEventListener(type: string, fn: (e: PressEvent) => void, options?: unknown): void;
  /** Stop listening. */
  removeEventListener(type: string, fn: (e: PressEvent) => void, options?: unknown): void;
  /** The element's box (the native menu's preview and anchor). */
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
  /** Inline style access (the lift preview's corner radius). */
  readonly style?: {
    getPropertyValue?(name: string): string;
    setProperty?(name: string, value: string): void;
    removeProperty?(name: string): void;
  };
}

/** What a bound element reads at event time (the hook keeps it current across renders). */
interface Binding {
  items(): readonly ContextMenuItem[];
  onSelect(id: string): void;
  options(): ContextMenuTargetOptions;
}

/** The iOS plugin, when this is the iOS shell and the installed plugin can arm. */
function armablePlugin(): ArmablePlugin | undefined {
  if (nativePlatform() !== "ios") return undefined;
  return nativePlugin<ArmablePlugin>("DenextContextMenu", ["arm", "disarm", "addListener"]);
}

/** The one `menuAction` listener every armed element shares, created on first use. */
let dispatcher: { handlers: Map<string, (id: string) => void>; dispose: () => void } | null = null;
/** Token counter for armed elements. */
let tokenSeq = 0;

/** Route `token`'s menu choices to `handler`; returns the unregister. */
function onMenuAction(plugin: ArmablePlugin, token: string, handler: (id: string) => void) {
  if (!dispatcher) {
    const handlers = new Map<string, (id: string) => void>();
    const dispose = listenerDisposer(plugin.addListener("menuAction", (event) => {
      if (typeof event?.token === "string" && typeof event.id === "string") {
        handlers.get(event.token)?.(event.id);
      }
    }));
    dispatcher = { handlers, dispose };
  }
  const own = dispatcher;
  own.handlers.set(token, handler);
  return () => {
    own.handlers.delete(token);
    if (own.handlers.size > 0 || dispatcher !== own) return;
    own.dispose();
    dispatcher = null;
  };
}

/** The element's top-left corner radius in px (0 when unknown), for the lifted preview. */
function cornerRadius(el: ContextMenuElement): number {
  const cs = (globalThis as { getComputedStyle?: (e: unknown) => { borderTopLeftRadius?: string } })
    .getComputedStyle;
  try {
    const value = parseFloat(cs?.(el)?.borderTopLeftRadius ?? "");
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** iOS: arm the native interaction on every press; its long press shows the menu. */
function attachNative(
  el: ContextMenuElement,
  plugin: ArmablePlugin,
  bind: Binding,
): () => void {
  const token = `dnx-cm-${++tokenSeq}`;
  const unroute = onMenuAction(plugin, token, (id) => bind.onSelect(id));
  const arm = () => {
    const options = bind.options();
    if (options.disabled) return;
    const items = bind.items();
    if (items.length === 0) return;
    const r = el.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
    plugin.arm({
      token,
      items: nativeMenuItems(items),
      ...(options.title !== undefined ? { title: options.title } : {}),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      cornerRadius: cornerRadius(el),
    }).catch(() => {});
  };
  // A press that ends, or turns into a scroll (pointercancel), disarms, so the armed rect can
  // never match a later long press after the content moved. A long press the system took is
  // already configured by then.
  const disarm = () => void plugin.disarm({ token }).catch(() => {});
  // The native interaction owns the long press and the secondary click: keep WebKit's.
  const suppress = (e: PressEvent) => e.preventDefault?.();
  const listeners: Array<[string, (e: PressEvent) => void]> = [
    ["pointerdown", arm],
    ["pointerup", disarm],
    ["pointercancel", disarm],
    ["contextmenu", suppress],
  ];
  for (const [type, fn] of listeners) el.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of listeners) el.removeEventListener(type, fn);
    unroute();
    disarm();
  };
}

/** The in-progress press of the JS path. */
interface Press {
  timer: ReturnType<typeof setTimeout> | null;
  id: number | undefined;
  type: string | undefined;
  x: number;
  y: number;
  /** A menu opened during this press (its click and a late `contextmenu` are swallowed). */
  opened: boolean;
}

/** Off iOS's native interaction: a long press or a `contextmenu` event opens the menu. */
function attachJs(el: ContextMenuElement, bind: Binding): () => void {
  const press: Press = { timer: null, id: undefined, type: undefined, x: 0, y: 0, opened: false };
  const cancel = () => {
    if (press.timer !== null) clearTimeout(press.timer);
    press.timer = null;
  };
  const open = (x: number, y: number, withHaptic: boolean) => {
    cancel();
    const options = bind.options();
    const items = bind.items();
    if (options.disabled || items.length === 0) return;
    press.opened = true;
    showContextMenu(items, {
      x,
      y,
      ...(options.title !== undefined ? { title: options.title } : {}),
      haptic: withHaptic && options.haptic !== false,
    }).then((id) => {
      if (id !== null) bind.onSelect(id);
    }, () => {});
  };
  const down = (e: PressEvent) => {
    press.opened = false;
    press.type = e.pointerType;
    if (e.pointerType === "mouse" || (e.button ?? 0) !== 0) return;
    cancel();
    press.id = e.pointerId;
    press.x = e.clientX;
    press.y = e.clientY;
    press.timer = setTimeout(
      () => open(press.x, press.y, true),
      bind.options().longPressMs ?? 500,
    );
  };
  const move = (e: PressEvent) => {
    if (press.timer === null || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel();
  };
  const end = () => cancel();
  const context = (e: PressEvent) => {
    e.preventDefault?.();
    if (press.opened) return;
    const touch = press.timer !== null || press.type === "touch" || press.type === "pen";
    open(e.clientX, e.clientY, touch);
  };
  // The click that ends a long press that opened a menu must not also activate the element.
  const click = (e: PressEvent) => {
    if (!press.opened) return;
    e.preventDefault?.();
    e.stopPropagation?.();
  };
  const listeners: Array<[string, (e: PressEvent) => void, unknown?]> = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", end],
    ["pointercancel", end],
    ["contextmenu", context],
    ["click", click, true],
  ];
  for (const [type, fn, opt] of listeners) el.addEventListener(type, fn, opt);
  return () => {
    cancel();
    for (const [type, fn, opt] of listeners) el.removeEventListener(type, fn, opt);
  };
}

/** Turn off iOS's link callout and text selection on the element while bound. */
function suppressCallout(el: ContextMenuElement): () => void {
  const style = el.style;
  if (typeof style?.setProperty !== "function") return () => {};
  const props = ["-webkit-touch-callout", "-webkit-user-select", "user-select"];
  const saved = props.map((p) => style.getPropertyValue?.(p) ?? "");
  for (const p of props) style.setProperty!(p, "none");
  return () =>
    props.forEach((p, i) => saved[i] ? style.setProperty!(p, saved[i]) : style.removeProperty?.(p));
}

/** Bind `bind` to `el` on the path this runtime takes; returns the unbind. */
function attach(el: ContextMenuElement, bind: Binding): () => void {
  const restore = suppressCallout(el);
  const plugin = armablePlugin();
  const detach = plugin ? attachNative(el, plugin, bind) : attachJs(el, bind);
  return () => {
    detach();
    restore();
  };
}

/** `items` as a function. */
function itemsOf(items: ContextMenuItems): readonly ContextMenuItem[] {
  return typeof items === "function" ? items() : items;
}

/**
 * Bind a context menu to `el`: a long press (or a right click) opens it and `onSelect` gets the
 * chosen item's `id`. Inside the iOS shell with `denext mobile add context-menu` it is the
 * system's `UIContextMenuInteraction` with the lifted element as its preview; see the module
 * docs for the other platforms.
 *
 * @param el The element.
 * @param items The items, or a function that builds them when the menu opens.
 * @param onSelect Called with the chosen item's `id` (not on dismissal).
 * @param options Title, long-press delay, haptic.
 * @returns The unbind function (removes every listener; disarms the native menu).
 * @example
 * ```ts
 * import { attachContextMenu } from "denext/mobile";
 * const off = attachContextMenu(row, [{ id: "delete", label: "Delete", destructive: true }], (id) => {
 *   if (id === "delete") remove(row.dataset.id!);
 * });
 * ```
 */
export function attachContextMenu(
  el: ContextMenuElement,
  items: ContextMenuItems,
  onSelect: (id: string) => void,
  options: ContextMenuTargetOptions = {},
): () => void {
  return attach(el, { items: () => itemsOf(items), onSelect, options: () => options });
}

/**
 * {@linkcode attachContextMenu} as a hook: returns a ref callback for the element. The latest
 * `items`, `onSelect` and `options` are read when a menu opens, so they can change every render
 * without rebinding.
 *
 * @param items The items, or a function that builds them when the menu opens.
 * @param onSelect Called with the chosen item's `id`.
 * @param options Title, long-press delay, haptic.
 * @returns A ref callback to put on the element.
 * @example
 * ```tsx
 * "use client";
 * import { useContextMenu } from "denext/mobile";
 *
 * export function MessageRow({ message }: { message: { id: string; text: string } }) {
 *   const menu = useContextMenu(
 *     [
 *       { id: "reply", label: "Reply", systemIcon: "arrowshape.turn.up.left" },
 *       { id: "copy", label: "Copy", systemIcon: "doc.on.doc" },
 *       { id: "delete", label: "Delete", systemIcon: "trash", destructive: true },
 *     ],
 *     (id) => act(id, message.id),
 *   );
 *   return <div ref={menu} style={{ borderRadius: 12 }}>{message.text}</div>;
 * }
 * ```
 */
export function useContextMenu(
  items: ContextMenuItems,
  onSelect: (id: string) => void,
  options: ContextMenuTargetOptions = {},
): (el: ContextMenuElement | null) => void {
  const latest = useRef({ items, onSelect, options });
  latest.current = { items, onSelect, options };
  const detach = useRef<(() => void) | null>(null);
  const ref = useRef<((el: ContextMenuElement | null) => void) | null>(null);
  ref.current ??= (el) => {
    detach.current?.();
    detach.current = el
      ? attach(el, {
        items: () => itemsOf(latest.current.items),
        onSelect: (id) => latest.current.onSelect(id),
        options: () => latest.current.options,
      })
      : null;
  };
  useEffect(() => () => {
    detach.current?.();
    detach.current = null;
  }, []);
  return ref.current;
}
