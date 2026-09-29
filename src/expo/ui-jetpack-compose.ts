/**
 * `@expo/ui/jetpack-compose` for denext: a load-safe stand-in. Jetpack Compose views are native Android UI that a web view
 * does not have, so each component here renders its children with web layout instead (stacks
 * and columns as flex boxes, `Text` as text, the buttons as a `<button>` that calls `onPress`,
 * everything else as its children alone) and warns once, the first time it renders. Nothing
 * throws at import, so a screen that imports `@expo/ui/jetpack-compose` builds and loads; give it a web layout
 * of its own (a `.web.tsx` file beside it) for a real web UI.
 *
 * Generated from the export list of `@expo/ui` 57.0.20, a superset of the 57.0.14 that
 * `src/expo/manifest.ts` pins; `deno task parity:native` checks the names.
 *
 * @example
 * ```ts
 * import { Column, Host, Text } from "denext/expo/ui/jetpack-compose";
 * import { h } from "denext/jsx-runtime";
 *
 * h(Host, null, h(Column, null, h(Text, null, "Hello"))); // a column with a text line
 * ```
 *
 * @module
 */

import type { VNode } from "../jsx/types.ts";
import { createContext } from "../runtime/context.ts";
import type { Context } from "../runtime/hooks.ts";
import {
  type StubModifier,
  stubModifierGroup,
  type StubProps,
  stubView,
} from "./internal/native-view.ts";

export type { StubModifier, StubProps };
export { type ObservableState, useNativeState } from "./internal/native-view.ts";

/** The package name the stand-ins warn with. */
const PKG = "@expo/ui/jetpack-compose";

/** Stand-in for Jetpack Compose's `BasicAlertDialog`: its children in a column. */
export const BasicAlertDialog: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "BasicAlertDialog",
  "column",
);

/** Stand-in for Jetpack Compose's `TextField`: its children only. */
export const TextField: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "TextField",
  "children",
);

/** Stand-in for Jetpack Compose's `OutlinedTextField`: its children only. */
export const OutlinedTextField: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "OutlinedTextField",
  "children",
);

/** Stand-in for Jetpack Compose's `BasicTextField`: its children only. */
export const BasicTextField: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "BasicTextField",
  "children",
);

/** Stand-in for Jetpack Compose's `HorizontalPager`: its children in a column. */
export const HorizontalPager: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "HorizontalPager",
  "column",
);

/** Stand-in for Jetpack Compose's `Text`: its children as text. */
export const Text: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Text", "text");

/** Stand-in for Jetpack Compose's `AlertDialog`: its children in a column. */
export const AlertDialog: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "AlertDialog",
  "column",
);

/** Stand-in for Jetpack Compose's `Badge`: its children only. */
export const Badge: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Badge",
  "children",
);

/** Stand-in for Jetpack Compose's `BadgedBox`: its children only. */
export const BadgedBox: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "BadgedBox",
  "children",
);

/** Stand-in for Jetpack Compose's `Card`: its children in a column. */
export const Card: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Card", "column");

/** Stand-in for Jetpack Compose's `ElevatedCard`: its children in a column. */
export const ElevatedCard: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ElevatedCard",
  "column",
);

/** Stand-in for Jetpack Compose's `OutlinedCard`: its children in a column. */
export const OutlinedCard: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "OutlinedCard",
  "column",
);

/** Stand-in for Jetpack Compose's `Checkbox`: its children only. */
export const Checkbox: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Checkbox",
  "children",
);

/** Stand-in for Jetpack Compose's `TriStateCheckbox`: its children only. */
export const TriStateCheckbox: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "TriStateCheckbox",
  "children",
);

/** Stand-in for Jetpack Compose's `AssistChip`: its children only. */
export const AssistChip: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "AssistChip",
  "children",
);

/** Stand-in for Jetpack Compose's `FilterChip`: its children only. */
export const FilterChip: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "FilterChip",
  "children",
);

/** Stand-in for Jetpack Compose's `InputChip`: its children only. */
export const InputChip: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "InputChip",
  "children",
);

/** Stand-in for Jetpack Compose's `SuggestionChip`: its children only. */
export const SuggestionChip: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SuggestionChip",
  "children",
);

/**
 * Stand-in for `transformButtonProps`: the props as given (there is no native button to
 * convert them for).
 *
 * @param props The button props.
 * @returns The same props.
 */
