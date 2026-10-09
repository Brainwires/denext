/**
 * `SwipeableRow` — a list row that swipes sideways to reveal actions, as iOS Mail's and
 * Android's: leading actions under a rightward swipe, trailing actions under a leftward one,
 * and a full swipe that runs a side's first action. Built with `h()` (framework source
 * carries no JSX).
 *
 * - **Compositor-only.** A drag writes `transform`s and nothing else (no layout property, no
 *   layout read): sizes come from a shared `ResizeObserver`, never from a synchronous
 *   measurement, so a row inside a scrolling `VirtualList` never forces a layout.
 * - **Axis lock** as in `denext/navigation`'s back swipe: nothing moves for the first 10 px,
 *   then the row takes the touch only when the movement is horizontal (vertical scrolling keeps
 *   it — the row is `touch-action: pan-y`); a swipe toward a side with nothing to reveal is
 *   left to the stack's back swipe.
 * - **One open row at a time**; a tap elsewhere, a scroll, or a tap on the open row closes it.
 * - **Haptics** through `denext/mobile`'s `haptic` inside the native shell, when a full swipe
 *   arms.
 * - **Accessible.** Every action is a real `<button>` in the tab order and the accessibility
 *   tree; focusing one opens its side so it is visible; Escape closes the row.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { useEffect, useRef } from "../../runtime/hooks.ts";
import { VelocityTracker } from "../../navigation/gesture.ts";
import { listenAll } from "../../navigation/listen.ts";
import { haptic } from "../../mobile/haptics.ts";
import { isNativeShell } from "../../mobile/bridge.ts";
import {
  actionEnd,
  isFullSwipe,
  lockRowAxis,
  type RowGeometry,
  rowOffset,
  type RowSettle,
  settleRow,
} from "./math.ts";

/** One action a {@linkcode SwipeableRow} reveals. */
export interface SwipeAction {
  /** Its visible label (and accessible name, unless `accessibilityLabel` is given). */
  readonly label: string;
  /** Run the action (a press, or a full swipe for a side's first action). */
  readonly onPress: () => void;
  /** An icon above the label. */
  readonly icon?: VNodeChildren;
  /** Its colour role (default `"neutral"`); `background` / `color` override it. */
  readonly tone?: "neutral" | "accent" | "destructive" | "warning" | "success";
  /** The button's background (any CSS colour). */
  readonly background?: string;
  /** The button's text colour (default white). */
  readonly color?: string;
  /** The accessible name (default: `label`). */
  readonly accessibilityLabel?: string;
  /** A stable key (default: `label`). */
  readonly key?: string;
}

/** Which side of a row is open. */
export type SwipeableRowSide = "leading" | "trailing";

/** What a {@linkcode SwipeableRow}'s `rowRef` receives. */
export interface SwipeableRowHandle {
  /** Open `side` (animated). */
  open(side: SwipeableRowSide): void;
  /** Close the row (animated). */
  close(): void;
  /** The side that is open, or `null`. */
  readonly openSide: SwipeableRowSide | null;
}

/** Props of {@linkcode SwipeableRow}. */
export interface SwipeableRowProps {
  /** The row's content (it slides; give it a background, or set `--dnx-swipe-row-bg`). */
  readonly children?: VNodeChildren;
  /** The actions a rightward swipe reveals, outermost first (the first runs on a full swipe). */
  readonly leading?: readonly SwipeAction[];
  /** The actions a leftward swipe reveals, outermost first (the first runs on a full swipe). */
  readonly trailing?: readonly SwipeAction[];
  /** Custom content to reveal on the leading side instead of `leading` (no full swipe). */
  readonly leadingPanel?: VNodeChildren;
  /** Custom content to reveal on the trailing side instead of `trailing` (no full swipe). */
  readonly trailingPanel?: VNodeChildren;
  /**
   * Which sides run their first action on a full swipe (default `true`: both sides that have
   * actions); `false` for neither.
   */
  readonly fullSwipe?: boolean | SwipeableRowSide;
  /** The fraction of the row's width past which a release is a full swipe (default `0.55`). */
  readonly fullSwipeThreshold?: number;
  /** Each action button's width in px (default `74`). */
  readonly actionWidth?: number;
  /** A haptic when a full swipe arms, inside the native shell (default `true`). */
  readonly haptics?: boolean;
  /** Close the row after an action button runs (default `true`). */
  readonly closeOnAction?: boolean;
  /** Turn the gesture off (the actions stay reachable by keyboard). */
  readonly disabled?: boolean;
  /** Let a mouse drag swipe too (default `false`: touch and pen only). */
  readonly mouse?: boolean;
  /** Drag resistance: the row moves `1 / friction` px per finger px (default `1`). */
  readonly friction?: number;
  /** Called when a side opens or the row closes. */
  readonly onOpenChange?: (side: SwipeableRowSide | null) => void;
  /**
   * Called whenever the content moves, with its offset in px (positive: the leading side is
   * revealed) and how far open the revealed side is (`1` = fully open; above `1` past it).
   */
  readonly onSwipeProgress?: (offset: number, progress: number) => void;
  /** Receives the row's handle (open, close). */
  readonly rowRef?: (handle: SwipeableRowHandle | null) => void;
  /** The row element's tag (default `"div"`; `"li"` inside a list). */
  readonly as?: "div" | "li";
  /** A class for the row. */
  readonly className?: string;
  /** Extra style for the row. */
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  /** Extra style for the sliding content. */
  readonly contentStyle?: Readonly<Record<string, string | number | undefined>>;
}

