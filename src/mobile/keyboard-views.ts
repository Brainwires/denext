/**
 * Keyboard-aware views for `denext/mobile`: {@linkcode KeyboardAvoidingView} (React Native's
 * component of the same name) and {@linkcode KeyboardStickyView} (a view that rides on top of
 * the keyboard, as `react-native-keyboard-controller`'s does). Both move only by the part of the
 * keyboard that covers the page, so a WebView that already resizes around the keyboard is not
 * lifted twice.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useEffect, useState } from "../runtime/hooks.ts";
import { type KeyboardOverlap, watchKeyboardOverlap } from "./keyboard-state.ts";

/** An inline style object, as the views accept and extend it. */
export type KeyboardViewStyle = Readonly<Record<string, string | number | undefined>>;

/**
 * How a {@linkcode KeyboardAvoidingView} makes room: add bottom padding, shrink its height, or
 * move up as a whole (a compositor-only `translateY`).
 */
export type KeyboardAvoidingBehavior = "padding" | "height" | "position";

/** Props of {@linkcode KeyboardAvoidingView}; any other prop goes to its `<div>`. */
export interface KeyboardAvoidingViewProps {
  /** How to make room for the keyboard (default `"padding"`). */
  readonly behavior?: KeyboardAvoidingBehavior;
  /** `false` turns the avoidance off (default `true`). */
  readonly enabled?: boolean;
  /** px of the covered height to ignore, e.g. a bottom bar the keyboard hides anyway (default 0). */
  readonly keyboardVerticalOffset?: number;
  /** The `<div>`'s own style, which the avoidance extends. */
  readonly style?: KeyboardViewStyle;
  /** The content. */
  readonly children?: VNodeChildren;
  /** Any other `<div>` attribute (`className`, `id`, `data-*`, …). */
  readonly [attribute: string]: unknown;
}

/** Props of {@linkcode KeyboardStickyView}; any other prop goes to its `<div>`. */
export interface KeyboardStickyViewProps {
  /**
   * Extra `translateY` in px, `closed` while the keyboard is hidden and `opened` while it is up.
   * Positive values move the view down (as `react-native-keyboard-controller`'s `offset`): give
   * `opened` the height of a tab bar the keyboard covers so the view lands on the keyboard.
   */
  readonly offset?: { readonly closed?: number; readonly opened?: number };
  /** `false` keeps the view where its own style puts it (default `true`). */
  readonly enabled?: boolean;
  /** The `<div>`'s own style, which the view's `transform` extends. */
  readonly style?: KeyboardViewStyle;
  /** The content. */
  readonly children?: VNodeChildren;
  /** Any other `<div>` attribute. */
  readonly [attribute: string]: unknown;
}

/** No keyboard: the state before mount, during SSR and while a view is disabled. */
const NO_OVERLAP: KeyboardOverlap = { px: 0 };

/**
 * The covered height while `enabled`, re-rendering only when it changes. Internal to
 * `denext/mobile` (React Native mode's `KeyboardAvoidingView` shares it); not re-exported.
 */
export function useOverlap(enabled: boolean): KeyboardOverlap {
  const [overlap, setOverlap] = useState<KeyboardOverlap>(NO_OVERLAP);
  useEffect(() => {
    if (!enabled) return;
    const stop = watchKeyboardOverlap((next) =>
      setOverlap((prev) => prev.px === next.px && prev.duration === next.duration ? prev : next)
    );
    return () => {
      stop();
      setOverlap(NO_OVERLAP);
    };
  }, [enabled]);
  return enabled ? overlap : NO_OVERLAP;
}

/** A style length as CSS: numbers are px. */
function cssLength(value: string | number): string {
  return typeof value === "number" ? `${value}px` : value;
}

/** `base` (a style length, when set) plus or minus `px`, as one CSS value. */
function offsetLength(base: string | number | undefined, sign: "+" | "-", px: number): string {
  if (base === undefined || base === "") return sign === "+" ? `${px}px` : `calc(100% - ${px}px)`;
  return `calc(${cssLength(base)} ${sign} ${px}px)`;
}

/** The transition to add for `property`, when the keyboard's duration is known. */
function transitionFor(
  style: KeyboardViewStyle,
  property: string,
  duration: number | undefined,
): KeyboardViewStyle {
  if (duration === undefined || style.transition !== undefined) return {};
  return { transition: `${property} ${duration}ms ease-out` };
}

/** The style a {@linkcode KeyboardAvoidingView} adds for `behavior` and a `lift` of px. */
function avoidingStyle(
  behavior: KeyboardAvoidingBehavior,
  style: KeyboardViewStyle,
  lift: number,
  duration: number | undefined,
): KeyboardViewStyle {
  switch (behavior) {
    case "height":
      return {
        ...(lift > 0 ? { height: offsetLength(style.height, "-", lift) } : {}),
        ...transitionFor(style, "height", duration),
      };
    case "position":
      return {
        ...(lift > 0 ? { transform: `translateY(${-lift}px)` } : {}),
        ...transitionFor(style, "transform", duration),
      };
    default:
      return {
        ...(lift > 0 ? { paddingBottom: offsetLength(style.paddingBottom, "+", lift) } : {}),
        ...transitionFor(style, "padding-bottom", duration),
      };
  }
}