export function transformButtonProps<T>(props: T): T {
  return props;
}

/** Stand-in for Jetpack Compose's `Button`: a `<button>` that calls `onPress`. */
export const Button: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Button",
  "button",
);

/** Stand-in for Jetpack Compose's `FilledTonalButton`: a `<button>` that calls `onPress`. */
export const FilledTonalButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "FilledTonalButton",
  "button",
);

/** Stand-in for Jetpack Compose's `OutlinedButton`: a `<button>` that calls `onPress`. */
export const OutlinedButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "OutlinedButton",
  "button",
);

/** Stand-in for Jetpack Compose's `ElevatedButton`: a `<button>` that calls `onPress`. */
export const ElevatedButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ElevatedButton",
  "button",
);

/** Stand-in for Jetpack Compose's `TextButton`: a `<button>` that calls `onPress`. */
export const TextButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "TextButton",
  "button",
);

/**
 * Stand-in for `getMaterialColors`: an empty palette (Material You colors come from the
 * Android system, which a web view cannot read).
 *
 * @param _options Ignored.
 * @returns `{}`.
 */
export function getMaterialColors(_options?: unknown): Record<string, string> {
  return {};
}

/**
 * Stand-in for `useMaterialColors` (a hook): an empty palette (Material You colors come from the
 * Android system, which a web view cannot read).
 *
 * @param _options Ignored.
 * @returns `{}`.
 */
export function useMaterialColors(_options?: unknown): Record<string, string> {
  return {};
}

/** Whether Material You dynamic color is available: never in a web view. */
export const isDynamicColorAvailable: boolean = false;

/** Stand-in for `HostPaletteContext`: the host's palette, always null here. */
export const HostPaletteContext: Context<Record<string, string> | null> =
  /* @__PURE__ */ createContext<
    Record<string, string> | null
  >(null);

/** Stand-in for Jetpack Compose's `Icon`: its children only. */
export const Icon: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Icon", "children");

/** Stand-in for Jetpack Compose's `Image`: its children only. */
export const Image: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Image",
  "children",
);

/** Stand-in for Jetpack Compose's `IconButton`: a `<button>` that calls `onPress`. */
export const IconButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "IconButton",
  "button",
);

/** Stand-in for Jetpack Compose's `FilledIconButton`: a `<button>` that calls `onPress`. */
export const FilledIconButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "FilledIconButton",
  "button",
);

/** Stand-in for Jetpack Compose's `FilledTonalIconButton`: a `<button>` that calls `onPress`. */
export const FilledTonalIconButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "FilledTonalIconButton",
  "button",
);

/** Stand-in for Jetpack Compose's `OutlinedIconButton`: a `<button>` that calls `onPress`. */
export const OutlinedIconButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "OutlinedIconButton",
  "button",
);

/** Stand-in for Jetpack Compose's `Items`: its children in a column. */
export const Items: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Items", "column");

/** Stand-in for Jetpack Compose's `Trigger`: its children only. */
export const Trigger: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Trigger",
  "children",
);

/** Stand-in for Jetpack Compose's `Preview`: its children only. */
export const Preview: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Preview",
  "children",
);

/** Stand-in for Jetpack Compose's `DropdownMenu`: its children in a column. */
export const DropdownMenu: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DropdownMenu",
  "column",
);

/** Stand-in for Jetpack Compose's `DropdownMenuItem`: its children only. */
export const DropdownMenuItem: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DropdownMenuItem",
  "children",
);

/** Stand-in for Jetpack Compose's `ExposedDropdownMenuBox`: its children in a column. */
export const ExposedDropdownMenuBox: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ExposedDropdownMenuBox",
  "column",
);

/** Stand-in for Jetpack Compose's `ExposedDropdownMenu`: its children in a column. */
export const ExposedDropdownMenu: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ExposedDropdownMenu",
  "column",
);

/** Stand-in for Jetpack Compose's `HorizontalDivider`: its children only. */
export const HorizontalDivider: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "HorizontalDivider",
  "children",
);

/** Stand-in for Jetpack Compose's `VerticalDivider`: its children only. */
export const VerticalDivider: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "VerticalDivider",
  "children",
);

/** Stand-in for Jetpack Compose's `Host`: its children in a column. */
export const Host: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Host", "column");

/** Stand-in for Jetpack Compose's `LazyColumn`: its children in a column. */
export const LazyColumn: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "LazyColumn",
  "column",
);

