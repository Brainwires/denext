/**
 * Pull-to-refresh for `denext/mobile`: a touch gesture on a scroll container that, pulled down
 * past a threshold while scrolled to the top, asks the app to refresh, and a spinner that
 * follows the pull and spins while the app refreshes. {@linkcode PullToRefresh} is the
 * component; React Native mode's `RefreshControl` shares the gesture and the spinner.
 *
 * The gesture reads touch events only (mouse and keyboard users get no gesture; give them a
 * refresh button). It never writes the scroll position and cancels a touch's default only
 * while it is pulling at the top, so iOS momentum scrolling and rubber-banding elsewhere are
 * untouched.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import { isNativeShell } from "./bridge.ts";
import { haptic } from "./haptics.ts";

/** An inline style object, as {@linkcode PullToRefresh} accepts and extends it. */
export type PullToRefreshStyle = Readonly<Record<string, string | number | undefined>>;

/** Props of {@linkcode PullToRefresh}; any other prop goes to its scrolling `<div>`. */
export interface PullToRefreshProps {
  /** Whether a refresh is in progress: the spinner stays out and spins while `true`. */
  readonly refreshing: boolean;
  /** Called when the user pulls past the threshold and lets go. Set `refreshing` in it. */
  readonly onRefresh?: () => void;
  /** `false` turns the gesture off (default `true`). */
  readonly enabled?: boolean;
  /** How far, in px, the spinner must be pulled to trigger a refresh (default 64). */
  readonly threshold?: number;
  /** Where the spinner rests while refreshing, in px from the top (default 16). */
  readonly offset?: number;
  /** The spinner's color (default `currentColor`). */
  readonly color?: string;
  /** The spinner disc's background (default `Canvas`, the page background). */
  readonly background?: string;
  /** A line of text under the spinner while refreshing (React Native's iOS `title`). */
  readonly title?: string;
  /** The title's color. */
  readonly titleColor?: string;
  /** The accessible name announced while refreshing (default `"Refreshing"`). */
  readonly label?: string;
  /** The scrolling `<div>`'s own style, which the component extends. */
  readonly style?: PullToRefreshStyle;
  /** The scrolling content. */
  readonly children?: VNodeChildren;
  /** Any other `<div>` attribute (`className`, `id`, `data-*`, …). */
  readonly [attribute: string]: unknown;
}

/** The pull in flight, as the spinner draws it. */
export interface PullState {
  /** How far the spinner has been pulled, in px (after resistance). */
  readonly distance: number;
  /** Whether letting go now refreshes (`distance` reached the threshold). */
  readonly armed: boolean;
}

/** What the spinner needs besides the pull itself. */
export interface PullIndicatorOptions {
  readonly refreshing: boolean;
  readonly threshold: number;
  readonly offset: number;
  readonly color?: string;
  readonly background?: string;
  readonly title?: string;
  readonly titleColor?: string;
  readonly label?: string;
}

/** What {@linkcode usePullToRefresh} is told. */
export interface PullGestureOptions {
  readonly refreshing: boolean;
  readonly onRefresh?: () => void;
  readonly enabled: boolean;
  readonly threshold: number;
}

/** The slice of a touch event the gesture reads. */
interface TouchLike {
  readonly touches?: ArrayLike<{ clientX: number; clientY: number }>;
  readonly cancelable?: boolean;
  preventDefault?(): void;
}

/** The slice of a scroll container the gesture reads. */
export interface PullScroller {
  readonly scrollTop: number;
  addEventListener(type: string, fn: (event: TouchLike) => void, options?: unknown): void;
  removeEventListener(type: string, fn: (event: TouchLike) => void, options?: unknown): void;
}

/** No pull: the resting state. */
const IDLE: PullState = { distance: 0, armed: false };

/** Movement, in px, before a downward touch at the top counts as a pull. */
const SLOP_PX = 8;
/** Finger travel per px of spinner travel (the pull's resistance). */
const RESISTANCE = 2;
/** The spinner disc's diameter, in px. */
const SPINNER_PX = 36;

/** The first touch of `event`, or undefined. */
function firstTouch(event: TouchLike): { clientX: number; clientY: number } | undefined {
  const touches = event.touches;
  return touches && touches.length > 0 ? touches[0] : undefined;
}

/** A pull of `travel` px of finger movement, resisted and capped at twice the threshold. */
function resisted(travel: number, threshold: number): number {
  return Math.min(threshold * 2, Math.max(0, travel / RESISTANCE));
}

/** Callbacks the gesture drives. */
interface PullCallbacks {
  /** Whether a pull may start now. */
  canPull(): boolean;
  /** The threshold, read at each move. */
  threshold(): number;
  onPull(state: PullState): void;
  onRelease(state: PullState): void;
}

