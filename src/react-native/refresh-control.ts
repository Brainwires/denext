/**
 * React Native's `RefreshControl` for React Native mode: pull-to-refresh on a `ScrollView` /
 * `FlatList`, sharing `denext/mobile`'s `PullToRefresh` gesture and spinner.
 * react-native-web renders it as a plain `View` ("not started"). The body is shared with
 * `denext/mobile`'s `RefreshControl` (`src/mobile/refresh-control.ts`); this module only binds
 * it to react-native-web's `View` and its style-array format.
 *
 * @module
 */

import type { VNode, VNodeType } from "../jsx/types.ts";
import { type RefreshControlProps, useRefreshControlView } from "../mobile/refresh-control.ts";

export type { RefreshControlProps } from "../mobile/refresh-control.ts";

/** React Native's `RefreshControl.SIZE` (Android's spinner sizes; `size` is accepted). */
const REFRESH_CONTROL_SIZE = { DEFAULT: "default", LARGE: "large" } as const;

/** The wrapping `View`'s style: the scroll view's style, clipped around the spinner. */
function viewStyle(style: unknown): unknown {
  return [style, { position: "relative", overflow: "hidden" }];
}

/**
 * React Native's `RefreshControl` over react-native-web's `View`. react-native-web's
 * `ScrollView` (and so `FlatList` / `SectionList`, which pass `refreshing` / `onRefresh` to
 * one) renders its `refreshControl` around the scroll view with the scroll view's style, as
 * React Native's Android does; this control is that wrapper. Pulling the scroll view down from
 * its top past 64 px and letting go calls `onRefresh`; while `refreshing` the spinner rests
 * `progressViewOffset` px from the top (default 16), in `tintColor` (else the first of
 * `colors`) on `progressBackgroundColor`, with `title` under it. The gesture is touch-only
 * (see `denext/mobile`'s `PullToRefresh`). `RefreshControl.SIZE` is React Native's
 * `{ DEFAULT, LARGE }`.
 *
 * @param View react-native-web's `View` (React Native mode passes it in).
 * @returns The component.
 */
export function createRefreshControl(
  View: VNodeType,
): ((props: RefreshControlProps) => VNode) & {
  SIZE: { readonly DEFAULT: "default"; readonly LARGE: "large" };
} {
  function RefreshControl(props: RefreshControlProps): VNode {
    return useRefreshControlView(View, props, viewStyle);
  }
  return Object.assign(RefreshControl, { SIZE: REFRESH_CONTROL_SIZE });
}