/** Stand-in for Jetpack Compose's `LazyRow`: its children in a row. */
export const LazyRow: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "LazyRow", "row");

/** Stand-in for Jetpack Compose's `ListItem`: its children in a column. */
export const ListItem: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ListItem",
  "column",
);

/** Stand-in for Jetpack Compose's `RNHostView`: its children in a column. */
export const RNHostView: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "RNHostView",
  "column",
);

/** Stand-in for Jetpack Compose's `DateTimePicker`: its children only. */
export const DateTimePicker: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DateTimePicker",
  "children",
);

/** Stand-in for Jetpack Compose's `DateRangePicker`: its children only. */
export const DateRangePicker: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DateRangePicker",
  "children",
);

/** Stand-in for Jetpack Compose's `DatePickerDialog`: its children in a column. */
export const DatePickerDialog: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DatePickerDialog",
  "column",
);

/** Stand-in for Jetpack Compose's `DateRangePickerDialog`: its children in a column. */
export const DateRangePickerDialog: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DateRangePickerDialog",
  "column",
);

/** Stand-in for Jetpack Compose's `TimePickerDialog`: its children in a column. */
export const TimePickerDialog: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "TimePickerDialog",
  "column",
);

/** Stand-in for Jetpack Compose's `SegmentedButton`: its children only. */
export const SegmentedButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SegmentedButton",
  "children",
);

/** Stand-in for Jetpack Compose's `SingleChoiceSegmentedButtonRow`: its children in a row. */
export const SingleChoiceSegmentedButtonRow: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SingleChoiceSegmentedButtonRow",
  "row",
);

/** Stand-in for Jetpack Compose's `MultiChoiceSegmentedButtonRow`: its children in a row. */
export const MultiChoiceSegmentedButtonRow: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "MultiChoiceSegmentedButtonRow",
  "row",
);

/** Stand-in for Jetpack Compose's `LinearProgressIndicator`: its children only. */
export const LinearProgressIndicator: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "LinearProgressIndicator",
  "children",
);

/** Stand-in for Jetpack Compose's `CircularProgressIndicator`: its children only. */
export const CircularProgressIndicator: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "CircularProgressIndicator",
  "children",
);

/** Stand-in for Jetpack Compose's `LinearWavyProgressIndicator`: its children only. */
export const LinearWavyProgressIndicator: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "LinearWavyProgressIndicator",
  "children",
);

/** Stand-in for Jetpack Compose's `CircularWavyProgressIndicator`: its children only. */
export const CircularWavyProgressIndicator: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "CircularWavyProgressIndicator",
  "children",
);

/** Stand-in for Jetpack Compose's `VerticalSlider`: its children only. */
export const VerticalSlider: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "VerticalSlider",
  "children",
);

/** Stand-in for Jetpack Compose's `Slider`: its children only. */
export const Slider: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Slider",
  "children",
);

/** Stand-in for Jetpack Compose's `Spacer`: its children only. */
export const Spacer: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Spacer",
  "children",
);

/** Stand-in for Jetpack Compose's `SwitchThumbContent`: its children only. */
export const SwitchThumbContent: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SwitchThumbContent",
  "children",
);

/** Stand-in for Jetpack Compose's `Switch`: its children only. */
export const Switch: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Switch",
  "children",
);

/** Stand-in for Jetpack Compose's `SyncSwitch`: its children only. */
export const SyncSwitch: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SyncSwitch",
  "children",
);

/**
 * Stand-in for `transformToggleButtonProps`: the props as given (there is no native toggle button to
 * convert them for).
 *
 * @param props The toggle button props.
 * @returns The same props.
 */
export function transformToggleButtonProps<T>(props: T): T {
  return props;
}

/** Stand-in for Jetpack Compose's `ToggleButton`: its children only. */
export const ToggleButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ToggleButton",
  "children",
);

/** Stand-in for Jetpack Compose's `IconToggleButton`: its children only. */
export const IconToggleButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "IconToggleButton",
  "children",
);

/** Stand-in for Jetpack Compose's `FilledIconToggleButton`: its children only. */
export const FilledIconToggleButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "FilledIconToggleButton",
  "children",
);

/** Stand-in for Jetpack Compose's `OutlinedIconToggleButton`: its children only. */
export const OutlinedIconToggleButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "OutlinedIconToggleButton",
  "children",
);

