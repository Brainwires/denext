// Loopy's window chrome on Deno Desktop: always on top, in the bottom-right corner of the primary
// display, dragged by Loopy itself. Each step is feature-detected through `windowCapabilities()`
// and skipped where the OS or runtime can't do it (Wayland can't place windows; the stock runtime
// has no displays list). Off desktop (`denext dev` in a browser) every call rejects `unavailable`
// and Loopy just renders in the page.
"use client";
import {
  getScreens,
  getWindowState,
  makeWindowDraggable,
  quitApp,
  setAlwaysOnTop,
  setWindowPosition,
  windowCapabilities,
} from "denext/desktop/window";
import { cornerPosition, primaryScreen, WINDOW_SIZE } from "./placement.ts";

/** What {@linkcode setupWindow} found and did. */
export interface WindowSetup {
  /** Running in a Deno Desktop window. */
  readonly desktop: boolean;
  /** The steps that were applied, for the debug line. */
  readonly applied: readonly string[];
}

/** Run `step`, recording `name` when it worked; a failure is skipped, never thrown. */
async function attempt(applied: string[], name: string, step: () => Promise<unknown>) {
  try {
    await step();
    applied.push(name);
  } catch { /* unsupported here: Loopy works without it */ }
}

/**
 * Float the window above others and move it to the bottom-right corner, where supported.
 *
 * @returns Whether this is a desktop window, and what was applied.
 */
export async function setupWindow(): Promise<WindowSetup> {
  let caps: Awaited<ReturnType<typeof windowCapabilities>>;
  try {
    caps = await windowCapabilities();
  } catch {
    return { desktop: false, applied: [] };
  }
  const applied: string[] = [];
  await attempt(applied, "always-on-top", () => setAlwaysOnTop(true));
  if (caps.screens && caps.setPosition) {
    await attempt(applied, "corner", async () => {
      const screen = primaryScreen(await getScreens());
      if (!screen) throw new Error("no display");
      const bounds = (await getWindowState()).bounds ?? WINDOW_SIZE;
      const { x, y } = cornerPosition(screen.workArea, bounds);
      await setWindowPosition(x, y);
    });
  }
  return { desktop: true, applied };
}

/** Make `element` drag the window (CSS `app-region` on CEF, pointer moves on the WebViews). */
export const dragWindowBy = makeWindowDraggable;

/** Quit the app (desktop only; a no-op in a browser). */
export async function quit(): Promise<void> {
  try {
    await quitApp();
  } catch { /* off desktop */ }
}
