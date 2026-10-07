/**
 * `@expo/ui/swift-ui/modifiers` for denext: a load-safe stand-in. Each SwiftUI modifier here returns an inert
 * config (`{ $type, $args }`) that nothing applies: the views of
 * `denext/expo/ui/swift-ui` render with web layout and ignore their modifiers.
 * Importing and calling them never throws.
 *
 * Generated from the export list of `@expo/ui` 57.0.20 and brought up to the 58.0.11 that
 * `src/expo/manifest.ts` pins; `deno task parity:native` checks the names.
 *
 * @example
 * ```ts
 * import { padding } from "denext/expo/ui/swift-ui/modifiers";
 *
 * const config = padding(8); // { $type: "padding", $args: [8] }, never applied
 * ```
 *
 * @module
 */

import {
  isStubModifier,
  type StubModifier,
  stubModifier,
  stubModifierGroup,
} from "./internal/native-view.ts";

export type { StubModifier };
export { createModifier, createModifierWithEventListener } from "./internal/native-view.ts";

/** Stand-in for the `lineLimit` modifier: an inert config. */
export const lineLimit: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "lineLimit",
);

/** Stand-in for the `dynamicTypeSize` modifier: an inert config. */
export const dynamicTypeSize: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "dynamicTypeSize",
);

/** Stand-in for the `listSectionSpacing` modifier: an inert config. */
export const listSectionSpacing: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("listSectionSpacing");

/** Stand-in for the `cornerRadius` modifier: an inert config. */
export const cornerRadius: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "cornerRadius",
);

/** Stand-in for the `shadow` modifier: an inert config. */
export const shadow: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("shadow");

/** Stand-in for the `matchedGeometryEffect` modifier: an inert config. */
export const matchedGeometryEffect: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("matchedGeometryEffect");

/** Stand-in for the `geometryGroup` modifier: an inert config. */
export const geometryGroup: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "geometryGroup",
);

/** Stand-in for the `frame` modifier: an inert config. */
export const frame: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("frame");

/** Stand-in for the `containerRelativeFrame` modifier: an inert config. */
export const containerRelativeFrame: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("containerRelativeFrame");

/** Stand-in for the `padding` modifier: an inert config. */
export const padding: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "padding",
);

/** Stand-in for the `fixedSize` modifier: an inert config. */
export const fixedSize: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "fixedSize",
);

/** Stand-in for the `ignoreSafeArea` modifier: an inert config. */
export const ignoreSafeArea: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "ignoreSafeArea",
);

/** Stand-in for the `onTapGesture` modifier: an inert config. */
export const onTapGesture: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "onTapGesture",
);

/** Stand-in for the `onLongPressGesture` modifier: an inert config. */
export const onLongPressGesture: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("onLongPressGesture");

/** Stand-in for the `onAppear` modifier: an inert config. */
export const onAppear: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "onAppear",
);

/** Stand-in for the `onDisappear` modifier: an inert config. */
export const onDisappear: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "onDisappear",
);

/** Stand-in for the `onGeometryChange` modifier: an inert config. */
export const onGeometryChange: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "onGeometryChange",
);

/** Stand-in for the `refreshable` modifier: an inert config. */
export const refreshable: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "refreshable",
);

/** Stand-in for the `opacity` modifier: an inert config. */
export const opacity: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "opacity",
);

/** Stand-in for the `clipShape` modifier: an inert config. */
export const clipShape: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "clipShape",
);

/** Stand-in for the `border` modifier: an inert config. */
export const border: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("border");

/** Stand-in for the `strokeBorder` modifier: an inert config. */
export const strokeBorder: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "strokeBorder",
);

/** Stand-in for the `scaleEffect` modifier: an inert config. */
export const scaleEffect: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "scaleEffect",
);

/** Stand-in for the `rotationEffect` modifier: an inert config. */
export const rotationEffect: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "rotationEffect",
);

/** Stand-in for the `rotation3DEffect` modifier: an inert config. */
export const rotation3DEffect: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "rotation3DEffect",
);

/** Stand-in for the `offset` modifier: an inert config. */
export const offset: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("offset");

/** Stand-in for the `foregroundColor` modifier: an inert config. */
export const foregroundColor: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "foregroundColor",
);

/** Stand-in for the `foregroundStyle` modifier: an inert config. */
export const foregroundStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "foregroundStyle",
);

/** Stand-in for the `bold` modifier: an inert config. */
export const bold: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("bold");

/** Stand-in for the `italic` modifier: an inert config. */
export const italic: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("italic");

