/**
 * `@expo/ui/community/pager-view` for denext: the same `PagerView` React Native mode gives
 * `react-native-pager-view` (the two are API-compatible): each child is a page of a CSS
 * scroll-snap pager, with `onPageSelected` / `onPageScroll` / `onPageScrollStateChanged` and
 * the ref's `setPage` / `setPageWithoutAnimation` / `setScrollEnabled`. `@expo/ui`'s own web
 * build throws when it renders.
 *
 * @example
 * ```ts
 * import PagerView from "denext/expo/ui/community/pager-view";
 * import { h } from "denext/jsx-runtime";
 *
 * h(PagerView, { initialPage: 0, style: { flex: 1 } }, h("div", { key: "1" }, "One"), h("div", { key: "2" }, "Two"));
 * ```
 *
 * @module
 */

export {
  PagerView,
  PagerView as default,
  type PagerViewEvent,
  type PagerViewHandle as PagerViewRef,
  type PagerViewOnPageScrollEvent,
  type PagerViewOnPageScrollEventData,
  type PagerViewOnPageSelectedEvent,
  type PagerViewOnPageSelectedEventData,
  type PagerViewProps,
  type PageScrollStateChangedNativeEvent as PageScrollStateChangedEvent,
  type PageScrollStateChangedNativeEventData as PageScrollStateChangedEventData,
} from "../react-native-compat/pager-view.ts";
