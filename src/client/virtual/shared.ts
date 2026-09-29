/**
 * Small helpers shared by `VirtualList`, `useVirtualList` and `VirtualMasonry` (internal).
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { Component, VNode, VNodeChild } from "../../jsx/types.ts";
import type { VirtualListKey, VirtualListSlot } from "./types.ts";

/** `n` as a CSS px length (rounded to 1/100 px). */
export function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`;
}

/** The default key: `item.key`, `item.id`, or the index (React Native FlatList's rule). */
export function defaultKey(item: unknown, index: number): VirtualListKey {
  if (item !== null && typeof item === "object") {
    const o = item as { key?: unknown; id?: unknown };
    if (typeof o.key === "string" || typeof o.key === "number") return o.key;
    if (typeof o.id === "string" || typeof o.id === "number") return o.id;
  }
  return index;
}

/** A slot prop (a component or an element) as a child. */
export function slot(value: VirtualListSlot): VNodeChild {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && "props" in value && "type" in value) return value as VNode;
  return h(value as Component<Record<string, never>>, null);
}
