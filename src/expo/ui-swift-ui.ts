/**
 * `@expo/ui/swift-ui` for denext: a load-safe stand-in. SwiftUI views are native iOS UI that a web view
 * does not have, so each component here renders its children with web layout instead (stacks
 * and columns as flex boxes, `Text` as text, the buttons as a `<button>` that calls `onPress`,
 * everything else as its children alone) and warns once, the first time it renders. Nothing
 * throws at import, so a screen that imports `@expo/ui/swift-ui` builds and loads; give it a web layout
 * of its own (a `.web.tsx` file beside it) for a real web UI.
 *
 * Generated from the export list of `@expo/ui` 57.0.20, a superset of the 57.0.14 that
 * `src/expo/manifest.ts` pins; `deno task parity:native` checks the names.
 *
 * @example
 * ```ts
 * import { Host, Text, VStack } from "denext/expo/ui/swift-ui";
 * import { h } from "denext/jsx-runtime";
 *
 * h(Host, null, h(VStack, null, h(Text, null, "Hello"))); // a column with a text line
 * ```
 *
 * @module
 */

import type { VNode } from "../jsx/types.ts";
import {
  type StubModifier,
  stubModifierGroup,
  type StubProps,
  stubView,
} from "./internal/native-view.ts";

export type { StubModifier, StubProps };
export { type ObservableState, useNativeState } from "./internal/native-view.ts";

/** The package name the stand-ins warn with. */
const PKG = "@expo/ui/swift-ui";

/**
 * Stand-in for SwiftUI's `withAnimation`: runs `body` at once, then `completion`. Nothing
 * animates (there is no SwiftUI view to animate).
 *
 * @param _animation The animation (ignored).
 * @param body The state change.
 * @param completion Called after `body`.
 * @param _completionCriteria Ignored.
 */
export function withAnimation(
  _animation: unknown,
  body: () => void,
  completion?: () => void,
  _completionCriteria?: unknown,
): void {
  body();
  completion?.();
}

/** Stand-in for SwiftUI's `TextField`: its children only. */
export const TextField: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "TextField",
  "children",
);

/** Stand-in for SwiftUI's `AccessoryWidgetBackground`: its children only. */
export const AccessoryWidgetBackground: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "AccessoryWidgetBackground",
  "children",
);

/** Stand-in for SwiftUI's `Alert`: its children in a column. */
export const Alert: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Alert", "column");

/** Stand-in for SwiftUI's `BottomSheet`: its children in a column. */
export const BottomSheet: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "BottomSheet",
  "column",
);

/** Stand-in for SwiftUI's `Button`: a `<button>` that calls `onPress`. */
export const Button: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Button",
  "button",
);

/** Stand-in for SwiftUI's `Chart`: its children only. */
export const Chart: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Chart",
  "children",
);

/** Stand-in for SwiftUI's `ColorPicker`: its children only. */
export const ColorPicker: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ColorPicker",
  "children",
);

/** Stand-in for SwiftUI's `ContentUnavailableView`: its children only. */
export const ContentUnavailableView: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ContentUnavailableView",
  "children",
);

/** Stand-in for SwiftUI's `ConfirmationDialog`: its children in a column. */
export const ConfirmationDialog: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ConfirmationDialog",
  "column",
);

/** Stand-in for SwiftUI's `ControlGroup`: its children in a column. */
export const ControlGroup: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ControlGroup",
  "column",
);

/** Stand-in for SwiftUI's `Items`: its children in a column. */
export const Items: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Items", "column");

/** Stand-in for SwiftUI's `Trigger`: its children only. */
export const Trigger: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Trigger",
  "children",
);

/** Stand-in for SwiftUI's `Preview`: its children only. */
export const Preview: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Preview",
  "children",
);

/** Stand-in for SwiftUI's `ContextMenu`: its children in a column. */
export const ContextMenu: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ContextMenu",
  "column",
);

/** Stand-in for SwiftUI's `DatePicker`: its children only. */
export const DatePicker: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DatePicker",
  "children",
);

/** Stand-in for SwiftUI's `Divider`: its children only. */
export const Divider: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Divider",
  "children",
);

/** Stand-in for SwiftUI's `DisclosureGroup`: its children in a column. */
export const DisclosureGroup: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "DisclosureGroup",
  "column",
);

/** Stand-in for SwiftUI's `Form`: its children in a column. */
export const Form: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Form", "column");

/** Stand-in for SwiftUI's `Gauge`: its children only. */
export const Gauge: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Gauge",
  "children",
);

/** Stand-in for SwiftUI's `Host`: its children in a column. */
export const Host: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Host", "column");

/** Stand-in for SwiftUI's `Image`: its children only. */
export const Image: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Image",
  "children",
);

/** Stand-in for SwiftUI's `Label`: its children as text. */
export const Label: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Label", "text");

/** Stand-in for SwiftUI's `LabeledContent`: its children only. */
export const LabeledContent: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "LabeledContent",
  "children",
);

/** Stand-in for SwiftUI's `HStack`: its children in a row. */
export const HStack: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "HStack", "row");

/** Stand-in for SwiftUI's `LazyHStack`: its children in a row. */
export const LazyHStack: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "LazyHStack",
  "row",
);

/** Stand-in for SwiftUI's `LazyVStack`: its children in a column. */
export const LazyVStack: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "LazyVStack",
  "column",
);

/** Stand-in for SwiftUI's `VStack`: its children in a column. */
export const VStack: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "VStack",
  "column",
);

/** Stand-in for SwiftUI's `ZStack`: its children in a column. */
export const ZStack: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ZStack",
  "column",
);

/** Stand-in for SwiftUI's `Group`: its children in a column. */
export const Group: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Group", "column");

/** Stand-in for SwiftUI's `List`: its children in a column. */
export const List: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "List", "column");

