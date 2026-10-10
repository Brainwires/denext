/**
 * The stack's view, independent of any router: it draws a list of screens (bottom first),
 * keeps the ones below the top mounted but hidden with `<Activity>` (state, DOM and scroll
 * position survive; effects are torn down), animates a push or a pop, and runs the two back
 * gestures — the iOS edge swipe that follows the finger and Android's predictive back — plus
 * the native-style header and the modal presentations (`"modal"`, `"formSheet"` as a
 * {@linkcode Sheet}, `"transparentModal"`).
 *
 * The owner decides what the screens are and does the popping: `StackLayout` binds it to the
 * App Router's URL history; the React Navigation adapter binds it to a navigator's state.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "../runtime/hooks.ts";
import { Activity } from "../runtime/react-extras.ts";
import { type BackProgressEvent, onBackProgress, useBackHandler } from "../mobile/back-handler.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { haptic } from "../mobile/haptics.ts";
import {
  detectPlatform,
  type GestureStyle,
  playFrames,
  predictiveFrame,
  stackFrames,
  swipeFrame,
} from "./animation.ts";
import { EdgeSwipeTracker, FULL_SCREEN_SWIPE, type SwipeRelease } from "./gesture.ts";
import { LARGE_TITLE_COLLAPSE, LargeTitle, StackHeader } from "./header.ts";
import { Sheet } from "./sheet.ts";
import { navigationContexts } from "./context.ts";
import { useRouteAnnouncer } from "./announcer.ts";
import { listenAll, type ListenerTarget } from "./listen.ts";
import { type NavigationThemeProps, themeAttributes, useNavigationTheme } from "./theme.ts";
import type { NavigationPlatform, ScreenOptions, StackViewEntry } from "./types.ts";

/**
 * How a change of `entries` animates: `"auto"` (the view animates it), `"external"` (a View
 * Transition the owner started animates it), `"none"`.
 */
export type StackViewAnimate = "auto" | "external" | "none";

/**
 * Props of {@linkcode StackView}. The theme props (`theme`, `material`, `accentColor`) pick the
 * platform look: see {@linkcode NavigationThemeProps}.
 */
export interface StackViewProps extends NavigationThemeProps {
  /** The screens, bottom first. */
  readonly entries: readonly StackViewEntry[];
  /**
   * Pop so the screen at `toIndex` is on top. `animated: false` when a gesture already
   * animated it off (the next change must not animate again).
   */
  readonly onPop: (toIndex: number, how: { animated: boolean }) => void;
  /** How the change in this render's `entries` animates (default `"auto"`). */
  readonly animate?: StackViewAnimate;
  /** The look (default: detected from the user agent). */
  readonly platform?: NavigationPlatform;
  /** Options every screen starts from. */
  readonly screenOptions?: ScreenOptions;
  /** Whether the iOS edge swipe pops (default: `true` on the iOS look). */
  readonly swipeBack?: boolean;
  /**
   * Whether the back swipe may start anywhere on the screen, not only at its left edge
   * (default `false`; a screen's `fullScreenGestureEnabled` option overrides it). The
   * full-screen swipe locks only on a clearly horizontal movement (at least 1.4 × as
   * horizontal as vertical) and a fling commits only past 72 px; it yields to text fields,
   * horizontal scrollers and any element marked `data-dnx-no-back-swipe` (a
   * `SwipeableRow` with leading actions, or an open one, marks itself).
   */
  readonly fullScreenSwipe?: boolean;
  /** A light haptic when a swipe commits (default `false`). */
  readonly swipeHaptic?: boolean;
  /** Extra style for the container. */
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  /** A class for the container. */
  readonly className?: string;
  /** Receives the container element. */
  readonly containerRef?: (el: HTMLElement | null) => void;
  /** Receives the stack's handle for a tab bar (pop to root, scroll to top). */
  readonly onHandle?: (handle: StackViewHandle | null) => void;
  /**
   * Announce the new top screen's title to screen readers on a push or pop (an
   * `aria-live` region; the `title` option, else the document title). Default `true`.
   */
  readonly announceRouteChanges?: boolean;
  /**
   * Lay each screen's content out as React Native does (default `false`): the screen body (and
   * a `formSheet`'s) is a flex column the content fills, so a `flex: 1` view takes the screen's
   * height and a list inside scrolls (and virtualizes) itself, instead of the body scrolling a
   * page as tall as its content. React Navigation's and expo-router's stacks set it.
   */
  readonly fillScreens?: boolean;
}

/** What {@linkcode StackView} lets its owner do. */
export interface StackViewHandle {
  /** The section element of the screen `id`. */
  section(id: string): HTMLElement | null;
  /** Scroll the top screen to its top (smoothly); `false` when it already was. */
  scrollToTop(): boolean;
}

