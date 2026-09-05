/**
 * `Slot` / `Slottable` — the primitive behind Radix UI's `asChild` pattern,
 * reimplemented for denext. Instead of rendering a wrapper element, `Slot` merges
 * its own props onto its single child element: event handlers compose (the
 * child's runs first, then the slot's), `className`/`class` join, `style` merges,
 * refs merge (slot ref + child ref), and other props let the child win.
 *
 * Alias `@radix-ui/react-slot` to this module (once verified against your Radix
 * version) so `asChild` components resolve to denext:
 *
 * ```jsonc
 * "imports": { "@radix-ui/react-slot": "jsr:@denext/denext/slot" }
 * ```
 *
 * @module
 */

import { Fragment, h } from "../../mod.ts";
import { Children, cloneElement, isValidElement } from "./react.ts";
import { composeRefs } from "./refs.ts";
import { brand, REACT_FORWARD_REF_TYPE } from "../runtime/react-brands.ts";
import type { VNode, VNodeChild } from "../jsx/types.ts";

type Props = Record<string, unknown>;

/** Join two className/class values, dropping falsy parts. */
function joinClass(a: unknown, b: unknown): string {
  return [a, b].filter(Boolean).join(" ");
}

/**
 * Merge `slotProps` (the outer/`asChild` props) with `childProps` (the child
 * element's own props), following Radix's `mergeProps` rules: child wins for
 * plain props; handlers compose (child first, then slot); `className`/`class`
 * join; `style` merges with child keys winning.
 *
 * @param slotProps The props passed to `Slot`.
 * @param childProps The child element's props.
 * @returns The merged prop object.
 */
export function mergeProps(
  slotProps: Record<string, unknown>,
  childProps: Record<string, unknown>,
): Record<string, unknown> {
  const overrides: Props = { ...childProps };
  for (const name of Object.keys(childProps)) {
    const slotValue = slotProps[name];
    const childValue = childProps[name];
    if (/^on[A-Z]/.test(name)) {
      if (typeof slotValue === "function" && typeof childValue === "function") {
        overrides[name] = (...args: unknown[]) => {
          (childValue as (...a: unknown[]) => unknown)(...args);
          (slotValue as (...a: unknown[]) => unknown)(...args);
        };
      } else if (typeof slotValue === "function") {
        overrides[name] = slotValue;
      }
    } else if (name === "style") {
      overrides[name] = { ...(slotValue as Props), ...(childValue as Props) };
    } else if (name === "className" || name === "class") {
      overrides[name] = joinClass(slotValue, childValue);
    }
  }
  return { ...slotProps, ...overrides };
}

/** Props for {@link Slot}: any element props, plus a single element `children`. */
export interface SlotProps {
  /** The single element child to merge props onto. */
  children?: VNodeChild;
  /** A ref to merge with the child's own ref. */
  ref?: unknown;
  /** Any other props are merged onto the child. */
  [key: string]: unknown;
}

/** A marker so {@link Slot} can find the mergeable child among siblings. */
const SLOTTABLE = Symbol.for("denext.slottable");

/**
 * Wrap the mergeable child when a `Slot` has several children, e.g.
 * `<Slot><Icon/><Slottable>{children}</Slottable></Slot>`. `Slot` merges its
 * props onto the `Slottable`'s child and preserves the surrounding siblings.
 *
 * @param props Its single-element `children`.
 * @returns The children unchanged (the marker is read by `Slot`).
 */
export function Slottable(props: { children?: VNodeChild }): VNodeChild {
  return props.children ?? null;
}
brand(Slottable, SLOTTABLE);

/** Is `child` a `<Slottable>` element? */
function isSlottable(child: VNodeChild): child is VNode {
  return isValidElement(child) && (child as VNode).type === Slottable;
}

/**
 * Merge `Slot`'s props onto its single element child (Radix `asChild`). When the
 * children contain a {@link Slottable}, its child becomes the merge target and
 * the siblings are preserved around it.
 *
 * @param props Slot props (merged onto the child) including `children`.
 * @returns The child element with merged props, or the children unchanged when
 *          there is no single element to merge onto.
 */
export function Slot(props: SlotProps): VNode {
  const { children, ref: slotRef, ...slotProps } = props;
  const childArray = Children.toArray(children);

  // Slottable path: find the marked child, merge onto its inner element, keep
  // siblings in place.
  const slottable = childArray.find(isSlottable) as VNode | undefined;
  if (slottable) {
    const inner = Children.toArray((slottable.props as { children?: VNodeChild }).children)[0];
    const mergedInner = isValidElement(inner)
      ? mergeOnto(inner as VNode, slotProps, slotRef)
      : inner;
    const newChildren = childArray.map((c) => (c === slottable ? mergedInner : c));
    return h(Fragment, null, ...(newChildren as VNode[]));
  }

  if (childArray.length > 1) {
    // Radix's Slot goes through `Children.only`, which throws for several children.
    throw new Error(
      "Slot (asChild) expects exactly one React element child. Received " +
        `${childArray.length} children — wrap the target in <Slottable> if you ` +
        "need siblings, or pass a single element.",
    );
  }
  const only = childArray[0];
  // Nothing (or a text node) to merge onto: Radix renders null here, not an error.
  if (!isValidElement(only)) return null as unknown as VNode;
  return mergeOnto(only as VNode, slotProps, slotRef);
}
brand(Slot, REACT_FORWARD_REF_TYPE, {
  render: (props: SlotProps) => Slot(props),
});

/** Merge `slotProps` (+ a slot ref) onto a single child element. */
function mergeOnto(child: VNode, slotProps: Props, slotRef: unknown): VNode {
  const merged = mergeProps(slotProps, child.props as Props);
  const childRef = (child.props as { ref?: unknown }).ref;
  if (slotRef != null || childRef != null) {
    merged.ref = composeRefs(
      slotRef as never,
      childRef as never,
    );
  }
  return cloneElement(child, merged);
}

/**
 * Radix 1.2's `createSlot(ownerName)` — a `Slot` component tagged with the owning
 * primitive's name (for devtools); behaviorally the shared {@link Slot}.
 *
 * @param ownerName The primitive that owns this slot (e.g. `"Button"`).
 * @returns A `Slot` component.
 */
export function createSlot(ownerName: string): typeof Slot {
  const Owned = (props: SlotProps): VNode => Slot(props);
  Owned.displayName = `${ownerName}.Slot`;
  return Owned;
}

/**
 * Radix 1.2's `createSlottable(ownerName)` — a `Slottable` marker paired with the slot
 * `createSlot(ownerName)` returns. Behaviorally the shared {@link Slottable}.
 *
 * @param ownerName The primitive that owns this slottable.
 * @returns A `Slottable` component.
 */
export function createSlottable(ownerName: string): typeof Slottable {
  void ownerName;
  return Slottable;
}