/** The default background of each tone (the iOS system colours). */
const TONES: Readonly<Record<NonNullable<SwipeAction["tone"]>, string>> = {
  neutral: "#8e8e93",
  accent: "#007aff",
  destructive: "#ff3b30",
  warning: "#ff9500",
  success: "#34c759",
};

/** The settle animation. */
const SETTLE_MS = 260;
const SETTLE_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

// ---- sizes: one shared ResizeObserver, never a synchronous measurement ---------------------

const sizes = new WeakMap<Element, number>();
let observer: ResizeObserver | null = null;

/** Keep `el`'s width in {@linkcode sizes} while it is observed; returns the unobserve. */
function observeWidth(el: Element): () => void {
  if (typeof ResizeObserver !== "function") return () => {};
  observer ??= new ResizeObserver((entries) => {
    for (const e of entries) {
      sizes.set(e.target, e.borderBoxSize?.[0]?.inlineSize ?? e.contentRect.width);
    }
  });
  observer.observe(el);
  return () => observer?.unobserve(el);
}

/** `el`'s last observed width, or `fallback`. */
function widthOf(el: Element | null, fallback: number): number {
  const w = el ? sizes.get(el) : undefined;
  return w !== undefined && w > 0 ? w : fallback;
}

/** Whether the user asked for reduced motion. */
function reducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

// ---- the row's runtime -----------------------------------------------------------------------

/** A drag in progress. */
interface Drag {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** The content's offset when the drag locked. */
  base: number;
  locked: boolean;
  readonly velocity: VelocityTracker;
}

/** The row's state that lives across renders outside React state (it changes every frame). */
interface RowRt {
  props: SwipeableRowProps;
  root: HTMLElement | null;
  content: HTMLElement | null;
  readonly panels: { leading: HTMLElement | null; trailing: HTMLElement | null };
  readonly buttons: { leading: Array<HTMLElement | null>; trailing: Array<HTMLElement | null> };
  offset: number;
  side: SwipeableRowSide | null;
  full: boolean;
  drag: Drag | null;
  suppressClick: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  unlistenOutside: (() => void) | null;
}

/** The one open row (opening another closes it, as on iOS). */
let openRow: RowRt | null = null;

/** The open width of one side. */
function sideWidth(rt: RowRt, side: SwipeableRowSide): number {
  const actions = rt.props[side];
  const width = rt.props.actionWidth ?? 74;
  if (actions && actions.length > 0) return actions.length * width;
  return rt.props[`${side}Panel`] !== undefined ? widthOf(rt.panels[side], width) : 0;
}

/** Whether `side`'s full swipe runs its first action. */
function sideFull(rt: RowRt, side: SwipeableRowSide): boolean {
  const f = rt.props.fullSwipe ?? true;
  return (f === true || f === side) && (rt.props[side]?.length ?? 0) > 0;
}

/** The row's geometry, from the observed sizes. */
function geometry(rt: RowRt): RowGeometry {
  const fallback = (globalThis as { innerWidth?: number }).innerWidth ?? 375;
  return {
    leading: { width: sideWidth(rt, "leading"), full: sideFull(rt, "leading") },
    trailing: { width: sideWidth(rt, "trailing"), full: sideFull(rt, "trailing") },
    rowWidth: widthOf(rt.root, fallback),
    fullThreshold: rt.props.fullSwipeThreshold,
  };
}

