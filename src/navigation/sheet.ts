/**
 * `<Sheet>`: a bottom sheet with detents, a grabber, drag between detents with velocity,
 * dismissal by dragging down or tapping the backdrop, a focus trap, and keyboard avoidance.
 *
 * - **Detents**: `"medium"`, `"large"`, `"fit"` (the content's height) or a number (a fraction
 *   of the available height up to `1`, else px). The sheet rests at one of them.
 * - **Nested scrolling**: until the sheet is at its largest detent, a drag on its content moves
 *   the sheet (it expands before its content scrolls, as on iOS). At the largest detent the
 *   content scrolls, and dragging down from the content's top moves the sheet again.
 * - **Accessibility**: `role="dialog"` and `aria-modal`, the rest of the page is `inert` while
 *   it is open, Tab stays inside, Escape dismisses, and focus returns where it was. With
 *   `prefers-reduced-motion` it appears and leaves without sliding.
 * - **Keyboard**: pass `keyboard` (e.g. `useKeyboard()` from `denext/mobile`) or let it read
 *   the visual viewport; the sheet rises above the on-screen keyboard.
 * - **Android back**: in the native shell, the back button or gesture dismisses it first.
 *
 * The drag writes only the panel's `transform`; it never writes a scroll position.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import { createPortal } from "../client/reconciler.ts";
import { clamp, resolveDetents, rubberband, snapSheet, VelocityTracker } from "./gesture.ts";
import { listenAll, type ListenerTarget } from "./listen.ts";
import { prefersReducedMotion } from "./animation.ts";
import { useBackHandler } from "../mobile/back-handler.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import type { SheetDetent } from "./types.ts";

/** Props of {@linkcode Sheet}. */
export interface SheetProps {
  /** Whether the sheet is open. Closing it (`false`) slides it away first. */
  readonly open: boolean;
  /**
   * Called with `false` when the user dismisses the sheet (drag down, backdrop, Escape); set
   * `open` from it.
   */
  readonly onOpenChange?: (open: boolean) => void;
  /** Called once the sheet has finished leaving (after its exit animation). */
  readonly onExitComplete?: () => void;
  /** The heights it can rest at (default `["large"]`). */
  readonly detents?: readonly SheetDetent[];
  /** The detent it opens at, as an index into `detents` (default `0`). */
  readonly initialDetent?: number;
  /** Called with the detent index whenever the sheet settles at a new one. */
  readonly onDetentChange?: (index: number) => void;
  /** Whether to draw the grabber (default `true`). It also cycles the detents on click. */
  readonly grabber?: boolean;
  /** Whether the user can dismiss it (default `true`). */
  readonly dismissible?: boolean;
  /** Whether to dim the page behind it (default `true`); tapping it dismisses. */
  readonly backdrop?: boolean;
  /**
   * The on-screen keyboard (`useKeyboard()` from `denext/mobile` fits). Without it the sheet
   * reads the visual viewport.
   */
  readonly keyboard?: { readonly visible: boolean; readonly height: number } | null;
  /** The accessible name. */
  readonly "aria-label"?: string;
  /** The id of the element naming it. */
  readonly "aria-labelledby"?: string;
  /** Where it renders: `document.body` by default; `false` renders it in place. */
  readonly portal?: Element | false;
  /** Extra style for the panel. */
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  /** The content. */
  readonly children?: VNodeChildren;
}

/** Where the sheet is in its life: shown, sliding away, or gone. */
type Phase = "closed" | "open" | "closing";

/** The gap between a `"large"` sheet and the top of the viewport, in px. */
const TOP_GAP = 10;
/** The slide's length and curve. */
const DURATION = 320;
const EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/** Focusable descendants, for the trap. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/** The viewport height and the keyboard's height as the visual viewport reports it. */
function viewportMetrics(): { height: number; keyboard: number } {
  const g = globalThis as {
    innerHeight?: number;
    visualViewport?: { height: number; offsetTop: number } | null;
  };
  const height = typeof g.innerHeight === "number" && g.innerHeight > 0 ? g.innerHeight : 800;
  const vv = g.visualViewport;
  const keyboard = vv ? Math.max(0, Math.round(height - vv.height - vv.offsetTop)) : 0;
  return { height, keyboard: keyboard > 80 ? keyboard : 0 };
}

