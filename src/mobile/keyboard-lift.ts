/**
 * The keyboard lift of a chat scroll view, for React Native mode's
 * `react-native-keyboard-controller` (`KeyboardChatScrollView`) and `@legendapp/list/keyboard`
 * (`KeyboardAwareLegendList`): while the keyboard covers the page, the scroll view gets that much
 * room after its content, and its content moves up with the keyboard as on a phone
 * (`keyboardLiftBehavior`):
 *
 * - `"always"` (the default): the content lifts with the keyboard and drops back when it hides;
 * - `"whenAtEnd"`: only when the end of the content was in view as the keyboard opened;
 * - `"persistent"`: lifts like `"always"` but stays where it is when the keyboard hides;
 * - `"never"`: only the room is added; the content does not move.
 *
 * The lift is the keyboard's covered height minus `offset` (the distance between the scroll
 * view's bottom and the screen's). Where the WebView resizes around the keyboard nothing covers
 * the page, so nothing lifts. Internal to `denext/mobile`; not re-exported.
 *
 * @module
 */

import { useEffect, useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import { watchKeyboardOverlap } from "./keyboard-state.ts";

/** How the content moves when the keyboard opens and hides (see the module comment). */
export type KeyboardLiftBehavior = "always" | "whenAtEnd" | "persistent" | "never";

/** The lift's options, as the components' props give them. */
export interface KeyboardLiftOptions {
  /** `false` turns the lift off (default `true`). */
  readonly enabled?: boolean;
  /** How the content moves (default `"always"`). */
  readonly behavior?: KeyboardLiftBehavior;
  /** px between the scroll view's bottom and the screen's, not lifted (default 0). */
  readonly offset?: number;
  /** While true (or a shared value holding true), keyboard changes are ignored. */
  readonly freeze?: boolean | { readonly value: boolean };
  /** The list is inverted: its end is at scroll offset 0. */
  readonly inverted?: boolean;
}

/** The scroll position the lift reads (a scroll container's). */
export interface LiftMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/** Where the lift stands: the room it added and how far it moved the content. */
export interface LiftState {
  /** The room after the content, in px. */
  readonly padding: number;
  /** px the content was lifted by, or -1 when it was not lifted on open. */
  readonly shift: number;
}

/** No keyboard. */
export const NO_LIFT: LiftState = { padding: 0, shift: -1 };

/** How near the end (px) still counts as at the end, as react-native-keyboard-controller's. */
const AT_END_PX = 20;

/** Whether the end of the content is in view. */
export function isAtEnd(m: LiftMetrics | null, inverted = false): boolean {
  if (!m) return true;
  return inverted
    ? m.scrollTop <= AT_END_PX
    : m.scrollTop + m.clientHeight >= m.scrollHeight - AT_END_PX;
}

/** Whether the content lifts as the keyboard opens. */
function liftsOnOpen(
  behavior: KeyboardLiftBehavior,
  metrics: LiftMetrics | null,
  inverted: boolean,
): boolean {
  return behavior === "always" || behavior === "persistent" ||
    (behavior === "whenAtEnd" && isAtEnd(metrics, inverted));
}

/**
 * The scroll that moves `px` of room: a lifted list scrolls with it, unless it is inverted (its
 * room sits at its start, so its content moves with the room and only an unlifted one scrolls).
 */
function scrollFor(lifted: boolean, px: number, inverted: boolean): number {
  return lifted !== inverted ? px : 0;
}

/**
 * One keyboard change: the new state, and the px to scroll the content by (positive moves it
 * up).
 *
 * @param state The state before the change.
 * @param effective The keyboard's covered height minus `offset`, clamped at 0.
 * @param behavior How the content moves.
 * @param metrics The scroll position before the change (null when unknown: treated as at the end).
 * @param inverted Whether the list is inverted.
 */
export function liftStep(
  state: LiftState,
  effective: number,
  behavior: KeyboardLiftBehavior,
  metrics: LiftMetrics | null,
  inverted = false,
): { state: LiftState; scrollBy: number } {
  if (effective === state.padding) return { state, scrollBy: 0 };
  const lifted = state.shift >= 0;
  if (effective === 0) {
    // Closing: a lifted list drops back (unless persistent); the browser clamps the rest.
    const scrollBy = inverted
      ? scrollFor(lifted, -state.padding, true)
      : scrollFor(lifted && behavior !== "persistent", -state.shift, false);
    return { state: NO_LIFT, scrollBy };
  }
  if (state.padding === 0) {
    const lift = liftsOnOpen(behavior, metrics, inverted);
    const shift = lift ? effective : -1;
    return { state: { padding: effective, shift }, scrollBy: scrollFor(lift, effective, inverted) };
  }
  // A keyboard of another height (the suggestion bar): a lifted list follows it.
  const delta = effective - state.padding;
  const shift = lifted ? state.shift + delta : -1;
  return { state: { padding: effective, shift }, scrollBy: scrollFor(lifted, delta, inverted) };
}

/** Whether `freeze` holds true now. */
function frozen(freeze: KeyboardLiftOptions["freeze"]): boolean {
  return typeof freeze === "object" && freeze !== null ? !!freeze.value : !!freeze;
}

/** A scroll container's metrics, or null when `node` is not one. */
function metricsOf(node: unknown): (LiftMetrics & { scrollTop: number }) | null {
  const el = node as Partial<LiftMetrics> | null;
  return el && typeof el.scrollTop === "number" && typeof el.scrollHeight === "number"
    ? el as LiftMetrics & { scrollTop: number }
    : null;
}

/**
 * Hook: the keyboard lift of the scroll container `node()` returns (see the module comment).
 * Returns the room to add after the content (before it, for an inverted list); the content is
 * scrolled by the hook.
 *
 * @param node The scroll container (read on every keyboard change).
 * @param options The lift's options.
 * @returns The room in px.
 */
export function useKeyboardLift(node: () => unknown, options: KeyboardLiftOptions): number {
  const enabled = options.enabled !== false;
  const [padding, setPadding] = useState(0);
  const state = useRef<LiftState>(NO_LIFT);
  const pending = useRef(0);
  const latest = useRef(options);
  latest.current = options;
  const nodeRef = useRef(node);
  nodeRef.current = node;
  useEffect(() => {
    if (!enabled) return;
    const stop = watchKeyboardOverlap(({ px }) => {
      const o = latest.current;
      if (frozen(o.freeze)) return;
      const el = metricsOf(nodeRef.current());
      const effective = Math.max(0, Math.round(px - (o.offset ?? 0)));
      const step = liftStep(state.current, effective, o.behavior ?? "always", el, !!o.inverted);
      state.current = step.state;
      // Moving up needs the room rendered first; moving down goes before the room shrinks.
      if (step.scrollBy < 0 && el) el.scrollTop += step.scrollBy;
      else pending.current += step.scrollBy;
      setPadding(step.state.padding);
    });
    return () => {
      stop();
      state.current = NO_LIFT;
      pending.current = 0;
      setPadding(0);
    };
  }, [enabled]);
  useLayoutEffect(() => {
    const by = pending.current;
    if (by === 0) return;
    pending.current = 0;
    const el = metricsOf(nodeRef.current());
    if (el) el.scrollTop += by;
  }, [padding]);
  return enabled ? padding : 0;
}
