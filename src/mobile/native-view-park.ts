/**
 * Keeping a native view across a remount of its slot (`NativeViewSlot`, denext/mobile). A slot
 * that unmounts parks its view: hidden at once, destroyed {@linkcode PARK_MS} later. A slot of
 * the same identity (view type, `viewKey` or its place in the page, placement) that mounts in
 * that window takes the parked view over and sends it its props, so a Fast Refresh remount, a
 * re-keyed parent or a list re-render keeps a video's position and a map's region instead of
 * making the view again. Internal to `denext/mobile`; not re-exported.
 *
 * @module
 */

import type {
  NativeViewFrame,
  NativeViewPlacement,
  NativeViewsPlugin,
} from "./native-view-tracker.ts";

/** How long an unmounted slot's view waits for a slot of the same identity. */
export const PARK_MS = 150;

/** A view waiting for its slot to come back. */
interface Parked {
  readonly plugin: NativeViewsPlugin;
  readonly viewId: string;
  /** The placement the slot asked for (a slot taking it over must ask for the same). */
  readonly placement: NativeViewPlacement;
  /** The placement the view has (the native side may have fallen back). */
  readonly used: NativeViewPlacement;
  readonly timer: ReturnType<typeof setTimeout>;
}

let parked: Map<string, Parked> | undefined;

/** The slot element's place in the page: each ancestor's index among its siblings. */
function pathOf(el: Element): string {
  const parts: number[] = [];
  for (let node: Element | null = el; node?.parentElement; node = node.parentElement) {
    parts.push(Array.prototype.indexOf.call(node.parentElement.children ?? [], node));
  }
  return parts.reverse().join("/");
}

/**
 * A slot's identity: its view type and `viewKey` when given, else its place in the page.
 *
 * @param type The view type.
 * @param el The slot element.
 * @param viewKey The slot's `viewKey` prop.
 * @returns The identity.
 */
export function slotIdentity(type: string, el: Element, viewKey: string | undefined): string {
  return `${type}\n${viewKey === undefined ? `@${pathOf(el)}` : `#${viewKey}`}`;
}

/** A frame that hides view `id` (it is parked: nothing may show while no slot holds it). */
function hiddenFrame(id: string): NativeViewFrame {
  const zero = { x: 0, y: 0, width: 0, height: 0 };
  return {
    id,
    ...zero,
    clip: null,
    scroller: {
      id: 0,
      kind: "document",
      ...zero,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 0,
      scrollHeight: 0,
    },
    content: zero,
    localClip: null,
    hidden: true,
    active: false,
    covered: false,
    interactive: false,
    passthrough: [],
  };
}

/**
 * Park view `viewId` under `identity`: hide it now, destroy it after {@linkcode PARK_MS} unless a
 * slot takes it over. A view already parked there is destroyed first.
 */
export function parkView(
  identity: string,
  plugin: NativeViewsPlugin,
  viewId: string,
  placement: NativeViewPlacement,
  used: NativeViewPlacement,
): void {
  parked ??= new Map();
  const old = parked.get(identity);
  if (old) {
    clearTimeout(old.timer);
    old.plugin.destroy({ id: old.viewId }).catch(() => {});
  }
  plugin.update({ frames: [hiddenFrame(viewId)], dpr: 1 }).catch(() => {});
  const timer = setTimeout(() => {
    if (parked?.get(identity)?.viewId !== viewId) return;
    parked.delete(identity);
    plugin.destroy({ id: viewId }).catch(() => {});
  }, PARK_MS);
  parked.set(identity, { plugin, viewId, placement, used, timer });
}

/**
 * Take over the view parked under `identity`, when there is one for this plugin and placement.
 *
 * @returns Its id and the placement it has, or undefined (make a new view).
 */
export function takeParked(
  identity: string,
  plugin: NativeViewsPlugin,
  placement: NativeViewPlacement,
): { viewId: string; used: NativeViewPlacement } | undefined {
  const found = parked?.get(identity);
  if (!found || found.plugin !== plugin || found.placement !== placement) return undefined;
  clearTimeout(found.timer);
  parked!.delete(identity);
  return { viewId: found.viewId, used: found.used };
}