/** The pointer-drag state of a sheet. */
interface DragState {
  readonly id: number;
  readonly startY: number;
  readonly startHeight: number;
  /** `true` once the drag moves the sheet; `false` while it may still be a content scroll. */
  sheet: boolean;
  readonly inScroller: boolean;
  height: number;
  readonly velocity: VelocityTracker;
}

/** What {@linkcode attachSheetDrag} needs from the sheet. */
export interface SheetDragHost {
  /** The heights (ascending) and the current resting height. */
  metrics(): { heights: readonly number[]; height: number; dismissible: boolean };
  /** Whether the content scroller is at its top (and so a downward drag moves the sheet). */
  scrollerAtTop(): boolean;
  /** Whether the sheet is at its largest detent (its content may scroll). */
  atLargest(): boolean;
  /** Draw the sheet at `height` px (during the drag). */
  follow(height: number): void;
  /** The drag ended: settle at a detent index, or dismiss. */
  release(result: number | "dismiss", fromHeight: number): void;
}

/** The pointer event fields the drag reads. */
interface PointerLike {
  readonly pointerId: number;
  readonly clientY: number;
  readonly timeStamp?: number;
  readonly target?: unknown;
  readonly button?: number;
}

/** The sheet's panel or scroller, as the drag uses it. */
interface DragTarget extends ListenerTarget {
  contains?(node: unknown): boolean;
}

/** A pointer-down's drag, or `null` for a non-primary button. */
function startDrag(
  e: PointerLike,
  host: SheetDragHost,
  scroller: DragTarget | null,
): DragState | null {
  if (e.button !== undefined && e.button !== 0) return null;
  const { height } = host.metrics();
  const inScroller = !!scroller?.contains?.(e.target);
  const velocity = new VelocityTracker();
  velocity.add(e.timeStamp ?? Date.now(), 0, e.clientY);
  // Below the largest detent every drag moves the sheet (it expands before scrolling).
  const sheet = !(inScroller && host.atLargest());
  return {
    id: e.pointerId,
    startY: e.clientY,
    startHeight: height,
    sheet,
    inScroller,
    height,
    velocity,
  };
}

/**
 * Advance `drag` to a pointer move; returns `false` once the drag turned out to be the
 * content's own scroll (so it is dropped).
 */
function moveDrag(drag: DragState, e: PointerLike, host: SheetDragHost): boolean {
  const dy = e.clientY - drag.startY;
  drag.velocity.add(e.timeStamp ?? Date.now(), 0, e.clientY);
  if (!drag.sheet) {
    // At the largest detent, over the content: a downward drag from the top moves the sheet;
    // anything else is the content's own scroll.
    if (Math.abs(dy) < 6) return true;
    if (!(dy > 0 && host.scrollerAtTop())) return false;
    drag.sheet = true;
  }
  const { heights } = host.metrics();
  const max = heights[heights.length - 1] ?? drag.startHeight;
  const next = drag.startHeight - dy;
  drag.height = Math.max(0, next > max ? max + rubberband(next - max, max) : next);
  host.follow(drag.height);
  return true;
}

/**
 * Wire the sheet's drag to `panel` (and its content `scroller`): pointer events move the sheet,
 * a non-passive `touchmove` on the scroller cancels the browser's own pan while the sheet is
 * the one moving. Returns the detach function. Exported for testing.
 */
export function attachSheetDrag(
  panel: DragTarget,
  scroller: DragTarget | null,
  host: SheetDragHost,
): () => void {
  let drag: DragState | null = null;
  const mine = (e: PointerLike) => drag !== null && e.pointerId === drag.id;
  /** End the drag; a sheet drag settles where `settle` says. */
  const end = (settle: (d: DragState) => number | "dismiss") => {
    const ended = drag!;
    drag = null;
    if (ended.sheet) host.release(settle(ended), ended.height);
  };
  const offPanel = listenAll(panel, {
    pointerdown: (e: PointerLike) => {
      if (!drag) drag = startDrag(e, host, scroller);
    },
    pointermove: (e: PointerLike) => {
      if (mine(e) && !moveDrag(drag!, e, host)) drag = null;
    },
    pointerup: (e: PointerLike) => {
      if (!mine(e)) return;
      const { heights, dismissible } = host.metrics();
      end((d) => snapSheet(heights, d.height, d.velocity.velocity().y, dismissible));
    },
    pointercancel: (e: PointerLike) => {
      if (!mine(e)) return;
      const { heights, height } = host.metrics();
      end(() => Math.max(0, heights.indexOf(height)));
    },
  });
  // While the sheet (not the content) is moving, the browser must not pan the content.
  const offScroller = scroller
    ? listenAll(scroller, {
      touchmove: (e: { cancelable?: boolean; preventDefault?(): void }) => {
        if (drag?.sheet && e.cancelable !== false) e.preventDefault?.();
      },
    })
    : () => {};
  return () => {
    offPanel();
    offScroller();
  };
}

