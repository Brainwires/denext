/**
 * `@expo/ui/jetpack-compose/modifiers` for denext: a load-safe stand-in. Each Jetpack Compose modifier here returns an inert
 * config (`{ $type, $args }`) that nothing applies: the views of
 * `denext/expo/ui/jetpack-compose` render with web layout and ignore their modifiers.
 * Importing and calling them never throws.
 *
 * Generated from the export list of `@expo/ui` 57.0.20 and brought up to the 58.0.11 that
 * `src/expo/manifest.ts` pins; `deno task parity:native` checks the names.
 *
 * @example
 * ```ts
 * import { padding } from "denext/expo/ui/jetpack-compose/modifiers";
 *
 * const config = padding(8); // { $type: "padding", $args: [8] }, never applied
 * ```
 *
 * @module
 */

import { type StubModifier, stubModifier, stubModifierGroup } from "./internal/native-view.ts";

export type { StubModifier };
export { createModifier, createModifierWithEventListener } from "./internal/native-view.ts";

/** Stand-in for the `animated` modifier: an inert config. */
export const animated: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "animated",
);

/** Stand-in for the `spring` modifier: an inert config. */
export const spring: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("spring");

/** Stand-in for the `tween` modifier: an inert config. */
export const tween: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("tween");

/** Stand-in for the `snap` modifier: an inert config. */
export const snap: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("snap");

/** Stand-in for the `keyframes` modifier: an inert config. */
export const keyframes: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "keyframes",
);

/** Stand-in for the `paddingAll` modifier: an inert config. */
export const paddingAll: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "paddingAll",
);

/** Stand-in for the `padding` modifier: an inert config. */
export const padding: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "padding",
);

/** Stand-in for the `size` modifier: an inert config. */
export const size: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("size");

/** Stand-in for the `fillMaxSize` modifier: an inert config. */
export const fillMaxSize: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "fillMaxSize",
);

/** Stand-in for the `fillMaxWidth` modifier: an inert config. */
export const fillMaxWidth: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "fillMaxWidth",
);

/** Stand-in for the `fillMaxHeight` modifier: an inert config. */
export const fillMaxHeight: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "fillMaxHeight",
);

/** Stand-in for the `width` modifier: an inert config. */
export const width: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("width");

/** Stand-in for the `height` modifier: an inert config. */
export const height: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("height");

/** Stand-in for the `defaultMinSize` modifier: an inert config. */
export const defaultMinSize: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "defaultMinSize",
);

/** Stand-in for the `wrapContentWidth` modifier: an inert config. */
export const wrapContentWidth: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "wrapContentWidth",
);

/** Stand-in for the `wrapContentHeight` modifier: an inert config. */
export const wrapContentHeight: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "wrapContentHeight",
);

/** Stand-in for the `imePadding` modifier: an inert config. */
export const imePadding: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "imePadding",
);

/** Stand-in for the `offset` modifier: an inert config. */
export const offset: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("offset");

/** Stand-in for the `background` modifier: an inert config. */
export const background: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "background",
);

/** Stand-in for the `border` modifier: an inert config. */
export const border: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("border");

/** Stand-in for the `shadow` modifier: an inert config. */
export const shadow: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("shadow");

/** Stand-in for the `dropShadow` modifier: an inert config. */
export const dropShadow: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "dropShadow",
);

/** Stand-in for the `innerShadow` modifier: an inert config. */
export const innerShadow: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "innerShadow",
);

/** Stand-in for the `alpha` modifier: an inert config. */
export const alpha: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("alpha");

/** Stand-in for the `blur` modifier: an inert config. */
export const blur: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("blur");

/** Stand-in for the `rotate` modifier: an inert config. */
export const rotate: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("rotate");

/** Stand-in for the `graphicsLayer` modifier: an inert config. */
export const graphicsLayer: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "graphicsLayer",
);

/** Stand-in for the `zIndex` modifier: an inert config. */
export const zIndex: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("zIndex");

/** Stand-in for the `animateContentSize` modifier: an inert config. */
export const animateContentSize: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("animateContentSize");

/** Stand-in for the `weight` modifier: an inert config. */
export const weight: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("weight");

/** Stand-in for the `align` modifier: an inert config. */
export const align: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("align");

/** Stand-in for the `matchParentSize` modifier: an inert config. */
export const matchParentSize: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "matchParentSize",
);

/** Stand-in for the `menuAnchor` modifier: an inert config. */
export const menuAnchor: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "menuAnchor",
);

/** Stand-in for the `clickable` modifier: an inert config. */
export const clickable: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "clickable",
);

/** Stand-in for the `combinedClickable` modifier: an inert config. */
export const combinedClickable: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "combinedClickable",
);

/** Stand-in for the `selectable` modifier: an inert config. */
export const selectable: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "selectable",
);

/** Stand-in for the `selectableGroup` modifier: an inert config. */
export const selectableGroup: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "selectableGroup",
);

/** Stand-in for the `toggleable` modifier: an inert config. */
export const toggleable: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "toggleable",
);

/** Stand-in for the `onVisibilityChanged` modifier: an inert config. */
export const onVisibilityChanged: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("onVisibilityChanged");

/** Stand-in for the `onSizeChanged` modifier: an inert config. */
export const onSizeChanged: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "onSizeChanged",
);

/** Stand-in for the `onGloballyPositioned` modifier: an inert config. */
export const onGloballyPositioned: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("onGloballyPositioned");

/** Stand-in for the `testID` modifier: an inert config. */
export const testID: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("testID");

/** Stand-in for the `semantics` modifier: an inert config. */
export const semantics: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "semantics",
);

/** Stand-in for `Shapes`: shape configs, never applied. */
export const Shapes: Readonly<
  Record<
    "Circle" | "CutCorner" | "Material" | "Rectangle" | "RoundedCorner",
    (...args: unknown[]) => StubModifier
  >
> = /* @__PURE__ */ stubModifierGroup("Shapes", [
  "Circle",
  "CutCorner",
  "Material",
  "Rectangle",
  "RoundedCorner",
]);

/** Stand-in for the `clip` modifier: an inert config. */
export const clip: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier("clip");

/** Stand-in for the `verticalScroll` modifier: an inert config. */
export const verticalScroll: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "verticalScroll",
);

/** Stand-in for the `horizontalScroll` modifier: an inert config. */
export const horizontalScroll: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "horizontalScroll",
);

/** Stand-in for the `createViewModifierEventListener` modifier: an inert config. */
export const createViewModifierEventListener: (...args: unknown[]) => StubModifier =
  /* @__PURE__ */ stubModifier("createViewModifierEventListener");

/** Compose's intrinsic sizes, for `width` / `height` (`IntrinsicSize.Min`). */
export const IntrinsicSize: { readonly Min: "min"; readonly Max: "max" } = {
  Min: "min",
  Max: "max",
};

/** One of {@linkcode IntrinsicSize}'s values. */
export type IntrinsicSize = (typeof IntrinsicSize)[keyof typeof IntrinsicSize];

/** Stand-in for the `cornerRadius` modifier: an inert config. */
export const cornerRadius: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "cornerRadius",
);

/** Stand-in for the `maskClip` modifier: an inert config. */
export const maskClip: (...args: unknown[]) => StubModifier = /* @__PURE__ */ stubModifier(
  "maskClip",
);