/**
 * Stand-in for `parseJSXShape`: the shape element's props, or undefined.
 *
 * @param shape A shape element.
 * @returns Its props.
 */
export function parseJSXShape(shape?: unknown): Record<string, unknown> | undefined {
  const props = (shape as { props?: Record<string, unknown> } | undefined)?.props;
  return props ? { ...props } : undefined;
}

/** Stand-in for Compose's `Shape` components: each renders its children only. */
export const Shape: {
  /** Stand-in for `Shape.Circle`. */
  Circle: (props: StubProps) => VNode;
  /** Stand-in for `Shape.Pill`. */
  Pill: (props: StubProps) => VNode;
  /** Stand-in for `Shape.PillStar`. */
  PillStar: (props: StubProps) => VNode;
  /** Stand-in for `Shape.Polygon`. */
  Polygon: (props: StubProps) => VNode;
  /** Stand-in for `Shape.Rectangle`. */
  Rectangle: (props: StubProps) => VNode;
  /** Stand-in for `Shape.RoundedCorner`. */
  RoundedCorner: (props: StubProps) => VNode;
  /** Stand-in for `Shape.Star`. */
  Star: (props: StubProps) => VNode;
} = {
  Circle: /* @__PURE__ */ stubView(PKG, "Shape.Circle", "children"),
  Pill: /* @__PURE__ */ stubView(PKG, "Shape.Pill", "children"),
  PillStar: /* @__PURE__ */ stubView(PKG, "Shape.PillStar", "children"),
  Polygon: /* @__PURE__ */ stubView(PKG, "Shape.Polygon", "children"),
  Rectangle: /* @__PURE__ */ stubView(PKG, "Shape.Rectangle", "children"),
  RoundedCorner: /* @__PURE__ */ stubView(PKG, "Shape.RoundedCorner", "children"),
  Star: /* @__PURE__ */ stubView(PKG, "Shape.Star", "children"),
};

/** Stand-in for Jetpack Compose's `ModalBottomSheet`: its children in a column. */
export const ModalBottomSheet: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ModalBottomSheet",
  "column",
);

/** Stand-in for Jetpack Compose's `NavigationBar`: its children in a row. */
export const NavigationBar: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "NavigationBar",
  "row",
);

/** Stand-in for Jetpack Compose's `NavigationBarItem`: its children only. */
export const NavigationBarItem: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "NavigationBarItem",
  "children",
);

/** Stand-in for Jetpack Compose's `HorizontalCenteredHeroCarousel`: its children in a column. */
export const HorizontalCenteredHeroCarousel: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "HorizontalCenteredHeroCarousel",
  "column",
);

/** Stand-in for Jetpack Compose's `HorizontalMultiBrowseCarousel`: its children in a column. */
export const HorizontalMultiBrowseCarousel: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "HorizontalMultiBrowseCarousel",
  "column",
);

/** Stand-in for Jetpack Compose's `HorizontalUncontainedCarousel`: its children in a column. */
export const HorizontalUncontainedCarousel: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "HorizontalUncontainedCarousel",
  "column",
);

/** Stand-in for Jetpack Compose's `SearchBarPlaceholder`: its children only. */
export const SearchBarPlaceholder: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SearchBarPlaceholder",
  "children",
);

/** Stand-in for Jetpack Compose's `ExpandedFullScreenSearchBar`: its children only. */
export const ExpandedFullScreenSearchBar: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ExpandedFullScreenSearchBar",
  "children",
);

/** Stand-in for Jetpack Compose's `SearchBar`: its children only. */
export const SearchBar: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SearchBar",
  "children",
);

/** Stand-in for Jetpack Compose's `Snackbar`: its children in a column. */
export const Snackbar: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Snackbar",
  "column",
);

/** Stand-in for Jetpack Compose's `SnackbarHost`: its children in a column. */
export const SnackbarHost: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SnackbarHost",
  "column",
);

/** Stand-in for Jetpack Compose's `DockedSearchBarPlaceholder`: its children only. */
export const DockedSearchBarPlaceholder: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DockedSearchBarPlaceholder",
  "children",
);

/** Stand-in for Jetpack Compose's `DockedSearchBarLeadingIcon`: its children only. */
export const DockedSearchBarLeadingIcon: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DockedSearchBarLeadingIcon",
  "children",
);