/** The open sheets' roots, newest last (the newest one is the modal layer). */
let openSheets: Element[] | null = null;

/**
 * Mark every sibling of `root` under `<body>` inert (and hidden from assistive technology)
 * while it is open; returns the undo, which releases only what this call set.
 */
function inertSiblings(root: Element): () => void {
  const touched: Element[] = [];
  for (const el of Array.from(root.parentElement?.children ?? [])) {
    if (el === root || el.hasAttribute("inert") || el.tagName === "SCRIPT") continue;
    el.setAttribute("inert", "");
    touched.push(el);
  }
  (openSheets ??= []).push(root);
  return () => {
    for (const el of touched) el.removeAttribute("inert");
    openSheets = (openSheets ?? []).filter((r) => r !== root);
  };
}

/**
 * Where Tab (or Shift+Tab) must move focus to stay inside the sheet: the first item after the
 * last, the last before the first (or from the panel itself), the panel when it has nothing
 * focusable. `null` when the browser's own move stays inside. Exported for testing.
 */
export function trapFocusTarget<T>(
  items: readonly T[],
  active: T | null | undefined,
  shiftKey: boolean,
  panel: T,
): T | null {
  if (items.length === 0) return panel;
  const first = items[0];
  const last = items[items.length - 1];
  if (shiftKey && (active === first || active === panel)) return last;
  if (!shiftKey && active === last) return first;
  if (active !== panel && !items.includes(active as T)) return shiftKey ? last : first;
  return null;
}

/** Keep Tab inside `panel`. */
function trapTab(panel: HTMLElement, event: KeyboardEvent): void {
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
  const active = panel.ownerDocument?.activeElement as HTMLElement | null;
  const target = trapFocusTarget(items, active, event.shiftKey, panel);
  if (!target) return;
  event.preventDefault();
  target.focus?.();
}

/** The Web Animations slice {@linkcode Sheet} uses. */
interface Animatable {
  animate(
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ): { finished: Promise<unknown>; cancel(): void };
}

/** The sheet's elements. */
interface SheetEls {
  root: HTMLElement | null;
  panel: HTMLElement | null;
  scroll: HTMLElement | null;
  content: HTMLElement | null;
  backdrop: HTMLElement | null;
}

/** The sheet's geometry this render. */
interface Geometry {
  readonly heights: number[];
  readonly index: number;
  readonly height: number;
  readonly max: number;
  readonly atLargest: boolean;
  readonly dismissible: boolean;
  readonly keyboard: number;
}

/** The backdrop's opacity for a sheet `h` px tall. */
function dimFor(h: number, g: Geometry): number {
  return clamp(h / Math.max(1, g.heights[0]), 0, 1);
}

/** Draw the panel at `h` px visible (and the backdrop at the matching dim). */
function placeSheet(els: SheetEls, g: Geometry, h: number): void {
  if (els.panel?.style) els.panel.style.transform = `translateY(${Math.max(0, g.max - h)}px)`;
  if (els.backdrop?.style) els.backdrop.style.opacity = String(dimFor(h, g));
}

/** Slide the panel from `from` px visible to rest at `to`, then run `done`. */
function slideSheet(els: SheetEls, g: Geometry, from: number, to: number, done?: () => void): void {
  placeSheet(els, g, to);
  const panel = els.panel as (HTMLElement & Partial<Animatable>) | null;
  if (!panel || typeof panel.animate !== "function" || Math.abs(from - to) <= 0.5) {
    done?.();
    return;
  }
  const reduced = prefersReducedMotion();
  const timing = { duration: reduced ? 150 : DURATION, easing: EASING };
  const frames = reduced ? [{ opacity: from > to ? 1 : 0 }, { opacity: from > to ? 0 : 1 }] : [
    { transform: `translateY(${Math.max(0, g.max - from)}px)` },
    { transform: `translateY(${Math.max(0, g.max - to)}px)` },
  ];
  const anim = panel.animate(frames, timing);
  (els.backdrop as Partial<Animatable> | null)?.animate?.(
    [{ opacity: dimFor(from, g) }, { opacity: dimFor(to, g) }],
    timing,
  );
  anim.finished.then(() => done?.(), () => done?.());
}

