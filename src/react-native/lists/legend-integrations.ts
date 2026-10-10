/**
 * `@legendapp/list/reanimated` and `@legendapp/list/keyboard` for React Native mode, over the
 * `LegendList` React Native mode builds (`createLegendList`). The real modules wrap LegendList's
 * native scroll view (a Reanimated `ScrollView`, react-native-keyboard-controller's
 * `KeyboardChatScrollView`) through its private `internal` API, which denext's list does not
 * have; these keep their exports and props and map them onto denext's list:
 *
 * - `AnimatedLegendList`: the list, with `sharedValues` kept current from the list's state and
 *   scroll. `itemLayoutAnimation` and `animatedProps` have no effect (items move with their
 *   measurements).
 * - `KeyboardAwareLegendList`: the list with the room after the last item that
 *   `contentInsetEndAdjustment` (a shared value: the composer's height) plus
 *   `contentInsetEndStaticAdjustment` describe. The page's own layout follows the keyboard in a
 *   web view, so the keyboard props (`keyboardLiftBehavior`, `keyboardOffset`, `freeze`, …) have
 *   no effect.
 * - `useKeyboardChatComposerInset` / `useKeyboardScrollToEnd`: as in the package, with shared
 *   values from the app's own `react-native-reanimated`.
 *
 * Internal to the prebuilt `denext/react-native/legend-list` runtime: the build generates the
 * two modules from the factories below (see `src/build/react-native-lists.ts`).
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import {
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "../../runtime/hooks.ts";
import { memo } from "../../runtime/memo.ts";
import { forwardRef } from "../../runtime/react-core.ts";

/** The slice of a Reanimated shared value these modules use. */
export interface SharedValueLike<T> {
  value: T;
  addListener?: (id: number, listener: (value: T) => void) => void;
  removeListener?: (id: number) => void;
}

/** The slice of `react-native-reanimated` the keyboard module uses. */
export interface ReanimatedLike {
  readonly useSharedValue: <T>(initial: T) => SharedValueLike<T>;
}

/** The slice of the list's ref these modules call. */
interface ListRefLike {
  scrollToEnd(options?: { animated?: boolean }): Promise<void>;
  getState?(): {
    scroll: number;
    listen: (type: string, callback: (value: unknown) => void) => () => void;
  } & Record<string, unknown>;
}

/** A list component (React Native mode's `LegendList`). */
type ListComponent = (props: Record<string, unknown>) => VNode;

/** The `sharedValues` `AnimatedLegendList` keeps current. */
interface LegendSharedValues {
  readonly activeStickyIndex?: SharedValueLike<number>;
  readonly isAtEnd?: SharedValueLike<boolean>;
  readonly isAtStart?: SharedValueLike<boolean>;
  readonly isNearEnd?: SharedValueLike<boolean>;
  readonly isNearStart?: SharedValueLike<boolean>;
  readonly isWithinMaintainScrollAtEndThreshold?: SharedValueLike<boolean>;
  readonly scrollOffset?: SharedValueLike<number>;
}

/** The state values `sharedValues` mirrors (all but `scrollOffset`, which follows the scroll). */
const MIRRORED = [
  "activeStickyIndex",
  "isAtEnd",
  "isAtStart",
  "isNearEnd",
  "isNearStart",
  "isWithinMaintainScrollAtEndThreshold",
] as const;

/** Set a shared value when it changed. */
function put<T>(shared: SharedValueLike<T> | undefined, value: T): void {
  if (shared && shared.value !== value) shared.value = value;
}

/** Assign `value` to `ref` (a function or an object). */
function assign<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/** Hook: mirror the list's state into `shared` while both exist. */
function useSharedValuesSync(list: ListRefLike | null, shared?: LegendSharedValues): void {
  useEffect(() => {
    const state = list?.getState?.();
    if (!state || !shared) return;
    put(shared.scrollOffset, state.scroll);
    const stops = MIRRORED.filter((k) => shared[k]).map((k) => {
      put(shared[k] as SharedValueLike<unknown>, state[k]);
      return state.listen(k, (v) => put(shared[k] as SharedValueLike<unknown>, v));
    });
    return () => stops.forEach((stop) => stop());
  }, [list, shared]);
}

