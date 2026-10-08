/**
 * `@legendapp/list/react` (LegendList's DOM build) on denext's `VirtualList`. With the
 * top-level `lists: "denext"` in `denext.config.ts`, an app's (and its packages')
 * `@legendapp/list/react` imports resolve to this module, in SPA mode and on the App Router
 * alike; without it they keep resolving to the real package. It is React Native mode's
 * `LegendList` (`src/react-native/legend-list.ts`) built over DOM primitives: the same engine,
 * props, ref methods and cell hooks, with the DOM build's differences: `className` and
 * `contentContainerClassName` style the scroll element and the content container, `style`,
 * `contentContainerStyle` and the header / footer styles are CSS objects, the other DOM
 * attributes (`id`, `data-*`, `aria-*`, event handlers such as `onKeyDown`) land on the scroll
 * element, and `getNativeScrollRef()` / `getAnimatableRef()` / `getScrollResponder()` /
 * `refScrollView` give the scroll element itself. A prebuilt runtime entry
 * (`denext/lists/legend-list`); not a public entrypoint.
 *
 * Differences from the real DOM build, all deliberate: the ones React Native mode's module
 * lists, and the scroll element carries `VirtualList`'s own inline `height: 100%` (a `style`
 * height or a class with a max-height still sizes it).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../jsx/types.ts";
import { type Ref, useLayoutEffect, useRef } from "../runtime/hooks.ts";
import {
  createLegendList,
  type LegendListProps,
  type LegendListRef,
} from "../react-native/legend-list.ts";
import { type LayoutEventLike, observeLayout } from "../react-native/lists/virtualized.ts";

export {
  useAdaptiveRender,
  useAdaptiveRenderChange,
  useIsLastItem,
  useListScrollSize,
  useRecyclingEffect,
  useRecyclingState,
  useSyncLayout,
  useViewability,
  useViewabilityAmount,
} from "../react-native/legend-list.ts";

/** A CSS style object (`React.CSSProperties`). */
export type CSSStyle = Readonly<Record<string, string | number | undefined>>;

/** The DOM build's props: React Native mode's, with CSS styles, classes and DOM attributes. */
export interface LegendListDomProps<T> extends
  Omit<
    LegendListProps<T>,
    | "style"
    | "contentContainerStyle"
    | "ListHeaderComponentStyle"
    | "ListFooterComponentStyle"
    | "refScrollView"
    | "ref"
  > {
  /** The scroll element's class. */
  readonly className?: string;
  /** The content container's class. */
  readonly contentContainerClassName?: string;
  /** The scroll element's style. */
  readonly style?: CSSStyle;
  /** The content container's style. */
  readonly contentContainerStyle?: CSSStyle;
  /** The header's wrapper style. */
  readonly ListHeaderComponentStyle?: CSSStyle;
  /** The footer's wrapper style. */
  readonly ListFooterComponentStyle?: CSSStyle;
  /** Receives the scroll element. */
  readonly refScrollView?: Ref<Element>;
  /** Receives the ref methods. */
  readonly ref?: Ref<LegendListDomRef>;
  /** Another DOM attribute of the scroll element (`id`, `data-*`, `aria-*`, `onKeyDown`, …). */
  readonly [attribute: string]: unknown;
}

/** The DOM build's ref: the scroll-view getters return the scroll element. */
export interface LegendListDomRef extends
  Omit<
    LegendListRef,
    "getAnimatableRef" | "getNativeScrollRef" | "getScrollResponder" | "getScrollableNode"
  > {
  /** The scroll element. */
  getAnimatableRef(): Element | null;
  /** The scroll element. */
  getNativeScrollRef(): Element | null;
  /** The scroll element. */
  getScrollResponder(): Element | null;
  /** The scroll element. */
  getScrollableNode(): Element | null;
}

/** A style (an object or nested arrays of them) merged into one CSS object. */
function flatten(style: unknown, out: Record<string, string | number> = {}): Record<
  string,
  string | number
> {
  if (Array.isArray(style)) { for (const s of style) flatten(s, out); }
  else if (style && typeof style === "object") Object.assign(out, style);
  return out;
}

/** What the DOM `View` stand-in takes (the list wraps headers, footers and grid rows in it). */
interface DomViewProps {
  readonly style?: unknown;
  readonly onLayout?: (e: LayoutEventLike) => void;
  readonly children?: VNodeChild;
}

/**
 * A `div` standing in for React Native's `View`: a CSS style, and `onLayout` from a
 * `ResizeObserver` (the list measures its header and footer through it).
 */
function DomView(props: DomViewProps): VNode {
  const el = useRef<Element | null>(null);
  const latest = useRef(props.onLayout);
  latest.current = props.onLayout;
  const wanted = !!props.onLayout;
  useLayoutEffect(() => {
    const node = el.current;
    if (!wanted || !node) return;
    return observeLayout(node, true, (e) => latest.current?.(e));
  }, [wanted]);
  return h("div", { ref: el, style: flatten(props.style) }, props.children);
}

/** LegendList's DOM build on denext's `VirtualList`. */
export const LegendList: <T>(props: LegendListDomProps<T>) => VNode = /* @__PURE__ */
  createLegendList({ View: DomView, dom: true }) as unknown as <T>(
    props: LegendListDomProps<T>,
  ) => VNode;
