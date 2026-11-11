// Loopy's window on Deno Desktop. The window itself is configured in denext.config.ts (a
// transparent, frameless overlay that never takes the focus, on top and on every Space, no Dock
// icon); here the page:
//
// - clears its own background where the window is transparent, so Loopy stands on the desktop;
// - lets clicks through everywhere but Loopy, its bubble and its buttons (the elements marked
//   `data-loopy-hit`, not the rows they sit in): a hit region where the
//   runtime has one (`setHitRegion`), else click-through with pointer forwarding toggled over
//   them (`setIgnoreMouseEvents(true, { forward: true })`), else the whole window catches clicks;
// - moves the window to the bottom-right corner of the primary display (on Wayland only as a
//   layer-shell overlay, kept clear of the panels: lib/placement.ts);
// - makes Loopy the drag handle;
// - sizes the window to Loopy's size setting (lib/voice-settings.ts): the base 260 × 300 times the
//   scale, keeping its bottom-right corner (lib/placement.ts), with the hit region re-sent.
//
// Each step is feature-detected through `windowCapabilities()` and skipped where the OS or runtime
// can't do it. Off desktop (`denext dev` in a browser) every call rejects `unavailable` and Loopy
// just renders in the page.
"use client";
import {
  getScreens,
  getWindowState,
  makeWindowDraggable,
  quitApp,
  setHitRegion,
  setIgnoreMouseEvents,
  setMaximumWindowSize,
  setMinimumWindowSize,
  setWindowBounds,
  setWindowPosition,
  setWindowSize,
  type WindowBounds,
  windowCapabilities,
} from "denext/desktop/window";
import { clickThroughPlan, HIT_SELECTOR, hitRects, insideAny } from "./click-through.ts";
import {
  anchoredBounds,
  cornerOnScreen,
  primaryScreen,
  type Rect,
  scaledWindowSize,
  type Size,
} from "./placement.ts";

/** What {@linkcode setupWindow} found and did. */
export interface WindowSetup {
  /** Running in a Deno Desktop window. */
  readonly desktop: boolean;
  /** The steps that were applied, for the debug line. */
  readonly applied: readonly string[];
  /** Stop following the click-catching elements (a no-op when nothing follows them). */
  readonly stop: () => void;
  /** Resize the window for Loopy at `scale` percent (a no-op off desktop). */
  readonly rescale: (scale: number) => Promise<void>;
}

/** Run `step`, recording `name` when it worked; a failure is skipped, never thrown. */
async function attempt(applied: string[], name: string, step: () => Promise<unknown>) {
  try {
    await step();
    applied.push(name);
  } catch { /* unsupported here: Loopy works without it */ }
}

/** The click-catching elements under `root` now (a bubble comes and goes). */
function catchersIn(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(HIT_SELECTOR));
}

/** The current rectangles of the click-catching elements under `root`. */
function rectsOf(root: ParentNode): WindowBounds[] {
  return hitRects(catchersIn(root).map((e) => e.getBoundingClientRect()));
}

/**
 * Keep the native hit region on the click-catching elements under `root`: re-sent when one is
 * added or removed (a bubble opens or closes), resizes, or ends an entrance animation (the bubble
 * springs in scaled down, which no resize reports).
 */
function followRegion(root: Element): Follow {
  const resized = typeof ResizeObserver === "function" ? new ResizeObserver(() => send()) : null;
  const send = () => void setHitRegion(rectsOf(root)).catch(() => {});
  const observe = () => {
    resized?.disconnect();
    for (const e of catchersIn(root)) resized?.observe(e);
    send();
  };
  observe();
  const changed = typeof MutationObserver === "function" ? new MutationObserver(observe) : null;
  changed?.observe(root, { childList: true, subtree: true });
  root.addEventListener("animationend", send);
  // A new size scales the page (a transform, which no ResizeObserver reports) and the window.
  globalThis.addEventListener("resize", send);
  return {
    refresh: send,
    stop: () => {
      resized?.disconnect();
      changed?.disconnect();
      root.removeEventListener("animationend", send);
      globalThis.removeEventListener("resize", send);
    },
  };
}

/** Following the click-catching elements: re-send now, and stop. */
interface Follow {
  readonly refresh: () => void;
  readonly stop: () => void;
}

/** Nothing to follow. */
const NO_FOLLOW: Follow = { refresh: () => {}, stop: () => {} };

/** Click-through with forwarded pointer moves, caught again while the pointer is over Loopy. */
function followPointer(root: Element): Follow {
  let ignoring = true;
  void setIgnoreMouseEvents(true, { forward: true }).catch(() => {});
  const onMove = (e: PointerEvent) => {
    const over = insideAny(rectsOf(root), e.clientX, e.clientY);
    if (over === !ignoring) return;
    ignoring = !over;
    void setIgnoreMouseEvents(ignoring, { forward: true }).catch(() => {});
  };
  globalThis.addEventListener("pointermove", onMove);
  return { refresh: () => {}, stop: () => globalThis.removeEventListener("pointermove", onMove) };
}

