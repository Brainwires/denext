/**
 * React Native's `ScrollView` snap props for React Native mode: `snapToInterval`,
 * `snapToOffsets`, `snapToAlignment`, `snapToStart`, `snapToEnd`, `decelerationRate` and
 * `disableIntervalMomentum`, which react-native-web drops (it implements only
 * `pagingEnabled`). They become CSS scroll snap: the scroller gets `scroll-snap-type`, and each
 * snap point near the viewport an invisible marker inside the content, so the platform's own
 * momentum ends on one (see `src/client/virtual/snap.ts`). React Native mode's build wraps
 * react-native-web's `ScrollView` with {@linkcode withScrollSnap}; its `FlatList` /
 * `SectionList` run on denext's `VirtualList`, which draws the same markers.
 *
 * `decelerationRate` changes nothing else: the momentum curve is the platform's.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType } from "../jsx/types.ts";
import { useCallback, useState } from "../runtime/hooks.ts";
import {
  snapContainerStyle,
  snapMarkers,
  snapOptionsFromProps,
  snapPositions,
  snapWindow,
} from "../client/virtual/snap.ts";

/** The props the wrapper reads (the rest go to react-native-web's `ScrollView`). */
interface SnapScrollViewProps {
  readonly horizontal?: boolean | null;
  readonly pagingEnabled?: boolean;
  readonly snapToInterval?: number;
  readonly snapToOffsets?: readonly number[];
  readonly snapToAlignment?: "start" | "center" | "end";
  readonly snapToStart?: boolean;
  readonly snapToEnd?: boolean;
  readonly decelerationRate?: "fast" | "normal" | number;
  readonly disableIntervalMomentum?: boolean;
  readonly style?: unknown;
  readonly children?: unknown;
  readonly onLayout?: (event: LayoutEvent) => void;
  readonly onContentSizeChange?: (width: number, height: number) => void;
  readonly onScroll?: (event: ScrollEvent) => void;
  readonly [prop: string]: unknown;
}

/** react-native-web's layout event. */
interface LayoutEvent {
  readonly nativeEvent?: {
    readonly layout?: { readonly width?: number; readonly height?: number };
  };
}

/** react-native-web's scroll event. */
interface ScrollEvent {
  readonly nativeEvent?: { readonly contentOffset?: { readonly x?: number; readonly y?: number } };
}

/** The snap props, which react-native-web's `ScrollView` does not take. */
const SNAP_PROPS = [
  "snapToInterval",
  "snapToOffsets",
  "snapToAlignment",
  "snapToStart",
  "snapToEnd",
  "decelerationRate",
  "disableIntervalMomentum",
] as const;

/** `props` without the snap props. */
function withoutSnapProps(props: SnapScrollViewProps): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...props };
  for (const key of SNAP_PROPS) delete rest[key];
  return rest;
}

/**
 * react-native-web's `ScrollView` with React Native's snap props (see the module docs).
 * `pagingEnabled` keeps react-native-web's own paging, and a scroll view without snap props
 * renders exactly as before.
 *
 * @param ScrollView react-native-web's `ScrollView` (React Native mode passes it in).
 * @returns The snapping `ScrollView`.
 */
export function withScrollSnap(ScrollView: VNodeType): VNodeType {
  function SnapScrollView(props: SnapScrollViewProps): VNode {
    const horizontal = !!props.horizontal;
    const [box, setBox] = useState({ content: 0, viewport: 0, page: 0 });
    const { onLayout, onContentSizeChange, onScroll } = props;
    const layout = useCallback((event: LayoutEvent) => {
      const l = event?.nativeEvent?.layout;
      const viewport = (horizontal ? l?.width : l?.height) ?? 0;
      setBox((b) => (b.viewport === viewport ? b : { ...b, viewport }));
      onLayout?.(event);
    }, [horizontal, onLayout]);
    const contentSize = useCallback((width: number, height: number) => {
      const content = horizontal ? width : height;
      setBox((b) => (b.content === content ? b : { ...b, content }));
      onContentSizeChange?.(width, height);
    }, [horizontal, onContentSizeChange]);
    const scroll = useCallback((event: ScrollEvent) => {
      const o = event?.nativeEvent?.contentOffset;
      const offset = (horizontal ? o?.x : o?.y) ?? 0;
      setBox((b) => {
        const page = b.viewport > 0 ? Math.floor(offset / b.viewport) : 0;
        return b.page === page ? b : { ...b, page };
      });
      onScroll?.(event);
    }, [horizontal, onScroll]);

    const opts = props.pagingEnabled ? null : snapOptionsFromProps(props);
    const rest = withoutSnapProps(props);
    if (!opts) return h(ScrollView, rest);
    const [from, to] = snapWindow(box.page * box.viewport, box.viewport);
    const markers = snapMarkers(
      opts,
      snapPositions(opts, box.content, from, to),
      box.content,
      horizontal,
    );
    return h(ScrollView, {
      ...rest,
      style: [props.style, snapContainerStyle(horizontal)],
      onLayout: layout,
      onContentSizeChange: contentSize,
      onScroll: scroll,
      scrollEventThrottle: props.scrollEventThrottle ?? 16,
      children: [props.children as VNodeChild, ...markers],
    });
  }
  return Object.assign(SnapScrollView, { displayName: "ScrollView" }) as unknown as VNodeType;
}