/** A scroll event's offset along the list's axis. */
function scrollOffsetOf(event: unknown, horizontal: boolean): number | undefined {
  const offset = (event as { nativeEvent?: { contentOffset?: { x?: number; y?: number } } })
    ?.nativeEvent?.contentOffset;
  return horizontal ? offset?.x : offset?.y;
}

/**
 * `@legendapp/list/reanimated`'s exports over `LegendList`.
 *
 * @param LegendList React Native mode's `LegendList`.
 * @returns `{ AnimatedLegendList }`.
 */
export function legendReanimatedExports(
  LegendList: ListComponent,
): { AnimatedLegendList: ListComponent } {
  function AnimatedLegendList(props: Record<string, unknown>): VNode {
    const {
      itemLayoutAnimation: _layout,
      animatedProps: _animated,
      sharedValues,
      ref,
      onScroll,
      ...rest
    } = props as Record<string, unknown> & {
      sharedValues?: LegendSharedValues;
      ref?: Ref<unknown>;
      onScroll?: (event: unknown) => void;
    };
    const [list, setList] = useState<ListRefLike | null>(null);
    const setRef = useCallback((instance: unknown) => {
      setList((prev) => prev === instance ? prev : instance as ListRefLike | null);
      assign(ref, instance);
    }, [ref]);
    useSharedValuesSync(list, sharedValues);
    const scrollOffset = sharedValues?.scrollOffset;
    const horizontal = !!rest.horizontal;
    const handleScroll = useCallback((event: unknown) => {
      put(scrollOffset, scrollOffsetOf(event, horizontal) ?? scrollOffset?.value ?? 0);
      onScroll?.(event);
    }, [scrollOffset, horizontal, onScroll]);
    return h(LegendList, {
      ...rest,
      ref: setRef,
      onScroll: scrollOffset ? handleScroll : onScroll,
    });
  }
  return { AnimatedLegendList };
}