/** What `windowCapabilities()` reports (the keys read here). */
type Caps = Awaited<ReturnType<typeof windowCapabilities>>;

/** Clear the page's background where the window is transparent: Loopy stands on the desktop. */
function clearBackground(caps: Caps, applied: string[]): void {
  if (!caps.transparent) return;
  document.documentElement.dataset.overlay = "transparent";
  applied.push("transparent");
}

/**
 * Let clicks through outside the click-catching elements under `root` the best way the runtime
 * has; returns the undo.
 */
function startClickThrough(caps: Caps, root: Element | null, applied: string[]): Follow {
  const plan = clickThroughPlan(caps);
  if (plan === "none" || root === null) return NO_FOLLOW;
  applied.push(`click-through:${plan}`);
  return plan === "region" ? followRegion(root) : followPointer(root);
}

/** The session facts placement reads. */
const placementSession = (caps: Caps) => ({
  wayland: caps.sessionType === "wayland",
  edgeAnchored: caps.layerShellEdgeAnchor === true,
});

/**
 * Move the window, `size`, to the bottom-right corner of the primary display. On Wayland only a
 * layer-shell overlay moves (`setPosition` is reported for one where the runtime has `layerShell`).
 */
async function placeInCorner(caps: Caps, size: Size, applied: string[]): Promise<void> {
  if (!caps.screens || !caps.setPosition) return;
  await attempt(applied, "corner", async () => {
    const screen = primaryScreen(await getScreens());
    if (!screen) throw new Error("no display");
    const { x, y } = cornerOnScreen(screen, size, placementSession(caps));
    await setWindowPosition(x, y);
  });
}

/** No size limit (`0` on both axes). */
const NO_LIMIT: Size = { width: 0, height: 0 };

/** Pin the window's size limits to `size` ({@linkcode NO_LIMIT} lifts them). */
async function limitSize(caps: Caps, size: Size): Promise<void> {
  if (!caps.sizeConstraints) return;
  await setMinimumWindowSize(size.width, size.height).catch(() => {});
  await setMaximumWindowSize(size.width, size.height).catch(() => {});
}

/**
 * Move and resize a window that can be placed: its bounds keep their bottom-right corner, except
 * on Wayland, where a layer surface's position is its margins and the corner is computed again.
 */
async function moveAndResize(caps: Caps, size: Size): Promise<void> {
  if (caps.sessionType === "wayland") {
    await setWindowSize(size.width, size.height);
    return await placeInCorner(caps, size, []);
  }
  const current: Rect | null = (await getWindowState()).bounds;
  await setWindowBounds(current ? anchoredBounds(current, size) : size);
}

/**
 * Resize the window to `size`, keeping its bottom-right corner where it can be placed (elsewhere
 * only its size changes), with the size limits lifted while it changes and pinned after.
 */
async function resizeAnchored(caps: Caps, size: Size): Promise<void> {
  await limitSize(caps, NO_LIMIT);
  await (caps.setPosition ? moveAndResize(caps, size) : setWindowSize(size.width, size.height));
  await limitSize(caps, size);
}

/**
 * Set the window up as Loopy's overlay where supported.
 *
 * @param root The page's root: the elements under it marked `data-loopy-hit` (Loopy, its bubble,
 *   its buttons) catch clicks, followed as they come and go; `null` lets no click through.
 * @param scale Loopy's size in percent: the window becomes the base size times it.
 * @returns Whether this is a desktop window, what was applied, how to stop following, and how
 *   to resize for a new size.
 */
export async function setupWindow(
  root: Element | null = null,
  scale = 100,
): Promise<WindowSetup> {
  let caps: Caps;
  try {
    caps = await windowCapabilities();
  } catch {
    return { desktop: false, applied: [], stop: () => {}, rescale: () => Promise.resolve() };
  }
  const applied: string[] = [];
  clearBackground(caps, applied);
  const follow = startClickThrough(caps, root, applied);
  const size = scaledWindowSize(scale);
  await attempt(applied, "size", () => resizeAnchored(caps, size));
  await placeInCorner(caps, size, applied);
  follow.refresh();
  const rescale = async (next: number) => {
    await attempt([], "size", () => resizeAnchored(caps, scaledWindowSize(next)));
    follow.refresh();
  };
  return { desktop: true, applied, stop: follow.stop, rescale };
}

/** Make `element` drag the window (CSS `app-region` on CEF, pointer moves on the WebViews). */
export const dragWindowBy = makeWindowDraggable;

/** Quit the app (desktop only; a no-op in a browser). */
export async function quit(): Promise<void> {
  try {
    await quitApp();
  } catch { /* off desktop */ }
}
