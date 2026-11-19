// Full screen on each target: the Deno Desktop window goes full screen through denext's window
// API; in the Capacitor shell the system bars hide (immersive mode) while the page, laid out to
// the safe-area insets, already fills the screen; a browser uses the Fullscreen API.

import { setFullScreen } from "denext/desktop/window";
import { runtimePlatform, setSystemBars } from "denext/mobile";
import { type FullscreenMethod, fullscreenMethod } from "./fullscreen-method.ts";

export type { FullscreenMethod };

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

function fullscreenApi(): boolean {
  const el = document.documentElement as FullscreenElement;
  return typeof el.requestFullscreen === "function" ||
    typeof el.webkitRequestFullscreen === "function";
}

/** The method this page will use. */
export function currentFullscreenMethod(): FullscreenMethod {
  return fullscreenMethod(runtimePlatform(), fullscreenApi());
}

/** Enters (`on`) or leaves full screen around `element`; resolves to the method used. */
export async function setImmersive(
  on: boolean,
  element: HTMLElement,
): Promise<FullscreenMethod> {
  const method = currentFullscreenMethod();
  if (method === "desktop-window") await setFullScreen(on);
  else if (method === "mobile-immersive") {
    await setSystemBars({ hidden: on, animation: "fade" });
  } else if (method === "fullscreen-api") {
    await webFullscreen(on, element as FullscreenElement);
  }
  return method;
}

async function webFullscreen(
  on: boolean,
  element: FullscreenElement,
): Promise<void> {
  const doc = document as FullscreenDocument;
  const current = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  if (on && !current) {
    await (element.requestFullscreen?.({ navigationUI: "hide" }) ??
      element.webkitRequestFullscreen?.());
  } else if (!on && current) {
    await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
  }
}