/** Put `transform` on `el` (empty clears it). */
function setTransform(el: HTMLElement | null | undefined, value: string): void {
  if (el?.style) el.style.transform = value;
}

/** Draw the row at `offset`: the content, then each revealed side's action buttons. */
function paint(rt: RowRt, offset: number): void {
  rt.offset = offset;
  reportProgress(rt, offset);
  setTransform(rt.content, offset === 0 ? "" : `translate3d(${offset}px, 0, 0)`);
  paintSide(rt.buttons.leading, Math.max(0, offset), rt.full, (end) => `${end}px - 100%`);
  paintSide(rt.buttons.trailing, Math.max(0, -offset), rt.full, (end) => `100% - ${end}px`);
}

/** Place one side's buttons for `reveal` px open (each box's inner end, as a `calc()`). */
function paintSide(
  buttons: Array<HTMLElement | null>,
  reveal: number,
  full: boolean,
  x: (end: number) => string,
): void {
  for (let i = 0; i < buttons.length; i++) {
    const end = reveal > 0 ? actionEnd(i, buttons.length, reveal, full) : 0;
    setTransform(buttons[i], `translate3d(calc(${x(end)}), 0, 0)`);
  }
}

/** Tell `onSwipeProgress` where the content is and how far open its side is. */
function reportProgress(rt: RowRt, offset: number): void {
  const report = rt.props.onSwipeProgress;
  if (!report) return;
  const width = offset === 0 ? 0 : sideWidth(rt, offset > 0 ? "leading" : "trailing");
  report(offset, width > 0 ? Math.abs(offset) / width : 0);
}

/** Every element that moves (for the transition and `will-change`). */
function movers(rt: RowRt): Array<HTMLElement | null> {
  return [rt.content, ...rt.buttons.leading, ...rt.buttons.trailing];
}

/** Turn the settle transition on (`ms > 0`) or off, and `will-change` with it. */
function setMotion(rt: RowRt, ms: number, dragging: boolean): void {
  const transition = ms > 0 ? `transform ${ms}ms ${SETTLE_EASING}` : "";
  for (const el of movers(rt)) {
    if (!el?.style) continue;
    el.style.transition = transition;
    el.style.willChange = ms > 0 || dragging ? "transform" : "";
  }
}

/** Glide to `offset`, then run `done`. */
function animateTo(rt: RowRt, offset: number, done?: () => void): void {
  if (rt.timer) clearTimeout(rt.timer);
  const ms = reducedMotion() ? 0 : SETTLE_MS;
  setMotion(rt, ms, false);
  paint(rt, offset);
  rt.timer = setTimeout(() => {
    rt.timer = null;
    setMotion(rt, 0, false);
    done?.();
  }, ms + 20);
}

/** Mark the full-swipe state (attribute + a haptic when it arms). */
function setFull(rt: RowRt, full: boolean): void {
  if (full === rt.full) return;
  rt.full = full;
  if (full) rt.root?.setAttribute?.("data-dnx-full-swipe", "");
  else rt.root?.removeAttribute?.("data-dnx-full-swipe");
  if (full && rt.props.haptics !== false && isNativeShell()) haptic("medium").catch(() => {});
}

/** Whether a row with these props reveals something under a rightward swipe. */
function hasLeading(props: SwipeableRowProps): boolean {
  return (props.leading?.length ?? 0) > 0 || props.leadingPanel !== undefined;
}

/** Become the one open row (closing the other) and listen for presses and scrolls outside. */
function becomeOpen(rt: RowRt): void {
  if (openRow && openRow !== rt) closeRow(openRow);
  openRow = rt;
  rt.unlistenOutside ??= listenOutside(rt);
}

/** Stop being the open row. */
function becomeClosed(rt: RowRt): void {
  if (openRow === rt) openRow = null;
  rt.unlistenOutside?.();
  rt.unlistenOutside = null;
}

/** Record which side is open: the one-open-row rule, the outside listeners, the callback. */
function setSide(rt: RowRt, side: SwipeableRowSide | null): void {
  if (side === rt.side) return;
  rt.side = side;
  // An open row (or one with leading actions) keeps the stack's back swipe off it.
  if (side !== null || hasLeading(rt.props)) rt.root?.setAttribute?.("data-dnx-no-back-swipe", "");
  else rt.root?.removeAttribute?.("data-dnx-no-back-swipe");
  if (side) becomeOpen(rt);
  else becomeClosed(rt);
  rt.props.onOpenChange?.(side);
}

