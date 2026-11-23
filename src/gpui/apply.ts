/**
 * React props to native tree ops for one node. {@linkcode applyProps} diffs what the host has
 * against the new props and appends SET_STYLE (changed style props, `unset` for removed ones),
 * SET_PROP (the non-style props this kind takes), LISTEN (only when the mask of handlers present
 * changed), and the per-kind work: an Image's source, a TextInput's controlled value with React
 * Native's event count, a press target's state machine.
 *
 * @module
 */

import { Pressability, type PressabilityConfig } from "../react-native/pressability.ts";
import { type NtValue, sameValue, UNSET } from "./encoder.ts";
import { parseColor } from "./color.ts";
import { ENUM, KIND, PROP, STYLE_PROP } from "./props.generated.ts";
import { diffStyle, resolveStyle } from "./style.ts";
import { listenMask, PRESS_HANDLERS } from "./listen.ts";
import type { GpuiNode } from "./node.ts";

/** A non-style prop's name in the v1 table. */
type PropName = keyof typeof PROP;

/** The props every node takes. */
const COMMON: readonly PropName[] = ["accessibilityLabel", "accessibilityRole", "testID"];

/** The props each kind takes besides the common ones (a TextInput's `value` is synced apart). */
const BY_KIND: Readonly<Record<number, readonly PropName[]>> = {
  [KIND.TextInput]: [
    "placeholder",
    "editable",
    "secureTextEntry",
    "multiline",
    "placeholderTextColor",
  ],
  [KIND.ScrollView]: ["horizontal", "scrollEnabled"],
  [KIND.Image]: ["resizeMode"],
  [KIND.Pressable]: ["disabled"],
};

/** A prop's encoder: its React value as a tagged value, or null when it takes no such value. */
type PropEncoder = (raw: unknown) => NtValue | null;

const bool: PropEncoder = (raw) => typeof raw === "boolean" ? { tag: "bool", value: raw } : null;

/** A string prop (a number is written as its string). */
const text: PropEncoder = (raw) => {
  if (typeof raw === "string") return { tag: "string", value: raw };
  return typeof raw === "number" ? { tag: "string", value: String(raw) } : null;
};

/** The props that are not strings, by name; every other prop is a string. */
const ENCODERS: Partial<Readonly<Record<PropName, PropEncoder>>> = {
  editable: bool,
  secureTextEntry: bool,
  multiline: bool,
  horizontal: bool,
  scrollEnabled: bool,
  disabled: bool,
  resizeMode: (raw) => {
    const value = typeof raw === "string"
      ? (ENUM.resizeMode as Record<string, number>)[raw]
      : undefined;
    return value === undefined ? null : { tag: "enum", value };
  },
  placeholderTextColor: (raw) => {
    const value = parseColor(raw);
    return value === null ? null : { tag: "color", value };
  },
  eventCount: (raw) => typeof raw === "number" ? { tag: "f64", value: raw } : null,
};

/** A prop's value, reading React Native's newer aliases (`aria-label`, `role`). */
function rawProp(props: Record<string, unknown>, name: PropName): unknown {
  if (name === "accessibilityLabel") return props.accessibilityLabel ?? props["aria-label"];
  if (name === "accessibilityRole") return props.accessibilityRole ?? props.role;
  return props[name];
}

/**
 * One non-style prop's value with its tag, or null when it is unset or not a value it takes.
 *
 * @param name The prop.
 * @param raw Its React value.
 * @returns The encoded value, or null.
 */
export function encodeProp(name: PropName, raw: unknown): NtValue | null {
  return (ENCODERS[name] ?? text)(raw);
}

/** SET_STYLE for the style the props (and the hidden flag) ask for. */
function syncStyle(node: GpuiNode): void {
  const next = resolveStyle(node.props.style);
  if (node.hidden) next.set(STYLE_PROP.display, { tag: "enum", value: ENUM.display.none });
  const entries = diffStyle(node.style, next);
  node.style = next;
  if (entries.length > 0) node.container.writer.setStyle(node.id, entries);
}

/** SET_PROP for each non-style prop that changed (unset for one that went away). */
function syncProps(node: GpuiNode): void {
  const writer = node.container.writer;
  for (const name of [...COMMON, ...(BY_KIND[node.kind] ?? [])]) {
    const id = PROP[name];
    const next = encodeProp(name, rawProp(node.props, name));
    const prev = node.sent.get(id);
    if (next === null) {
      if (prev === undefined) continue;
      node.sent.delete(id);
      writer.setProp(node.id, id, UNSET);
    } else if (!sameValue(prev, next)) {
      node.sent.set(id, next);
      writer.setProp(node.id, id, next);
    }
  }
}

/**
 * Put a TextInput's text where its props say: a controlled `value` the host does not show (or, at
 * creation, `defaultValue`), sent after the event count JS has seen, so the host drops it when the
 * user has typed since (React Native's `mostRecentEventCount`).
 *
 * @param node The TextInput.
 * @param write Where the ops go (default: the pending batch).
 * @returns Whether anything was sent.
 */
export function syncInputValue(
  node: GpuiNode,
  write = node.container.writer,
): boolean {
  const props = node.props;
  const initial = node.nativeText === undefined && typeof props.defaultValue === "string"
    ? props.defaultValue
    : undefined;
  const value = typeof props.value === "string" ? props.value : initial;
  if (value === undefined || value === node.nativeText) return false;
  node.nativeText = value;
  write.setProp(node.id, PROP.eventCount, { tag: "f64", value: node.eventCount });
  write.setProp(node.id, PROP.value, { tag: "string", value });
  return true;
}

/** Keep a press target's state machine in step with its handlers. */
function syncPressability(node: GpuiNode): void {
  if (node.kind !== KIND.Pressable && node.kind !== KIND.Text) return;
  const props = node.props;
  const wants = PRESS_HANDLERS.some((name) => typeof props[name] === "function");
  const config = props as PressabilityConfig;
  if (wants && !node.pressability) node.pressability = new Pressability(config);
  else if (wants && node.pressability) node.pressability.config = config;
  else if (node.pressability) {
    node.pressability.reset();
    node.pressability = null;
  }
}

/** LISTEN when the mask of handlers present changed. */
function syncListen(node: GpuiNode): void {
  const mask = listenMask(node.kind, node.props);
  if (mask === node.mask) return;
  node.mask = mask;
  node.container.writer.listen(node.id, mask);
}

/**
 * Bring the host's copy of `node` in line with `props` (see the module docs).
 *
 * @param node The node.
 * @param props Its new props.
 */
export function applyProps(node: GpuiNode, props: Record<string, unknown>): void {
  node.props = props;
  syncStyle(node);
  syncProps(node);
  if (node.kind === KIND.TextInput) syncInputValue(node);
  if (node.kind === KIND.Image) node.container.images.set(node, props.source);
  syncPressability(node);
  syncListen(node);
}

/**
 * Hide or show `node` (a suspended boundary's content): `display: none` over its own style.
 *
 * @param node The node.
 * @param hidden Whether to hide it.
 */
export function setHidden(node: GpuiNode, hidden: boolean): void {
  if (node.hidden === hidden) return;
  node.hidden = hidden;
  syncStyle(node);
}

/**
 * Forget `node` and its subtree on the JavaScript side: timers, images, the id map. The host
 * frees the same subtree on DESTROY.
 *
 * @param node The subtree's root.
 */
export function releaseSubtree(node: GpuiNode): void {
  for (const child of node.children) releaseSubtree(child);
  node.children.length = 0;
  node.pressability?.reset();
  node.pressability = null;
  node.container.images.release(node);
  node.container.nodes.delete(node.id);
}