/**
 * Attach the pull gesture to `scroller`; returns the detach function. A touch that starts with
 * the container scrolled to the top (or rubber-banding past it) and moves down more than it
 * moves sideways becomes a pull; from then on the touch's default is cancelled (no native
 * scroll or bounce) and `onPull` follows it until the finger lifts (`onRelease`).
 */
export function attachPullGesture(scroller: PullScroller, cb: PullCallbacks): () => void {
  let start: { x: number; y: number } | null = null;
  let pulling = false;
  let last: PullState = IDLE;
  const reset = () => {
    start = null;
    pulling = false;
    last = IDLE;
  };
  const onStart = (event: TouchLike) => {
    const touch = firstTouch(event);
    reset();
    if (!touch || !cb.canPull() || scroller.scrollTop > 0) return;
    start = { x: touch.clientX, y: touch.clientY };
  };
  const onMove = (event: TouchLike) => {
    const touch = firstTouch(event);
    if (!start || !touch) return;
    const dy = touch.clientY - start.y;
    const dx = touch.clientX - start.x;
    if (!pulling) {
      if (dy <= 0 || scroller.scrollTop > 0 || Math.abs(dx) > dy) return void (start = null);
      if (dy < SLOP_PX) return;
      pulling = true;
    }
    if (event.cancelable !== false) event.preventDefault?.();
    const threshold = cb.threshold();
    const distance = resisted(dy - SLOP_PX, threshold);
    last = { distance, armed: distance >= threshold };
    cb.onPull(last);
  };
  const onEnd = () => {
    const released = pulling ? last : null;
    reset();
    if (released) cb.onRelease(released);
  };
  scroller.addEventListener("touchstart", onStart, { passive: true });
  scroller.addEventListener("touchmove", onMove, { passive: false });
  scroller.addEventListener("touchend", onEnd, { passive: true });
  scroller.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    scroller.removeEventListener("touchstart", onStart, { passive: true });
    scroller.removeEventListener("touchmove", onMove, { passive: false });
    scroller.removeEventListener("touchend", onEnd, { passive: true });
    scroller.removeEventListener("touchcancel", onEnd, { passive: true });
  };
}

/** A light tick as the pull arms, inside the native shell only (the web would buzz). */
function armedTick(): void {
  if (isNativeShell()) haptic("light").catch(() => {});
}

/**
 * The pull gesture as a hook: attaches to the element `getScroller` returns after each commit
 * (re-attaching when it changes), and reports the pull in flight. Letting go armed calls
 * `onRefresh` (unless already refreshing). Internal to `denext/mobile` and React Native mode's
 * `RefreshControl`; not re-exported.
 *
 * @param getScroller Returns the scroll container, or null before it is mounted.
 * @param options The refreshing state, callback, switch and threshold.
 * @returns The pull in flight.
 */
export function usePullToRefresh(
  getScroller: () => PullScroller | null | undefined,
  options: PullGestureOptions,
): PullState {
  const [pull, setPull] = useState<PullState>(IDLE);
  const latest = useRef(options);
  latest.current = options;
  const attached = useRef<{ el: PullScroller; detach: () => void } | null>(null);
  useEffect(() => {
    const el = getScroller() ?? null;
    if (attached.current?.el === el) return;
    attached.current?.detach();
    attached.current = null;
    if (!el) return;
    let wasArmed = false;
    const detach = attachPullGesture(el, {
      canPull: () => latest.current.enabled && !latest.current.refreshing,
      threshold: () => latest.current.threshold,
      onPull: (state) => {
        if (state.armed && !wasArmed) armedTick();
        wasArmed = state.armed;
        setPull(state);
      },
      onRelease: (state) => {
        wasArmed = false;
        setPull(IDLE);
        if (state.armed && !latest.current.refreshing) latest.current.onRefresh?.();
      },
    });
    attached.current = { el, detach };
  });
  useEffect(() => () => {
    attached.current?.detach();
    attached.current = null;
  }, []);
  return pull;
}