/** The detent heights and where the sheet rests, from the props and the viewport. */
function useGeometry(props: SheetProps, detent: number, content: number | undefined): Geometry {
  const [viewport, setViewport] = useState(viewportMetrics);
  const tracking = props.open;
  useEffect(() => {
    if (!tracking || typeof globalThis.addEventListener !== "function") return;
    const update = () => setViewport(viewportMetrics());
    const vv = (globalThis as { visualViewport?: EventTarget | null }).visualViewport;
    globalThis.addEventListener("resize", update);
    vv?.addEventListener("resize", update);
    return () => {
      globalThis.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
    };
  }, [tracking]);
  const kb = props.keyboard;
  const keyboard = kb ? (kb.visible ? kb.height : 0) : viewport.keyboard;
  const available = Math.max(0, viewport.height - keyboard - TOP_GAP);
  const heights = resolveDetents(props.detents ?? ["large"], available, content);
  const index = clamp(detent, 0, heights.length - 1);
  return {
    heights,
    index,
    height: heights[index],
    max: heights[heights.length - 1],
    atLargest: index === heights.length - 1,
    dismissible: props.dismissible !== false,
    keyboard,
  };
}

/** Enter (after measuring a `"fit"` detent) and exit animations. */
function useSheetMotion(
  phase: Phase,
  mounted: boolean,
  els: SheetEls,
  geo: { current: Geometry },
  fit: { needed: boolean; set: (h: number) => void; grabber: boolean },
  onClosed: () => void,
): { current: boolean } {
  const entered = useRef(false);
  const dragged = useRef(false);
  useLayoutEffect(() => {
    if (phase !== "open" || !mounted || !els.panel) return;
    if (fit.needed) {
      const natural = els.content?.offsetHeight ?? 0;
      fit.set(natural > 0 ? natural + (fit.grabber ? 21 : 0) : 0);
    } else if (!entered.current) {
      entered.current = true;
      slideSheet(els, geo.current, 0, geo.current.height);
    } else placeSheet(els, geo.current, geo.current.height);
  });
  useLayoutEffect(() => {
    if (phase !== "closing") return;
    entered.current = false;
    // A drag that dismissed the sheet already carried it off.
    const from = dragged.current ? 0 : geo.current.height;
    dragged.current = false;
    slideSheet(els, geo.current, from, 0, onClosed);
  }, [phase]);
  return dragged;
}

/** While open: the rest of the page inert, focus inside, Tab trapped, Escape dismisses. */
function useModality(
  phase: Phase,
  mounted: boolean,
  els: SheetEls,
  inPlace: boolean,
  dismiss: () => void,
): void {
  useEffect(() => {
    const { root, panel } = els;
    if (phase !== "open" || !root || !panel || typeof document === "undefined") return;
    const previous = document.activeElement as HTMLElement | null;
    const release = inPlace ? () => {} : inertSiblings(root);
    const first = panel.querySelector?.(FOCUSABLE) as HTMLElement | null | undefined;
    (first ?? panel).focus?.({ preventScroll: true } as FocusOptions);
    const onKey = (event: KeyboardEvent) => {
      if (openSheets && openSheets.length > 0 && openSheets[openSheets.length - 1] !== root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      } else if (event.key === "Tab") trapTab(panel, event);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      release();
      previous?.focus?.({ preventScroll: true } as FocusOptions);
    };
  }, [phase, mounted]);
}