/** A change between two renders' entries. */
export interface StackDiff {
  readonly kind: "push" | "pop";
  /** The screen that was on top. */
  readonly fromId: string;
  /** The screen now on top. */
  readonly toId: string;
  /** The screens a pop removed (top last). */
  readonly popped: readonly StackViewEntry[];
}

/** How `next` differs from `prev` at the top: a push, a pop, or nothing to animate (`null`). */
export function diffEntries(
  prev: readonly StackViewEntry[],
  next: readonly StackViewEntry[],
): StackDiff | null {
  const from = prev[prev.length - 1];
  const to = next[next.length - 1];
  if (!from || !to || from.id === to.id) return null;
  const nextIds = new Set(next.map((e) => e.id));
  const prevIds = new Set(prev.map((e) => e.id));
  if (!prevIds.has(to.id)) {
    // A replace (the old top is gone too) also slides in like a push.
    return { kind: "push", fromId: from.id, toId: to.id, popped: [] };
  }
  if (!nextIds.has(from.id)) {
    return {
      kind: "pop",
      fromId: from.id,
      toId: to.id,
      popped: prev.filter((e) => !nextIds.has(e.id)),
    };
  }
  return null;
}

/** Whether a screen lets the one below it show through (so that one stays visible). */
function isOverlay(options: ScreenOptions): boolean {
  return options.presentation === "formSheet" || options.presentation === "transparentModal";
}

/**
 * The ids of the screens to draw: the top, and below it every screen an overlay leaves
 * visible (a form sheet or a transparent modal on top shows the screen under it).
 */
export function visibleIds(
  entries: readonly StackViewEntry[],
  optionsOf: (e: StackViewEntry) => ScreenOptions,
): Set<string> {
  const out = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].element === undefined) continue;
    out.add(entries[i].id);
    if (!isOverlay(optionsOf(entries[i]))) break;
  }
  return out;
}

/** The pointer event fields the edge swipe reads. */
interface SwipePointer {
  readonly pointerId: number;
  readonly pointerType?: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly timeStamp?: number;
  readonly isPrimary?: boolean;
  readonly target?: unknown;
}

/** What {@linkcode attachEdgeSwipe} drives. */
export interface EdgeSwipeHost {
  /** Whether a swipe may start for this pointer-down. */
  canStart(event: SwipePointer): boolean;
  /** The axis locked horizontal: reveal the screen below. */
  begin(): void;
  /** The finger moved: `progress` 0…1 over `width` px. */
  update(progress: number, width: number): void;
  /** The finger lifted after a locked swipe. */
  release(decision: SwipeRelease, progress: number, velocityX: number, width: number): void;
  /** The swipe was taken away (pointercancel) after it locked. */
  abort(): void;
}

/** An element the edge swipe listens on. */
interface SwipeTarget extends ListenerTarget {
  getBoundingClientRect?(): { left: number; width: number };
  setPointerCapture?(id: number): void;
}

/**
 * Wire the iOS interactive back swipe to `el`: a touch (or pen) that goes down within 20 px of
 * its left edge and moves horizontally (the axis locks after 10 px; vertical movement leaves
 * the touch to scrolling) drives `host`. With `fullScreen` (read at each pointer-down) the
 * touch may go down anywhere, under {@linkcode FULL_SCREEN_SWIPE}'s stricter lock. Mouse
 * pointers are ignored unless `mouse` is set. Returns the detach function. Exported for
 * testing.
 */
export function attachEdgeSwipe(
  el: SwipeTarget,
  host: EdgeSwipeHost,
  options: { edgeWidth?: number; mouse?: boolean; fullScreen?: () => boolean } = {},
): () => void {
  const edge = new EdgeSwipeTracker({ edgeWidth: options.edgeWidth });
  let full: EdgeSwipeTracker | null = null;
  let tracker = edge;
  let id: number | null = null;
  let width = 1;
  const t = (e: SwipePointer) => e.timeStamp ?? Date.now();
  const down = (e: SwipePointer) => {
    if (id !== null || e.isPrimary === false) return;
    if (e.pointerType === "mouse" && !options.mouse) return;
    if (!host.canStart(e)) return;
    tracker = options.fullScreen?.() ? (full ??= new EdgeSwipeTracker(FULL_SCREEN_SWIPE)) : edge;
    const rect = el.getBoundingClientRect?.() ??
      { left: 0, width: (globalThis as { innerWidth?: number }).innerWidth ?? 375 };
    if (!tracker.start(e.clientX, e.clientY, t(e), rect.left, rect.width)) return;
    id = e.pointerId;
    width = Math.max(1, rect.width);
  };
  const move = (e: SwipePointer) => {
    if (e.pointerId !== id) return;
    const was = tracker.tracking;
    const m = tracker.move(e.clientX, e.clientY, t(e));
    if (m.phase === "rejected") {
      id = null;
      if (was) host.abort();
      return;
    }
    if (m.phase !== "tracking") return;
    if (!was) {
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch { /* the pointer is gone; the next event ends the swipe */ }
      host.begin();
    }
    host.update(m.progress, width);
  };
  const up = (e: SwipePointer) => {
    if (e.pointerId !== id) return;
    id = null;
    const r = tracker.end(t(e));
    if (r) host.release(r.decision, r.progress, r.velocityX, width);
  };
  const cancel = (e: SwipePointer) => {
    if (e.pointerId !== id) return;
    id = null;
    const was = tracker.tracking;
    tracker.cancel();
    if (was) host.abort();
  };
  return listenAll(el, {
    pointerdown: down,
    pointermove: move,
    pointerup: up,
    pointercancel: cancel,
  });
}

