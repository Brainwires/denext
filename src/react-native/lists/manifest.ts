/**
 * The list packages React Native mode runs on denext's `VirtualList` (unless
 * `reactNative: { lists: "library" }`): which specifiers resolve to a denext module, what that
 * module exports, the version its API was matched against, and what it leaves out. React
 * Native's own `FlatList`, `SectionList` and `VirtualizedList` are replaced inside
 * react-native-web ({@linkcode RN_LIST_COMPONENTS}). `scripts/parity/native` checks each
 * against the pinned package. Pure data: no imports, nothing runs.
 *
 * @module
 */

/** react-native-web's list components React Native mode replaces (`create<Name>` builds each). */
export const RN_LIST_COMPONENTS: readonly string[] = ["FlatList", "SectionList", "VirtualizedList"];

/** One aliased list package. */
export interface ListPackage {
  /** The specifiers that resolve to the shim (the package and any subpaths). */
  readonly specifiers: readonly string[];
  /** The prebuilt runtime module (`denext/react-native/<name>`). */
  readonly runtime: string;
  /** The package version its API was matched against. */
  readonly pinned: string;
  /** Components built from react-native-web's primitives: export name → factory. */
  readonly components: Readonly<Record<string, string>>;
  /** `Animated.createAnimatedComponent` of a component: export name → component. */
  readonly animated?: Readonly<Record<string, string>>;
  /** Exports re-exported from the runtime module (`"local as exported"` renames one). */
  readonly reexports: readonly string[];
  /**
   * A subpath that wraps the package's list (`@legendapp/list/keyboard`): its exports come from
   * a runtime `factory` called with `args` in order, each bound by an import of the app's own
   * packages (`[binding, import clause, specifier]`), instead of `components` / `reexports`.
   */
  readonly integration?: {
    readonly factory: string;
    readonly args: readonly (readonly [string, string, string])[];
    readonly exports: readonly string[];
  };
  /** Runtime exports of the package deliberately not provided. */
  readonly omitted: readonly string[];
  /** Why. */
  readonly notes: string;
}

/** The aliased list packages, by package name. */
export const LIST_PACKAGES: Readonly<Record<string, ListPackage>> = {
  "@shopify/flash-list": {
    specifiers: ["@shopify/flash-list"],
    runtime: "denext/react-native/flash-list",
    pinned: "2.3.2",
    components: { FlashList: "createFlashList" },
    animated: { AnimatedFlashList: "FlashList" },
    reexports: [
      "Cancellable",
      "JSFPSMonitor",
      "LayoutCommitObserver",
      "RenderTargetOptions",
      "autoScroll",
      "useBenchmark",
      "useDataMultiplier",
      "useFlashListContext",
      "useFlatListBenchmark",
      "useLayoutState",
      "useMappingHelper",
      "useFlashRecyclingState as useRecyclingState",
    ],
    omitted: [],
    notes: "Recycling is off unless `recycleItems` is set; `useFlashListContext` returns " +
      "undefined. The benchmark hooks run as on a device (JS frame rate while scrolling).",
  },
  "@legendapp/list": {
    specifiers: ["@legendapp/list", "@legendapp/list/react-native"],
    runtime: "denext/react-native/legend-list",
    pinned: "3.4.0",
    components: { LegendList: "createLegendList" },
    reexports: [
      "useAdaptiveRender",
      "useAdaptiveRenderChange",
      "useIsLastItem",
      "useListScrollSize",
      "useRecyclingEffect",
      "useRecyclingState",
      "useSyncLayout",
      "useViewability",
      "useViewabilityAmount",
      "internal",
    ],
    omitted: [],
    notes: "`@legendapp/list/react` (the DOM build), `/section-list`, `/animated` and " +
      "`/keyboard-legacy` keep resolving to the real package (which builds on this one: " +
      "`internal` holds the generic helpers they import; the list-state ones are not provided).",
  },
  "@legendapp/list/reanimated": {
    specifiers: ["@legendapp/list/reanimated"],
    runtime: "denext/react-native/legend-list",
    pinned: "3.4.0",
    components: {},
    reexports: [],
    integration: {
      factory: "legendReanimatedExports",
      args: [["LegendList", "{ LegendList }", "@legendapp/list/react-native"]],
      exports: ["AnimatedLegendList"],
    },
    omitted: [],
    notes: "`AnimatedLegendList` is the list with `sharedValues` kept current; " +
      "`itemLayoutAnimation` and `animatedProps` have no effect.",
  },
  "@legendapp/list/keyboard": {
    specifiers: ["@legendapp/list/keyboard"],
    runtime: "denext/react-native/legend-list",
    pinned: "3.4.0",
    components: {},
    reexports: [],
    integration: {
      factory: "legendKeyboardExports",
      args: [
        ["Reanimated", "* as Reanimated", "react-native-reanimated"],
        ["LegendList", "{ LegendList }", "@legendapp/list/react-native"],
        ["Keyboard", "{ Keyboard }", "react-native"],
      ],
      exports: [
        "KeyboardAwareLegendList",
        "useKeyboardChatComposerInset",
        "useKeyboardScrollToEnd",
      ],
    },
    omitted: [],
    notes: "`KeyboardAwareLegendList` adds the composer's height (`contentInsetEndAdjustment`, " +
      "a shared value) and `contentInsetEndStaticAdjustment` after the last item; the web " +
      "view's layout follows the keyboard, so the keyboard props have no effect.",
  },
};
