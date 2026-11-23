/**
 * A node of the native tree on the JavaScript side: its id and kind, the props React gave it,
 * what the host was last sent (its style, its non-style props, its event mask), its place in the
 * tree, and the per-kind state the events need (a press state machine, a text input's event
 * count, an image's source). A node reaches the host only once it is attached in a commit
 * (`materialized`).
 *
 * @module
 */

import type { Pressability } from "../react-native/pressability.ts";
import type { NtValue } from "./encoder.ts";
import { KIND } from "./props.generated.ts";
import type { ResolvedStyle } from "./style.ts";
import type { GpuiContainer } from "./container.ts";

/** The host component names `denext/gpui` renders (the element types its primitives use). */
type HostType = Exclude<keyof typeof KIND, "RawText">;

/**
 * The CREATE kind of a host component, or of a text instance.
 *
 * @param type The element type.
 * @returns The kind.
 * @throws {Error} For a type that is no native tree primitive.
 */
export function kindOf(type: string): number {
  if (type !== "RawText" && Object.hasOwn(KIND, type)) return KIND[type as HostType];
  throw new Error(
    `denext/gpui: <${type}> is not a native tree primitive (use View, Text, Image, ScrollView, ` +
      "TextInput or Pressable)",
  );
}

/** One node (see the module docs). */
export class GpuiNode {
  /** The node's id. */
  readonly id: number;
  /** Its CREATE kind. */
  readonly kind: number;
  /** The window's tree. */
  readonly container: GpuiContainer;
  /** The props React last gave it (a text instance: none). */
  props: Record<string, unknown> = {};
  /** The style the host has. */
  style: ResolvedStyle = new Map();
  /** The non-style props the host has, by prop id. */
  sent: Map<number, NtValue> = new Map();
  /** The event mask the host has. */
  mask = 0;
  /** Hidden by a suspended boundary (`display: none` over its style; a RawText shows ""). */
  hidden = false;
  /**
   * Whether the host has the node: its CREATE and initial props are emitted when it is first
   * attached inside a commit, so an instance React discards never reaches the host.
   */
  materialized = false;
  /** The parent node, while attached. */
  parent: GpuiNode | null = null;
  /** The children, in order. */
  readonly children: GpuiNode[] = [];
  /** A RawText node's text. */
  text = "";
  /** The press state machine of a node with press handlers. */
  pressability: Pressability | null = null;
  /** A TextInput's most recent native event count (React Native's controlled-input protocol). */
  eventCount = 0;
  /** The text the host's input shows, as far as JS knows. */
  nativeText: string | undefined = undefined;
  /** An Image's source key (its URI) while it holds one. */
  imageKey: string | undefined = undefined;

  /**
   * @param container The window's tree.
   * @param kind The CREATE kind.
   */
  constructor(container: GpuiContainer, kind: number) {
    this.container = container;
    this.kind = kind;
    this.id = container.allocId();
  }
}