/** The spinner's arc: a partial ring that closes as the pull approaches the threshold. */
function spinnerSvg(progress: number, spinning: boolean, color: string): VNode {
  const circumference = 2 * Math.PI * 9;
  const arc = spinning ? 0.75 : Math.max(0.1, Math.min(0.75, progress * 0.75));
  return h(
    "svg",
    { width: 24, height: 24, viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" },
    h(
      "circle",
      {
        cx: 12,
        cy: 12,
        r: 9,
        fill: "none",
        stroke: color,
        strokeWidth: 2.5,
        strokeLinecap: "round",
        strokeDasharray: `${arc * circumference} ${circumference}`,
        transform: `rotate(${spinning ? 0 : -90 + progress * 270} 12 12)`,
      },
      spinning
        ? h("animateTransform", {
          attributeName: "transform",
          type: "rotate",
          from: "0 12 12",
          to: "360 12 12",
          dur: "0.8s",
          repeatCount: "indefinite",
        })
        : null,
    ),
  );
}

/**
 * The spinner for a pull (or a refresh in progress): a disc that slides down from above the
 * container's top edge as it is pulled, and rests at `offset` spinning while refreshing. It is
 * positioned absolutely in a zero-height box, so it never moves the content. While refreshing
 * it is a `role="progressbar"` with `label` as its name. Internal; not re-exported.
 *
 * @param pull The pull in flight.
 * @param options Refreshing state, threshold, rest offset and colors.
 * @returns The indicator.
 */
export function pullIndicator(pull: PullState, options: PullIndicatorOptions): VNode {
  const { refreshing, threshold, offset } = options;
  const visible = refreshing || pull.distance > 0;
  const top = refreshing ? offset : Math.min(pull.distance, threshold) - SPINNER_PX;
  const progress = refreshing ? 1 : Math.min(1, pull.distance / threshold);
  const color = options.color ?? "currentColor";
  const title = refreshing && options.title
    ? h("div", {
      style: {
        marginTop: "6px",
        fontSize: "12px",
        textAlign: "center",
        ...(options.titleColor ? { color: options.titleColor } : {}),
      },
    }, options.title)
    : null;
  return h(
    "div",
    {
      "data-denext-pull-indicator": "",
      ...(refreshing
        ? { role: "progressbar", "aria-label": options.label ?? "Refreshing", "aria-busy": "true" }
        : { "aria-hidden": "true" }),
      style: {
        position: "absolute",
        top: "0px",
        left: "0px",
        right: "0px",
        height: "0px",
        zIndex: 1,
        pointerEvents: "none",
        display: "flex",
        justifyContent: "center",
        overflow: "visible",
      },
    },
    h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          transform: `translateY(${top}px)`,
          opacity: visible ? Math.max(0.2, progress) : 0,
          transition: pull.distance > 0 ? "none" : "transform 200ms ease-out, opacity 200ms",
        },
      },
      h(
        "div",
        {
          style: {
            width: `${SPINNER_PX}px`,
            height: `${SPINNER_PX}px`,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: options.background ?? "Canvas",
            color,
            boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
          },
        },
        spinnerSvg(progress, refreshing, color),
      ),
      title,
    ),
  );
}

/**
 * A scrolling `<div>` with pull-to-refresh: pull down from the top, past `threshold`, and let
 * go to call `onRefresh`; the spinner then rests near the top and spins while `refreshing` is
 * `true`. Set `refreshing` to `true` in `onRefresh` and back to `false` when the data arrives,
 * as with React Native's `RefreshControl` (React Native mode's `RefreshControl` is this same
 * gesture and spinner).
 *
 * The component is the scroll container (`overflow-y: auto`, with `overscroll-behavior-y:
 * contain` so the browser's own pull-to-refresh stays out of the way), so give it a height
 * (`style={{ height: "100dvh" }}`, or a flex parent). The gesture is touch-only; mouse and
 * keyboard users need another way to refresh. It works the same in the browser and in the
 * Capacitor shell, where arming the pull also plays a light haptic tick.
 *
 * @param props The component's props; unknown props pass through to the `<div>`.
 * @returns The scrolling `<div>`.
 * @example
 * ```tsx
 * "use client";
 * import { useState } from "denext";
 * import { PullToRefresh } from "denext/mobile";
 *
 * export function Inbox({ load }: { load: () => Promise<void> }) {
 *   const [refreshing, setRefreshing] = useState(false);
 *   return (
 *     <PullToRefresh
 *       refreshing={refreshing}
 *       onRefresh={async () => {
 *         setRefreshing(true);
 *         await load();
 *         setRefreshing(false);
 *       }}
 *       style={{ height: "100dvh" }}
 *     >
 *       <ul>…</ul>
 *     </PullToRefresh>
 *   );
 * }
 * ```
 */
export function PullToRefresh(props: PullToRefreshProps): VNode {
  const {
    refreshing,
    onRefresh,
    enabled = true,
    threshold = 64,
    offset = 16,
    color,
    background,
    title,
    titleColor,
    label,
    style = {},
    children,
    ...rest
  } = props;
  const el = useRef<PullScroller | null>(null);
  const pull = usePullToRefresh(() => el.current, { refreshing, onRefresh, enabled, threshold });
  return h(
    "div",
    {
      ...rest,
      ref: (node: PullScroller | null) => void (el.current = node),
      "data-denext-pull-to-refresh": "",
      style: { position: "relative", overflowY: "auto", overscrollBehaviorY: "contain", ...style },
    },
    h(
      "div",
      { style: { position: "sticky", top: "0px", height: "0px", zIndex: 1 } },
      pullIndicator(pull, {
        refreshing,
        threshold,
        offset,
        color,
        background,
        title,
        titleColor,
        label,
      }),
    ),
    children,
  );
}