/** The panel's style. */
function panelStyle(g: Geometry, extra: SheetProps["style"]): Record<string, unknown> {
  return {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: g.keyboard,
    marginInline: "auto",
    maxWidth: 700,
    height: g.max,
    transform: "translateY(100%)",
    display: "flex",
    flexDirection: "column",
    background: "var(--dnx-sheet-bg, Canvas)",
    color: "var(--dnx-sheet-fg, CanvasText)",
    borderRadius: "12px 12px 0 0",
    boxShadow: "0 -2px 24px rgba(0, 0, 0, 0.18)",
    pointerEvents: "auto",
    touchAction: g.atLargest ? "pan-y" : "none",
    outline: "none",
    overflow: "hidden",
    ...(extra ?? {}),
  };
}

/** The grabber: a pill that also cycles the detents (a button, so keyboards reach it). */
function grabberButton(onClick: () => void): VNode {
  return h("button", {
    type: "button",
    "aria-label": "Sheet grabber",
    "data-dnx-sheet-grabber": "",
    onClick,
    style: {
      flex: "none",
      alignSelf: "center",
      width: 36,
      height: 5,
      margin: "8px 0",
      padding: 0,
      border: 0,
      borderRadius: 3,
      background: "rgba(127, 127, 127, 0.5)",
      touchAction: "none",
    },
  });
}

/** Where the sheet renders: `document.body`, the given element, or in place. */
function portalTarget(portal: SheetProps["portal"]): Element | null {
  if (portal !== undefined) return portal || null;
  return typeof document !== "undefined" ? document.body : null;
}

/** What the sheet's render and drag need from the component. */
interface SheetCtl {
  readonly props: SheetProps;
  readonly phase: Phase;
  readonly els: SheetEls;
  readonly geo: { current: Geometry };
  readonly dismiss: () => void;
  readonly settleAt: (index: number, from: number) => void;
  readonly dragged: { current: boolean };
}

/** The drag, attached while the sheet is open. */
function useSheetDrag(c: SheetCtl, mounted: boolean): void {
  const { els, geo } = c;
  useEffect(() => {
    if (c.phase !== "open" || !els.panel) return;
    return attachSheetDrag(els.panel, els.scroll, {
      metrics: () => geo.current,
      scrollerAtTop: () => (els.scroll?.scrollTop ?? 0) <= 0,
      atLargest: () => geo.current.atLargest,
      follow: (h) => placeSheet(els, geo.current, h),
      release: (result, from) => {
        if (result !== "dismiss") return c.settleAt(result, from);
        c.dragged.current = true;
        slideSheet(els, geo.current, from, 0);
        c.dismiss();
      },
    });
  }, [c.phase, mounted, geo.current.index]);
}

/** The backdrop: dims the page; a tap dismisses. */
function backdropEl(c: SheetCtl, set: (key: keyof SheetEls) => (el: HTMLElement | null) => void) {
  return h("div", {
    ref: set("backdrop"),
    "data-dnx-sheet-backdrop": "",
    "aria-hidden": "true",
    onClick: c.dismiss,
    style: {
      position: "absolute",
      inset: 0,
      background: "rgba(0, 0, 0, 0.4)",
      pointerEvents: c.phase === "open" ? "auto" : "none",
    },
  });
}

/** The sheet's DOM: the fixed layer, the backdrop, the dialog panel with grabber and content. */
function sheetTree(c: SheetCtl): VNode {
  const { props, els } = c;
  const g = c.geo.current;
  const set = (key: keyof SheetEls) => (el: HTMLElement | null) => void (els[key] = el);
  const cycle = () => c.settleAt((g.index + 1) % g.heights.length, g.height);
  const scroll = {
    flex: 1,
    minHeight: 0,
    overflowY: g.atLargest ? "auto" : "hidden",
    overscrollBehavior: "contain",
    touchAction: g.atLargest ? "pan-y" : "none",
  };
  return h(
    "div",
    {
      ref: set("root"),
      "data-dnx-sheet": "",
      style: { position: "fixed", inset: 0, zIndex: 1000, pointerEvents: "none" },
    },
    props.backdrop === false ? null : backdropEl(c, set),
    h(
      "div",
      {
        ref: set("panel"),
        role: "dialog",
        "aria-modal": "true",
        "aria-label": props["aria-label"],
        "aria-labelledby": props["aria-labelledby"],
        tabIndex: -1,
        "data-dnx-sheet-panel": "",
        "data-detent": String(g.index),
        style: panelStyle(g, props.style),
      },
      props.grabber === false ? null : grabberButton(cycle),
      h(
        "div",
        { ref: set("scroll"), "data-dnx-sheet-scroll": "", style: scroll },
        h("div", { ref: set("content"), "data-dnx-sheet-content": "" }, props.children),
      ),
    ),
  );
}

