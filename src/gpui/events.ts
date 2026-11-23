/**
 * Native tree events (host → JavaScript): the host sends `{ node, type, … }` as JSON through the
 * window's event channel; {@linkcode parseNativeTreeEvent} reads one and
 * {@linkcode dispatchNativeTreeEvent} calls the node's handler, shaped as React Native's event
 * (the host sends only the events a node's LISTEN mask asks for: ./listen.ts).
 *
 * Presses go through denext's React Native pressability (`Pressability`): the host's `pressIn`
 * grants the press, `pressOut` releases it, and `press` is a press with no press-in (the keyboard,
 * assistive technology) unless it trails a release. React Native's timings apply (`onLongPress`
 * after `delayLongPress`, `onPressOut` held for `minPressDuration`); the host's own `longPress` is
 * not needed for that.
 *
 * @module
 */

import { CONTINUOUS_PRIORITY, DISCRETE_PRIORITY, withEventPriority } from "./priority.ts";
import { syncInputValue } from "./apply.ts";
import type { GpuiContainer } from "./container.ts";
import type { GpuiNode } from "./node.ts";

/** The window event the native tree's events arrive as. */
export const NATIVE_TREE_EVENT = "nativetree";

/** One event from the host. */
export interface NativeTreeEvent {
  /** The node it is about. */
  readonly node: number;
  /** What happened (`press`, `layout`, `changeText`, …). */
  readonly type: string;
  /** The type's fields (`x`, `y`, `text`, `eventCount`, …). */
  readonly [field: string]: unknown;
}

/** An event's payload: a `CustomEvent`'s `detail`, a `{ json }` wrapper, JSON text or the object. */
function payloadOf(event: unknown): unknown {
  let value = event instanceof Event ? (event as CustomEvent).detail : event;
  if (
    value && typeof value === "object" && typeof (value as { json?: unknown }).json === "string"
  ) {
    value = (value as { json: string }).json;
  }
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Read a native tree event from what the window's listener got.
 *
 * @param event The window event (or its detail, or the JSON text).
 * @returns The event, or null when it is not one.
 */
export function parseNativeTreeEvent(event: unknown): NativeTreeEvent | null {
  const value = payloadOf(event) as Partial<NativeTreeEvent> | null;
  if (!value || typeof value !== "object") return null;
  if (typeof value.node !== "number" || typeof value.type !== "string") return null;
  return value as NativeTreeEvent;
}

/** A number field, else 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Call `node`'s handler `name` with `arg`, when it has one. */
function call(node: GpuiNode, name: string, arg: unknown): void {
  const handler = node.props[name];
  if (typeof handler === "function") handler(arg);
}

/** React Native's press event for a host press at (`x`, `y`) on `node`. */
function pressEvent(node: GpuiNode, ev: NativeTreeEvent) {
  const x = num(ev.x);
  const y = num(ev.y);
  return {
    nativeEvent: {
      locationX: x,
      locationY: y,
      pageX: x,
      pageY: y,
      target: node.id,
      timestamp: Date.now(),
    },
    currentTarget: node.id,
    target: node.id,
    persist() {},
    stopPropagation() {},
  };
}

/** `press` / `pressIn` / `pressOut` through the node's pressability. */
function routePress(node: GpuiNode, ev: NativeTreeEvent): void {
  const handlers = node.pressability?.handlers;
  if (!handlers) return;
  const event = pressEvent(node, ev);
  if (ev.type === "pressIn") {
    if (node.props.disabled !== true) handlers.onResponderGrant(event);
  } else if (ev.type === "pressOut") handlers.onResponderRelease(event);
  else if (ev.type === "press") handlers.onClick(event);
}

/** A controlled TextInput whose props did not take the user's text gets its value back. */
function restoreControlledValue(node: GpuiNode): void {
  if (node.container.nodes.get(node.id) !== node || typeof node.props.value !== "string") return;
  node.container.commitAside((writer) => void syncInputValue(node, writer));
}

/** `changeText`: React Native's `onChange` then `onChangeText`, keeping the event count. */
function routeChangeText(node: GpuiNode, ev: NativeTreeEvent): void {
  const text = typeof ev.text === "string" ? ev.text : "";
  const eventCount = num(ev.eventCount);
  node.eventCount = Math.max(node.eventCount, eventCount);
  node.nativeText = text;
  call(node, "onChange", { nativeEvent: { text, eventCount, target: node.id } });
  call(node, "onChangeText", text);
  // After React's synchronous re-render (queued by a setState in the handler, before this).
  queueMicrotask(() => restoreControlledValue(node));
}

/** Each event type's route. */
const ROUTES: Readonly<Record<string, (node: GpuiNode, ev: NativeTreeEvent) => void>> = {
  press: routePress,
  pressIn: routePress,
  pressOut: routePress,
  // React Native's long press comes from pressability's own timer (`delayLongPress`).
  longPress: () => {},
  layout: (node, ev) =>
    call(node, "onLayout", {
      nativeEvent: {
        layout: { x: num(ev.x), y: num(ev.y), width: num(ev.width), height: num(ev.height) },
        target: node.id,
      },
    }),
  scroll: (node, ev) =>
    call(node, "onScroll", {
      nativeEvent: {
        contentOffset: { x: num(ev.x), y: num(ev.y) },
        contentSize: { width: num(ev.contentWidth), height: num(ev.contentHeight) },
        target: node.id,
      },
    }),
  focus: (node) => call(node, "onFocus", { nativeEvent: { target: node.id } }),
  blur: (node) => call(node, "onBlur", { nativeEvent: { target: node.id } }),
  changeText: routeChangeText,
  submitEditing: (node) =>
    call(node, "onSubmitEditing", {
      nativeEvent: { text: node.nativeText ?? "", target: node.id },
    }),
  selectionChange: (node, ev) =>
    call(node, "onSelectionChange", {
      nativeEvent: { selection: { start: num(ev.start), end: num(ev.end) }, target: node.id },
    }),
  key: (node, ev) =>
    call(node, "onKeyPress", {
      nativeEvent: { key: String(ev.key ?? ""), modifiers: ev.modifiers, target: node.id },
    }),
  imageLoad: (node) => {
    call(node, "onLoad", { nativeEvent: { source: { uri: node.imageKey }, target: node.id } });
    call(node, "onLoadEnd", undefined);
  },
  imageError: (node) => {
    call(node, "onError", { nativeEvent: { error: "decode failed", target: node.id } });
    call(node, "onLoadEnd", undefined);
  },
};

/** Scroll and layout are continuous; everything else a user does is discrete. */
function priorityOf(type: string): number {
  return type === "scroll" || type === "layout" ? CONTINUOUS_PRIORITY : DISCRETE_PRIORITY;
}

/**
 * Call the handler `event` is for. An event for a node that is gone, or of a type this renderer
 * does not know, is dropped; a handler that throws is reported, not rethrown.
 *
 * @param container The window's tree.
 * @param event The event.
 * @returns Whether a route took it.
 */
export function dispatchNativeTreeEvent(container: GpuiContainer, event: NativeTreeEvent): boolean {
  const node = container.nodes.get(event.node);
  const route = Object.hasOwn(ROUTES, event.type) ? ROUTES[event.type] : undefined;
  if (!node || !route) return false;
  withEventPriority(priorityOf(event.type), () => {
    try {
      route(node, event);
    } catch (error) {
      container.reportError(error);
    }
  });
  return true;
}
