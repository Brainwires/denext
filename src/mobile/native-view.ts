/**
 * Native views inside the page layout for `denext/mobile`: {@linkcode NativeViewSlot} reserves a
 * box in the DOM and keeps a native view (a map, a video player, a camera preview, any view type
 * the app registers natively) on it, and {@linkcode useNativeViewSlot} is the same as a hook for
 * a slot element you render yourself. Both need the `DenextNativeViews` plugin
 * (`denext mobile add native-views`); anywhere else (the web, SSR, a shell without the plugin or
 * without that view type) the slot renders its children instead, so they are the web fallback.
 *
 * On iOS the view is embedded in the page's own layer tree (`placement: "embed"`, the approach of
 * `@capacitor/google-maps`), so the compositor scrolls, clips and transforms it with the page.
 * Elsewhere it is drawn under a transparent WebView (`"under"`) or over it (`"over"`) and moved to
 * the slot's measured box each frame the page moves; see `native-view-tracker.ts`.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useCallback, useEffect, useRef, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import type { GeometryElement } from "./native-view-geometry.ts";
import {
  type NativeViewPlacement,
  type NativeViewsPlugin,
  nativeViewsPlugin,
  onNativeViewEvent,
  pageTracker,
  registeredTypes,
} from "./native-view-tracker.ts";

export type { NativeViewPlacement } from "./native-view-tracker.ts";

/**
 * Where a slot's native view is drawn: a {@linkcode NativeViewPlacement}, or `"auto"` (`"embed"`
 * on iOS, `"over"` on Android).
 */
export type NativeViewPlacementOption = NativeViewPlacement | "auto";

/**
 * A slot's state: `"web"` (no native view: the children render), `"pending"` (the native view is
 * being made), `"native"` (it is on the slot) or `"error"` (making it failed: the children
 * render, and `error` says why).
 */
export type NativeViewStatus = "web" | "pending" | "native" | "error";

/** Options of {@linkcode useNativeViewSlot}. */
export interface NativeViewSlotOptions {
  /** The view's props, sent to its native factory (JSON-serialisable). */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Where the view is drawn (default `"auto"`). */
  readonly placement?: NativeViewPlacementOption;
  /** `false` hides the native view without destroying it (default `true`). */
  readonly active?: boolean;
  /** Events the native view sends (`ready`, `ended`, `regionChange`, …). */
  readonly onEvent?: (name: string, data: unknown) => void;
}