/** Hook: a number prop that may be a shared value, as a number that re-renders on change. */
function useSharedNumber(value: unknown): number {
  const shared = value !== null && typeof value === "object"
    ? value as SharedValueLike<number>
    : undefined;
  const [current, setCurrent] = useState(() => shared ? shared.value : Number(value ?? 0));
  useLayoutEffect(() => {
    if (!shared) return;
    setCurrent(shared.value);
    if (!shared.addListener) return;
    const id = nextListenerId++;
    shared.addListener(id, (v) => setCurrent(v));
    return () => shared.removeListener?.(id);
  }, [shared]);
  const n = shared ? current : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Listener ids for shared values (Reanimated keys listeners by a number). */
let nextListenerId = 1_000_000;

/** `measure`'s callback (`x`, `y`, `width`, `height`, …). */
type MeasureCallback = (x: number, y: number, width: number, height: number) => void;

/** `useKeyboardScrollToEnd`'s options. */
interface ScrollToEndOptions {
  readonly freeze?: SharedValueLike<boolean>;
  readonly listRef: { current: ListRefLike | null };
}

/**
 * `@legendapp/list/keyboard`'s exports over `LegendList`.
 *
 * @param reanimated The app's `react-native-reanimated` (its `useSharedValue`).
 * @param LegendList React Native mode's `LegendList`.
 * @param Keyboard React Native's `Keyboard` (its `dismiss`).
 * @returns `{ KeyboardAwareLegendList, useKeyboardChatComposerInset, useKeyboardScrollToEnd }`.
 */
export function legendKeyboardExports(
  reanimated: ReanimatedLike,
  LegendList: ListComponent,
  Keyboard: { dismiss(): void },
): {
  KeyboardAwareLegendList: ListComponent;
  useKeyboardChatComposerInset: (
    listRef: unknown,
    composerRef: { current: { measure?: (cb: MeasureCallback) => void } | null },
    initialHeight?: number,
    heightAdjustment?: number,
    animationDuration?: number,
  ) => {
    contentInsetEndAdjustment: SharedValueLike<number>;
    onComposerLayout: (event: { nativeEvent: { layout: { height: number } } }) => void;
  };
  useKeyboardScrollToEnd: (options: ScrollToEndOptions) => {
    freeze: SharedValueLike<boolean>;
    scrollMessageToEnd: (o: { animated: boolean; closeKeyboard: boolean }) => Promise<void>;
  };
} {
  function useKeyboardChatComposerInset(
    _listRef: unknown,
    composerRef: { current: { measure?: (cb: MeasureCallback) => void } | null },
    initialHeight = 0,
    heightAdjustment = 0,
    _animationDuration = 0,
  ) {
    const contentInsetEndAdjustment = reanimated.useSharedValue(initialHeight);
    const last = useRef<number | undefined>(undefined);
    const report = useCallback((raw: number) => {
      const height = Math.max(0, raw + heightAdjustment);
      if (!Number.isFinite(height) || height === last.current) return;
      last.current = height;
      contentInsetEndAdjustment.value = height;
    }, [contentInsetEndAdjustment, heightAdjustment]);
    useLayoutEffect(() => {
      composerRef.current?.measure?.((_x, _y, _w, height) => report(height));
    }, [composerRef, report]);
    const onComposerLayout = useCallback(
      (event: { nativeEvent: { layout: { height: number } } }) =>
        report(event.nativeEvent.layout.height),
      [report],
    );
    return { contentInsetEndAdjustment, onComposerLayout };
  }

  function useKeyboardScrollToEnd({ freeze: given, listRef }: ScrollToEndOptions) {
    const own = reanimated.useSharedValue(false);
    const freeze = given ?? own;
    const scrollMessageToEnd = useCallback(
      async ({ animated, closeKeyboard }: { animated: boolean; closeKeyboard: boolean }) => {
        const list = listRef.current;
        if (!list) return;
        freeze.value = true;
        if (closeKeyboard) Keyboard.dismiss();
        await list.scrollToEnd({ animated });
        freeze.value = false;
      },
      [freeze, listRef],
    );
    return { freeze, scrollMessageToEnd };
  }

  function KeyboardAwareLegendList(props: Record<string, unknown>): VNode {
    const {
      adjustedInsetCompensation: _compensation,
      applyWorkaroundForContentInsetHitTestBug: _hitTest,
      contentInsetEndAdjustment,
      contentInsetEndStaticAdjustment,
      contentInsetStartAdjustment: _start,
      freeze: _freeze,
      keyboardLiftBehavior: _lift,
      keyboardOffset: _offset,
      ...rest
    } = props;
    // On iOS UIKit adds the static adjustment (the safe area) to the shared value's inset; a web
    // view adds nothing, so the list's room is both.
    const room = useSharedNumber(contentInsetEndAdjustment) +
      useSharedNumber(contentInsetEndStaticAdjustment);
    return h(LegendList, { ...rest, contentInsetEndAdjustment: room });
  }

  return { KeyboardAwareLegendList, useKeyboardChatComposerInset, useKeyboardScrollToEnd };
}

/** Hook: one callback ref that sets every ref given. */
function useCombinedRef<T>(...refs: Ref<T>[]): (value: T | null) => void {
  const latest = useRef(refs);
  latest.current = refs;
  return useCallback((value: T | null) => {
    for (const ref of latest.current) assign(ref, value);
  }, []);
}

/** Hook: a ref that always holds the latest `value`. */
function useLatestRef<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * `@legendapp/list`'s `internal`: the generic helpers the package's own `/section-list` and
 * integration modules import (`typedForwardRef`, `typedMemo`, `useCombinedRef`,
 * `useLatestRef`). Its list-state helpers (`useStateContext`, `peek$`, …) belong to the real
 * list's store and are not provided.
 */
export const internal: Readonly<Record<string, unknown>> = {
  typedForwardRef: forwardRef,
  typedMemo: memo,
  useCombinedRef,
  useLatestRef,
  IsNewArchitecture: true,
  POSITION_OUT_OF_VIEW: -10000000,
};
