// Loopy's window on Deno Desktop. The window itself is configured in denext.config.ts (a
// transparent, frameless overlay that never takes the focus, on top and on every Space, no Dock
// icon); here the page:
//
// - clears its own background where the window is transparent, so Loopy stands on the desktop;
// - lets clicks through everywhere but Loopy, its bubble and its buttons: a hit region where the
//   runtime has one (`setHitRegion`), else click-through with pointer forwarding toggled over
//   them (`setIgnoreMouseEvents(true, { forward: true })`), else the whole window catches clicks;
// - moves the window to the bottom-right corner of the primary display (on Wayland only as a
//   layer-shell overlay, kept clear of the panels: lib/placement.ts);
// - makes Loopy the drag handle.
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
  setWindowPosition,
  type WindowBounds,
  windowCapabilities,
} from "denext/desktop/window";
import { clickThroughPlan, hitRects, insideAny } from "./click-through.ts";
import { cornerOnScreen, primaryScreen, WINDOW_SIZE } from "./placement.ts";

/** What {@linkcode setupWindow} found and did. */
export interface WindowSetup {
  /** Running in a Deno Desktop window. */
  readonly desktop: boolean;
  /** The steps that were applied, for the debug line. */
  readonly applied: readonly string[];
  /** Stop following the click-catching elements (a no-op when nothing follows them). */
  readonly stop: () => void;
}

/** Run `step`, recording `name` when it worked; a failure is skipped, never thrown. */
async function attempt(applied: string[], name: string, step: () => Promise<unknown>) {
  try {
    await step();
    applied.push(name);
  } catch { /* unsupported here: Loopy works without it */ }
}

/** The current rectangles of the click-catching elements. */
function rectsOf(elements: readonly Element[]): WindowBounds[] {
  return hitRects(elements.map((e) => e.getBoundingClientRect()));
}

/** Keep the native hit region on `elements`, re-sent whenever one resizes. */
function followRegion(elements: readonly Element[]): () => void {
  const send = () => void setHitRegion(rectsOf(elements)).catch(() => {});
  send();
  if (typeof ResizeObserver !== "function") return () => {};
  const observer = new ResizeObserver(send);
  for (const e of elements) observer.observe(e);
  return () => observer.disconnect();
}

/** Click-through with forwarded pointer moves, caught again while the pointer is over Loopy. */
function followPointer(elements: readonly Element[]): () => void {
  let ignoring = true;
  void setIgnoreMouseEvents(true, { forward: true }).catch(() => {});
  const onMove = (e: PointerEvent) => {
    const over = insideAny(rectsOf(elements), e.clientX, e.clientY);
    if (over === !ignoring) return;
    ignoring = !over;
    void setIgnoreMouseEvents(ignoring, { forward: true }).catch(() => {});
  };
  globalThis.addEventListener("pointermove", onMove);
  return () => globalThis.removeEventListener("pointermove", onMove);
}

/** What `windowCapabilities()` reports (the keys read here). */
type Caps = Awaited<ReturnType<typeof windowCapabilities>>;

/** Clear the page's background where the window is transparent: Loopy stands on the desktop. */
function clearBackground(caps: Caps, applied: string[]): void {
  if (!caps.transparent) return;
  document.documentElement.dataset.overlay = "transparent";
  applied.push("transparent");
}

/** Let clicks through outside `catchers` the best way the runtime has; returns the undo. */
function startClickThrough(caps: Caps, catchers: readonly Element[], applied: string[]) {
  const plan = clickThroughPlan(caps);
  if (plan === "none" || catchers.length === 0) return () => {};
  applied.push(`click-through:${plan}`);
  return plan === "region" ? followRegion(catchers) : followPointer(catchers);
}

/**
 * Move the window to the bottom-right corner of the primary display. On Wayland only a layer-shell
 * overlay moves (`setPosition` is reported for one where the runtime has `layerShell`).
 */
async function placeInCorner(caps: Caps, applied: string[]): Promise<void> {
  if (!caps.screens || !caps.setPosition) return;
  await attempt(applied, "corner", async () => {
    const screen = primaryScreen(await getScreens());
    if (!screen) throw new Error("no display");
    const bounds = (await getWindowState()).bounds ?? WINDOW_SIZE;
    const { x, y } = cornerOnScreen(screen, bounds, {
      wayland: caps.sessionType === "wayland",
      edgeAnchored: caps.layerShellEdgeAnchor === true,
    });
    await setWindowPosition(x, y);
  });
}

/**
 * Set the window up as Loopy's overlay where supported.
 *
 * @param catchers The elements that catch clicks (Loopy, its bubble, its buttons).
 * @returns Whether this is a desktop window, what was applied, and how to stop following.
 */
export async function setupWindow(catchers: readonly Element[] = []): Promise<WindowSetup> {
  let caps: Caps;
  try {
    caps = await windowCapabilities();
  } catch {
    return { desktop: false, applied: [], stop: () => {} };
  }
  const applied: string[] = [];
  clearBackground(caps, applied);
  const stop = startClickThrough(caps, catchers, applied);
  await placeInCorner(caps, applied);
  return { desktop: true, applied, stop };
}

/** Make `element` drag the window (CSS `app-region` on CEF, pointer moves on the WebViews). */
export const dragWindowBy = makeWindowDraggable;

/** Quit the app (desktop only; a no-op in a browser). */
export async function quit(): Promise<void> {
  try {
    await quitApp();
  } catch { /* off desktop */ }
}