/** Stand-in for Jetpack Compose's `DockedSearchBar`: its children only. */
export const DockedSearchBar: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DockedSearchBar",
  "children",
);

/** Stand-in for Jetpack Compose's `HorizontalFloatingToolbarFloatingActionButton`: its children only. */
export const HorizontalFloatingToolbarFloatingActionButton: (props: StubProps) => VNode =
  /* @__PURE__ */ stubView(PKG, "HorizontalFloatingToolbarFloatingActionButton", "children");

/** Stand-in for Jetpack Compose's `HorizontalFloatingToolbar`: its children in a row. */
export const HorizontalFloatingToolbar: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "HorizontalFloatingToolbar",
  "row",
);

/** Stand-in for Jetpack Compose's `SmallFloatingActionButton`: a `<button>` that calls `onPress`. */
export const SmallFloatingActionButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SmallFloatingActionButton",
  "button",
);

/** Stand-in for Jetpack Compose's `FloatingActionButton`: a `<button>` that calls `onPress`. */
export const FloatingActionButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "FloatingActionButton",
  "button",
);

/** Stand-in for Jetpack Compose's `LargeFloatingActionButton`: a `<button>` that calls `onPress`. */
export const LargeFloatingActionButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "LargeFloatingActionButton",
  "button",
);

/** Stand-in for Jetpack Compose's `ExtendedFloatingActionButton`: a `<button>` that calls `onPress`. */
export const ExtendedFloatingActionButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ExtendedFloatingActionButton",
  "button",
);

/** Stand-in for Jetpack Compose's `PullToRefreshBox`: its children in a column. */
export const PullToRefreshBox: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "PullToRefreshBox",
  "column",
);

/** Stand-in for Jetpack Compose's `RadioButton`: its children only. */
export const RadioButton: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "RadioButton",
  "children",
);

/** Stand-in for Jetpack Compose's `Surface`: its children in a column. */
export const Surface: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Surface",
  "column",
);

/** Stand-in for Jetpack Compose's `TooltipBox`: its children in a column. */
export const TooltipBox: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "TooltipBox",
  "column",
);

/** Stand-in for Jetpack Compose's `LoadingIndicator`: its children only. */
export const LoadingIndicator: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "LoadingIndicator",
  "children",
);

/** Stand-in for Jetpack Compose's `ContainedLoadingIndicator`: its children only. */
export const ContainedLoadingIndicator: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ContainedLoadingIndicator",
  "children",
);

/** Stand-in for Jetpack Compose's `AnimatedVisibility`: its children in a column. */
export const AnimatedVisibility: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "AnimatedVisibility",
  "column",
);

/** Stand-in for Compose's `EnterTransition`: transition configs, never applied. */
export const EnterTransition: Readonly<
  Record<
    | "expandHorizontally"
    | "expandIn"
    | "expandVertically"
    | "fadeIn"
    | "scaleIn"
    | "slideInHorizontally"
    | "slideInVertically",
    (...args: unknown[]) => StubModifier
  >
> = /* @__PURE__ */ stubModifierGroup("EnterTransition", [
  "expandHorizontally",
  "expandIn",
  "expandVertically",
  "fadeIn",
  "scaleIn",
  "slideInHorizontally",
  "slideInVertically",
]);

/** Stand-in for Compose's `ExitTransition`: transition configs, never applied. */
export const ExitTransition: Readonly<
  Record<
    | "fadeOut"
    | "scaleOut"
    | "shrinkHorizontally"
    | "shrinkOut"
    | "shrinkVertically"
    | "slideOutHorizontally"
    | "slideOutVertically",
    (...args: unknown[]) => StubModifier
  >
> = /* @__PURE__ */ stubModifierGroup("ExitTransition", [
  "fadeOut",
  "scaleOut",
  "shrinkHorizontally",
  "shrinkOut",
  "shrinkVertically",
  "slideOutHorizontally",
  "slideOutVertically",
]);

/** Stand-in for Jetpack Compose's `Box`: its children in a column. */
export const Box: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Box", "column");

/** Stand-in for Jetpack Compose's `Row`: its children in a row. */
export const Row: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Row", "row");

/** Stand-in for Jetpack Compose's `Column`: its children in a column. */
export const Column: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Column",
  "column",
);

/** Stand-in for Jetpack Compose's `FlowRow`: its children in a row. */
export const FlowRow: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "FlowRow", "row");