/** Stand-in for the `monospacedDigit` modifier: an inert config. */
export const monospacedDigit: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "monospacedDigit",
);

/** Stand-in for the `tint` modifier: an inert config. */
export const tint: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("tint");

/** Stand-in for the `hidden` modifier: an inert config. */
export const hidden: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("hidden");

/** Stand-in for the `disabled` modifier: an inert config. */
export const disabled: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "disabled",
);

/** Stand-in for the `redacted` modifier: an inert config. */
export const redacted: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "redacted",
);

/** Stand-in for the `unredacted` modifier: an inert config. */
export const unredacted: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "unredacted",
);

/** Stand-in for the `privacySensitive` modifier: an inert config. */
export const privacySensitive: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "privacySensitive",
);

/** Stand-in for the `invalidatableContent` modifier: an inert config. */
export const invalidatableContent: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("invalidatableContent");

/** Stand-in for the `zIndex` modifier: an inert config. */
export const zIndex: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("zIndex");

/** Stand-in for the `blur` modifier: an inert config. */
export const blur: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("blur");

/** Stand-in for the `brightness` modifier: an inert config. */
export const brightness: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "brightness",
);

/** Stand-in for the `contrast` modifier: an inert config. */
export const contrast: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "contrast",
);

/** Stand-in for the `saturation` modifier: an inert config. */
export const saturation: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "saturation",
);

/** Stand-in for the `hueRotation` modifier: an inert config. */
export const hueRotation: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "hueRotation",
);

/** Stand-in for the `colorInvert` modifier: an inert config. */
export const colorInvert: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "colorInvert",
);

/** Stand-in for the `grayscale` modifier: an inert config. */
export const grayscale: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "grayscale",
);

/** Stand-in for the `buttonStyle` modifier: an inert config. */
export const buttonStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "buttonStyle",
);

/** Stand-in for the `buttonBorderShape` modifier: an inert config. */
export const buttonBorderShape: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "buttonBorderShape",
);

/** Stand-in for the `toggleStyle` modifier: an inert config. */
export const toggleStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "toggleStyle",
);

/** Stand-in for the `menuStyle` modifier: an inert config. */
export const menuStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "menuStyle",
);

/** Stand-in for the `menuIndicator` modifier: an inert config. */
export const menuIndicator: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "menuIndicator",
);

/** Stand-in for the `controlSize` modifier: an inert config. */
export const controlSize: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "controlSize",
);

/** Stand-in for the `imageScale` modifier: an inert config. */
export const imageScale: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "imageScale",
);

/** Stand-in for the `labelStyle` modifier: an inert config. */
export const labelStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "labelStyle",
);

/** Stand-in for the `labelsHidden` modifier: an inert config. */
export const labelsHidden: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "labelsHidden",
);

/** Stand-in for the `textFieldStyle` modifier: an inert config. */
export const textFieldStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "textFieldStyle",
);

/** Stand-in for the `scrollDismissesKeyboard` modifier: an inert config. */
export const scrollDismissesKeyboard: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("scrollDismissesKeyboard");

/** Stand-in for the `scrollDisabled` modifier: an inert config. */
export const scrollDisabled: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "scrollDisabled",
);

/** Stand-in for the `scrollClipDisabled` modifier: an inert config. */
export const scrollClipDisabled: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("scrollClipDisabled");

/** Stand-in for the `scrollIndicators` modifier: an inert config. */
export const scrollIndicators: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "scrollIndicators",
);

/** Stand-in for the `scrollEdgeEffectStyle` modifier: an inert config. */
export const scrollEdgeEffectStyle: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("scrollEdgeEffectStyle");

/** Stand-in for the `defaultScrollAnchor` modifier: an inert config. */
export const defaultScrollAnchor: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("defaultScrollAnchor");

/** Stand-in for the `defaultScrollAnchorForRole` modifier: an inert config. */
export const defaultScrollAnchorForRole: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("defaultScrollAnchorForRole");

/** Stand-in for the `scrollTargetBehavior` modifier: an inert config. */
export const scrollTargetBehavior: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("scrollTargetBehavior");

/** Stand-in for the `scrollTargetLayout` modifier: an inert config. */
export const scrollTargetLayout: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("scrollTargetLayout");

/** Stand-in for the `moveDisabled` modifier: an inert config. */
export const moveDisabled: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "moveDisabled",
);

/** Stand-in for the `deleteDisabled` modifier: an inert config. */
export const deleteDisabled: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "deleteDisabled",
);

/** Stand-in for the `menuActionDismissBehavior` modifier: an inert config. */
export const menuActionDismissBehavior: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("menuActionDismissBehavior");