/** Refuse a behavior outside {@linkcode KeyboardAvoidingBehavior}. */
function checkBehavior(behavior: string): KeyboardAvoidingBehavior {
  if (behavior === "padding" || behavior === "height" || behavior === "position") return behavior;
  throw new TypeError(`KeyboardAvoidingView: unknown behavior "${behavior}"`);
}

/**
 * A `<div>` that makes room for the on-screen keyboard, like React Native's
 * `KeyboardAvoidingView`: with `behavior="padding"` (the default) it adds the covered height to
 * its bottom padding, with `"height"` it shrinks its height by it (from `style.height`, else
 * `100%`), and with `"position"` it moves up by it. `keyboardVerticalOffset` subtracts a fixed
 * amount (a bottom bar the keyboard hides anyway).
 *
 * "Covered" is the part of the keyboard over the page's layout viewport, which is 0 where the
 * WebView resizes around the keyboard (Android; the iOS shell with `@capacitor/keyboard`'s
 * default `resize: "native"`); the view then leaves layout alone. In the iOS shell with
 * `resize: "none"` it follows the keyboard's will-show / will-hide, animated over the
 * keyboard's own duration; on the web it follows the visual viewport (see
 * {@linkcode onKeyboardChange}). It renders without any avoidance during SSR.
 *
 * @param props The view's props; unknown props pass through to the `<div>`.
 * @returns The `<div>`.
 * @example
 * ```tsx
 * "use client";
 * import { KeyboardAvoidingView } from "denext/mobile";
 *
 * export function SignIn() {
 *   return (
 *     <KeyboardAvoidingView behavior="padding" style={{ minHeight: "100dvh" }}>
 *       <form>…</form>
 *     </KeyboardAvoidingView>
 *   );
 * }
 * ```
 */
export function KeyboardAvoidingView(props: KeyboardAvoidingViewProps): VNode {
  const {
    behavior = "padding",
    enabled = true,
    keyboardVerticalOffset = 0,
    style = {},
    children,
    ...rest
  } = props;
  const kind = checkBehavior(behavior);
  const overlap = useOverlap(enabled);
  const lift = Math.max(0, overlap.px - keyboardVerticalOffset);
  return h(
    "div",
    { ...rest, style: { ...style, ...avoidingStyle(kind, style, lift, overlap.duration) } },
    children,
  );
}

/** The `translateY` of a {@linkcode KeyboardStickyView}: on the keyboard, or `closed` off it. */
function stickyTranslate(overlap: number, offset: KeyboardStickyViewProps["offset"]): number {
  return overlap > 0 ? -overlap + (offset?.opened ?? 0) : offset?.closed ?? 0;
}

/**
 * A `<div>` that rides on top of the on-screen keyboard: while the keyboard covers the page it
 * moves up by the covered height (a compositor-only `translateY`), and back down when the
 * keyboard hides. Place it at the bottom of the screen yourself (`position: fixed` /
 * `sticky`, `bottom: 0`); the view only adds the transform. This is the composer of a chat
 * screen: see the chat-composer recipe on /docs/mobile.
 *
 * Like {@linkcode KeyboardAvoidingView} it follows only the part of the keyboard that covers the
 * page, so where the WebView resizes around the keyboard it stays put (the resize already
 * moved it). `offset` adds a fixed shift in each state.
 *
 * @param props The view's props; unknown props pass through to the `<div>`.
 * @returns The `<div>`.
 * @example
 * ```tsx
 * "use client";
 * import { KeyboardStickyView } from "denext/mobile";
 *
 * export function Composer() {
 *   return (
 *     <KeyboardStickyView style={{ position: "fixed", left: 0, right: 0, bottom: 0 }}>
 *       <textarea placeholder="Message" />
 *     </KeyboardStickyView>
 *   );
 * }
 * ```
 */
export function KeyboardStickyView(props: KeyboardStickyViewProps): VNode {
  const { offset, enabled = true, style = {}, children, ...rest } = props;
  const overlap = useOverlap(enabled);
  const shift = enabled ? stickyTranslate(overlap.px, offset) : 0;
  const own = style.transform === undefined ? "" : `${style.transform} `;
  return h(
    "div",
    {
      ...rest,
      style: {
        ...style,
        ...(shift !== 0 ? { transform: `${own}translateY(${shift}px)` } : {}),
        ...transitionFor(style, "transform", overlap.duration),
      },
    },
    children,
  );
}
