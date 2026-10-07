// Intentional, documented parity deviations for the react-native / expo targets — the
// mobile-side twin of `scripts/parity/waivers.ts`. A waiver suppresses one finding so the
// native gate stays green on KNOWN differences while still failing the moment a NEW,
// unexplained deviation appears. Every waiver carries a reason.
//
// The `Waiver` shape and matching logic are reused from the React harness, so the
// semantics (categorical `pattern` vs specific `symbol`, `categories` filter, cross- or
// per-specifier) are identical.

import type { Waiver } from "../waivers.ts";

export const NATIVE_WAIVERS: Waiver[] = [
  // ── Categorical policy (both targets) ────────────────────────────────────────────
  {
    // `unstable_batchedUpdates` is excluded: mobx-react-lite / redux batching configs import it
    // from `react-native`, and React Native mode provides it (denext's, via react-dom).
    pattern: "^unstable_(?!batchedUpdates$)",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "unstable_* are unstable react-native-web / Expo APIs; denext does not guarantee their shape.",
  },
  {
    pattern: "^(Unstable_|UNSTABLE_)",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "Unstable_/UNSTABLE_-prefixed exports are library internals, not stable public surface.",
  },
  {
    pattern: "^experimental_",
    categories: ["MISSING_VALUE", "ARITY_MISMATCH"],
    reason:
      "experimental_* are experimental react-native / Expo APIs; denext does not guarantee their shape.",
  },
  {
    pattern: "^_",
    categories: ["MISSING_VALUE"],
    reason: "Underscore-prefixed exports are library internals, not public surface.",
  },
  // ── Type-level members the .d.ts reports as statics ──────────────────────────────
  {
    // Every React Native flavour (react-native, react-native-windows, react-native-macos).
    symbol: "Animated",
    categories: ["MEMBER_MISSING"],
    reason: "react-native's `Animated` namespace declares its node classes (`Animated.Animated`, " +
      "`AnimatedAddition` … `AnimatedWithChildren`) for typing only; React Native's runtime " +
      "`Animated` does not export them either, so the member diff reports type-level names.",
  },
  // ── Declarations React Native's legacy `.d.ts` exports and its runtime does not ───────
  // TypeScript treats every top-level declaration of a `.d.ts` module as exported, so the
  // legacy types React Native 0.86 ships (`types/index.d.ts` → `Libraries/**/*.d.ts`) "export"
  // helper declarations its runtime never had. Checked against react-native 0.86.3's own
  // JavaScript (`index.js` and `Libraries/`): none of these names or members exists there, and
  // 0.87's generated types (`types_generated/`) drop them. An app that reads one gets
  // `undefined` in React Native too.
  {
    // `declare class ViewComponent extends React.Component<ViewProps> {}` and
    // `declare const ViewBase: Constructor<HostInstance> & typeof ViewComponent` (and the same
    // pair for each core component, plus `FlatListComponent` / `SectionListComponent`): the
    // base classes the `.d.ts` builds `View`, `Text`, … from.
    pattern: "^(?:ActivityIndicator|DrawerLayoutAndroid|ImageBackground|Image|" +
      "KeyboardAvoidingView|ProgressBarAndroid|RefreshControl|SafeAreaView|ScrollView|Switch|" +
      "TextInput|Text|TouchableNativeFeedback|TouchableWithoutFeedback|View)(?:Base|Component)$" +
      "|^(?:FlatList|SectionList)Component$",
    categories: ["MISSING_VALUE"],
    reason: "Type-only base classes of React Native's legacy `.d.ts` (`declare const ViewBase`, " +
      "`declare class ViewComponent`, …); React Native's runtime does not export them.",
  },
  {
    // Every React Native flavour (react-native, react-native-windows, react-native-macos).
    symbol: "DeviceEventEmitter",
    categories: ["MEMBER_MISSING"],
    members: ["sharedSubscriber"],
    reason: "`sharedSubscriber` is declared by React Native's legacy `DeviceEventEmitterStatic` " +
      "type only; `RCTDeviceEventEmitter` (an `EventEmitter`) has no such member at run time.",
  },
  {
    symbol: "NativeAppEventEmitter",
    categories: ["MEMBER_MISSING"],
    members: ["sharedSubscriber"],
    reason: "`NativeAppEventEmitter` is React Native's alias of `DeviceEventEmitter`; its " +
      "`sharedSubscriber` is the same type-only declaration.",
  },
  {
    symbol: "LayoutAnimation",
    categories: ["MEMBER_MISSING"],
    members: ["configChecker"],
    reason: "`configChecker` is declared by React Native's legacy `LayoutAnimationStatic` type " +
      "only; `Libraries/LayoutAnimation/LayoutAnimation.js` exports no such member.",
  },
  {
    // React Native 0.88's generated types declare `VirtualizedList` as its class, statics
    // included.
    symbol: "VirtualizedList",
    categories: ["MEMBER_MISSING"],
    members: ["contextType", "getDerivedStateFromProps"],
    reason: "`contextType` and `getDerivedStateFromProps` are React's class-component hooks on " +
      "React Native's `VirtualizedList` class, read by React itself (apps never call them); " +
      "React Native mode's `VirtualizedList` is a function component over denext's " +
      "`VirtualList`, which React does not read them from.",
  },
  {
    symbol: "View",
    categories: ["MEMBER_MISSING"],
    members: ["forceTouchAvailable"],
    reason: "`View.forceTouchAvailable` is declared by React Native's legacy `.d.ts` only; the " +
      "runtime value is `Platform.constants.forceTouchAvailable` (iOS), which denext's " +
      "`Platform` provides.",
  },
];

/** A documented waiver of names the lists target compares (see `lists.ts`). */
export interface ListWaiver {
  /** The target (`"react-native#SectionList"`, `"@shopify/flash-list"`, …). */
  readonly target: string;
  /** The kind of name. */
  readonly kind: "prop" | "method" | "export";
  /** The waived names (exact). */
  readonly names: readonly string[];
  /** Why. */
  readonly reason: string;
}

/**
 * Names the real lists' types declare that React Native's runtime never reads, so an adapter
 * has nothing to honour. Each names exactly the names it covers: any other missing name still
 * fails the lists gate.
 */
export const LIST_WAIVERS: readonly ListWaiver[] = [
  {
    target: "react-native#SectionList",
    kind: "prop",
    names: ["data", "getItem", "getItemCount"],
    reason: "`SectionListProps` extends `VirtualizedListWithoutRenderItemProps`, so the .d.ts " +
      "inherits `data` / `getItem` / `getItemCount`, but React Native's `SectionList` never " +
      "reads them: `SectionList.js` passes its own `getItem` / `getItemCount` after the app's " +
      "props, and `VirtualizedSectionList` passes `data={sections}` to `VirtualizedList`. The " +
      "items come from `sections` (react-native-web 0.21's copy does the same).",
  },
];