/** Stand-in for the `accessibilityLabel` modifier: an inert config. */
export const accessibilityLabel: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("accessibilityLabel");

/** Stand-in for the `accessibilityHint` modifier: an inert config. */
export const accessibilityHint: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "accessibilityHint",
);

/** Stand-in for the `accessibilityValue` modifier: an inert config. */
export const accessibilityValue: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("accessibilityValue");

/** Stand-in for the `accessibilityInputLabels` modifier: an inert config. */
export const accessibilityInputLabels: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("accessibilityInputLabels");

/** Stand-in for the `accessibilityIdentifier` modifier: an inert config. */
export const accessibilityIdentifier: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("accessibilityIdentifier");

/** Stand-in for the `accessibilityHidden` modifier: an inert config. */
export const accessibilityHidden: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("accessibilityHidden");

/** Stand-in for the `accessibilityElement` modifier: an inert config. */
export const accessibilityElement: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("accessibilityElement");

/** Stand-in for the `accessibilityAddTraits` modifier: an inert config. */
export const accessibilityAddTraits: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("accessibilityAddTraits");

/** Stand-in for the `accessibilityRemoveTraits` modifier: an inert config. */
export const accessibilityRemoveTraits: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("accessibilityRemoveTraits");

/** Stand-in for the `layoutPriority` modifier: an inert config. */
export const layoutPriority: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "layoutPriority",
);

/** Stand-in for the `mask` modifier: an inert config. */
export const mask: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("mask");

/** Stand-in for the `overlay` modifier: an inert config. */
export const overlay: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "overlay",
);

/** Stand-in for the `backgroundOverlay` modifier: an inert config. */
export const backgroundOverlay: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "backgroundOverlay",
);

/** Stand-in for the `aspectRatio` modifier: an inert config. */
export const aspectRatio: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "aspectRatio",
);

/** Stand-in for the `clipped` modifier: an inert config. */
export const clipped: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "clipped",
);

/** Stand-in for the `glassEffect` modifier: an inert config. */
export const glassEffect: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "glassEffect",
);

/** Stand-in for the `glassEffectId` modifier: an inert config. */
export const glassEffectId: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "glassEffectId",
);

/** Stand-in for the `scrollContentBackground` modifier: an inert config. */
export const scrollContentBackground: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("scrollContentBackground");

/** Stand-in for the `listRowBackground` modifier: an inert config. */
export const listRowBackground: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "listRowBackground",
);

/** Stand-in for the `listRowSeparator` modifier: an inert config. */
export const listRowSeparator: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "listRowSeparator",
);

/** Stand-in for the `listRowSeparatorTint` modifier: an inert config. */
export const listRowSeparatorTint: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("listRowSeparatorTint");

/** Stand-in for the `listRowSpacing` modifier: an inert config. */
export const listRowSpacing: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "listRowSpacing",
);

/** Stand-in for the `alignmentGuide` modifier: an inert config. */
export const alignmentGuide: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "alignmentGuide",
);

/** Stand-in for the `truncationMode` modifier: an inert config. */
export const truncationMode: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "truncationMode",
);

/** Stand-in for the `allowsTightening` modifier: an inert config. */
export const allowsTightening: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "allowsTightening",
);

/** Stand-in for the `minimumScaleFactor` modifier: an inert config. */
export const minimumScaleFactor: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("minimumScaleFactor");

/** Stand-in for the `kerning` modifier: an inert config. */
export const kerning: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "kerning",
);

/** Stand-in for the `textCase` modifier: an inert config. */
export const textCase: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "textCase",
);

/** Stand-in for the `underline` modifier: an inert config. */
export const underline: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "underline",
);

/** Stand-in for the `strikethrough` modifier: an inert config. */
export const strikethrough: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "strikethrough",
);

/** Stand-in for the `multilineTextAlignment` modifier: an inert config. */
export const multilineTextAlignment: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("multilineTextAlignment");

/** Stand-in for the `textSelection` modifier: an inert config. */
export const textSelection: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "textSelection",
);

/** Stand-in for the `lineSpacing` modifier: an inert config. */
export const lineSpacing: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "lineSpacing",
);

/** Stand-in for the `lineHeight` modifier: an inert config. */
export const lineHeight: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "lineHeight",
);

/** Stand-in for the `headerProminence` modifier: an inert config. */
export const headerProminence: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "headerProminence",
);

/** Stand-in for the `listRowInsets` modifier: an inert config. */
export const listRowInsets: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "listRowInsets",
);