/** Open `side` (animated). */
function openSide(rt: RowRt, side: SwipeableRowSide): void {
  const width = sideWidth(rt, side);
  if (width <= 0) return;
  setFull(rt, false);
  setSide(rt, side);
  animateTo(rt, side === "leading" ? width : -width);
}

/** Close the row (animated). */
function closeRow(rt: RowRt): void {
  setFull(rt, false);
  setSide(rt, null);
  animateTo(rt, 0);
}

/** A full swipe: slide the content off, run the side's first action, then come back. */
function runFull(rt: RowRt, side: SwipeableRowSide): void {
  const action = rt.props[side]?.[0];
  const width = geometry(rt).rowWidth;
  setSide(rt, null);
  animateTo(rt, side === "leading" ? width : -width, () => {
    action?.onPress();
    setFull(rt, false);
    // Still here (the action did not remove the row): come back closed.
    if (rt.root) animateTo(rt, 0);
  });
}

/** Settle a released (or taken-away) row. */
function settle(rt: RowRt, where: RowSettle): void {
  if (where === "full-leading") return runFull(rt, "leading");
  if (where === "full-trailing") return runFull(rt, "trailing");
  if (where === "closed") return closeRow(rt);
  openSide(rt, where);
}

/** While open: a press outside the row, or any scroll, closes it. */
function listenOutside(rt: RowRt): () => void {
  const doc = rt.root?.ownerDocument;
  if (!doc || typeof doc.addEventListener !== "function") return () => {};
  const onDown = (event: Event) => {
    const target = event.target as Node | null;
    if (target && rt.root?.contains?.(target)) return;
    closeRow(rt);
  };
  const onScroll = (event: Event) => {
    const target = event.target as Node | null;
    if (target && rt.root?.contains?.(target)) return;
    closeRow(rt);
  };
  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("scroll", onScroll, true);
  };
}

/** The pointer event fields the gesture reads. */
interface RowPointer {
  readonly pointerId: number;
  readonly pointerType?: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly timeStamp?: number;
  readonly isPrimary?: boolean;
  readonly target?: unknown;
}

/** Whether `target` is inside one of the row's action panels (a button press, not a drag). */
function inPanel(rt: RowRt, target: unknown): boolean {
  const node = target as Node | null;
  if (!node) return false;
  return [rt.panels.leading, rt.panels.trailing].some((p) => p?.contains?.(node) === true);
}

/** A pointer goes down: maybe the start of a swipe. */
function onDown(rt: RowRt, e: RowPointer): void {
  if (rt.drag || e.isPrimary === false || rt.props.disabled) return;
  if (e.pointerType === "mouse" && !rt.props.mouse) return;
  if (inPanel(rt, e.target)) return;
  const velocity = new VelocityTracker();
  velocity.add(e.timeStamp ?? Date.now(), e.clientX, e.clientY);
  rt.drag = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    base: rt.offset,
    locked: false,
    velocity,
  };
}

/** Whether a closed row has nothing to reveal in the direction `dx` moves. */
function nothingToReveal(rt: RowRt, dx: number): boolean {
  if (rt.side !== null) return false;
  const g = geometry(rt);
  return dx > 0 ? g.leading.width <= 0 : g.trailing.width <= 0;
}

/** Lock the drag horizontal, or give the touch up (a scroll, or a side with nothing to reveal). */
function tryLock(rt: RowRt, d: Drag, dx: number, dy: number): boolean {
  const axis = lockRowAxis(dx, dy);
  if (axis === "pending") return false;
  if (axis === "reject" || nothingToReveal(rt, dx)) {
    rt.drag = null;
    return false;
  }
  d.locked = true;
  d.base = rt.offset;
  if (rt.timer) clearTimeout(rt.timer);
  rt.timer = null;
  setMotion(rt, 0, true);
  if (openRow && openRow !== rt) closeRow(openRow);
  try {
    (rt.root as { setPointerCapture?(id: number): void } | null)?.setPointerCapture?.(d.id);
  } catch { /* the pointer is gone; the next event ends the drag */ }
  return true;
}