/** Open, still sliding away after `open` went false, or gone. */
function sheetPhase(open: boolean, present: boolean): Phase {
  if (open) return "open";
  return present ? "closing" : "closed";
}

/** The user's dismissal, and settling at a detent. */
function sheetActions(
  els: SheetEls,
  geo: { current: Geometry },
  latest: { current: SheetProps },
  setDetent: (index: number) => void,
): { dismiss: () => void; settleAt: (index: number, from: number) => void } {
  return {
    dismiss: () => {
      if (geo.current.dismissible) latest.current.onOpenChange?.(false);
    },
    settleAt: (index, from) => {
      slideSheet(els, geo.current, from, geo.current.heights[index]);
      if (index === geo.current.index) return;
      setDetent(index);
      latest.current.onDetentChange?.(index);
    },
  };
}

/** Android's back button / gesture closes the open sheet first (in the native shell). */
function useSheetBack(phase: Phase, geo: { current: Geometry }, dismiss: () => void): void {
  useBackHandler(() => {
    if (!geo.current.dismissible) return false;
    dismiss();
    return true;
  }, phase === "open" && nativePlatform() === "android");
}

/** Where the sheet's tree goes: a portal, or in place. */
function placed(tree: VNode, portal: SheetProps["portal"]): VNode {
  const target = portalTarget(portal);
  return target ? createPortal(tree, target) as VNode : tree;
}

/** The sheet's React state: mounted (client), shown, its detent and its measured content. */
function useSheetState(props: SheetProps) {
  const [mounted, setMounted] = useState(false);
  const [present, setPresent] = useState(props.open);
  const [detent, setDetent] = useState(() => Math.max(0, props.initialDetent ?? 0));
  const [content, setContent] = useState<number | undefined>(undefined);
  useEffect(() => setMounted(true), []);
  useEffect(() => void (props.open && setPresent(true)), [props.open]);
  return { mounted, present, setPresent, detent, setDetent, content, setContent };
}

/** Whether a `"fit"` detent still needs its content measured. */
function fitOf(props: SheetProps, content: number | undefined, set: (h: number) => void) {
  const needed = (props.detents ?? []).includes("fit") && content === undefined;
  return { needed, set, grabber: props.grabber !== false };
}

/**
 * A bottom sheet. Controlled by `open`; the user's dismissal calls `onOpenChange(false)`.
 *
 * @example
 * ```tsx
 * "use client";
 * import { useState } from "denext";
 * import { Sheet } from "denext/navigation";
 *
 * export function Filters() {
 *   const [open, setOpen] = useState(false);
 *   return (
 *     <>
 *       <button type="button" onClick={() => setOpen(true)}>Filters</button>
 *       <Sheet open={open} onOpenChange={setOpen} detents={["medium", "large"]} aria-label="Filters">
 *         <FilterForm />
 *       </Sheet>
 *     </>
 *   );
 * }
 * ```
 */
export function Sheet(props: SheetProps): VNode {
  const st = useSheetState(props);
  const phase = sheetPhase(props.open, st.present);
  const els = useRef<SheetEls>({
    root: null,
    panel: null,
    scroll: null,
    content: null,
    backdrop: null,
  }).current;
  const latest = useRef(props);
  latest.current = props;
  const geo = useRef<Geometry>(null as unknown as Geometry);
  geo.current = useGeometry(props, st.detent, st.content);

  const { dismiss, settleAt } = sheetActions(els, geo, latest, st.setDetent);
  const onClosed = () => {
    st.setPresent(false);
    latest.current.onExitComplete?.();
  };
  const fit = fitOf(props, st.content, st.setContent);
  const dragged = useSheetMotion(phase, st.mounted, els, geo, fit, onClosed);
  const ctl: SheetCtl = { props, phase, els, geo, dismiss, settleAt, dragged };
  useModality(phase, st.mounted, els, props.portal === false, dismiss);
  useSheetBack(phase, geo, dismiss);
  useSheetDrag(ctl, st.mounted);

  const hidden = phase === "closed" || !st.mounted;
  return hidden ? null as unknown as VNode : placed(sheetTree(ctl), props.portal);
}