/** Stand-in for the `badgeProminence` modifier: an inert config. */
export const badgeProminence: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "badgeProminence",
);

/** Stand-in for the `badge` modifier: an inert config. */
export const badge: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("badge");

/** Stand-in for the `listSectionMargins` modifier: an inert config. */
export const listSectionMargins: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("listSectionMargins");

/** Stand-in for the `font` modifier: an inert config. */
export const font: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("font");

/** Stand-in for the `gridCellUnsizedAxes` modifier: an inert config. */
export const gridCellUnsizedAxes: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("gridCellUnsizedAxes");

/** Stand-in for the `gridCellColumns` modifier: an inert config. */
export const gridCellColumns: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "gridCellColumns",
);

/** Stand-in for the `gridColumnAlignment` modifier: an inert config. */
export const gridColumnAlignment: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("gridColumnAlignment");

/** Stand-in for the `gridCellAnchor` modifier: an inert config. */
export const gridCellAnchor: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "gridCellAnchor",
);

/** Stand-in for the `submitLabel` modifier: an inert config. */
export const submitLabel: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "submitLabel",
);

/** Stand-in for the `keyboardType` modifier: an inert config. */
export const keyboardType: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "keyboardType",
);

/** Stand-in for the `autocorrectionDisabled` modifier: an inert config. */
export const autocorrectionDisabled: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("autocorrectionDisabled");

/** Stand-in for the `onSubmit` modifier: an inert config. */
export const onSubmit: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "onSubmit",
);

/** Stand-in for the `textInputAutocapitalization` modifier: an inert config. */
export const textInputAutocapitalization: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("textInputAutocapitalization");

/** Stand-in for the `textContentType` modifier: an inert config. */
export const textContentType: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "textContentType",
);

/** Stand-in for the `contentTransition` modifier: an inert config. */
export const contentTransition: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "contentTransition",
);

/** Stand-in for the `listStyle` modifier: an inert config. */
export const listStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "listStyle",
);

/** Stand-in for the `luminanceToAlpha` modifier: an inert config. */
export const luminanceToAlpha: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "luminanceToAlpha",
);

/** Stand-in for the `resizable` modifier: an inert config. */
export const resizable: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "resizable",
);

/** Stand-in for the `navigationTitle` modifier: an inert config. */
export const navigationTitle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "navigationTitle",
);

/**
 * Whether `value` is a modifier config from this module.
 *
 * @param value Anything.
 */
export const isModifier: (value: unknown) => value is StubModifier = isStubModifier;

/**
 * The modifier configs among `modifiers`.
 *
 * @param modifiers Anything.
 * @returns The configs.
 */
export function filterModifiers(modifiers: unknown[]): StubModifier[] {
  return modifiers.filter(isStubModifier);
}

/** Stand-in for the `createViewModifierEventListener` modifier: an inert config. */
export const createViewModifierEventListener: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("createViewModifierEventListener");

/** A chainable animation config (inert here). */
export interface ChainableAnimation extends StubModifier {
  /** Delay it (seconds). */
  delay(delay: number): ChainableAnimation;
  /** Repeat it. */
  repeat(params: { repeatCount: number; autoreverses?: boolean }): ChainableAnimation;
}

/** A chainable animation config of `type` with `args`. */
function chainable(type: string, args: readonly unknown[]): ChainableAnimation {
  return {
    $type: type,
    $args: args,
    delay: (delay: number) => chainable(type, [...args, { delay }]),
    repeat: (params) => chainable(type, [...args, { repeat: params }]),
  };
}

/** Stand-in for SwiftUI's `Animation` presets: inert chainable configs. */
export const Animation: {
  /** Ease in and out. */
  easeInOut: (params?: unknown) => ChainableAnimation;
  /** Ease in. */
  easeIn: (params?: unknown) => ChainableAnimation;
  /** Ease out. */
  easeOut: (params?: unknown) => ChainableAnimation;
  /** Linear. */
  linear: (params?: unknown) => ChainableAnimation;
  /** A spring. */
  spring: (params?: unknown) => ChainableAnimation;
  /** An interpolating spring. */
  interpolatingSpring: (params?: unknown) => ChainableAnimation;
  /** The default animation. */
  default: ChainableAnimation;
} = {
  easeInOut: (params) => chainable("easeInOut", [params]),
  easeIn: (params) => chainable("easeIn", [params]),
  easeOut: (params) => chainable("easeOut", [params]),
  linear: (params) => chainable("linear", [params]),
  spring: (params) => chainable("spring", [params]),
  interpolatingSpring: (params) => chainable("interpolatingSpring", [params]),
  default: /* @__PURE__ */ chainable("default", []),
};