/** What {@linkcode useNativeViewSlot} returns. */
export interface NativeViewSlotHandle {
  /** Put on the slot element (a callback ref). */
  readonly ref: (el: Element | null) => void;
  /** Put on the element holding the DOM drawn over the native view (a callback ref). */
  readonly overlayRef: (el: Element | null) => void;
  /** Where the native view is: pending, drawn natively, or the web fallback. */
  readonly status: NativeViewStatus;
  /** The placement in use once `status` is `"pending"` or `"native"`, else null. */
  readonly placement: NativeViewPlacement | null;
  /**
   * `"embed"`: render {@linkcode nativeViewEmbedScroller}`(embedMarker)` inside the slot; it is
   * the element iOS attaches the view to.
   */
  readonly embedMarker: number;
  /** Why making the view failed (`status` `"error"`). */
  readonly error: string | undefined;
  /** Run a command of the native view; rejects while it is not `"native"`. */
  command(name: string, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

let nextId = 0;

/** The placement `"auto"` resolves to on this platform. */
function resolvePlacement(option: NativeViewPlacementOption | undefined): NativeViewPlacement {
  if (option && option !== "auto") return option;
  return nativePlatform() === "ios" ? "embed" : "over";
}

/** A rejection's message. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Warn (once per slot) when a `"under"` slot has an ancestor that paints over the view. */
function warnOpaqueAncestor(el: Element): void {
  const w = globalThis as { getComputedStyle?: (el: Element) => CSSStyleDeclaration };
  if (typeof w.getComputedStyle !== "function") return;
  for (let p: Element | null = el; p; p = p.parentElement) {
    const s = w.getComputedStyle(p);
    const bg = s.backgroundColor;
    const opaque = (bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg)) ||
      (s.backgroundImage && s.backgroundImage !== "none");
    if (!opaque) continue;
    console.warn(
      `NativeViewSlot: placement "under" draws behind the page, but <${p.tagName.toLowerCase()}> ` +
        "paints a background over it. Make the slot and its ancestors transparent there.",
    );
    return;
  }
}

interface Live {
  plugin: NativeViewsPlugin | undefined;
  /** The native view's id: the slot's id and a count, new for every view made. */
  viewId: string;
  made: number;
  overlay: Element | null;
  props: Readonly<Record<string, unknown>> | undefined;
  active: boolean;
  onEvent: NativeViewSlotOptions["onEvent"];
}

/** A slot's React state, shared by the hooks below. */
interface SlotState {
  readonly id: string;
  readonly marker: number;
  readonly live: Live;
  readonly setStatus: (status: NativeViewStatus) => void;
  readonly setPlacement: (placement: NativeViewPlacement | null) => void;
  readonly setError: (error: string | undefined) => void;
}

/** Pick the placement once the plugin says it can make `type` (status `"pending"`). */
function usePlacement(
  state: SlotState,
  type: string,
  option: NativeViewPlacementOption | undefined,
) {
  useEffect(() => {
    const plugin = nativeViewsPlugin();
    if (!plugin) return;
    let cancelled = false;
    registeredTypes(plugin).then((types) => {
      if (cancelled || !types.includes(type)) return;
      state.live.plugin = plugin;
      state.setPlacement(resolvePlacement(option));
      state.setStatus("pending");
    });
    return () => {
      cancelled = true;
      state.setStatus("web");
      state.setPlacement(null);
    };
  }, [type, option]);
}

/**
 * Make the native view (a new id each time) and follow its slot; returns the teardown.
 * `placement` is the one asked for; the native side may answer with a fallback.
 */
function makeView(
  state: SlotState,
  plugin: NativeViewsPlugin,
  type: string,
  el: Element,
  placement: NativeViewPlacement,
): () => void {
  const { live } = state;
  let made = false;
  let gone = false;
  // A new id per view: a slot re-made before the old view's destroy lands never collides.
  const viewId = `${state.id}.${++live.made}`;
  live.viewId = viewId;
  const stopEvents = onNativeViewEvent(plugin, viewId, (name, data) => live.onEvent?.(name, data));
  if (placement === "under") warnOpaqueAncestor(el);
  const created = (r: { placement?: NativeViewPlacement } | undefined) => {
    made = true;
    if (gone) return void plugin.destroy({ id: viewId }).catch(() => {});
    const used = r?.placement ?? placement;
    if (used !== placement) state.setPlacement(used);
    pageTracker(plugin).add({
      id: viewId,
      el: el as unknown as GeometryElement,
      placement: used,
      overlay: () => live.overlay as unknown as GeometryElement | null,
      active: () => live.active,
    });
    state.setStatus("native");
  };
  const failed = (err: unknown) => {
    if (gone) return;
    state.setError(messageOf(err));
    state.setStatus("error");
  };
  const options = {
    id: viewId,
    type,
    props: live.props ?? {},
    placement,
    embedMarker: state.marker,
  };
  plugin.create(options).then(created, failed);
  return () => {
    gone = true;
    stopEvents();
    pageTracker(plugin).remove(viewId);
    if (made) plugin.destroy({ id: viewId }).catch(() => {});
  };
}

/** Send new props to a live view (not the ones it was made with). */
function usePropsSync(live: Live, status: NativeViewStatus, props: NativeViewSlotOptions["props"]) {
  const propsKey = JSON.stringify(props ?? {});
  const sent = useRef(propsKey);
  useEffect(() => {
    if (status !== "native" || !live.plugin || sent.current === propsKey) return;
    sent.current = propsKey;
    live.plugin.setProps({ id: live.viewId, props: live.props ?? {} }).catch(() => {});
  }, [status, propsKey]);
}

/**
 * Keep a native view of `type` on a slot element: the hook behind {@linkcode NativeViewSlot}.
 * Put `ref` on the slot (give it a size), `overlayRef` on the element holding DOM drawn over the
 * view, and, while `placement` is `"embed"`, render {@linkcode nativeViewEmbedScroller} inside it.
 * Render your web fallback while `status` is `"web"` or `"error"`.
 *
 * @param type The view type, as registered natively (`"map"`, `"video"`, your own).
 * @param options Props, placement, events.
 * @returns The refs, the state and `command`.
 * @example
 * ```tsx
 * const slot = useNativeViewSlot("video", { props: { src, controls: true } });
 * return <div ref={slot.ref} style={{ height: 240 }}>{slot.status === "web" && <video src={src} controls />}</div>;
 * ```
 */
export function useNativeViewSlot(
  type: string,
  options: NativeViewSlotOptions = {},
): NativeViewSlotHandle {
  const [id] = useState(() => `nv${++nextId}`);
  const [marker] = useState(() => 1000 + (nextId % 4000));
  const [status, setStatus] = useState<NativeViewStatus>("web");
  const [placement, setPlacement] = useState<NativeViewPlacement | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [el, setEl] = useState<Element | null>(null);
  const live = useRef<Live>({
    plugin: undefined,
    viewId: "",
    made: 0,
    overlay: null,
    props: undefined,
    active: true,
    onEvent: undefined,
  }).current;
  live.props = options.props;
  live.active = options.active !== false;
  live.onEvent = options.onEvent;
  const state: SlotState = { id, marker, live, setStatus, setPlacement, setError };

  const ref = useCallback((node: Element | null) => setEl(node), []);
  const overlayRef = useCallback((node: Element | null) => void (live.overlay = node), []);
  usePlacement(state, type, options.placement);
  // Make the view once the slot (and, for "embed", its scroller) is in the page. A placement
  // the native side fell back to re-runs nothing: the view already exists.
  useEffect(() => {
    if (!live.plugin || !el || !placement) return;
    return makeView(state, live.plugin, type, el, placement);
  }, [el, placement === null, type]);
  usePropsSync(live, status, options.props);
  // `active` changed: measure now rather than at the next idle poll.
  useEffect(() => {
    if (status === "native" && live.plugin) pageTracker(live.plugin).kick();
  }, [status, live.active]);

  const command = useCallback(
    (name: string, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> => {
      const plugin = live.plugin;
      if (!plugin) return Promise.reject(new Error("the native view is not ready"));
      return plugin.command({ id: live.viewId, name, args });
    },
    [],
  );

  return { ref, overlayRef, status, placement, embedMarker: marker, error, command };
}

/** An inline style object, as {@linkcode NativeViewSlot} accepts and extends it. */
export type NativeViewSlotStyle = Readonly<Record<string, string | number | undefined>>;

/** Props of {@linkcode NativeViewSlot}; any other prop goes to its `<div>`. */
export interface NativeViewSlotProps extends NativeViewSlotOptions {
  /** The view type, as registered natively (`"map"`, `"video"`, your own). */
  readonly type: string;
  /** DOM drawn over the native view (buttons, labels); touches on it stay in the page. */
  readonly overlay?: VNodeChildren;
  /** The slot's style: give it a size. */
  readonly style?: NativeViewSlotStyle;
  /** The web fallback, rendered while there is no native view. */
  readonly children?: VNodeChildren;
  /** Called with the handle's `command` once the view is native, and with null when it is gone. */
  readonly onCommand?: (command: NativeViewSlotHandle["command"] | null) => void;
  /** Any other `<div>` attribute (`className`, `id`, `aria-label`, …). */
  readonly [attribute: string]: unknown;
}

const EMBED_SCROLLER_STYLE = {
  position: "absolute",
  inset: "0",
  overflow: "scroll",
  "scrollbar-width": "none",
  "overscroll-behavior": "none",
  background: "transparent",
};

/**
 * The element iOS embeds a `"embed"` slot's native view in: an `overflow: scroll` box filling the
 * slot (WebKit backs it with a native scroll view) whose content is `marker` px taller than the
 * box, which is how the plugin tells the slots apart.
 *
 * @param marker The handle's `embedMarker`.
 * @returns The element to render inside the slot.
 */
export function nativeViewEmbedScroller(marker: number): VNode {
  return h(
    "div",
    { "data-denext-native-view-embed": "", "aria-hidden": "true", style: EMBED_SCROLLER_STYLE },
    h("div", { style: { width: "100%", height: `calc(100% + ${marker}px)` } }),
  );
}

const OVERLAY_STYLE = {
  position: "absolute",
  inset: "0",
  "z-index": "1",
  transform: "translateZ(0)",
  "pointer-events": "none",
};

/**
 * A box in the page that a native view of `type` fills: a map, a video player, a camera preview
 * or any view type the app registers natively (`denext mobile add native-views`). Give it a size.
 * Its children are the web fallback, rendered wherever the native view is not available; `overlay`
 * is DOM drawn over the native view (touches on its elements stay in the page).
 *
 * @param props The view type and props, placement, overlay, fallback and `<div>` attributes.
 * @returns The slot.
 * @example
 * ```tsx
 * import { NativeViewSlot } from "denext/mobile";
 * <NativeViewSlot type="map" props={{ latitude: 51.5, longitude: -0.12, zoom: 12 }}
 *   style={{ height: 280 }} overlay={<button style={{ pointerEvents: "auto" }}>Recenter</button>}>
 *   <img src="/static-map.png" alt="Map of London" />
 * </NativeViewSlot>
 * ```
 */
export function NativeViewSlot(props: NativeViewSlotProps): VNode {
  const {
    type,
    props: viewProps,
    placement: placementOption,
    active,
    onEvent,
    onCommand,
    overlay,
    style,
    children,
    ...rest
  } = props;
  const slot = useNativeViewSlot(type, {
    props: viewProps,
    placement: placementOption,
    active,
    onEvent,
  });
  const native = slot.status === "native" || slot.status === "pending";
  useEffect(() => {
    if (slot.status !== "native" || !onCommand) return;
    onCommand(slot.command);
    return () => onCommand(null);
  }, [slot.status]);
  return h(
    "div",
    {
      ...rest,
      ref: slot.ref,
      "data-denext-native-view": type,
      "data-status": slot.status,
      style: { position: "relative", ...(native ? { background: "transparent" } : {}), ...style },
    },
    native ? null : children,
    native && slot.placement === "embed" ? nativeViewEmbedScroller(slot.embedMarker) : null,
    native && overlay !== undefined
      ? h("div", {
        ref: slot.overlayRef,
        "data-denext-native-view-overlay": "",
        style: OVERLAY_STYLE,
      }, overlay)
      : null,
  );
}

/** `name` → `onName`: the React Native prop a native event of that name calls. */
function handlerProp(name: string): string {
  return `on${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** The props a native view factory receives: every JSON value but the component's own. */
function viewPropsOf(props: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function" || key === "children" || key === "style") continue;
    if (key === "ref" || key === "key" || key === "testID" || key === "nativeID") continue;
    out[key] = value;
  }
  return out;
}

/**
 * A component for native view type `type` in React Native's host-component shape: what React
 * Native mode can return from `requireNativeComponent(type)` / Expo's `requireNativeView`. Its
 * JSON props go to the native factory, a native event `name` calls the `on<Name>` prop with
 * `{ nativeEvent: data }`, `style` styles the slot, and its children are drawn over the view
 * (or, where the view type is not registered natively, rendered in its place).
 * Internal to denext (React Native mode); not re-exported from `denext/mobile`.
 *
 * @param type The native view type, as registered with `DenextNativeViews`.
 * @returns The component.
 */
export function nativeViewComponent(
  type: string,
): (props: Readonly<Record<string, unknown>>) => VNode {
  function NativeView(props: Readonly<Record<string, unknown>>): VNode {
    const latest = useRef(props);
    latest.current = props;
    const onEvent = useCallback((name: string, data: unknown) => {
      const handler = latest.current[handlerProp(name)];
      if (typeof handler === "function") handler({ nativeEvent: data });
    }, []);
    return h(NativeViewSlot, {
      type,
      props: viewPropsOf(props),
      onEvent,
      style: props.style as NativeViewSlotStyle | undefined,
      overlay: props.children as VNodeChildren,
      // Where the view type is not registered natively, the children render in its place.
      children: props.children as VNodeChildren,
    });
  }
  return NativeView;
}
