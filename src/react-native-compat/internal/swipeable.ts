/**
 * The shared implementation of the `react-native-gesture-handler` swipeable stand-ins
 * (`Swipeable` and `ReanimatedSwipeable`): RNGH's props drawn by denext's
 * {@linkcode SwipeableRow}. `renderLeftActions` / `renderRightActions` become the row's
 * leading / trailing panels; the open and close callbacks, `friction`, `enabled` and the ref
 * methods (`close`, `openLeft`, `openRight`, `reset`) map across.
 *
 * Internal to the stand-ins: not an entrypoint.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { useImperativeHandle, useRef } from "../../runtime/hooks.ts";
import {
  SwipeableRow,
  type SwipeableRowHandle,
  type SwipeableRowSide,
} from "../../client/swipe-row/swipeable-row.ts";
import { flattenStyle } from "../../expo/internal/common.ts";
import * as RN from "./react-native.ts";

/** RNGH's direction names: the side whose actions opened. */
type Direction = "left" | "right";

/** A value the render functions receive: an `Animated.Value`, or a `{ value }` holder. */
interface DragValue {
  set(n: number): void;
  readonly handle: unknown;
}

/** The ref methods of RNGH's swipeables. */
export interface SwipeableMethods {
  /** Close the row (animated). */
  close(): void;
  /** Open the left actions. */
  openLeft(): void;
  /** Open the right actions. */
  openRight(): void;
  /** Close the row without the callbacks' bookkeeping (here: the same as `close`). */
  reset(): void;
}

/** The props of RNGH's `Swipeable` / `ReanimatedSwipeable` the stand-ins honour. */
export interface SwipeableProps {
  /** The row's content. */
  children?: VNodeChildren;
  /** The left (leading) actions. */
  renderLeftActions?: (
    progress: unknown,
    drag: unknown,
    methods: SwipeableMethods,
  ) => VNodeChildren;
  /** The right (trailing) actions. */
  renderRightActions?: (
    progress: unknown,
    drag: unknown,
    methods: SwipeableMethods,
  ) => VNodeChildren;
  /** Drag resistance (default `1`). */
  friction?: number;
  /** `false` turns the gesture off. */
  enabled?: boolean;
  /** Called once a side has opened. */
  onSwipeableOpen?: (direction: Direction, methods: SwipeableMethods) => void;
  /** Called once the row has closed. */
  onSwipeableClose?: (direction: Direction, methods: SwipeableMethods) => void;
  /** Called as a side starts opening. */
  onSwipeableWillOpen?: (direction: Direction) => void;
  /** Called as the row starts closing. */
  onSwipeableWillClose?: (direction: Direction) => void;
  /** The row's style (an object or a style array). */
  containerStyle?: unknown;
  /** The content's style. */
  childrenContainerStyle?: unknown;
  /** The ref handle ({@linkcode SwipeableMethods}). */
  ref?: unknown;
  /** The test id. */
  testID?: string;
}

/** A plain-CSS style from a React Native style (numbers stay px; RN-only keys pass through). */
function cssStyle(style: unknown): Record<string, string | number | undefined> | undefined {
  if (style === undefined || style === null || style === false) return undefined;
  return flattenStyle(style) as Record<string, string | number | undefined>;
}

/** A drag value for the render functions: `Animated.Value` (classic) or `{ value }`. */
function makeValue(kind: "animated" | "shared"): DragValue {
  if (kind === "animated" && RN.Animated) {
    const v = new RN.Animated.Value(0);
    return { set: (n) => v.setValue(n), handle: v };
  }
  const holder = { value: 0 };
  return { set: (n) => void (holder.value = n), handle: holder };
}

const DIRECTION: Readonly<Record<SwipeableRowSide, Direction>> = {
  leading: "left",
  trailing: "right",
};

/**
 * A swipeable component of `kind`: `"animated"` hands the render functions React Native
 * `Animated.Value`s (classic `Swipeable`), `"shared"` hands them `{ value }` holders
 * (`ReanimatedSwipeable`; animated styles computed from them are not re-run per frame).
 */
export function createSwipeable(kind: "animated" | "shared"): (props: SwipeableProps) => VNode {
  return function Swipeable(props: SwipeableProps): VNode {
    const row = useRef<SwipeableRowHandle | null>(null);
    const values = useRef<{ progress: DragValue; drag: DragValue } | null>(null);
    const last = useRef<SwipeableRowSide | null>(null);
    values.current ??= { progress: makeValue(kind), drag: makeValue(kind) };
    const methods: SwipeableMethods = {
      close: () => row.current?.close(),
      openLeft: () => row.current?.open("leading"),
      openRight: () => row.current?.open("trailing"),
      reset: () => row.current?.close(),
    };
    useImperativeHandle(props.ref as never, () => methods);
    const v = values.current;
    const left = props.renderLeftActions?.(v.progress.handle, v.drag.handle, methods);
    const right = props.renderRightActions?.(v.progress.handle, v.drag.handle, methods);
    return h(SwipeableRow, {
      leadingPanel: left ?? undefined,
      trailingPanel: right ?? undefined,
      friction: props.friction,
      disabled: props.enabled === false,
      fullSwipe: false,
      style: cssStyle(props.containerStyle),
      contentStyle: cssStyle(props.childrenContainerStyle),
      rowRef: (handle: SwipeableRowHandle | null) => void (row.current = handle),
      onSwipeProgress: (offset: number, progress: number) => {
        v.drag.set(offset);
        v.progress.set(progress);
      },
      onOpenChange: (side: SwipeableRowSide | null) => {
        if (side) {
          last.current = side;
          props.onSwipeableWillOpen?.(DIRECTION[side]);
          props.onSwipeableOpen?.(DIRECTION[side], methods);
        } else if (last.current) {
          const dir = DIRECTION[last.current];
          props.onSwipeableWillClose?.(dir);
          props.onSwipeableClose?.(dir, methods);
        }
      },
    }, props.children);
  };
}