/** The finger moved. */
function onMove(rt: RowRt, e: RowPointer): void {
  const d = rt.drag;
  if (!d || e.pointerId !== d.id) return;
  d.velocity.add(e.timeStamp ?? Date.now(), e.clientX, e.clientY);
  const dx = e.clientX - d.x;
  if (!d.locked && !tryLock(rt, d, dx, e.clientY - d.y)) return;
  const g = geometry(rt);
  const offset = rowOffset(d.base + dx / Math.max(1, rt.props.friction ?? 1), g);
  setFull(rt, isFullSwipe(offset, g));
  paint(rt, offset);
}

/** The finger lifted: settle a swipe; a tap on an open row closes it. */
function onUp(rt: RowRt, e: RowPointer): void {
  const d = rt.drag;
  if (!d || e.pointerId !== d.id) return;
  rt.drag = null;
  if (d.locked) {
    rt.suppressClick = true;
    settle(rt, settleRow(rt.offset, d.velocity.velocity().x, geometry(rt)));
  } else if (rt.side !== null) {
    rt.suppressClick = true;
    closeRow(rt);
  }
}

/** The touch was taken away (a scroll claimed it): settle without a full swipe. */
function onCancel(rt: RowRt, e: RowPointer): void {
  const d = rt.drag;
  if (!d || e.pointerId !== d.id) return;
  rt.drag = null;
  if (!d.locked) return;
  const where = settleRow(rt.offset, 0, geometry(rt));
  settle(rt, where === "full-leading" ? "leading" : where === "full-trailing" ? "trailing" : where);
}

/** A click right after a swipe (or the tap that closed the row) does not reach the content. */
function onClickCapture(rt: RowRt, e: Event): void {
  if (!rt.suppressClick) return;
  rt.suppressClick = false;
  if (inPanel(rt, e.target)) return;
  e.preventDefault();
  e.stopPropagation();
}

/** Bind the gesture and the keyboard to the row element. */
function useRowListeners(rt: RowRt): void {
  useEffect(() => {
    const root = rt.root;
    if (!root || typeof root.addEventListener !== "function") return;
    const offDrag = listenAll(root, {
      pointerdown: (e: RowPointer) => onDown(rt, e),
      pointermove: (e: RowPointer) => onMove(rt, e),
      pointerup: (e: RowPointer) => onUp(rt, e),
      pointercancel: (e: RowPointer) => onCancel(rt, e),
      keydown: (e: KeyboardEvent) => {
        if (e.key === "Escape" && rt.side !== null) closeRow(rt);
      },
      focusout: (e: FocusEvent) => {
        const next = e.relatedTarget as Node | null;
        if (rt.side !== null && !(next && root.contains(next))) closeRow(rt);
      },
    });
    const onClick = (e: Event) => onClickCapture(rt, e);
    root.addEventListener("click", onClick, true);
    const unobserve = [root, rt.panels.leading, rt.panels.trailing]
      .filter((el): el is HTMLElement => el !== null)
      .map(observeWidth);
    return () => {
      offDrag();
      root.removeEventListener("click", onClick, true);
      for (const off of unobserve) off();
      if (rt.timer) clearTimeout(rt.timer);
      rt.unlistenOutside?.();
      rt.unlistenOutside = null;
      if (openRow === rt) openRow = null;
    };
  }, []);
}

/** An action button's box: full-row wide, parked outside the row until it is revealed. */
function buttonStyle(
  side: SwipeableRowSide,
  action: SwipeAction,
  zIndex: number,
): Record<string, string | number> {
  const leading = side === "leading";
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: "100%",
    display: "flex",
    alignItems: "stretch",
    justifyContent: leading ? "flex-end" : "flex-start",
    margin: 0,
    padding: 0,
    border: 0,
    font: "inherit",
    cursor: "pointer",
    zIndex,
    background: action.background ?? TONES[action.tone ?? "neutral"],
    color: action.color ?? "#fff",
    transform: leading ? "translate3d(-100%, 0, 0)" : "translate3d(100%, 0, 0)",
  };
}

