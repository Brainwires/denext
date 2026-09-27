/**
 * Pull-to-refresh AROUND a scroll container that is already rendered — React Native's
 * `refreshControl` shape. One implementation serves two hosts:
 *
 * - {@linkcode RefreshControl} (`denext/mobile`): a `<div>` wrapper, for `VirtualList`'s
 *   `refreshControl` prop or any scroll container you render;
 * - React Native mode's `RefreshControl` (`src/react-native/refresh-control.ts`): the same
 *   body over react-native-web's `View`, which its `ScrollView` / `FlatList` wrap themselves in.
 *
 * Both share `PullToRefresh`'s gesture and spinner (`pull-to-refresh.ts`); the difference is
 * that `PullToRefresh` IS the scroll container, while this wraps one (its first element child).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import { useRef } from "../runtime/hooks.ts";
import { pullIndicator, type PullScroller, usePullToRefresh } from "./pull-to-refresh.ts";

/** Props of {@linkcode RefreshControl} (React Native's); any other prop goes to the wrapper. */
export interface RefreshControlProps {
  /** Whether a refresh is in progress (the spinner rests and spins while `true`). */
  readonly refreshing: boolean;
  /** Called when the user pulls past the threshold and lets go. */
  readonly onRefresh?: () => void;
  /** `false` turns the gesture off (default `true`). */
  readonly enabled?: boolean;
  /** How far, in px, the spinner must be pulled to refresh (default 64). */
  readonly threshold?: number;
  /** Where the spinner rests while refreshing, in px from the top (default 16). */
  readonly progressViewOffset?: number;
  /** iOS: the spinner's color (default `currentColor`). */
  readonly tintColor?: string;
  /** Android: the spinner's colors (the first one is used when `tintColor` is not set). */
  readonly colors?: readonly string[];
  /** Android: the spinner disc's background. */
  readonly progressBackgroundColor?: string;
  /** Android: the spinner's size (accepted; one size is drawn). */
  readonly size?: unknown;
  /** iOS: text under the spinner while refreshing. */
  readonly title?: string;
  /** iOS: the title's color. */
  readonly titleColor?: string;
  /** The wrapper's style (a list or scroll view passes its own style here). */
  readonly style?: unknown;
  /** The scroll container. */
  readonly children?: VNodeChildren;
  /** Any other attribute of the wrapper (`class`, `id`, `testID`, `data-*`, …). */
  readonly [attribute: string]: unknown;
}

/** The slice of a DOM element the scroller lookup reads. */
interface HostNode {
  readonly childNodes?: ArrayLike<unknown>;
}

/** The wrapped scroll container: the first element child that is not the spinner. */
function scrollerIn(wrapper: HostNode | null): PullScroller | null {
  const kids = wrapper?.childNodes;
  if (!kids) return null;
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i] as { nodeType?: number; getAttribute?(n: string): string | null };
    if (kid?.nodeType !== 1) continue;
    const spinner = kid.getAttribute?.("data-denext-pull-indicator");
    if (spinner !== null && spinner !== undefined) continue;
    return kid as unknown as PullScroller;
  }
  return null;
}

/**
 * The shared body of both `RefreshControl`s: the pull gesture on the wrapped scroller, the
 * spinner, and `host` as the wrapper with `wrapperStyle(style)` as its style. Call it from a
 * component (it uses hooks). Internal to denext; not re-exported from `denext/mobile`.
 *
 * @param host The wrapper element type (`"div"`, or react-native-web's `View`).
 * @param props The control's props.
 * @param wrapperStyle The wrapper's style from the `style` prop (the host's style format).
 * @returns The wrapper with the spinner and the scroll container.
 */
export function useRefreshControlView(
  host: VNodeType,
  props: RefreshControlProps,
  wrapperStyle: (style: unknown) => unknown,
): VNode {
  const {
    refreshing,
    onRefresh,
    colors,
    enabled = true,
    threshold = 64,
    progressBackgroundColor,
    progressViewOffset,
    size: _size,
    tintColor,
    title,
    titleColor,
    style,
    children,
    ...rest
  } = props;
  const wrapper = useRef<HostNode | null>(null);
  const pull = usePullToRefresh(() => scrollerIn(wrapper.current), {
    refreshing: refreshing === true,
    onRefresh,
    enabled: enabled !== false,
    threshold,
  });
  return h(
    host,
    {
      ...rest,
      ref: (node: HostNode | null) => void (wrapper.current = node),
      style: wrapperStyle(style),
    },
    pullIndicator(pull, {
      refreshing: refreshing === true,
      threshold,
      offset: progressViewOffset ?? 16,
      color: tintColor ?? colors?.[0],
      background: progressBackgroundColor,
      title,
      titleColor,
    }),
    children,
  );
}

/** The `<div>` wrapper's style: a flex column that clips the spinner, keeping `style`. */
function divStyle(style: unknown): Record<string, unknown> {
  return {
    display: "flex",
    flexDirection: "column",
    ...(style && typeof style === "object" ? style as Record<string, unknown> : {}),
    position: "relative",
    overflow: "hidden",
  };
}

/**
 * Pull-to-refresh around a scroll container: pulling the container down from its top past
 * `threshold` and letting go calls `onRefresh`; while `refreshing` the spinner rests at
 * `progressViewOffset`. Touch only (as `PullToRefresh`); give mouse and keyboard users a
 * refresh button too. Pass it to a `VirtualList` as `refreshControl` — the list renders it
 * around its scroller with the list's `class` and `style` and passes `refreshing`,
 * `onRefresh` and `progressViewOffset` from its own props.
 *
 * @param props The control's props; unknown props pass through to the wrapping `<div>`.
 * @returns The wrapper with the spinner and the scroll container.
 * @example
 * ```tsx
 * "use client";
 * import { useState, VirtualList } from "denext";
 * import { RefreshControl } from "denext/mobile";
 *
 * export function Inbox({ mail, reload }) {
 *   const [refreshing, setRefreshing] = useState(false);
 *   return (
 *     <VirtualList
 *       style={{ height: "100dvh" }}
 *       data={mail}
 *       renderItem={(m) => <Row mail={m} />}
 *       refreshControl={RefreshControl}
 *       refreshing={refreshing}
 *       onRefresh={async () => {
 *         setRefreshing(true);
 *         await reload();
 *         setRefreshing(false);
 *       }}
 *     />
 *   );
 * }
 * ```
 */
export function RefreshControl(props: RefreshControlProps): VNode {
  return useRefreshControlView("div", { ...props, "data-denext-refresh-control": "" }, divStyle);
}