/**
 * Whether a gesture starting on `target` belongs to it: a text field, a scrolled row, or an
 * element marked `data-dnx-no-back-swipe` (a swipeable row that reveals actions rightward).
 */
function claimsHorizontal(target: unknown): boolean {
  for (let el = target as Element | null; el && el.tagName; el = el.parentElement) {
    if (claimsAt(el as HTMLElement)) return true;
    if (el.hasAttribute?.("data-dnx-screen")) break;
  }
  return false;
}

/** Whether `el` itself keeps a horizontal gesture: a text field, a scrolled row, an opt-out. */
function claimsAt(el: HTMLElement): boolean {
  if (/^(?:INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return true;
  return el.scrollLeft > 0 || el.hasAttribute?.("data-dnx-no-back-swipe") === true;
}

/** Write a gesture frame's style onto `el` (or clear it with `null`). */
function applyGestureStyle(el: HTMLElement | null | undefined, style: GestureStyle | null): void {
  const s = el?.style;
  if (!s) return;
  s.transform = style?.transform ?? "";
  s.filter = style?.filter ?? "";
  s.borderRadius = style?.borderRadius ?? "";
  s.willChange = style ? "transform" : "";
}

/** A Web Animation handle (what `playFrames` returns). */
type Anim = { finished: Promise<unknown>; cancel(): void };

/** The live gesture state (outside React state: it changes every frame). */
interface GestureRun {
  /** "swipe" (iOS edge) or "predictive" (Android back). */
  readonly kind: "swipe" | "predictive";
  /** The top screen's id and the one below. */
  readonly topId: string;
  readonly belowId: string;
  progress: number;
  edge: "left" | "right" | "none";
  width: number;
  /** Set once the pop has been handed to the owner (the next change must not animate). */
  committed: boolean;
}

/** The view's state that lives across renders outside React state. */
interface StackRt {
  props: StackViewProps;
  platform: NavigationPlatform;
  readonly sections: Map<string, HTMLElement>;
  readonly bodies: Map<string, HTMLElement>;
  readonly scrollMemo: Map<string, number>;
  /**
   * The scroll positions of the scrollers inside each screen (a virtualized list's own
   * scroller): hiding a screen (`display: none`) drops them, so they are put back on reveal.
   */
  readonly nestedScroll: Map<string, Map<Element, number>>;
  /** The entries of the last commit. */
  prev: readonly StackViewEntry[];
  /** Popped screens still drawn while they leave. */
  exiting: Map<string, StackViewEntry>;
  /** The screens a running push/pop animation keeps visible. */
  animating: { ids: string[] } | null;
  /** Finished animations to cancel once the render that hides their screens committed. */
  cancelLater: Anim[];
  gesture: GestureRun | null;
  root: HTMLElement | null;
  wasVisible: Set<string>;
  force: () => void;
  setRevealed: (id: string | null) => void;
}

/** What this render draws. */
interface RenderPlan {
  readonly entries: readonly StackViewEntry[];
  readonly change: StackDiff | null;
  readonly willAnimate: boolean;
  readonly exiting: Map<string, StackViewEntry>;
  readonly visible: Set<string>;
}

/** A screen's options over the view's defaults. */
function optionsOf(rt: StackRt, e: StackViewEntry): ScreenOptions {
  return { ...rt.props.screenOptions, ...e.options };
}

/** Whether the change involves a form sheet (which animates itself). */
function involvesSheet(
  rt: StackRt,
  change: StackDiff,
  entries: readonly StackViewEntry[],
): boolean {
  const ends = [
    ...entries.filter((e) => e.id === change.toId),
    ...rt.prev.filter((e) => e.id === change.fromId),
  ];
  return ends.some((e) => optionsOf(rt, e).presentation === "formSheet");
}

/**
 * What this render draws (pure: the runtime only moves in the commit): the change since the
 * last commit, whether the view animates it, the screens still leaving, and the visible ones.
 */
function planRender(rt: StackRt, animate: StackViewAnimate, revealed: string | null): RenderPlan {
  const entries = rt.props.entries;
  const change = diffEntries(rt.prev, entries);
  const gestureDone = rt.gesture?.committed === true;
  const willAnimate = change !== null && animate === "auto" && !gestureDone &&
    !involvesSheet(rt, change, entries);
  // Popped screens stay drawn while they leave: animated ones, and sheets (they slide away).
  const exiting = new Map(rt.exiting);
  if (change?.kind === "pop" && !gestureDone) {
    for (const e of change.popped) {
      const sheet = optionsOf(rt, e).presentation === "formSheet";
      if (e.element !== undefined && (willAnimate || sheet)) exiting.set(e.id, e);
    }
  }
  const visible = visibleIds(entries, (e) => optionsOf(rt, e));
  if (willAnimate) visible.add(change!.fromId);
  for (const id of rt.animating?.ids ?? []) visible.add(id);
  if (revealed) visible.add(revealed);
  return { entries, change, willAnimate, exiting, visible };
}

/**
 * Put the remembered nested scrollers of a screen back where they were, then tell them so: a
 * `scroll` event once the revealed subtree's effects are back, so a virtualized list (whose
 * window followed the reset to 0 while hidden) renders the rows at its position again.
 */
function restoreNested(memo: Map<Element, number> | undefined): void {
  if (!memo) return;
  const live: Element[] = [];
  for (const [el, top] of memo) {
    if (!el.isConnected) {
      memo.delete(el);
      continue;
    }
    if (el.scrollTop !== top) el.scrollTop = top;
    live.push(el);
  }
  const raf = globalThis.requestAnimationFrame;
  if (live.length === 0 || typeof raf !== "function") return;
  raf(() =>
    raf(() => {
      for (const el of live) el.dispatchEvent?.(new Event("scroll"));
    })
  );
}

/** Remember where a scroller inside screen `id` scrolled to (a capture-phase `scroll`). */
function noteNestedScroll(rt: StackRt, id: string, event: Event): void {
  const el = event.target as Element | null;
  if (!el || el === event.currentTarget || typeof el.scrollTop !== "number") return;
  if (el.hasAttribute?.("data-dnx-screen-body")) return;
  let memo = rt.nestedScroll.get(id);
  if (!memo) rt.nestedScroll.set(id, memo = new Map());
  memo.set(el, el.scrollTop);
}

/** Forget the scroll positions of screens no longer drawn (they hold detached elements). */
function pruneScrollMemos(rt: StackRt, plan: RenderPlan): void {
  const live = (id: string) => plan.exiting.has(id) || plan.entries.some((e) => e.id === id);
  for (const id of [...rt.nestedScroll.keys(), ...rt.scrollMemo.keys()]) {
    if (live(id)) continue;
    rt.nestedScroll.delete(id);
    rt.scrollMemo.delete(id);
  }
}

/** Screens that show again get their scroll position back (display:none dropped it). */
function restoreScroll(rt: StackRt, visible: Set<string>): void {
  for (const id of visible) {
    if (rt.wasVisible.has(id)) continue;
    const body = rt.bodies.get(id);
    const memo = rt.scrollMemo.get(id);
    if (body && memo !== undefined && body.scrollTop !== memo) body.scrollTop = memo;
    restoreNested(rt.nestedScroll.get(id));
  }
  rt.wasVisible = new Set(visible);
}

/** Animate a push or pop between the two screens' sections (Web Animations). */
function runAnimation(rt: StackRt, change: StackDiff, entries: readonly StackViewEntry[]): void {
  const driver = change.kind === "push"
    ? entries.find((e) => e.id === change.toId)
    : change.popped[change.popped.length - 1];
  const opts = driver ? optionsOf(rt, driver) : {};
  const frames = stackFrames(opts.animation, change.kind, rt.platform, {
    duration: opts.animationDuration,
  });
  const timing = { duration: frames.duration, easing: frames.easing };
  const anims = [
    playFrames(rt.sections.get(change.toId), frames.incoming, timing),
    playFrames(rt.sections.get(change.fromId), frames.outgoing, timing),
  ].filter((a): a is Anim => a !== null);
  const run = { ids: [change.fromId, change.toId] };
  rt.animating = run;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    // Even when a newer change superseded this run, its popped screens are done leaving.
    for (const e of change.popped) rt.exiting.delete(e.id);
    rt.cancelLater.push(...anims);
    if (rt.animating === run) rt.animating = null;
    rt.force();
  };
  if (anims.length === 0) finish();
  else Promise.all(anims.map((a) => a.finished)).then(finish, finish);
}

/** The commit: remember the entries, restore scroll, and animate (or settle a gesture). */
function commitRender(rt: StackRt, plan: RenderPlan, revealed: string | null): void {
  rt.prev = plan.entries;
  pruneScrollMemos(rt, plan);
  for (const a of rt.cancelLater.splice(0)) a.cancel();
  restoreScroll(rt, plan.visible);
  if (!plan.change) return;
  const g = rt.gesture;
  if (g?.committed) {
    // A gesture pop already moved the screens: clear its inline styles now the pop landed.
    rt.gesture = null;
    applyGestureStyle(rt.sections.get(g.belowId), null);
    if (revealed) rt.setRevealed(null);
    return;
  }
  rt.exiting = plan.exiting; // animated pops until they finish; sheets until they slide away
  if (plan.willAnimate) runAnimation(rt, plan.change, plan.entries);
}

/** The top screen and the one below, when a back gesture may pop between them. */
function gesturePair(rt: StackRt): { top: StackViewEntry; below: StackViewEntry } | null {
  const list = rt.props.entries;
  const top = list[list.length - 1];
  const below = list[list.length - 2];
  if (!top || !below || below.element === undefined || rt.animating || rt.gesture) return null;
  const o = optionsOf(rt, top);
  if (o.gestureEnabled === false || (o.presentation ?? "card") !== "card") return null;
  return { top, below };
}

/** Start a gesture between the top screen and the one below (revealing it). */
function beginGesture(
  rt: StackRt,
  kind: GestureRun["kind"],
  pair: { top: StackViewEntry; below: StackViewEntry },
  edge: GestureRun["edge"],
  width: number,
): void {
  rt.gesture = {
    kind,
    topId: pair.top.id,
    belowId: pair.below.id,
    progress: 0,
    edge,
    width,
    committed: false,
  };
  rt.setRevealed(pair.below.id);
}

/** Put the gesture's screens back and hide the one below. */
function endGesture(rt: StackRt, g: GestureRun): void {
  if (rt.gesture === g) rt.gesture = null;
  applyGestureStyle(rt.sections.get(g.topId), null);
  applyGestureStyle(rt.sections.get(g.belowId), null);
  rt.setRevealed(null);
}

/** Hand the pop to the owner; if it never lands (refused), put the screens back. */
function commitGesturePop(rt: StackRt, g: GestureRun, cleanup?: () => void): void {
  g.committed = true;
  rt.props.onPop(rt.props.entries.length - 2, { animated: false });
  setTimeout(() => {
    if (rt.gesture !== g) return;
    cleanup?.();
    endGesture(rt, g);
  }, 1000);
}

/** Play `anims` to their end, then run `done` (at once when there is nothing to play). */
function afterAll(anims: Array<Anim | null>, done: () => void): void {
  const live = anims.filter((a): a is Anim => a !== null);
  if (live.length === 0) done();
  else Promise.all(live.map((a) => a.finished)).then(done, done);
}

/** Finish a swipe: glide to the end (commit → pop) or back (cancel → restore). */
function settleSwipe(
  rt: StackRt,
  g: GestureRun,
  commit: boolean,
  progress: number,
  velocityX: number,
): void {
  const width = g.width;
  const topEl = rt.sections.get(g.topId);
  const belowEl = rt.sections.get(g.belowId);
  const target = commit ? 1 : 0;
  const distance = Math.abs(target - progress) * width;
  const speed = Math.max(Math.abs(velocityX), 0.8); // px/ms
  const duration = Math.round(Math.min(350, Math.max(120, distance / speed)));
  const from = swipeFrame(progress, width);
  const to = swipeFrame(target, width);
  const timing = { duration, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
  applyGestureStyle(topEl, to.top);
  applyGestureStyle(belowEl, to.below);
  const anims = [
    playFrames(topEl, [from.top, to.top], timing),
    playFrames(belowEl, [from.below, to.below], timing),
  ];
  afterAll(anims, () => {
    for (const a of anims) a?.cancel();
    if (!commit) return endGesture(rt, g);
    if (rt.props.swipeHaptic) haptic("light").catch(() => {});
    commitGesturePop(rt, g);
  });
}

/** The edge swipe's host over the view's runtime. */
function swipeHost(rt: StackRt): EdgeSwipeHost {
  return {
    canStart: (e) => gesturePair(rt) !== null && !claimsHorizontal(e.target),
    begin: () => {
      const pair = gesturePair(rt);
      if (pair) beginGesture(rt, "swipe", pair, "left", 1);
    },
    update: (progress, width) => {
      const g = rt.gesture;
      if (!g) return;
      g.progress = progress;
      g.width = width;
      const f = swipeFrame(progress, width);
      applyGestureStyle(rt.sections.get(g.topId), f.top);
      applyGestureStyle(rt.sections.get(g.belowId), f.below);
    },
    release: (decision, progress, velocityX) => {
      const g = rt.gesture;
      if (g) settleSwipe(rt, g, decision === "commit", progress, velocityX);
    },
    abort: () => {
      const g = rt.gesture;
      if (g) settleSwipe(rt, g, false, g.progress, 0);
    },
  };
}

/** Whether the top screen's back swipe may start anywhere (its option, else the view's). */
function fullScreenSwipe(rt: StackRt): boolean {
  const list = rt.props.entries;
  const top = list[list.length - 1];
  const own = top ? optionsOf(rt, top).fullScreenGestureEnabled : undefined;
  return own ?? rt.props.fullScreenSwipe ?? false;
}

/** The iOS edge swipe on the stack's container. */
function useEdgeSwipe(rt: StackRt, enabled: boolean): void {
  useEffect(() => {
    const root = rt.root;
    if (!root || !enabled || typeof root.addEventListener !== "function") return;
    return attachEdgeSwipe(root, swipeHost(rt), { fullScreen: () => fullScreenSwipe(rt) });
  }, [enabled]);
}

/** A predictive-back gesture's start: reveal the screen below. */
function predictiveStart(rt: StackRt, edge: GestureRun["edge"]): void {
  const pair = gesturePair(rt);
  if (!pair) return;
  const width = rt.root?.getBoundingClientRect?.().width ?? 360;
  beginGesture(rt, "predictive", pair, edge, width);
}

/** A cancelled predictive back: spring the top screen back. */
function predictiveCancel(rt: StackRt, g: GestureRun): void {
  const topEl = rt.sections.get(g.topId);
  const from = predictiveFrame(g.progress, g.edge, g.width).top;
  applyGestureStyle(topEl, null);
  const a = playFrames(topEl, [from, { transform: "none" }], { duration: 200, easing: "ease-out" });
  afterAll([a], () => {
    a?.cancel();
    endGesture(rt, g);
  });
}

/** A committed predictive back: finish the exit, then pop (the back handler must not pop again). */
function predictiveCommit(rt: StackRt, g: GestureRun): void {
  g.committed = true;
  const topEl = rt.sections.get(g.topId);
  const from = predictiveFrame(g.progress, g.edge, g.width).top;
  const to = { ...predictiveFrame(1, g.edge, g.width).top, opacity: 0 };
  const a = playFrames(topEl, [from, to], { duration: 200, easing: "ease-in" });
  afterAll([a], () => commitGesturePop(rt, g, () => a?.cancel()));
}

/** One predictive-back event from `denext/mobile`. */
function onPredictive(rt: StackRt, event: BackProgressEvent): void {
  if (event.type === "start") return predictiveStart(rt, event.edge);
  const g = rt.gesture;
  if (!g || g.kind !== "predictive") return;
  if (event.type === "progress") {
    g.progress = event.progress;
    applyGestureStyle(
      rt.sections.get(g.topId),
      predictiveFrame(event.progress, g.edge, g.width).top,
    );
  } else if (event.type === "cancel") predictiveCancel(rt, g);
  else predictiveCommit(rt, g);
}

/** Android: predictive back previews the pop; the back button pops. */
function useAndroidBack(rt: StackRt, canGoBack: boolean): void {
  const android = nativePlatform() === "android";
  useEffect(() => (android ? onBackProgress((event) => onPredictive(rt, event)) : undefined), [
    android,
  ]);
  useBackHandler(() => {
    if (rt.gesture?.kind === "predictive" && rt.gesture.committed) return true;
    const list = rt.props.entries;
    if (list.length < 2) return false;
    rt.props.onPop(list.length - 2, { animated: true });
    return true;
  }, android && canGoBack);
}

/** The screens to draw: the stack, then the ones still leaving. */
function drawnScreens(
  plan: RenderPlan,
): Array<{ entry: StackViewEntry; index: number; exiting: boolean }> {
  const drawn = plan.entries.map((entry, index) => ({ entry, index, exiting: false }));
  for (const e of plan.exiting.values()) {
    if (!plan.entries.some((x) => x.id === e.id)) {
      drawn.push({ entry: e, index: drawn.length, exiting: true });
    }
  }
  return drawn;
}

/** A drawn screen, as the render helpers take it. */
interface ScreenItem {
  readonly entry: StackViewEntry;
  readonly index: number;
  readonly exiting: boolean;
  readonly shown: boolean;
  readonly isTop: boolean;
  readonly options: ScreenOptions;
  readonly content: VNode;
}

/** A `"formSheet"` screen: the page in a {@linkcode Sheet} over the screen below. */
function sheetScreen(rt: StackRt, item: ScreenItem): VNode {
  const { entry, index, options: o } = item;
  return h(Sheet, {
    key: entry.id,
    open: !item.exiting,
    detents: o.sheetAllowedDetents ?? ["large"],
    initialDetent: o.sheetInitialDetentIndex,
    grabber: o.sheetGrabberVisible !== false,
    dismissible: o.gestureEnabled !== false,
    fillContent: rt.props.fillScreens,
    "aria-label": o.title,
    onOpenChange: (open: boolean) => {
      if (!open && item.isTop) rt.props.onPop(index - 1, { animated: false });
    },
    onExitComplete: () => {
      if (rt.exiting.delete(entry.id)) rt.force();
    },
  }, item.content);
}

/** The header of a card screen (when `headerShown`). */
function screenHeader(rt: StackRt, item: ScreenItem): VNode | null {
  if (!item.options.headerShown) return null;
  const below = rt.props.entries[item.index - 1];
  return h(StackHeader, {
    options: item.options,
    platform: rt.platform,
    canGoBack: item.index > 0,
    backHref: below?.href,
    backTitle: below ? optionsOf(rt, below).title : undefined,
    onBack: () => rt.props.onPop(item.index - 1, { animated: true }),
  });
}

/** Keep `el` in `map` under `id` while it is mounted. */
function track(map: Map<string, HTMLElement>, id: string) {
  return (el: HTMLElement | null) => {
    if (el) map.set(id, el);
    else map.delete(id);
  };
}

/** A card screen body's style: a scroll container, a flex column the content fills (`fill`). */
function bodyStyle(fill: boolean): Record<string, string | number> {
  return {
    flex: 1,
    minHeight: 0,
    ...(fill ? { display: "flex", flexDirection: "column" } : {}),
    overflowY: "auto",
    overscrollBehaviorY: "contain",
    // Horizontal pans stay with the page, so the edge swipe gets them (not a pointercancel).
    touchAction: "pan-y pinch-zoom",
    WebkitOverflowScrolling: "touch",
  };
}

/** A card (or modal) screen: header, then its own scroll container with the page. */
function cardScreen(rt: StackRt, item: ScreenItem): VNode {
  const { entry, index, options: o } = item;
  const large = o.headerShown && rt.platform === "ios" && o.headerLargeTitle
    ? h(LargeTitle, { title: o.headerTitle ?? o.title ?? "" })
    : null;
  const transparent = o.presentation === "transparentModal";
  const state = item.exiting ? "exiting" : item.isTop ? "top" : item.shown ? "below" : "hidden";
  return h(
    "section",
    {
      key: entry.id,
      ref: track(rt.sections, entry.id),
      "data-dnx-screen": entry.id,
      "data-dnx-screen-state": state,
      onScrollCapture: (event: Event) => noteNestedScroll(rt, entry.id, event),
      "aria-hidden": item.isTop ? undefined : "true",
      inert: item.isTop ? undefined : true,
      style: {
        position: "absolute",
        inset: 0,
        display: item.shown ? "flex" : "none",
        flexDirection: "column",
        overflow: "hidden",
        background: transparent ? "transparent" : "var(--dnx-screen-bg, Canvas)",
        boxShadow: index > 0 && !transparent ? "-1px 0 12px rgba(0, 0, 0, 0.12)" : undefined,
        transformOrigin: "center",
      },
    },
    screenHeader(rt, item),
    h(
      "div",
      {
        ref: track(rt.bodies, entry.id),
        "data-dnx-screen-body": "",
        onScroll: (event: Event) => {
          const top = (event.currentTarget as HTMLElement).scrollTop;
          rt.scrollMemo.set(entry.id, top);
          const section = rt.sections.get(entry.id);
          markScrolled(section, top);
          if (large) collapseLargeTitle(section, top);
        },
        style: bodyStyle(rt.props.fillScreens === true),
      },
      large,
      item.content,
    ),
  );
}

/** One drawn screen (nothing for a screen not loaded). */
function renderScreen(
  rt: StackRt,
  plan: RenderPlan,
  drawn: { entry: StackViewEntry; index: number; exiting: boolean },
): VNode | null {
  const { entry, index, exiting } = drawn;
  if (entry.element === undefined) return null;
  const shown = exiting || plan.visible.has(entry.id);
  const content = h(
    navigationContexts().screen,
    { value: { id: entry.id, index } },
    h(Activity, { mode: shown ? "visible" : "hidden" }, entry.element),
  );
  const item: ScreenItem = {
    ...drawn,
    shown,
    isTop: !exiting && index === plan.entries.length - 1,
    options: optionsOf(rt, entry),
    content,
  };
  return item.options.presentation === "formSheet" ? sheetScreen(rt, item) : cardScreen(rt, item);
}

/** The owner's handle: a screen's section, and scroll-to-top of the top screen. */
function ownerHandle(rt: StackRt): StackViewHandle {
  return {
    section: (id) => rt.sections.get(id) ?? null,
    scrollToTop: () => {
      const list = rt.props.entries;
      const body = rt.bodies.get(list[list.length - 1]?.id ?? "");
      if (!body || body.scrollTop <= 0) return false;
      if (typeof body.scrollTo === "function") body.scrollTo({ top: 0, behavior: "smooth" });
      else body.scrollTop = 0;
      return true;
    },
  };
}

/** A fresh runtime for a mounting view. */
function createRuntime(props: StackViewProps): StackRt {
  return {
    props,
    platform: "ios",
    sections: new Map(),
    bodies: new Map(),
    scrollMemo: new Map(),
    nestedScroll: new Map(),
    prev: props.entries,
    exiting: new Map(),
    animating: null,
    cancelLater: [],
    gesture: null,
    root: null,
    wasVisible: new Set(),
    force: () => {},
    setRevealed: () => {},
  };
}

/** Announce the top screen when it changes (`announceRouteChanges`). */
function useStackAnnouncer(rt: StackRt, props: StackViewProps): void {
  const top = props.entries[props.entries.length - 1];
  const o = top ? optionsOf(rt, top) : undefined;
  const title = typeof o?.title === "string"
    ? o.title
    : typeof o?.headerTitle === "string"
    ? o.headerTitle
    : undefined;
  useRouteAnnouncer(top?.id ?? "", title, props.announceRouteChanges !== false);
}

/**
 * The router-independent stack view; see the module docs. {@linkcode StackLayout} is the App
 * Router binding most apps use.
 */
export function StackView(props: StackViewProps): VNode {
  const [, force] = useReducer((n: number, _tick: void) => n + 1, 0);
  const [revealed, setRevealed] = useState<string | null>(null);
  const ref = useRef<StackRt | null>(null);
  const rt = ref.current ??= createRuntime(props);
  rt.props = props;
  rt.platform = props.platform ?? detectPlatform();
  rt.force = force;
  rt.setRevealed = setRevealed;

  const plan = planRender(rt, props.animate ?? "auto", revealed);
  useLayoutEffect(() => commitRender(rt, plan, revealed));
  useEffect(() => {
    const onHandle = rt.props.onHandle;
    onHandle?.(ownerHandle(rt));
    return () => onHandle?.(null);
  }, []);
  useStackAnnouncer(rt, props);
  useEdgeSwipe(rt, props.swipeBack ?? rt.platform === "ios");
  useAndroidBack(rt, props.entries.length > 1);
  useNavigationTheme(props.theme ?? "auto");
  const themed = themeAttributes(props, rt.platform);

  return h(
    "div",
    {
      ref: (el: HTMLElement | null) => {
        rt.root = el;
        rt.props.containerRef?.(el);
      },
      "data-dnx-stack": rt.platform,
      ...themed.attrs,
      className: props.className,
      style: {
        position: "relative",
        height: "var(--dnx-stack-height, 100dvh)",
        overflow: "hidden",
        isolation: "isolate",
        ...themed.style,
        ...(props.style ?? {}),
      },
    },
    ...drawnScreens(plan).map((d) => renderScreen(rt, plan, d)),
  );
}

/**
 * Mark a screen `data-dnx-scrolled` while its content is scrolled off the top (the platform
 * theme's bars switch from the scroll-edge look to their material on it).
 */
function markScrolled(section: HTMLElement | undefined, scrollTop: number): void {
  if (typeof section?.setAttribute !== "function") return;
  const scrolled = scrollTop > 0;
  if (section.hasAttribute?.("data-dnx-scrolled") === scrolled) return;
  if (scrolled) section.setAttribute("data-dnx-scrolled", "");
  else section.removeAttribute?.("data-dnx-scrolled");
}

/**
 * The iOS large title as the screen scrolls: the bar's small title fades in over the last
 * 20 px before the large one has scrolled under the bar, and pulling down past the top
 * stretches the large title (as UINavigationBar does).
 */
function collapseLargeTitle(section: HTMLElement | undefined, scrollTop: number): void {
  const title = section?.querySelector?.("[data-dnx-header-title]") as HTMLElement | null;
  if (title?.style) {
    const fade = (scrollTop - (LARGE_TITLE_COLLAPSE - 20)) / 20;
    title.style.setProperty("opacity", String(Math.min(1, Math.max(0, fade))));
  }
  const large = section?.querySelector?.("[data-dnx-large-title]") as HTMLElement | null;
  if (!large?.style) return;
  const stretch = scrollTop < 0 ? 1 + Math.min(-scrollTop, 120) / 480 : 1;
  const transform = stretch === 1 ? "" : `scale(${stretch.toFixed(3)})`;
  if (large.style.getPropertyValue("transform") === transform) return;
  if (transform) large.style.setProperty("transform", transform);
  else large.style.removeProperty("transform");
}

/**
 * The screen a component renders in, or `null` outside a stack. Reads `id` and `index`
 * (0 = the stack's root screen).
 */
export function useScreenInfo(): { id: string; index: number } | null {
  return useContext(navigationContexts().screen);
}