/** Stand-in for the `animation` modifier: an inert config. */
export const animation: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "animation",
);

/** Stand-in for the `containerBackground` modifier: an inert config. */
export const containerBackground: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("containerBackground");

/** Stand-in for the `containerShape` modifier: an inert config. */
export const containerShape: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "containerShape",
);

/** Stand-in for the `contentShape` modifier: an inert config. */
export const contentShape: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "contentShape",
);

/** Stand-in for `shapes`: shape configs, never applied. */
export const shapes: Readonly<
  Record<
    "capsule" | "circle" | "containerRelativeShape" | "ellipse" | "rectangle" | "roundedRectangle",
    (...args: unknown[]) => StubModifier
  >
> = /* @__PURE__ */ stubModifierGroup("shapes", [
  "capsule",
  "circle",
  "containerRelativeShape",
  "ellipse",
  "rectangle",
  "roundedRectangle",
]);

/** Stand-in for the `background` modifier: an inert config. */
export const background: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "background",
);

/** Stand-in for the `tag` modifier: an inert config. */
export const tag: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("tag");

/** Stand-in for the `pickerStyle` modifier: an inert config. */
export const pickerStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "pickerStyle",
);

/** Stand-in for the `menuOrder` modifier: an inert config. */
export const menuOrder: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "menuOrder",
);

/** Stand-in for the `tabViewStyle` modifier: an inert config. */
export const tabViewStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "tabViewStyle",
);

/** Stand-in for the `indexViewStyle` modifier: an inert config. */
export const indexViewStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "indexViewStyle",
);

/** Stand-in for the `navigationSplitViewColumnWidth` modifier: an inert config. */
export const navigationSplitViewColumnWidth: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("navigationSplitViewColumnWidth");

/** Stand-in for the `navigationSplitViewStyle` modifier: an inert config. */
export const navigationSplitViewStyle: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("navigationSplitViewStyle");

/** Stand-in for the `datePickerStyle` modifier: an inert config. */
export const datePickerStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "datePickerStyle",
);

/** Stand-in for the `progressViewStyle` modifier: an inert config. */
export const progressViewStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "progressViewStyle",
);

/** Stand-in for the `gaugeStyle` modifier: an inert config. */
export const gaugeStyle: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "gaugeStyle",
);

/** Stand-in for the `presentationDetents` modifier: an inert config. */
export const presentationDetents: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("presentationDetents");

/** Stand-in for the `presentationDragIndicator` modifier: an inert config. */
export const presentationDragIndicator: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("presentationDragIndicator");

/** Stand-in for the `presentationBackgroundInteraction` modifier: an inert config. */
export const presentationBackgroundInteraction: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("presentationBackgroundInteraction");

/** Stand-in for the `presentationBackground` modifier: an inert config. */
export const presentationBackground: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("presentationBackground");

/** Stand-in for the `interactiveDismissDisabled` modifier: an inert config. */
export const interactiveDismissDisabled: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("interactiveDismissDisabled");

/** Stand-in for the `presentationSizing` modifier: an inert config. */
export const presentationSizing: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("presentationSizing");

/** Stand-in for the `environment` modifier: an inert config. */
export const environment: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "environment",
);

/** Stand-in for the `id` modifier: an inert config. */
export const id: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("id");

/** Stand-in for the `scrollPosition` modifier: an inert config. */
export const scrollPosition: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "scrollPosition",
);

/** Stand-in for the `symbolEffect` modifier: an inert config. */
export const symbolEffect: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "symbolEffect",
);

/** Stand-in for the `useScrollGeometryChange` modifier: an inert config. */
export const useScrollGeometryChange: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("useScrollGeometryChange");

/** Stand-in for the `onScrollPhaseChange` modifier: an inert config. */
export const onScrollPhaseChange: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("onScrollPhaseChange");

/** Stand-in for the `widgetAccentedRenderingMode` modifier: an inert config. */
export const widgetAccentedRenderingMode: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("widgetAccentedRenderingMode");

/** Stand-in for the `widgetURL` modifier: an inert config. */
export const widgetURL: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "widgetURL",
);

/** Stand-in for the `activityBackgroundTint` modifier: an inert config. */
export const activityBackgroundTint: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("activityBackgroundTint");

/** Stand-in for the `preferredColorScheme` modifier: an inert config. */
export const preferredColorScheme: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("preferredColorScheme");

/** Stand-in for the `presentationCornerRadius` modifier: an inert config. */
export const presentationCornerRadius: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("presentationCornerRadius");
