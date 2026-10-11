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
 * the page, so nothing lifts. In the iOS shell the keyboard first slides in over the page and
 * the shell resizes the app around it afterwards: the room then gives way to the shrunk scroll
 * view without moving the content, and a list whose end was in view as the keyboard opened
 * (and lifted with it) stays pinned to its end through the lift, the resize and the hide; an
 * inverted list that was not lifted keeps its rows in place until the shell has grown the app
 * back after the hide. Android (the shell, and Chrome resizing content) shrinks the WebView
 * itself before the keyboard reports, so nothing covers the page: a list at its end as the
 * WebView shrinks is put back at its end instead (not `"never"`; an inverted list's end stays
 * in view by itself). Internal to `denext/mobile`; not re-exported.
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
  /**
   * The list lifted with its end in view and is kept at its end (not inverted: an inverted
   * list's end stays in view by itself). Set only while true.
   */
  readonly pinned?: true;
  /**
   * After the keyboard hid: px the shell still has to grow the app back by, which an inverted
   * list that was not lifted scrolls back as it does, so its rows stay put. Set only while > 0.
   */
  readonly regrow?: number;
}

/** What a keyboard change carries besides the covered height. */
export interface LiftChange {
  /** Whether the keyboard is up, covering the page or not (default: `effective > 0`). */
  readonly up?: boolean;
  /** px of the change the shell took by resizing the app: the scroll view shrank by it. */
  readonly absorbed?: number;
  /** px the shell has the app resized by now (the iOS shell; it lasts past the hide). */
  readonly resized?: number;
  /** Whether the keyboard was up before this change. */
  readonly wasUp?: boolean;
}

/** No keyboard. */
export const NO_LIFT: LiftState = { padding: 0, shift: -1 };

/** How near the end (px) still counts as at the end, as react-native-keyboard-controller's. */
const AT_END_PX = 20;

/**
 * Whether the end of the content is in view, within {@linkcode AT_END_PX} plus `slack` (px the
 * scroll view has just shrunk by, which hide the end until its room gives way).
 */