/** Stand-in for SwiftUI's `ListForEach`: its children in a column. */
export const ListForEach: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ListForEach",
  "column",
);

/** Stand-in for SwiftUI's `Menu`: its children in a column. */
export const Menu: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Menu", "column");

/** Stand-in for SwiftUI's `NavigationDestination`: its children in a column. */
export const NavigationDestination: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "NavigationDestination",
  "column",
);

/** Stand-in for SwiftUI's `NavigationLink`: a `<button>` that calls `onPress`. */
export const NavigationLink: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "NavigationLink",
  "button",
);

/** Stand-in for SwiftUI's `NavigationSplitView`: its children in a column. */
export const NavigationSplitView: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "NavigationSplitView",
  "column",
);

/** Stand-in for SwiftUI's `NavigationStack`: its children in a column. */
export const NavigationStack: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "NavigationStack",
  "column",
);

/** Stand-in for SwiftUI's `Picker`: its children only. */
export const Picker: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Picker",
  "children",
);

/** Stand-in for SwiftUI's `ProgressView`: its children only. */
export const ProgressView: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ProgressView",
  "children",
);

/** Stand-in for SwiftUI's `Section`: its children in a column. */
export const Section: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Section",
  "column",
);

/** Stand-in for SwiftUI's `ShareLink`: its children only. */
export const ShareLink: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ShareLink",
  "children",
);

/** Stand-in for SwiftUI's `Slider`: its children only. */
export const Slider: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Slider",
  "children",
);

/** Stand-in for SwiftUI's `Spacer`: its children only. */
export const Spacer: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Spacer",
  "children",
);

/** Stand-in for SwiftUI's `Stepper`: its children only. */
export const Stepper: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Stepper",
  "children",
);

/** Stand-in for SwiftUI's `Actions`: its children in a column. */
export const Actions: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Actions",
  "column",
);

/** Stand-in for SwiftUI's `SwipeActions`: its children only. */
export const SwipeActions: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SwipeActions",
  "children",
);

/** Stand-in for SwiftUI's `Text`: its children as text. */
export const Text: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Text", "text");

/** Stand-in for SwiftUI's `SyncToggle`: its children only. */
export const SyncToggle: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SyncToggle",
  "children",
);

/** Stand-in for SwiftUI's `TabView`: its children in a column. */
export const TabView: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "TabView",
  "column",
);

/** Stand-in for SwiftUI's `ToolbarItem`: its children only. */
export const ToolbarItem: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ToolbarItem",
  "children",
);

/** Stand-in for SwiftUI's `Toolbar`: its children in a column. */
export const Toolbar: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Toolbar",
  "column",
);

/** Stand-in for SwiftUI's `Toggle`: its children only. */
export const Toggle: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Toggle",
  "children",
);

/** Stand-in for SwiftUI's `SecureField`: its children only. */
export const SecureField: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "SecureField",
  "children",
);

/** Stand-in for SwiftUI's `Namespace`: its children only. */
export const Namespace: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Namespace",
  "children",
);

/** Stand-in for SwiftUI's `GlassEffectContainer`: its children in a column. */
export const GlassEffectContainer: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "GlassEffectContainer",
  "column",
);

/** Stand-in for SwiftUI's `ScrollView`: its children in a column. */
export const ScrollView: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ScrollView",
  "column",
);

/** Stand-in for SwiftUI's `Rectangle`: its children only. */
export const Rectangle: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Rectangle",
  "children",
);

/** Stand-in for SwiftUI's `RoundedRectangle`: its children only. */
export const RoundedRectangle: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "RoundedRectangle",
  "children",
);

/** Stand-in for SwiftUI's `Ellipse`: its children only. */
export const Ellipse: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Ellipse",
  "children",
);

/** Stand-in for SwiftUI's `UnevenRoundedRectangle`: its children only. */
export const UnevenRoundedRectangle: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "UnevenRoundedRectangle",
  "children",
);

/** Stand-in for SwiftUI's `Capsule`: its children only. */
export const Capsule: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Capsule",
  "children",
);

/** Stand-in for SwiftUI's `Circle`: its children only. */
export const Circle: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Circle",
  "children",
);

/** Stand-in for SwiftUI's `ConcentricRectangle`: its children only. */
export const ConcentricRectangle: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "ConcentricRectangle",
  "children",
);

/** Stand-in for `EdgeCornerStyle`: corner-style configs, never applied. */
export const EdgeCornerStyle: {
  /** A concentric corner. */
  concentric: (...args: unknown[]) => StubModifier;
  /** A fixed corner. */
  fixed: (...args: unknown[]) => StubModifier;
} = /* @__PURE__ */ stubModifierGroup("EdgeCornerStyle", ["concentric", "fixed"]);

/** Stand-in for SwiftUI's `Mask`: its children in a column. */
export const Mask: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Mask", "column");

/** Stand-in for SwiftUI's `Overlay`: its children in a column. */
export const Overlay: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Overlay",
  "column",
);

/** Stand-in for SwiftUI's `Background`: its children in a column. */
export const Background: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Background",
  "column",
);

/** Stand-in for SwiftUI's `Popover`: its children in a column. */
export const Popover: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "Popover",
  "column",
);

/** Stand-in for SwiftUI's `Grid`: its children in a column. */
export const Grid: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Grid", "column");

/** Stand-in for SwiftUI's `RNHostView`: its children in a column. */
export const RNHostView: (props: StubProps) => VNode = /* @__PURE__ */ stubView(
  PKG,
  "RNHostView",
  "column",
);

/** Stand-in for SwiftUI's `Link`: a `<button>` that calls `onPress`. */
export const Link: (props: StubProps) => VNode = /* @__PURE__ */ stubView(PKG, "Link", "button");