/** One action button: a full-row-wide box whose label sits at its inner end. */
function actionButton(
  rt: RowRt,
  side: SwipeableRowSide,
  action: SwipeAction,
  i: number,
  count: number,
): VNode {
  const width = rt.props.actionWidth ?? 74;
  return h(
    "button",
    {
      key: action.key ?? action.label,
      type: "button",
      ref: (el: HTMLElement | null) => void (rt.buttons[side][i] = el),
      "data-dnx-swipe-action": side,
      "aria-label": action.accessibilityLabel ?? action.label,
      onClick: () => {
        action.onPress();
        if (rt.props.closeOnAction !== false) closeRow(rt);
      },
      onFocus: () => {
        if (rt.side !== side) openSide(rt, side);
      },
      style: buttonStyle(side, action, count - i),
    },
    h(
      "span",
      {
        style: {
          width: `${width}px`,
          flex: "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "4px",
          fontSize: "13px",
          fontWeight: "500",
        },
      },
      action.icon ?? null,
      action.label,
    ),
  );
}

/** One side's panel: its action buttons, or the custom panel. */
function sidePanel(rt: RowRt, side: SwipeableRowSide): VNode | null {
  const actions = rt.props[side] ?? [];
  const custom = rt.props[`${side}Panel`];
  if (actions.length === 0 && custom === undefined) return null;
  rt.buttons[side].length = actions.length;
  const ref = (el: HTMLElement | null) => void (rt.panels[side] = el);
  if (actions.length === 0) {
    return h("div", {
      ref,
      "data-dnx-swipe-actions": side,
      style: {
        position: "absolute",
        top: 0,
        bottom: 0,
        [side === "leading" ? "left" : "right"]: 0,
        display: "flex",
        zIndex: 0,
      },
    }, custom);
  }
  return h(
    "div",
    {
      ref,
      role: "group",
      "aria-label": side === "leading" ? "Leading actions" : "Trailing actions",
      "data-dnx-swipe-actions": side,
      style: { position: "absolute", inset: 0, zIndex: 0 },
    },
    ...actions.map((a, i) => actionButton(rt, side, a, i, actions.length)),
  );
}

/** A fresh runtime for a mounting row. */
function createRuntime(props: SwipeableRowProps): RowRt {
  return {
    props,
    root: null,
    content: null,
    panels: { leading: null, trailing: null },
    buttons: { leading: [], trailing: [] },
    offset: 0,
    side: null,
    full: false,
    drag: null,
    suppressClick: false,
    timer: null,
    unlistenOutside: null,
  };
}

/**
 * A row that swipes sideways to reveal actions; see the module docs. A client component:
 * render it from a `"use client"` file. Inside a `VirtualList`, render one per row.
 *
 * @example
 * ```tsx
 * "use client";
 * import { SwipeableRow, VirtualList } from "denext";
 *
 * export function Threads({ threads }: { threads: Thread[] }) {
 *   return (
 *     <VirtualList
 *       data={threads}
 *       renderItem={(item) => (
 *         <SwipeableRow
 *           leading={[{ label: "Unread", tone: "accent", onPress: () => markUnread(item.id) }]}
 *           trailing={[
 *             { label: "Archive", tone: "warning", onPress: () => archive(item.id) },
 *             { label: "Mute", onPress: () => mute(item.id) },
 *           ]}
 *         >
 *           <ThreadRow thread={item} />
 *         </SwipeableRow>
 *       )}
 *     />
 *   );
 * }
 * ```
 */
export function SwipeableRow(props: SwipeableRowProps): VNode {
  const ref = useRef<RowRt | null>(null);
  const rt = ref.current ??= createRuntime(props);
  rt.props = props;
  useRowListeners(rt);
  useEffect(() => {
    const rowRef = rt.props.rowRef;
    rowRef?.({
      open: (side) => openSide(rt, side),
      close: () => closeRow(rt),
      get openSide() {
        return rt.side;
      },
    });
    return () => rowRef?.(null);
  }, []);
  const claims = hasLeading(props);
  return h(
    props.as ?? "div",
    {
      ref: (el: HTMLElement | null) => void (rt.root = el),
      "data-dnx-swipe-row": "",
      "data-dnx-no-back-swipe": claims ? "" : undefined,
      className: props.className,
      style: {
        position: "relative",
        overflow: "hidden",
        touchAction: "pan-y",
        ...(props.style ?? {}),
      },
    },
    sidePanel(rt, "leading"),
    sidePanel(rt, "trailing"),
    h("div", {
      ref: (el: HTMLElement | null) => void (rt.content = el),
      "data-dnx-swipe-content": "",
      style: {
        position: "relative",
        zIndex: 1,
        background: "var(--dnx-swipe-row-bg, Canvas)",
        ...(props.contentStyle ?? {}),
      },
    }, props.children),
  );
}