export function isAtEnd(m: LiftMetrics | null, inverted = false, slack = 0): boolean {
  if (!m) return true;
  return inverted
    ? m.scrollTop <= AT_END_PX
    : m.scrollTop + m.clientHeight >= m.scrollHeight - AT_END_PX - slack;
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

/** `state` with `pinned` set when `pinned` holds. */
function withPin(state: { padding: number; shift: number }, pinned: boolean): LiftState {
  return pinned ? { ...state, pinned: true } : state;
}

/**
 * One keyboard change: the new state, and the px to scroll the content by (positive moves it
 * up). A pinned list's scroll is the hook's to keep at the end; the step only says whether it
 * still is.
 *
 * @param state The state before the change.
 * @param effective The keyboard's covered height minus `offset`, clamped at 0.
 * @param behavior How the content moves.
 * @param metrics The scroll position before the change (null when unknown: treated as at the end).
 * @param inverted Whether the list is inverted.
 * @param change Whether the keyboard is up, and how much of the change the shell's resize took.
 */
export function liftStep(
  state: LiftState,
  effective: number,
  behavior: KeyboardLiftBehavior,
  metrics: LiftMetrics | null,
  inverted = false,
  change: LiftChange = {},
): { state: LiftState; scrollBy: number } {
  const up = change.up ?? effective > 0;
  if (!up) return closeStep(state, behavior, inverted, change);
  const absorbed = Math.max(0, change.absorbed ?? 0);
  if (effective === state.padding && absorbed === 0) return { state, scrollBy: 0 };
  if (state.padding === 0 && state.shift < 0) {
    return openStep(effective, behavior, metrics, inverted);
  }
  // The keyboard's own move (another height: the suggestion bar), which a lifted list follows;
  // what the shell's resize took shrank the scroll view as the room gave way, so nothing moves.
  const lifted = state.shift >= 0;
  const moved = effective - state.padding + absorbed;
  const shift = lifted ? state.shift + moved : -1;
  const pinned = !!state.pinned && isAtEnd(metrics, false, absorbed);
  return {
    state: withPin({ padding: effective, shift }, pinned),
    scrollBy: scrollFor(lifted, moved, inverted),
  };
}

/** {@linkcode NO_LIFT}, still waiting for the shell to grow the app back by `regrow` px. */
function regrowing(regrow: number): LiftState {
  return regrow > 0 ? { ...NO_LIFT, regrow } : NO_LIFT;
}

/**
 * The keyboard hid (or, after it did, the shell grew the app back): a lifted list drops back
 * (unless persistent); the browser clamps the rest. An inverted list that was not lifted is
 * scrolled past its room; what the shell's resize took is given back only as the shell grows
 * the app back after will-hide, and the list scrolls back by it then, so its rows stay put.
 */
function closeStep(
  state: LiftState,
  behavior: KeyboardLiftBehavior,
  inverted: boolean,
  change: LiftChange,
): { state: LiftState; scrollBy: number } {
  const lifted = state.shift >= 0;
  const resized = Math.max(0, change.resized ?? 0);
  // What the shell still owes: from the hide, or from an earlier report since.
  const owed = state.regrow ?? (change.wasUp && inverted && !lifted ? resized : 0);
  const grown = Math.max(0, owed - resized);
  if (state.padding === 0 && !lifted) {
    return { state: regrowing(owed - grown), scrollBy: grown > 0 ? -grown : 0 };
  }
  const scrollBy = inverted
    ? scrollFor(lifted, -state.padding, true)
    : scrollFor(lifted && behavior !== "persistent", -state.shift, false);
  return { state: regrowing(owed), scrollBy };
}

/** The keyboard opened over `effective` px: the room, and the lift `behavior` asks for. */
function openStep(
  effective: number,
  behavior: KeyboardLiftBehavior,
  metrics: LiftMetrics | null,
  inverted: boolean,
): { state: LiftState; scrollBy: number } {
  const lift = liftsOnOpen(behavior, metrics, inverted);
  const pinned = lift && !inverted && isAtEnd(metrics);
  return {
    state: withPin({ padding: effective, shift: lift ? effective : -1 }, pinned),
    scrollBy: scrollFor(lift, effective, inverted),
  };
}

/** Whether `freeze` holds true now. */
function frozen(freeze: KeyboardLiftOptions["freeze"]): boolean {
  return typeof freeze === "object" && freeze !== null ? !!freeze.value : !!freeze;
}

/**
 * Whether a list keeps its end in view as its scroll view shrinks by `by` px with nothing
 * covering the page (Android, and Chrome resizing content, shrink the WebView around the
 * keyboard): it was at its end as the shrink began and its content moves (not `"never"`, not
 * frozen). An inverted list's end stays in view by itself.
 */
export function pinsOnShrink(
  options: KeyboardLiftOptions,
  metrics: LiftMetrics | null,
  by: number,
): boolean {
  return by > 0 && options.behavior !== "never" && !options.inverted &&
    !frozen(options.freeze) && !!metrics && isAtEnd(metrics, false, by);
}

/** A scroll container, with the metrics the lift reads. */
type ScrollEl = LiftMetrics & { scrollTop: number };

/** Scroll `el` to the end of its content. */
function toEnd(el: ScrollEl): void {
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
}

/** A scroll container's metrics, or null when `node` is not one. */
function metricsOf(node: unknown): ScrollEl | null {
  const el = node as Partial<LiftMetrics> | null;
  return el && typeof el.scrollTop === "number" && typeof el.scrollHeight === "number"
    ? el as ScrollEl
    : null;
}

/** The layout viewport's height (the WebView's, where it resizes around the keyboard). */
function layoutHeight(): number {
  const h = (globalThis as { innerHeight?: unknown }).innerHeight;
  return typeof h === "number" && Number.isFinite(h) ? h : 0;
}

/**
 * Call `onShrink(px)` each time a window or visual-viewport resize finds the layout viewport
 * shorter than the last one did (by `px`). Returns a stop function.
 */
function watchLayoutShrink(onShrink: (px: number) => void): () => void {
  let height = layoutHeight();
  const check = () => {
    const now = layoutHeight();
    if (now < height) onShrink(height - now);
    height = now;
  };
  const candidates: unknown[] = [globalThis, globalThis.visualViewport];
  const targets = candidates.filter((t): t is EventTarget =>
    typeof (t as Partial<EventTarget> | null | undefined)?.addEventListener === "function"
  );
  for (const t of targets) t.addEventListener("resize", check);
  return () => {
    for (const t of targets) t.removeEventListener("resize", check);
  };
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
  const snap = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const nodeRef = useRef(node);
  nodeRef.current = node;
  useEffect(() => {
    if (!enabled) return;
    let last = { px: 0, height: 0 };
    const stop = watchKeyboardOverlap(({ px, height = px, resized }) => {
      // What the shell's resize took: the keyboard kept its height, the covered part shrank.
      const absorbed = (height - last.height) - (px - last.px);
      const wasUp = last.height > 0;
      last = { px, height };
      const o = latest.current;
      if (frozen(o.freeze)) return;
      const el = metricsOf(nodeRef.current());
      const effective = Math.max(0, Math.round(px - (o.offset ?? 0)));
      const prev = state.current;
      const step = liftStep(prev, effective, o.behavior ?? "always", el, !!o.inverted, {
        up: height > 0,
        absorbed,
        resized,
        wasUp,
      });
      state.current = step.state;
      if (prev.pinned && (step.state.pinned || height === 0)) {
        // Pinned to the end: once the room has its new size (now, if it keeps it).
        pending.current = 0;
        if (step.state.padding !== prev.padding) snap.current = true;
        else if (el) toEnd(el);
      } else if (step.scrollBy < 0 && el) {
        // Moving up needs the room rendered first; moving down goes before the room shrinks.
        el.scrollTop += step.scrollBy;
      } else pending.current += step.scrollBy;
      setPadding(step.state.padding);
    });
    // Nothing covers the page where the WebView shrinks around the keyboard (Android): a list
    // at its end as its view shrinks is put back at its end.
    const stopShrink = watchLayoutShrink((by) => {
      const s = state.current;
      const el = metricsOf(nodeRef.current());
      const idle = last.height === 0 && s.padding === 0 && s.shift < 0;
      if (el && idle && pinsOnShrink(latest.current, el, by)) toEnd(el);
    });
    return () => {
      stop();
      stopShrink();
      state.current = NO_LIFT;
      pending.current = 0;
      snap.current = false;
      setPadding(0);
    };
  }, [enabled]);
  useLayoutEffect(() => {
    const el = metricsOf(nodeRef.current());
    if (snap.current) {
      snap.current = false;
      if (el) toEnd(el);
      return;
    }
    const by = pending.current;
    if (by === 0) return;
    pending.current = 0;
    if (el) el.scrollTop += by;
  }, [padding]);
  return enabled ? padding : 0;
}
