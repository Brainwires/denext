/**
 * The shared types of `denext/navigation`: screen options (the per-route `screenOptions`
 * export and `setOptions`), stack animations, sheet detents, and the stack view's entries.
 *
 * @module
 */

import type { VNodeChildren } from "../jsx/types.ts";

/**
 * How a screen enters and leaves a stack. The names follow `react-native-screens`'
 * native-stack `animation` option:
 *
 * - `"default"`: the platform's own (`"ios_from_right"` on iOS and the web,
 *   `"shared_axis_x"` on Android).
 * - `"ios_from_right"` / `"ios_from_left"`: the iOS push, with the screen below sliding a
 *   third of the way under and dimming (parallax).
 * - `"slide_from_right"` / `"slide_from_left"` / `"simple_push"`: both screens slide by a
 *   full width, no parallax (`"simple_push"` is `"slide_from_right"`).
 * - `"slide_from_bottom"`: the screen rises from the bottom edge (a full-screen modal).
 * - `"fade"`: a cross-fade.
 * - `"fade_from_bottom"`: Android 8's rise-and-fade.
 * - `"shared_axis_x"`: Material's shared-axis X (fade through with a short horizontal shift).
 * - `"none"`: no animation.
 */
export type StackAnimation =
  | "default"
  | "none"
  | "fade"
  | "fade_from_bottom"
  | "slide_from_right"
  | "slide_from_left"
  | "slide_from_bottom"
  | "simple_push"
  | "ios_from_right"
  | "ios_from_left"
  | "shared_axis_x";

/**
 * How a screen is presented:
 *
 * - `"card"`: a full screen pushed onto the stack (the default).
 * - `"modal"`: a full-screen modal rising from the bottom.
 * - `"formSheet"`: a bottom {@linkcode SheetDetent | sheet} over the screen below it.
 * - `"transparentModal"`: a screen with no background of its own, over the screen below it.
 */
export type StackPresentation = "card" | "modal" | "formSheet" | "transparentModal";

/**
 * A height a sheet can rest at: `"medium"` (half the available height), `"large"` (the full
 * available height), `"fit"` (its content's height, up to `"large"`), or a number (a fraction
 * of the available height when at most `1`, else CSS px).
 */
export type SheetDetent = "medium" | "large" | "fit" | number;

/** The platform look a navigator takes: iOS or Android (Material). */
export type NavigationPlatform = "ios" | "android";

/**
 * Options for one screen of a stack. As a page's `export const screenOptions = { … }` they are
 * plain JSON (the server reads them and ships them with the page); `setOptions` from
 * {@linkcode useStackNavigation} can also set the component-valued `header*` slots.
 */
export interface ScreenOptions {
  /** The header title (and the iOS back button's label on the screen above). */
  readonly title?: string;
  /** How the screen enters and leaves (default `"default"`, the platform's). */
  readonly animation?: StackAnimation;
  /** Transition length in ms (default: the animation's own, 350 on iOS and 300 on Android). */
  readonly animationDuration?: number;
  /** Whether the iOS edge swipe and Android predictive back can pop it (default `true`). */
  readonly gestureEnabled?: boolean;
  /** How the screen is presented (default `"card"`). */
  readonly presentation?: StackPresentation;
  /** Whether to draw the stack's header above the screen (default `false`). */
  readonly headerShown?: boolean;
  /** iOS: a large title that collapses into the header as the screen scrolls. */
  readonly headerLargeTitle?: boolean;
  /** iOS: the back button's label (default: the title of the screen below, else "Back"). */
  readonly headerBackTitle?: string;
  /** Whether to draw the back button when the stack can go back (default `true`). */
  readonly headerBackVisible?: boolean;
  /** A `"formSheet"`'s detents (default `["large"]`). */
  readonly sheetAllowedDetents?: readonly SheetDetent[];
  /** The detent a `"formSheet"` opens at (index into `sheetAllowedDetents`, default `0`). */
  readonly sheetInitialDetentIndex?: number;
  /** Whether a `"formSheet"` shows its grabber (default `true`). */
  readonly sheetGrabberVisible?: boolean;
  /** Replaces the header's title (client-only: set through `setOptions`). */
  readonly headerTitle?: VNodeChildren;
  /** Content at the header's leading edge, after the back button (client-only). */
  readonly headerLeft?: VNodeChildren;
  /** Content at the header's trailing edge (client-only). */
  readonly headerRight?: VNodeChildren;
}

/** One screen as the stack view draws it (bottom of the stack first). */
export interface StackViewEntry {
  /** A unique id for this push (two pushes of one route get two ids). */
  readonly id: string;
  /** The href it was pushed at (the header's back link points at the screen below's). */
  readonly href?: string;
  /** What it renders; `undefined` for a screen not loaded yet (or unloaded past `maxDepth`). */
  readonly element: VNodeChildren | undefined;
  /** Its options. */
  readonly options: ScreenOptions;
}
